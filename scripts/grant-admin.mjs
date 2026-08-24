/** 계정 목록 확인 및 관리자 권한 부여. 사용법: node scripts/grant-admin.mjs <서비스계정.json> [아이디] */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const sa = JSON.parse(readFileSync(process.argv[2], "utf8"));
const target = process.argv[3];
const b64 = (b) => Buffer.from(b).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const input = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({
  iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
  aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
}))}`;
const signer = createSign("RSA-SHA256"); signer.update(input);
const { access_token } = await (await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64(signer.sign(sa.private_key))}` }),
})).json();

const BASE = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
const H = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };

const list = await (await fetch(`${BASE}/users?pageSize=50`, { headers: H })).json();
const users = (list.documents ?? []).map((d) => ({
  id: d.name.split("/").pop(),
  is_admin: d.fields?.is_admin?.booleanValue ?? false,
  display_name: d.fields?.display_name?.stringValue ?? "",
}));
console.log("계정 목록:");
for (const u of users) console.log(`  ${u.id}  (${u.display_name})  관리자: ${u.is_admin}`);

const ids = target ? [target] : users.filter((u) => !u.is_admin).map((u) => u.id);
for (const id of ids) {
  const res = await fetch(
    `${BASE}/users/${encodeURIComponent(id)}?updateMask.fieldPaths=is_admin`,
    { method: "PATCH", headers: H, body: JSON.stringify({ fields: { is_admin: { booleanValue: true } } }) },
  );
  console.log(res.ok ? `관리자 권한 부여: ${id}` : `실패 ${id}: ${await res.text()}`);
}
