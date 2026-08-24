/**
 * id / pw 로그인 + 서명된 세션 쿠키.
 *
 * 사용자 계정은 Firestore users 컬렉션에 저장한다 (문서 ID = 로그인 아이디).
 * 비밀번호는 PBKDF2-SHA256 해시로만 저장하고, 원문은 어디에도 남기지 않는다.
 */

import type { Firestore } from "./firestore";

const PBKDF2_ITERATIONS = 210_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 2주
export const SESSION_COOKIE = "sk_session";

export interface User {
  id: string; // 로그인 아이디
  password_hash: string; // pbkdf2$<iterations>$<saltB64>$<hashB64>
  display_name?: string;
  /** 이 사용자가 쓸 수 있는 주소. ["*"] 면 도메인 전체 */
  addresses?: string[];
  created_at?: string;
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64decode(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function b64url(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/** 타이밍 공격을 피하기 위한 상수 시간 비교 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** 새 비밀번호 해시 생성 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

/** 저장된 해시와 입력 비밀번호 비교 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const salt = b64decode(parts[2]);
  const expected = b64decode(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 세션 토큰 발급: <payloadB64url>.<sigB64url> */
export async function createSession(userId: string, secret: string): Promise<string> {
  const payload = JSON.stringify({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  const payloadPart = b64url(new TextEncoder().encode(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart));
  return `${payloadPart}.${b64url(new Uint8Array(sig))}`;
}

/** 세션 토큰 검증. 유효하면 사용자 아이디, 아니면 null */
export async function verifySession(token: string, secret: string): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(sigPart) as BufferSource,
    new TextEncoder().encode(payloadPart),
  );
  if (!ok) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadPart))) as {
      sub?: string;
      exp?: number;
    };
    if (!claims.sub || !claims.exp) return null;
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

export interface CookieOptions {
  /** 서브도메인 간 공유용. 예: "sanghak.kr" (로컬 개발에서는 비운다) */
  domain?: string;
  /** http 로컬 개발에서는 false 여야 브라우저가 쿠키를 저장한다 */
  secure: boolean;
}

function cookieParts(value: string, maxAge: number, opts: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    // UI(mail.sanghak.kr) 와 API(api.sanghak.kr) 는 같은 사이트라 Lax 로도 쿠키가 전송된다
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionCookie(token: string, opts: CookieOptions): string {
  return cookieParts(token, SESSION_TTL_SECONDS, opts);
}

export function clearCookie(opts: CookieOptions): string {
  return cookieParts("", 0, opts);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** 요청에서 로그인된 사용자를 꺼낸다. 없으면 null */
export async function currentUser(
  request: Request,
  db: Firestore,
  secret: string,
): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const userId = await verifySession(token, secret);
  if (!userId) return null;
  const doc = await db.get("users", userId);
  if (!doc) return null;
  return doc as unknown as User;
}

/** 이 사용자가 해당 주소로 보낼 수 있는지 */
export function canUseAddress(user: User, address: string): boolean {
  const allowed = user.addresses ?? ["*"];
  if (allowed.includes("*")) return true;
  return allowed.some((a) => a.toLowerCase() === address.toLowerCase());
}
