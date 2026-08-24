/**
 * 웹메일 HTTP API.
 *
 * 모든 /api/* 요청은 세션 쿠키로 인증한다. 예외는 로그인과 최초 계정 생성뿐이다.
 */

import { Firestore } from "./firestore";
import { validateDocId } from "./validate";
import {
  canUseAddress,
  clearCookie,
  createSession,
  currentUser,
  hashPassword,
  sessionCookie,
  verifyPassword,
  type CookieOptions,
  type User,
} from "./auth";
import {
  derivedKeys,
  extractAddress,
  makeMessageId,
  makeSnippet,
  normalizeSubject,
  type Folder,
} from "./mail";

export interface Env {
  EMAIL: SendEmail;
  BLOBS: R2Bucket;
  MAIL_DOMAIN: string;
  FIREBASE_PROJECT_ID: string;
  FIRESTORE_DATABASE: string;
  GCP_SERVICE_ACCOUNT: string;
  SESSION_SECRET: string;
  SETUP_TOKEN?: string;
  /** 웹메일 UI 의 출처. 쉼표로 여러 개 (예: "https://mail.sanghak.kr,http://localhost:8080") */
  ALLOWED_ORIGINS: string;
  /** 세션 쿠키를 공유할 도메인. 로컬 개발에서는 비운다 */
  COOKIE_DOMAIN?: string;
  /** 수신 저장이 실패했을 때 메일을 넘길 검증된 주소 (유실 방지 안전망) */
  FALLBACK_FORWARD?: string;
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });

const bad = (message: string, status = 400) => json({ error: message }, { status });

/** 요청 Origin 이 허용 목록에 있으면 그 값을 그대로 반영한다 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-setup-token",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

/** 배포 환경과 로컬 개발에서 각각 동작하는 쿠키 속성 */
function cookieOptions(request: Request, env: Env): CookieOptions {
  const isHttps = new URL(request.url).protocol === "https:";
  return {
    domain: isHttps ? env.COOKIE_DOMAIN || undefined : undefined,
    secure: isHttps,
  };
}

export function makeDb(env: Env): Firestore {
  return new Firestore({
    projectId: env.FIREBASE_PROJECT_ID,
    database: env.FIRESTORE_DATABASE || "(default)",
    serviceAccountJson: env.GCP_SERVICE_ACCOUNT,
  });
}

