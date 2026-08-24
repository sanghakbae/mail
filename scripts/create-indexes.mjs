/**
 * Firestore 복합 색인을 한 번에 생성한다.
 *
 * 사용법:
 *   node scripts/create-indexes.mjs <서비스계정.json>
 *
 * 이미 있는 색인은 ALREADY_EXISTS 로 건너뛴다 (여러 번 실행해도 안전하다).
 */

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const saPath = process.argv[2];
if (!saPath) {
  console.error("사용법: node scripts/create-indexes.mjs <서비스계정.json>");
  process.exit(1);
}

const sa = JSON.parse(readFileSync(saPath, "utf8"));
const PROJECT = sa.project_id;
const DATABASE = "(default)";

const ASC = "ASCENDING";
const DESC = "DESCENDING";

/** 컬렉션별 필요한 복합 색인. 등호 필터 필드가 앞, 정렬 필드가 뒤에 온다. */
const INDEXES = [
  // --- messages: 메일함을 지정한 폴더별 조회 ---
  ["messages", [["mailbox", ASC], ["direction", ASC], ["is_trashed", ASC], ["is_spam", ASC], ["received_at", DESC]]],
  ["messages", [["mailbox", ASC], ["direction", ASC], ["is_trashed", ASC], ["received_at", DESC]]],
  ["messages", [["mailbox", ASC], ["is_starred", ASC], ["is_trashed", ASC], ["received_at", DESC]]],
  ["messages", [["mailbox", ASC], ["is_spam", ASC], ["is_trashed", ASC], ["received_at", DESC]]],
  ["messages", [["mailbox", ASC], ["is_trashed", ASC], ["received_at", DESC]]],

  // --- messages: 전체 주소 조회 (mailbox 필터 없음) ---
  ["messages", [["direction", ASC], ["is_trashed", ASC], ["is_spam", ASC], ["received_at", DESC]]],
  ["messages", [["direction", ASC], ["is_trashed", ASC], ["received_at", DESC]]],
  ["messages", [["is_starred", ASC], ["is_trashed", ASC], ["received_at", DESC]]],
  ["messages", [["is_spam", ASC], ["is_trashed", ASC], ["received_at", DESC]]],
  ["messages", [["is_trashed", ASC], ["received_at", DESC]]],

  // --- messages: 스레드 묶기 ---
  ["messages", [["thread_id", ASC], ["received_at", ASC]]],
  ["messages", [["mailbox", ASC], ["subject_key", ASC], ["received_at", DESC]]],
];

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const sig = base64url(signer.sign(sa.private_key));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패 (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

const token = await getAccessToken();
console.log(`프로젝트 ${PROJECT} · 색인 ${INDEXES.length}개 확인\n`);

let created = 0;
let existing = 0;
let failed = 0;

for (const [collection, fields] of INDEXES) {
  const label = `${collection}(${fields.map(([f, d]) => `${f}${d === DESC ? "↓" : ""}`).join(", ")})`;
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}` +
    `/databases/${encodeURIComponent(DATABASE)}/collectionGroups/${collection}/indexes`;

  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      queryScope: "COLLECTION",
      fields: fields.map(([fieldPath, order]) => ({ fieldPath, order })),
    }),
  });

  if (res.ok) {
    created++;
    console.log(`  생성  ${label}`);
  } else {
    const text = await res.text();
    if (text.includes("ALREADY_EXISTS") || res.status === 409) {
      existing++;
      console.log(`  기존  ${label}`);
    } else {
      failed++;
      console.log(`  실패  ${label}\n        ${text.replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
}

console.log(`\n생성 ${created} · 기존 ${existing} · 실패 ${failed}`);
console.log("색인 빌드에는 보통 1~3분 걸린다 (그 사이 조회는 계속 실패할 수 있다).");
if (failed) process.exit(1);
