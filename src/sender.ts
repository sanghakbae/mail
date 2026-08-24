/**
 * 발송 어댑터.
 *
 * Cloudflare Email Sending 은 도메인이 온보딩되기 전까지 샌드박스로 동작해,
 * Email Routing 에 검증된 목적지 주소로만 보낼 수 있다 (E_RECIPIENT_NOT_ALLOWED).
 * 그래서 발송 경로를 교체할 수 있게 분리했다.
 *
 *   MAIL_PROVIDER=cloudflare  → send_email 바인딩 (검증된 주소만)
 *   MAIL_PROVIDER=resend      → Resend REST API (도메인 인증 후 아무 주소로나)
 */

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  /** base64 로 인코딩된 파일 내용 */
  base64: string;
}

export interface OutgoingMail {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** In-Reply-To / References 같은 스레딩 헤더 */
  headers?: Record<string, string>;
  attachments?: OutgoingAttachment[];
}

export interface SendResult {
  provider: "cloudflare" | "resend";
  id: string | null;
}

/** 발송 실패를 사용자에게 보여줄 수 있는 형태로 감싼다 */
export class SendError extends Error {
  code: string;
  provider: string;

  constructor(message: string, code: string, provider: string) {
    super(message);
    this.name = "SendError";
    this.code = code;
    this.provider = provider;
  }
}

interface SenderEnv {
  EMAIL: SendEmail;
  MAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
}

/** base64 → Uint8Array (Cloudflare 바인딩은 원시 바이트를 받는다) */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** "이름 <주소>" 형태로 만든다. 이름에 콤마/따옴표가 있으면 인용한다. */
function formatAddress(email: string, name?: string): string {
  if (!name) return email;
  const needsQuote = /[",;<>@]/.test(name);
  const safe = name.replace(/"/g, '\\"');
  return `${needsQuote ? `"${safe}"` : safe} <${email}>`;
}

async function sendViaCloudflare(env: SenderEnv, mail: OutgoingMail): Promise<SendResult> {
  try {
    const response = await env.EMAIL.send({
      to: mail.to,
      ...(mail.cc?.length ? { cc: mail.cc } : {}),
      from: { email: mail.from, name: mail.fromName ?? mail.from },
      subject: mail.subject,
      ...(mail.text ? { text: mail.text } : {}),
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.headers && Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
      ...(mail.attachments?.length
        ? {
            // 바인딩은 base64 가 아니라 원시 바이트를 받는다
            attachments: mail.attachments.map((a) => ({
              content: base64ToBytes(a.base64),
              filename: a.filename,
              type: a.mimeType,
              disposition: "attachment",
            })),
          }
        : {}),
    } as Parameters<SendEmail["send"]>[0]);
    return { provider: "cloudflare", id: (response as { messageId?: string })?.messageId ?? null };
  } catch (error) {
    const err = error as { code?: string; message?: string };
    throw new SendError(
      err.message ?? String(error),
      err.code ?? "E_UNKNOWN",
      "cloudflare",
    );
  }
}

async function sendViaResend(env: SenderEnv, mail: OutgoingMail): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    throw new SendError(
      "RESEND_API_KEY 시크릿이 설정되지 않았다",
      "E_CONFIG_MISSING",
      "resend",
    );
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: formatAddress(mail.from, mail.fromName),
      to: mail.to,
      ...(mail.cc?.length ? { cc: mail.cc } : {}),
      subject: mail.subject,
      ...(mail.text ? { text: mail.text } : {}),
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.headers && Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
      ...(mail.attachments?.length
        ? {
            // Resend 는 base64 문자열을 받는다
            attachments: mail.attachments.map((a) => ({
              filename: a.filename,
              content: a.base64,
              content_type: a.mimeType,
            })),
          }
        : {}),
    }),
  });

  const body = (await res.json().catch(() => null)) as
    | { id?: string; message?: string; name?: string; statusCode?: number }
    | null;

  if (!res.ok) {
    // Resend 는 { statusCode, name, message } 형태로 오류를 준다
    throw new SendError(
      body?.message ?? `HTTP ${res.status}`,
      body?.name ?? `E_HTTP_${res.status}`,
      "resend",
    );
  }
  return { provider: "resend", id: body?.id ?? null };
}

/**
 * 실제로 쓸 provider 를 결정한다.
 *
 * 기본값 "auto": RESEND_API_KEY 가 있으면 resend, 없으면 cloudflare.
 * 키만 등록하면 재배포 없이 전환된다.
 */
export function resolveProvider(env: SenderEnv): "cloudflare" | "resend" {
  const configured = (env.MAIL_PROVIDER ?? "auto").toLowerCase();
  if (configured === "resend") return "resend";
  if (configured === "cloudflare") return "cloudflare";
  return env.RESEND_API_KEY ? "resend" : "cloudflare";
}

/** 설정된 provider 로 메일을 보낸다 */
export async function sendMail(env: SenderEnv, mail: OutgoingMail): Promise<SendResult> {
  const configured = (env.MAIL_PROVIDER ?? "auto").toLowerCase();
  if (!["auto", "resend", "cloudflare"].includes(configured)) {
    throw new SendError(
      `알 수 없는 MAIL_PROVIDER: ${configured} (auto | resend | cloudflare)`,
      "E_CONFIG_INVALID",
      configured,
    );
  }
  return resolveProvider(env) === "resend"
    ? sendViaResend(env, mail)
    : sendViaCloudflare(env, mail);
}