/** 목록 응답에서는 본문 전체를 빼고 보낸다 */
function toListItem(msg: Record<string, unknown>) {
  return {
    id: msg.id,
    mailbox: msg.mailbox,
    direction: msg.direction,
    thread_id: msg.thread_id,
    from_addr: msg.from_addr,
    from_name: msg.from_name,
    to_addrs: msg.to_addrs ?? [],
    subject: msg.subject,
    snippet: msg.snippet,
    has_attachments: msg.has_attachments ?? false,
    is_read: msg.is_read ?? false,
    is_starred: msg.is_starred ?? false,
    is_trashed: msg.is_trashed ?? false,
    is_spam: msg.is_spam ?? false,
    size_bytes: msg.size_bytes ?? 0,
    received_at: msg.received_at,
  };
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (!env.GCP_SERVICE_ACCOUNT) {
    return bad("GCP_SERVICE_ACCOUNT 시크릿이 설정되지 않았다", 500);
  }
  if (!env.SESSION_SECRET) {
    return bad("SESSION_SECRET 시크릿이 설정되지 않았다", 500);
  }

  const db = makeDb(env);

  // ---- 최초 계정 생성 (SETUP_TOKEN 헤더 필요) ----
  if (path === "/api/setup" && method === "POST") {
    if (!env.SETUP_TOKEN) return bad("SETUP_TOKEN 이 설정되지 않아 사용할 수 없다", 403);
    if (request.headers.get("x-setup-token") !== env.SETUP_TOKEN) {
      return bad("SETUP_TOKEN 이 일치하지 않는다", 403);
    }
    const body = (await request.json().catch(() => null)) as
      | { id?: string; password?: string; display_name?: string; addresses?: string[] }
      | null;
    if (!body?.id || !body.password) return bad("id 와 password 가 필요하다");
    if (body.password.length < 8) return bad("비밀번호는 8자 이상이어야 한다");
    const idError = validateDocId(body.id);
    if (idError) return bad(`아이디를 쓸 수 없다: ${idError}`);

    const user: User = {
      id: body.id,
      password_hash: await hashPassword(body.password),
      display_name: body.display_name ?? body.id,
      addresses: body.addresses ?? ["*"],
      // 최초 계정은 관리자여야 관리자 화면에 들어갈 수 있다
      is_admin: true,
      created_at: new Date().toISOString(),
    };
    await db.set("users", body.id, user as unknown as Record<string, unknown>);
    return json({ ok: true, id: body.id });
  }

  // ---- 로그인 ----
  if (path === "/api/login" && method === "POST") {
    const body = (await request.json().catch(() => null)) as
      | { id?: string; password?: string }
      | null;
    if (!body?.id || !body.password) return bad("아이디와 비밀번호를 입력해야 한다");

    const doc = await db.get("users", body.id);
    // 아이디가 없어도 같은 응답/비슷한 시간이 걸리도록 더미 검증을 수행한다
    const storedHash =
      (doc?.password_hash as string | undefined) ??
      "pbkdf2$6x100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const ok = await verifyPassword(body.password, storedHash);
    if (!doc || !ok) return bad("아이디 또는 비밀번호가 올바르지 않다", 401);

    const token = await createSession(body.id, env.SESSION_SECRET);
    return json(
      { ok: true, id: body.id, display_name: doc.display_name ?? body.id },
      { headers: { "set-cookie": sessionCookie(token, cookieOptions(request, env)) } },
    );
  }

  if (path === "/api/logout" && method === "POST") {
    return json(
      { ok: true },
      { headers: { "set-cookie": clearCookie(cookieOptions(request, env)) } },
    );
  }

  // ---- 여기부터는 로그인 필수 ----
  const user = await currentUser(request, db, env.SESSION_SECRET);
  if (!user) return bad("로그인이 필요하다", 401);

  if (path === "/api/me" && method === "GET") {
    return json({
      id: user.id,
      display_name: user.display_name ?? user.id,
      addresses: user.addresses ?? ["*"],
      is_admin: Boolean(user.is_admin),
      domain: env.MAIL_DOMAIN,
    });
  }

  // ---- 비밀번호 변경 ----
  if (path === "/api/password" && method === "POST") {
    const body = (await request.json().catch(() => null)) as
      | { current_password?: string; new_password?: string }
      | null;
    if (!body?.current_password || !body.new_password) {
      return bad("current_password 와 new_password 가 필요하다");
    }
    if (body.new_password.length < 8) return bad("새 비밀번호는 8자 이상이어야 한다");
    if (body.new_password === body.current_password) {
      return bad("새 비밀번호가 기존 비밀번호와 같다");
    }
    if (!(await verifyPassword(body.current_password, user.password_hash))) {
      return bad("현재 비밀번호가 올바르지 않다", 403);
    }
    await db.update("users", user.id, {
      password_hash: await hashPassword(body.new_password),
      password_changed_at: new Date().toISOString(),
    });
    // 기존 세션 토큰은 그대로 유효하다. 새 쿠키를 내려 만료를 갱신해 준다.
    const token = await createSession(user.id, env.SESSION_SECRET);
    return json(
      { ok: true },
      { headers: { "set-cookie": sessionCookie(token, cookieOptions(request, env)) } },
    );
  }

  // ================= 관리자 =================
  if (path.startsWith("/api/admin/")) {
    if (!user.is_admin) return bad("관리자 권한이 필요하다", 403);

    // 계정 목록 (비밀번호 해시는 절대 내려보내지 않는다)
    if (path === "/api/admin/users" && method === "GET") {
      const rows = await db.list("users");
      const users = rows.map((u) => ({
        id: u.id,
        display_name: u.display_name ?? u.id,
        addresses: u.addresses ?? ["*"],
        is_admin: Boolean(u.is_admin),
        created_at: u.created_at ?? null,
        password_changed_at: u.password_changed_at ?? null,
      }));
      users.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return json({ users });
    }

    // 계정 생성
    if (path === "/api/admin/users" && method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        id?: string; password?: string; display_name?: string;
        addresses?: string[]; is_admin?: boolean;
      } | null;
      if (!body?.id || !body.password) return bad("아이디와 비밀번호가 필요하다");
      if (body.password.length < 8) return bad("비밀번호는 8자 이상이어야 한다");
      const idError = validateDocId(body.id);
      if (idError) return bad(`아이디를 쓸 수 없다: ${idError}`);
      if (await db.get("users", body.id)) return bad("이미 있는 아이디다", 409);

      await db.set("users", body.id, {
        id: body.id,
        password_hash: await hashPassword(body.password),
        display_name: body.display_name || body.id,
        addresses: body.addresses?.length ? body.addresses : ["*"],
        is_admin: Boolean(body.is_admin),
        created_at: new Date().toISOString(),
      });
      return json({ ok: true, id: body.id });
    }

    const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);

    // 계정 수정
    if (userMatch && method === "PATCH") {
      const targetId = decodeURIComponent(userMatch[1]);
      const target = await db.get("users", targetId);
      if (!target) return bad("계정을 찾을 수 없다", 404);

      const body = (await request.json().catch(() => null)) as {
        password?: string; display_name?: string;
        addresses?: string[]; is_admin?: boolean;
      } | null;
      if (!body) return bad("본문이 필요하다");

      const patch: Record<string, unknown> = {};
      if (typeof body.display_name === "string") patch.display_name = body.display_name || targetId;
      if (Array.isArray(body.addresses)) {
        patch.addresses = body.addresses.length ? body.addresses : ["*"];
      }
      if (typeof body.is_admin === "boolean") {
        // 자기 자신의 관리자 권한은 뺄 수 없다 (관리자가 0명이 되는 상황 방지)
        if (targetId === user.id && !body.is_admin) {
          return bad("자기 자신의 관리자 권한은 해제할 수 없다");
        }
        patch.is_admin = body.is_admin;
      }
      if (body.password) {
        if (body.password.length < 8) return bad("비밀번호는 8자 이상이어야 한다");
        patch.password_hash = await hashPassword(body.password);
        patch.password_changed_at = new Date().toISOString();
      }
      if (!Object.keys(patch).length) return bad("변경할 내용이 없다");

      await db.update("users", targetId, patch);
      return json({ ok: true, id: targetId });
    }

    // 계정 삭제
    if (userMatch && method === "DELETE") {
      const targetId = decodeURIComponent(userMatch[1]);
      if (targetId === user.id) return bad("자기 계정은 삭제할 수 없다");
      if (!(await db.get("users", targetId))) return bad("계정을 찾을 수 없다", 404);
      await db.delete("users", targetId);
      return json({ ok: true, deleted: targetId });
    }

    // 통계
    if (path === "/api/admin/stats" && method === "GET") {
      // 규모가 커지면 집계 쿼리로 바꿔야 한다. 지금은 전체를 훑어 센다.
      const messages = await db.list("messages");
      const attachments = await db.list("attachments");

      const perMailbox = new Map<string, { total: number; unread: number }>();
      let inbox = 0, sent = 0, spam = 0, trash = 0, unread = 0;
      for (const m of messages) {
        const folder = String(m.folder ?? "");
        if (folder === "inbox") inbox++;
        else if (folder === "sent") sent++;
        else if (folder === "spam") spam++;
        else if (folder === "trash") trash++;
        if (!m.is_read) unread++;

        const key = String(m.mailbox ?? "(없음)");
        const entry = perMailbox.get(key) ?? { total: 0, unread: 0 };
        entry.total++;
        if (!m.is_read) entry.unread++;
        perMailbox.set(key, entry);
      }

      const attachmentBytes = attachments.reduce(
        (sum, a) => sum + (Number(a.size_bytes) || 0), 0,
      );

      return json({
        total: messages.length,
        inbox, sent, spam, trash, unread,
        attachments: attachments.length,
        attachment_bytes: attachmentBytes,
        per_mailbox: Array.from(perMailbox, ([mailbox, v]) => ({ mailbox, ...v }))
          .sort((a, b) => b.total - a.total),
      });
    }

    // 시스템 상태
    if (path === "/api/admin/system" && method === "GET") {
      return json({
        mail_domain: env.MAIL_DOMAIN,
        api_host: new URL(request.url).host,
        firebase_project: env.FIREBASE_PROJECT_ID,
        send_binding: Boolean(env.EMAIL),
        r2_binding: Boolean(env.BLOBS),
        session_secret: Boolean(env.SESSION_SECRET),
        setup_token: Boolean(env.SETUP_TOKEN),
        fallback_forward: env.FALLBACK_FORWARD ?? null,
        allowed_origins: (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
      });
    }

    return bad(`알 수 없는 관리자 경로: ${method} ${path}`, 404);
  }

  // ---- 메일함 목록 ----
  if (path === "/api/mailboxes" && method === "GET") {
    const boxes = await db.list("mailboxes");
    boxes.sort((a, b) => String(a.address).localeCompare(String(b.address)));
    return json({ mailboxes: boxes });
  }

  if (path === "/api/mailboxes" && method === "POST") {
    const body = (await request.json().catch(() => null)) as
      | { address?: string; label?: string }
      | null;
    if (!body?.address) return bad("address 가 필요하다");
    const address = body.address.trim().toLowerCase();
    if (!address.endsWith(`@${env.MAIL_DOMAIN}`)) {
      return bad(`주소는 @${env.MAIL_DOMAIN} 로 끝나야 한다`);
    }
    if (!/^[a-z0-9._%+-]+@/.test(address)) return bad("주소 형식이 올바르지 않다");
    const addrError = validateDocId(address);
    if (addrError) return bad(`주소를 쓸 수 없다: ${addrError}`);
    await db.set("mailboxes", address, {
      address,
      label: body.label ?? address.split("@")[0],
      auto_created: false,
      created_at: new Date().toISOString(),
    });
    return json({ ok: true, address });
  }

  if (path.startsWith("/api/mailboxes/") && method === "DELETE") {
    const address = decodeURIComponent(path.slice("/api/mailboxes/".length));
    await db.delete("mailboxes", address);
    return json({ ok: true });
  }

  // ---- 메시지 목록 ----
  if (path === "/api/messages" && method === "GET") {
    const mailbox = url.searchParams.get("mailbox") ?? "";
    const folder = url.searchParams.get("folder") ?? "inbox";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

    // 폴더 + 주소 조합을 하나의 등호 필터로 만든다.
    // "등호 1개 + __name__ 정렬" 은 Firestore 자동 색인으로 처리되므로
    // 복합 색인을 따로 만들 필요가 없다.
    const where: Array<[string, string, unknown]> = [];
    const mb = mailbox.toLowerCase();

    if (folder === "starred") {
      if (mb) where.push(["star_key", "EQUAL", `${mb}|starred`]);
      else where.push(["star_all", "EQUAL", true]);
    } else if (["inbox", "sent", "spam", "trash"].includes(folder)) {
      if (mb) where.push(["list_key", "EQUAL", `${mb}|${folder}`]);
      else where.push(["folder", "EQUAL", folder]);
    } else {
      return bad(`알 수 없는 folder: ${folder}`);
    }

    // 검색어가 있으면 넉넉히 가져와 메모리에서 걸러낸다.
    // (Firestore 는 전문 검색이 없다 — 규모가 커지면 외부 검색 색인이 필요하다)
    const fetchLimit = q ? Math.min(limit * 10, 500) : limit;
    let rows = await db.query("messages", {
      where,
      // 문서 ID 가 도착 시각 순이라 최신순 정렬이 된다
      orderBy: [["__name__", "DESCENDING"]],
      limit: fetchLimit,
    });

    if (q) {
      rows = rows
        .filter((r) => {
          const haystack = [
            r.subject,
            r.snippet,
            r.from_addr,
            r.from_name,
            r.body_text,
            Array.isArray(r.to_addrs) ? (r.to_addrs as string[]).join(" ") : "",
          ]
            .map((v) => String(v ?? "").toLowerCase())
            .join(" ");
          return haystack.includes(q);
        })
        .slice(0, limit);
    }

    return json({ messages: rows.map(toListItem), folder, mailbox, query: q || null });
  }

  // ---- 단일 메시지 (본문 포함, 읽음 처리) ----
  const msgMatch = path.match(/^\/api\/messages\/([^/]+)$/);
  if (msgMatch && method === "GET") {
    const id = decodeURIComponent(msgMatch[1]);
    const msg = await db.get("messages", id);
    if (!msg) return bad("메시지를 찾을 수 없다", 404);

    if (!msg.is_read) {
      await db.update("messages", id, { is_read: true });
      msg.is_read = true;
    }
    const attachments = await db.query("attachments", {
      where: [["message_id", "EQUAL", id]],
    });
    return json({ message: msg, attachments });
  }

  // ---- 플래그 변경 ----
  if (msgMatch && method === "PATCH") {
    const id = decodeURIComponent(msgMatch[1]);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return bad("본문이 필요하다");

    const allowed = ["is_read", "is_starred", "is_trashed", "is_spam"] as const;
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) patch[key] = Boolean(body[key]);
    }
    if (!Object.keys(patch).length) return bad("변경할 플래그가 없다");

    const existing = await db.get("messages", id);
    if (!existing) return bad("메시지를 찾을 수 없다", 404);

    // 플래그가 바뀌면 목록 조회용 파생 키도 함께 갱신해야 한다
    const trashed = Boolean(patch.is_trashed ?? existing.is_trashed);
    const spam = Boolean(patch.is_spam ?? existing.is_spam);
    const starred = Boolean(patch.is_starred ?? existing.is_starred);
    const outbound = existing.direction === "out";

    const folder: Folder = trashed ? "trash" : outbound ? "sent" : spam ? "spam" : "inbox";
    Object.assign(
      patch,
      derivedKeys({
        mailbox: String(existing.mailbox ?? ""),
        folder,
        starred,
        subjectKey: String(existing.subject_key ?? ""),
      }),
    );

    await db.update("messages", id, patch);
    return json({ ok: true, ...patch });
  }

  // ---- 완전 삭제 (휴지통에서 비우기) ----
  if (msgMatch && method === "DELETE") {
    const id = decodeURIComponent(msgMatch[1]);
    const msg = await db.get("messages", id);
    if (!msg) return bad("메시지를 찾을 수 없다", 404);

    // R2 의 원본과 첨부까지 함께 지운다
    const attachments = await db.query("attachments", {
      where: [["message_id", "EQUAL", id]],
    });
    for (const att of attachments) {
      if (typeof att.r2_key === "string") await env.BLOBS.delete(att.r2_key);
      await db.delete("attachments", String(att.id));
    }
    if (typeof msg.raw_key === "string") await env.BLOBS.delete(msg.raw_key);
    await db.delete("messages", id);
    return json({ ok: true, deleted: id });
  }

  // ---- 스레드 ----
  const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);
  if (threadMatch && method === "GET") {
    const threadId = decodeURIComponent(threadMatch[1]);
    const rows = await db.query("messages", {
      where: [["thread_id", "EQUAL", threadId]],
      orderBy: [["__name__", "ASCENDING"]],
      limit: 200,
    });
    return json({ thread_id: threadId, messages: rows });
  }

  // ---- 첨부파일 다운로드 ----
  const attMatch = path.match(/^\/api\/attachments\/([^/]+)$/);
  if (attMatch && method === "GET") {
    const attId = decodeURIComponent(attMatch[1]);
    const att = await db.get("attachments", attId);
    if (!att || typeof att.r2_key !== "string") return bad("첨부파일을 찾을 수 없다", 404);
    const object = await env.BLOBS.get(att.r2_key);
    if (!object) return bad("첨부파일 본문이 없다", 404);

    const filename = String(att.filename ?? "attachment");
    return new Response(object.body, {
      headers: {
        "content-type": String(att.mime_type ?? "application/octet-stream"),
        // 브라우저가 실행하지 못하도록 항상 첨부로 내려준다
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "x-content-type-options": "nosniff",
      },
    });
  }

  // ---- 원본 MIME 보기 ----
  const rawMatch = path.match(/^\/api\/messages\/([^/]+)\/raw$/);
  if (rawMatch && method === "GET") {
    const id = decodeURIComponent(rawMatch[1]);
    const msg = await db.get("messages", id);
    if (!msg || typeof msg.raw_key !== "string") return bad("원본이 없다", 404);
    const object = await env.BLOBS.get(msg.raw_key);
    if (!object) return bad("원본 본문이 없다", 404);
    return new Response(object.body, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // ---- 발송 ----
  if (path === "/api/send" && method === "POST") {
    const body = (await request.json().catch(() => null)) as
      | {
          from?: string;
          to?: string | string[];
          cc?: string | string[];
          subject?: string;
          text?: string;
          html?: string;
          reply_to_message_id?: string;
        }
      | null;
    if (!body) return bad("본문이 필요하다");

    const from = extractAddress(body.from);
    if (!from) return bad("from 이 필요하다");
    if (!from.endsWith(`@${env.MAIL_DOMAIN}`)) {
      return bad(`from 은 @${env.MAIL_DOMAIN} 주소여야 한다`);
    }
    if (!canUseAddress(user, from)) return bad("이 주소로 보낼 권한이 없다", 403);

    const toList = (Array.isArray(body.to) ? body.to : [body.to ?? ""])
      .flatMap((v) => String(v).split(","))
      .map(extractAddress)
      .filter(Boolean);
    const ccList = (Array.isArray(body.cc) ? body.cc : [body.cc ?? ""])
      .flatMap((v) => String(v).split(","))
      .map(extractAddress)
      .filter(Boolean);
    if (!toList.length) return bad("받는 사람이 필요하다");
    if (toList.length + ccList.length > 50) return bad("수신자는 합쳐서 50명까지만 가능하다");

    const subject = (body.subject ?? "").trim() || "(제목 없음)";
    const text = body.text ?? "";
    const html = body.html ?? "";
    if (!text && !html) return bad("본문이 비어 있다");

    // 답장이면 스레딩 헤더를 붙인다
    const headers: Record<string, string> = {};
    let threadId = crypto.randomUUID();
    let inReplyTo: string | null = null;
    if (body.reply_to_message_id) {
      const original = await db.get("messages", body.reply_to_message_id);
      if (original) {
        if (typeof original.thread_id === "string") threadId = original.thread_id;
        if (typeof original.message_id === "string" && original.message_id) {
          inReplyTo = original.message_id;
          headers["In-Reply-To"] = original.message_id;
          const refs =
            typeof original.refs === "string" && original.refs
              ? `${original.refs} ${original.message_id}`
              : original.message_id;
          headers["References"] = refs;
        }
      }
    }

    const sentAt = new Date();
    const id = makeMessageId(sentAt);
    const outboundMessageId = `<${id}@${env.MAIL_DOMAIN}>`;

    try {
      await env.EMAIL.send({
        to: toList,
        ...(ccList.length ? { cc: ccList } : {}),
        from: { email: from, name: user.display_name ?? from },
        subject,
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      } as Parameters<SendEmail["send"]>[0]);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      return bad(`발송 실패 (${err.code ?? "unknown"}): ${err.message ?? String(error)}`, 502);
    }

    // 보낸 메일함에 기록
    const subjectKey = normalizeSubject(subject);
    const record = {
      ...derivedKeys({ mailbox: from, folder: "sent", starred: false, subjectKey }),
      id,
      mailbox: from,
      direction: "out" as const,
      message_id: outboundMessageId,
      in_reply_to: inReplyTo,
      refs: headers["References"] ?? null,
      thread_id: threadId,
      from_addr: from,
      from_name: user.display_name ?? "",
      to_addrs: toList,
      cc_addrs: ccList,
      subject,
      subject_key: subjectKey,
      snippet: makeSnippet(text, html),
      body_text: text,
      body_html: html,
      raw_key: null,
      has_attachments: false,
      size_bytes: new TextEncoder().encode(text + html).byteLength,
      is_read: true,
      is_starred: false,
      is_trashed: false,
      is_spam: false,
      header_date: null,
      received_at: sentAt.toISOString(),
    };
    await db.set("messages", id, record as unknown as Record<string, unknown>);

    return json({ ok: true, id, thread_id: threadId });
  }

  return bad(`알 수 없는 경로: ${method} ${path}`, 404);
}
