/**
 * 메일 수신 처리: MIME 파싱 → 스레드 묶기 → Firestore 저장 → 첨부는 R2.
 */

import PostalMime, { type Email as ParsedEmail } from "postal-mime";
import type { Firestore } from "./firestore";

export interface StoredMessage {
  id: string;
  mailbox: string; // 이 메일이 도착한 sanghak.kr 주소
  direction: "in" | "out";
  message_id: string;
  in_reply_to: string | null;
  refs: string | null;
  thread_id: string;
  from_addr: string;
  from_name: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  snippet: string;
  body_text: string;
  body_html: string;
  raw_key: string | null;
  has_attachments: boolean;
  size_bytes: number;
  is_read: boolean;
  is_starred: boolean;
  is_trashed: boolean;
  is_spam: boolean;
  received_at: string; // ISO8601 — 정렬 키
}

export interface StoredAttachment {
  id: string;
  message_id: string;
  mailbox: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  disposition: string;
  content_id: string | null;
  r2_key: string;
}

/** 주소에서 이메일만 뽑는다. "홍길동 <a@b.com>" → a@b.com */
export function extractAddress(input: string | null | undefined): string {
  if (!input) return "";
  const angle = input.match(/<([^>]+)>/);
  const raw = angle ? angle[1] : input;
  return raw.trim().toLowerCase();
}

/** 제목에서 Re:/Fwd: 접두어를 벗겨 스레드 매칭에 쓴다 */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|res|fwd|fw|답장|전달)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

/** 본문에서 목록용 미리보기를 만든다 */
export function makeSnippet(text: string, html: string, limit = 200): string {
  let source = text;
  if (!source && html) {
    // 태그를 걷어내고 엔티티 몇 개만 되돌린다
    source = html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
  }
  const collapsed = source.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? collapsed.slice(0, limit) + "…" : collapsed;
}

/**
 * 스레드 ID 결정.
 * 1) In-Reply-To / References 가 가리키는 기존 메시지가 있으면 그 스레드에 붙인다.
 * 2) 없으면 같은 메일함 + 같은 정규화 제목의 최근 메시지를 찾아 붙인다.
 * 3) 그래도 없으면 새 스레드.
 */
export async function resolveThreadId(
  db: Firestore,
  opts: {
    mailbox: string;
    messageId: string;
    inReplyTo: string | null;
    references: string | null;
    subject: string;
  },
): Promise<string> {
  const candidates: string[] = [];
  if (opts.inReplyTo) candidates.push(opts.inReplyTo.trim());
  if (opts.references) {
    for (const ref of opts.references.split(/\s+/)) {
      const trimmed = ref.trim();
      if (trimmed) candidates.push(trimmed);
    }
  }

  // 참조된 Message-ID 로 기존 메시지 찾기 (가장 최근 참조부터)
  for (const ref of candidates.reverse()) {
    const found = await db.query("messages", {
      where: [["message_id", "EQUAL", ref]],
      limit: 1,
    });
    if (found.length && typeof found[0].thread_id === "string") {
      return found[0].thread_id;
    }
  }

  // 제목 기반 폴백 — 스레딩 헤더가 없는 메일 클라이언트 대응
  const normalized = normalizeSubject(opts.subject);
  if (normalized) {
    const found = await db.query("messages", {
      where: [
        ["mailbox", "EQUAL", opts.mailbox],
        ["subject_key", "EQUAL", normalized],
      ],
      orderBy: [["received_at", "DESCENDING"]],
      limit: 1,
    });
    if (found.length && typeof found[0].thread_id === "string") {
      return found[0].thread_id;
    }
  }

  return crypto.randomUUID();
}

/** 아주 단순한 스팸 힌트 — 인증 실패 헤더만 본다 */
export function looksLikeSpam(headers: Headers): boolean {
  const auth = (headers.get("authentication-results") ?? "").toLowerCase();
  const spamStatus = (headers.get("x-spam-status") ?? "").toLowerCase();
  if (spamStatus.startsWith("yes")) return true;
  // SPF 와 DKIM 이 모두 fail 이면 스팸함으로 보낸다
  return auth.includes("spf=fail") && auth.includes("dkim=fail");
}

