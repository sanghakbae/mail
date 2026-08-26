/** 계정 삭제. 사용법: node scripts/delete-user.mjs <서비스계정.json> <아이디> */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const sa = JSON.parse(readFileSync(process.argv[2], "utf8"));
const userId = process.argv[3];
if (!userId) { console.error("아이디를 지정해야 한다"); process.exit(1); }

const b64 = (b) => Buffer.from(b).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const input = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({
  iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
  aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
}))}`;
const signer = createSign("RSA-SHA256"); signer.update(input);
const tok = await (await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64(signer.sign(sa.private_key))}` }),
})).json();

const PREFIX = process.env.COLLECTION_PREFIX ?? "";
const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${PREFIX}users/${encodeURIComponent(userId)}`;
const res = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${tok.access_token}` } });
console.log(res.ok ? `삭제됨: users/${userId}` : `실패 (${res.status}): ${await res.text()}`);
