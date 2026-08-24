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
  assert.ok(a.startsWith("pbkdf2$6x100000$"), a.slice(0, 20));
  assert.equal(await verifyPassword("hunter2hunter2", a), true);
  assert.equal(await verifyPassword("hunter2hunter3", a), false);
  assert.equal(await verifyPassword("hunter2hunter2", "garbage"), false);
});

test("반복 횟수가 Workers 한계(10만)를 넘는 해시는 거부한다", async () => {
  // 런타임이 거부하는 값이므로 검증 단계에서 미리 걸러야 한다
  assert.equal(await verifyPassword("x", "pbkdf2$210000$AAAA$AAAA"), false);
  assert.equal(await verifyPassword("x", "pbkdf2$99x100000$AAAA$AAAA"), false);
});

test("단일 라운드 레거시 포맷도 계속 검증된다", async () => {
  // pbkdf2$<반복>$... 형태 (x 없음)
  const salt = new Uint8Array(16);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("pw"), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 50000, hash: "SHA-256" }, key, 256,
  );
  const stored = `pbkdf2$50000$${Buffer.from(salt).toString("base64")}$${Buffer.from(bits).toString("base64")}`;
  assert.equal(await verifyPassword("pw", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
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

test("서비스 계정 값은 따옴표/base64 로 감싸여 있어도 읽힌다", async () => {
  const { normalizeServiceAccount } = await import("../src/firestore.ts");
  const plain = '{"client_email":"a@b.com","private_key":"k"}';
  assert.equal(normalizeServiceAccount(plain), plain);
  assert.equal(normalizeServiceAccount(`  ${plain}  `), plain);
  assert.equal(normalizeServiceAccount(`'${plain}'`), plain);
  assert.equal(normalizeServiceAccount(`"${plain}"`), plain);
  assert.equal(normalizeServiceAccount(Buffer.from(plain).toString("base64")), plain);
  // 이스케이프된 개행이 살아있어야 PEM 이 깨지지 않는다
  const withPem = '{"private_key":"-----BEGIN-----\\nabc\\n-----END-----\\n"}';
  assert.equal(JSON.parse(normalizeServiceAccount(`'${withPem}'`)).private_key.includes("\n"), true);
});

test("문서 ID 는 도착 시각 순으로 정렬된다", async () => {
  const { makeMessageId } = await import("../src/mail.ts");
  const early = makeMessageId(new Date("2026-08-24T04:30:00.123Z"));
  const later = makeMessageId(new Date("2026-08-24T04:30:00.124Z"));
  const muchLater = makeMessageId(new Date("2026-12-01T00:00:00.000Z"));

  assert.ok(early < later, `${early} < ${later}`);
  assert.ok(later < muchLater, `${later} < ${muchLater}`);
  // 고정 폭이어야 사전순 비교가 시각순과 일치한다
  assert.equal(early.split("_")[0].length, muchLater.split("_")[0].length);
  assert.match(early, /^\d{8}T\d{9}_[0-9a-f]{8}$/);

  // 같은 시각이라도 ID 가 충돌하지 않아야 한다
  const d = new Date("2026-08-24T04:30:00.000Z");
  assert.notEqual(makeMessageId(d), makeMessageId(d));
});

test("파생 키는 폴더·별표 상태를 반영한다", async () => {
  const { derivedKeys } = await import("../src/mail.ts");

  const inbox = derivedKeys({ mailbox: "a@sanghak.kr", folder: "inbox", starred: false, subjectKey: "안녕" });
  assert.equal(inbox.list_key, "a@sanghak.kr|inbox");
  assert.equal(inbox.star_key, null);
  assert.equal(inbox.star_all, false);
  assert.equal(inbox.subject_lookup, "a@sanghak.kr|안녕");

  const starred = derivedKeys({ mailbox: "a@sanghak.kr", folder: "inbox", starred: true, subjectKey: "x" });
  assert.equal(starred.star_key, "a@sanghak.kr|starred");
  assert.equal(starred.star_all, true);

  // 휴지통에 있으면 중요 목록에서 빠져야 한다
  const trashed = derivedKeys({ mailbox: "a@sanghak.kr", folder: "trash", starred: true, subjectKey: "x" });
  assert.equal(trashed.list_key, "a@sanghak.kr|trash");
  assert.equal(trashed.star_key, null);
  assert.equal(trashed.star_all, false);
});

test("Firestore 예약 ID 는 미리 거부한다", async () => {
  const { validateDocId } = await import("../src/validate.ts");
  assert.equal(validateDocId("admin"), null);
  assert.equal(validateDocId("hello@sanghak.kr"), null);
  assert.ok(validateDocId("__verify__"));
  assert.ok(validateDocId(""));
  assert.ok(validateDocId("a/b"));
  assert.ok(validateDocId("."));
  assert.ok(validateDocId(".."));
  assert.ok(validateDocId("x".repeat(1501)));
});

test("발송 어댑터는 provider 설정에 따라 경로를 고른다", async () => {
  const { sendMail, SendError } = await import("../src/sender.ts");

  // resend 경로: API 키가 없으면 설정 오류를 던진다
  await assert.rejects(
    () => sendMail({ MAIL_PROVIDER: "resend" }, {
      from: "a@sanghak.kr", to: ["b@example.com"], subject: "s", text: "t",
    }),
    (err) => err instanceof SendError && err.code === "E_CONFIG_MISSING",
  );

  // 알 수 없는 provider
  await assert.rejects(
    () => sendMail({ MAIL_PROVIDER: "nope" }, {
      from: "a@sanghak.kr", to: ["b@example.com"], subject: "s", text: "t",
    }),
    (err) => err instanceof SendError && err.code === "E_CONFIG_INVALID",
  );

  // cloudflare 경로: 바인딩 오류를 SendError 로 감싼다
  const failingBinding = {
    send: () => Promise.reject(Object.assign(new Error("nope"), { code: "E_RECIPIENT_NOT_ALLOWED" })),
  };
  await assert.rejects(
    () => sendMail({ EMAIL: failingBinding }, {
      from: "a@sanghak.kr", to: ["b@example.com"], subject: "s", text: "t",
    }),
    (err) =>
      err instanceof SendError &&
      err.code === "E_RECIPIENT_NOT_ALLOWED" &&
      err.provider === "cloudflare",
  );
});

test("Resend 요청은 이름을 포함한 from 형식으로 보낸다", async () => {
  const { sendMail } = await import("../src/sender.ts");
  const origFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body), auth: opts.headers.authorization };
    return Promise.resolve(new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
  };
  try {
    const result = await sendMail(
      { MAIL_PROVIDER: "resend", RESEND_API_KEY: "test-key" },
      {
        from: "hello@sanghak.kr",
        fromName: "배상학",
        to: ["a@example.com"],
        cc: ["b@example.com"],
        subject: "제목",
        text: "본문",
        html: "<p>본문</p>",
        headers: { "In-Reply-To": "<x@y>" },
      },
    );
    assert.equal(result.provider, "resend");
    assert.equal(result.id, "re_123");
    assert.equal(captured.url, "https://api.resend.com/emails");
    assert.equal(captured.auth, "Bearer test-key");
    assert.equal(captured.body.from, "배상학 <hello@sanghak.kr>");
    assert.deepEqual(captured.body.to, ["a@example.com"]);
    assert.deepEqual(captured.body.cc, ["b@example.com"]);
    assert.equal(captured.body.headers["In-Reply-To"], "<x@y>");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Resend 오류 응답은 SendError 로 변환된다", async () => {
  const { sendMail, SendError } = await import("../src/sender.ts");
  const origFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ statusCode: 403, name: "validation_error", message: "도메인 미인증" }),
        { status: 403 },
      ),
    );
  try {
    await assert.rejects(
      () => sendMail({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "k" }, {
        from: "a@sanghak.kr", to: ["b@example.com"], subject: "s", text: "t",
      }),
      (err) =>
        err instanceof SendError && err.code === "validation_error" && err.provider === "resend",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("auto 는 RESEND_API_KEY 유무로 경로를 정한다", async () => {
  const { resolveProvider } = await import("../src/sender.ts");
  assert.equal(resolveProvider({}), "cloudflare");
  assert.equal(resolveProvider({ RESEND_API_KEY: "k" }), "resend");
  assert.equal(resolveProvider({ MAIL_PROVIDER: "auto" }), "cloudflare");
  assert.equal(resolveProvider({ MAIL_PROVIDER: "auto", RESEND_API_KEY: "k" }), "resend");
  // 명시 설정이 auto 판단을 이긴다
  assert.equal(resolveProvider({ MAIL_PROVIDER: "cloudflare", RESEND_API_KEY: "k" }), "cloudflare");
  assert.equal(resolveProvider({ MAIL_PROVIDER: "resend" }), "resend");
});
