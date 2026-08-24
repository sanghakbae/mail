/** Firestore 문서를 직접 확인하는 진단 스크립트. 사용법: node scripts/inspect.mjs <서비스계정.json> */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const sa = JSON.parse(readFileSync(process.argv[2], "utf8"));
const b64 = (b) => Buffer.from(b).toString("base64url");

const now = Math.floor(Date.now() / 1000);
const input = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({
  iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
  aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
}))}`;
const signer = createSign("RSA-SHA256"); signer.update(input);
const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64(signer.sign(sa.private_key))}` }),
});
const { access_token } = await res.json();
const BASE = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
const H = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };

// 1) messages 컬렉션 나열
const list = await (await fetch(`${BASE}/messages?pageSize=5`, { headers: H })).json();
console.log("=== messages 문서 수:", (list.documents ?? []).length);
for (const d of list.documents ?? []) {
  const f = d.fields ?? {};
  const g = (k) => JSON.stringify(f[k] && Object.values(f[k])[0]);
  console.log("  id:", d.name.split("/").pop());
  console.log("     folder:", g("folder"), "list_key:", g("list_key"), "star_all:", g("star_all"));
  console.log("     mailbox:", g("mailbox"), "subject:", g("subject"));
}

// 2) 같은 쿼리를 그대로 실행
for (const q of [
  { label: 'folder == "inbox" + __name__ DESC', body: { structuredQuery: {
      from: [{ collectionId: "messages" }],
      where: { fieldFilter: { field: { fieldPath: "folder" }, op: "EQUAL", value: { stringValue: "inbox" } } },
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "DESCENDING" }], limit: 10 } } },
  { label: 'folder == "inbox" (정렬 없음)', body: { structuredQuery: {
      from: [{ collectionId: "messages" }],
      where: { fieldFilter: { field: { fieldPath: "folder" }, op: "EQUAL", value: { stringValue: "inbox" } } },
      limit: 10 } } },
  { label: '정렬만 __name__ DESC', body: { structuredQuery: {
      from: [{ collectionId: "messages" }],
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "DESCENDING" }], limit: 10 } } },
]) {
  const r = await fetch(`${BASE}:runQuery`, { method: "POST", headers: H, body: JSON.stringify(q.body) });
  const text = await r.text();
  let n = "?";
  try { n = JSON.parse(text).filter((x) => x.document).length; } catch { n = "파싱실패"; }
  console.log(`=== ${q.label} → ${r.status}, 결과 ${n}건`);
  if (!r.ok) console.log("   ", text.replace(/\s+/g, " ").slice(0, 200));
}
