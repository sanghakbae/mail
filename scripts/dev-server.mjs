/**
 * 개발용 정적 서버.
 *
 * python -m http.server 는 캐시 헤더를 주지 않아 브라우저가 예전 app.js/style.css 를
 * 계속 쓴다. 수정해도 화면이 안 바뀌어 디버깅이 헛돌기 때문에 no-store 로 못 박는다.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../site/", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  try {
    // 쿼리스트링(?v=dev)을 떼고, 상위 경로 탈출을 막는다
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    let file = join(ROOT, safe === "/" ? "index.html" : safe);

    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = join(file, "index.html");

    let body = await readFile(file);

    // index.html 의 ?v=dev 를 매 요청마다 새 값으로 바꿔, 브라우저가 예전
    // app.js/style.css 를 재사용하지 못하게 한다. (no-store 만으로는
    // 이미 캐시된 자산이 계속 쓰이는 경우가 있다)
    if (file.endsWith(".html")) {
      body = Buffer.from(String(body).replaceAll("?v=dev", `?v=${Date.now()}`));
    }

    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      // 개발 중에는 절대 캐시하지 않는다
      "cache-control": "no-store, must-revalidate",
      pragma: "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("찾을 수 없습니다");
  }
}).listen(PORT, () => {
  console.log(`웹메일 UI → http://localhost:${PORT} (캐시 없음)`);
});
