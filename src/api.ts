/**
 * 웹메일 HTTP API.
 *
 * 모든 /api/* 요청은 세션 쿠키로 인증한다. 예외는 로그인과 최초 계정 생성뿐이다.
 */

import { Firestore } from "./firestore";
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
import { extractAddress, makeSnippet, normalizeSubject, type StoredMessage } from "./mail";

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

    const user: User = {
      id: body.id,
      password_hash: await hashPassword(body.password),
      display_name: body.display_name ?? body.id,
      addresses: body.addresses ?? ["*"],
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
      "pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
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
      domain: env.MAIL_DOMAIN,
    });
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

    const where: Array<[string, string, unknown]> = [];
    if (mailbox) where.push(["mailbox", "EQUAL", mailbox.toLowerCase()]);

    // 폴더별 필터. Firestore 는 부등호/불리언 조합에 제약이 있어 단순 등호만 쓴다.
    switch (folder) {
      case "inbox":
        where.push(["direction", "EQUAL", "in"]);
        where.push(["is_trashed", "EQUAL", false]);
        where.push(["is_spam", "EQUAL", false]);
        break;
      case "sent":
        where.push(["direction", "EQUAL", "out"]);
        where.push(["is_trashed", "EQUAL", false]);
        break;
      case "starred":
        where.push(["is_starred", "EQUAL", true]);
        where.push(["is_trashed", "EQUAL", false]);
        break;
      case "spam":
        where.push(["is_spam", "EQUAL", true]);
        where.push(["is_trashed", "EQUAL", false]);
        break;
      case "trash":
        where.push(["is_trashed", "EQUAL", true]);
        break;
      case "all":
        where.push(["is_trashed", "EQUAL", false]);
        break;
      default:
        return bad(`알 수 없는 folder: ${folder}`);
    }

    // 검색어가 있으면 넉넉히 가져와 메모리에서 걸러낸다.
    // (Firestore 는 전문 검색이 없다 — 규모가 커지면 외부 검색 색인이 필요하다)
    const fetchLimit = q ? Math.min(limit * 10, 500) : limit;
    let rows = await db.query("messages", {
      where,
      orderBy: [["received_at", "DESCENDING"]],
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
      orderBy: [["received_at", "ASCENDING"]],
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

    const id = crypto.randomUUID();
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
    const record: StoredMessage & { subject_key: string } = {
      id,
      mailbox: from,
      direction: "out",
      message_id: outboundMessageId,
      in_reply_to: inReplyTo,
      refs: headers["References"] ?? null,
      thread_id: threadId,
      from_addr: from,
      from_name: user.display_name ?? "",
      to_addrs: toList,
      cc_addrs: ccList,
      subject,
      subject_key: normalizeSubject(subject),
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
      received_at: new Date().toISOString(),
    };
    await db.set("messages", id, record as unknown as Record<string, unknown>);

    return json({ ok: true, id, thread_id: threadId });
  }

  return bad(`알 수 없는 경로: ${method} ${path}`, 404);
}