export interface IngestResult {
  messageId: string;
  threadId: string;
  attachmentCount: number;
}

/**
 * 수신 메일 하나를 저장한다.
 * rawBuffer 는 email() 핸들러에서 한 번만 읽어 넘겨야 한다.
 */
export async function ingestInbound(
  db: Firestore,
  blobs: R2Bucket,
  args: {
    rawBuffer: ArrayBuffer;
    envelopeFrom: string;
    envelopeTo: string;
    headers: Headers;
  },
): Promise<IngestResult> {
  const parsed: ParsedEmail = await PostalMime.parse(args.rawBuffer);

  const id = crypto.randomUUID();
  const mailbox = args.envelopeTo.toLowerCase();
  const messageId = (args.headers.get("message-id") ?? parsed.messageId ?? `<${id}@local>`).trim();
  const inReplyTo = args.headers.get("in-reply-to");
  const references = args.headers.get("references");
  const subject = (parsed.subject ?? "").trim() || "(제목 없음)";

  const threadId = await resolveThreadId(db, {
    mailbox,
    messageId,
    inReplyTo,
    references,
    subject,
  });

  // 원본 MIME 을 R2 에 보관한다 (원문 보기 / 재파싱용)
  const rawKey = `raw/${mailbox}/${id}.eml`;
  await blobs.put(rawKey, args.rawBuffer, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  // 첨부파일 저장
  const attachments = parsed.attachments ?? [];
  for (const att of attachments) {
    const attId = crypto.randomUUID();
    const key = `att/${mailbox}/${id}/${attId}`;
    const content =
      typeof att.content === "string"
        ? new TextEncoder().encode(att.content)
        : new Uint8Array(att.content as ArrayBuffer);
    await blobs.put(key, content, {
      httpMetadata: { contentType: att.mimeType || "application/octet-stream" },
    });
    const record: StoredAttachment = {
      id: attId,
      message_id: id,
      mailbox,
      filename: att.filename || "attachment",
      mime_type: att.mimeType || "application/octet-stream",
      size_bytes: content.byteLength,
      disposition: att.disposition === "inline" ? "inline" : "attachment",
      content_id: att.contentId ?? null,
      r2_key: key,
    };
    await db.set("attachments", attId, record as unknown as Record<string, unknown>);
  }

  const bodyText = parsed.text ?? "";
  const bodyHtml = parsed.html ?? "";

  const record: StoredMessage & { subject_key: string } = {
    id,
    mailbox,
    direction: "in",
    message_id: messageId,
    in_reply_to: inReplyTo,
    refs: references,
    thread_id: threadId,
    from_addr: extractAddress(parsed.from?.address ?? args.envelopeFrom),
    from_name: parsed.from?.name ?? "",
    to_addrs: (parsed.to ?? []).map((a) => extractAddress(a.address)).filter(Boolean),
    cc_addrs: (parsed.cc ?? []).map((a) => extractAddress(a.address)).filter(Boolean),
    subject,
    subject_key: normalizeSubject(subject),
    snippet: makeSnippet(bodyText, bodyHtml),
    body_text: bodyText,
    body_html: bodyHtml,
    raw_key: rawKey,
    has_attachments: attachments.length > 0,
    size_bytes: args.rawBuffer.byteLength,
    is_read: false,
    is_starred: false,
    is_trashed: false,
    is_spam: looksLikeSpam(args.headers),
    received_at: (parsed.date ? new Date(parsed.date) : new Date()).toISOString(),
  };

  await db.set("messages", id, record as unknown as Record<string, unknown>);

  // 처음 보는 주소면 메일함 목록에 자동 등록한다 (catch-all 로 들어온 주소 포함)
  const existing = await db.get("mailboxes", mailbox);
  if (!existing) {
    await db.set("mailboxes", mailbox, {
      address: mailbox,
      label: mailbox.split("@")[0],
      auto_created: true,
      created_at: new Date().toISOString(),
    });
  }

  return { messageId: id, threadId, attachmentCount: attachments.length };
}
