/** 메일함 주소를 목록에서 제거. 사용법: node scripts/delete-mailbox.mjs <서비스계정.json> <주소> */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
const sa = JSON.parse(readFileSync(process.argv[2], "utf8"));
const address = process.argv[3];
if (!address) { console.error("주소를 지정해야 한다"); process.exit(1); }
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
const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/mailboxes/${encodeURIComponent(address)}`;
const res = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${access_token}` } });
console.log(res.ok ? `삭제됨: mailboxes/${address}` : `실패 (${res.status}): ${await res.text()}`);
