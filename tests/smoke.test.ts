import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hashPassword,
  verifyPassword,
  createSession,
  verifySession,
  sessionCookie,
  clearCookie,
  canUseAddress,
} from "../src/auth.ts";
import { extractAddress, normalizeSubject, makeSnippet, looksLikeSpam } from "../src/mail.ts";
import { toFs, fromFs, objectToFields, fieldsToObject, docId } from "../src/firestore.ts";

test("비밀번호 해시는 매번 다르고, 올바른 비밀번호만 통과한다", async () => {
  const a = await hashPassword("hunter2hunter2");
  const b = await hashPassword("hunter2hunter2");
  assert.notEqual(a, b, "salt 때문에 해시가 달라야 한다");
  assert.ok(a.startsWith("pbkdf2$210000$"));
  assert.equal(await verifyPassword("hunter2hunter2", a), true);
  assert.equal(await verifyPassword("hunter2hunter3", a), false);
  assert.equal(await verifyPassword("hunter2hunter2", "garbage"), false);
});

test("세션 토큰은 서명이 맞을 때만 통과한다", async () => {
  const token = await createSession("admin", "secret-key");
  assert.equal(await verifySession(token, "secret-key"), "admin");
  assert.equal(await verifySession(token, "wrong-key"), null, "다른 키로는 통과하면 안 된다");

  // payload 를 조작하면 서명이 깨져야 한다
  const [payload, sig] = token.split(".");
  const tampered = Buffer.from(JSON.stringify({ sub: "root", exp: 2000000000 }))
    .toString("base64url");
  assert.equal(await verifySession(`${tampered}.${sig}`, "secret-key"), null);
  assert.notEqual(payload, tampered);
});

test("만료된 세션은 거부된다", async () => {
  const expired = Buffer.from(JSON.stringify({ sub: "admin", exp: 1000 })).toString("base64url");
  // 올바른 서명을 직접 만들어 붙인다
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("secret-key"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expired));
  const sigB64 = Buffer.from(sig).toString("base64url");
  assert.equal(await verifySession(`${expired}.${sigB64}`, "secret-key"), null);
});

test("쿠키 속성은 환경에 따라 달라진다", () => {
  const prod = sessionCookie("tok", { domain: "sanghak.kr", secure: true });
  assert.match(prod, /Domain=sanghak\.kr/);
  assert.match(prod, /Secure/);
  assert.match(prod, /HttpOnly/);
  assert.match(prod, /SameSite=Lax/);

  const dev = sessionCookie("tok", { secure: false });
  assert.doesNotMatch(dev, /Domain=/);
  assert.doesNotMatch(dev, /Secure/);

  assert.match(clearCookie({ secure: true }), /Max-Age=0/);
});

test("주소 권한은 와일드카드와 명시 목록을 모두 지원한다", () => {
  assert.equal(canUseAddress({ id: "a", password_hash: "" }, "x@sanghak.kr"), true);
  const limited = { id: "a", password_hash: "", addresses: ["hello@sanghak.kr"] };
  assert.equal(canUseAddress(limited, "HELLO@sanghak.kr"), true);
  assert.equal(canUseAddress(limited, "other@sanghak.kr"), false);
});

test("주소 파싱", () => {
  assert.equal(extractAddress("홍길동 <Gil@Example.COM>"), "gil@example.com");
  assert.equal(extractAddress("  plain@example.com "), "plain@example.com");
  assert.equal(extractAddress(null), "");
});

test("제목 정규화로 답장 접두어를 벗긴다", () => {
  assert.equal(normalizeSubject("Re: Fwd: 회의 일정"), "회의 일정");
  assert.equal(normalizeSubject("RE: re: Hello"), "hello");
  assert.equal(normalizeSubject("답장: 안녕"), "안녕");
  assert.equal(normalizeSubject("원본 제목"), "원본 제목");
});

test("스니펫은 HTML 태그를 걷어내고 길이를 제한한다", () => {
  assert.equal(makeSnippet("", "<p>안녕<script>bad()</script>하세요</p>"), "안녕 하세요");
  assert.equal(makeSnippet("  여러   공백  ", ""), "여러 공백");
  const long = makeSnippet("가".repeat(500), "", 10);
  assert.equal(long.length, 11, "10자 + 생략기호");
  assert.ok(long.endsWith("…"));
});

test("스팸 판정은 SPF/DKIM 동시 실패나 명시 헤더만 본다", () => {
  assert.equal(looksLikeSpam(new Headers({ "x-spam-status": "Yes, score=9" })), true);
  assert.equal(
    looksLikeSpam(new Headers({ "authentication-results": "spf=fail; dkim=fail" })),
    true,
  );
  assert.equal(
    looksLikeSpam(new Headers({ "authentication-results": "spf=pass; dkim=fail" })),
    false,
  );
  assert.equal(looksLikeSpam(new Headers()), false);
});

test("Firestore 값 변환은 왕복해도 같은 값이 나온다", () => {
  const original = {
    subject: "안녕",
    count: 42,
    ratio: 1.5,
    flag: true,
    missing: null,
    list: ["a", "b"],
    nested: { inner: "값", n: 7 },
  };
  const round = fieldsToObject(objectToFields(original));
  assert.deepEqual(round, original);

  assert.deepEqual(toFs("x"), { stringValue: "x" });
  assert.deepEqual(toFs(3), { integerValue: "3" });
  assert.equal(fromFs({ integerValue: "9" }), 9);
  assert.equal(docId("projects/p/databases/(default)/documents/messages/abc"), "abc");
  assert.equal(docId(undefined), "");
});
