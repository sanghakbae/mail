/** 삭제 후 잔존물 점검. 사용법: node scripts/check-orphans.mjs <서비스계정.json> <메일주소> */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
const sa = JSON.parse(readFileSync(process.argv[2], "utf8"));
const mailbox = process.argv[3];
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

for (const coll of ["messages", "attachments"]) {
  const r = await fetch(`${BASE}:runQuery`, { method: "POST", headers: H, body: JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: coll }],
      where: { fieldFilter: { field: { fieldPath: "mailbox" }, op: "EQUAL", value: { stringValue: mailbox } } },
      limit: 20,
    },
  })});
  const rows = (await r.json()).filter((x) => x.document);
  console.log(`  ${coll}: ${rows.length}건 남음`);
}
