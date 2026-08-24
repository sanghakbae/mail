/**
 * sanghak.kr 메일 시스템 — Worker 엔트리포인트 (API + 메일 수신).
 *
 *  수신: Email Routing catch-all → email() → MIME 파싱 → Firestore + R2 저장
 *  발송: /api/send → send_email 바인딩 → Firestore 의 보낸메일함 기록
 *  UI:   GitHub Pages (mail.sanghak.kr) 에서 별도로 서빙되고, 여기 API 를 호출한다
 */

import { corsHeaders, handleApi, makeDb, type Env } from "./api";
import { ingestInbound } from "./mail";

/** 응답에 CORS 헤더를 덧붙인다 (Response 는 불변이라 새로 만든다) */
function withCors(response: Response, cors: Record<string, string>): Response {
  if (!Object.keys(cors).length) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    // CORS 사전 요청
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return withCors(await handleApi(request, env), cors);
      } catch (error) {
        console.error("API 오류", error);
        const message = error instanceof Error ? error.message : String(error);
        return withCors(
          new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
          cors,
        );
      }
    }

    if (url.pathname === "/health") {
      return withCors(Response.json({ ok: true, domain: env.MAIL_DOMAIN }), cors);
    }

    // 이 Worker 는 API 전용이다. UI 는 GitHub Pages 쪽에 있다.
    return withCors(
      Response.json(
        { error: "여기는 API 전용이다. 웹메일 UI 는 https://mail.sanghak.kr 에 있다." },
        { status: 404 },
      ),
      cors,
    );
  },

  /**
   * Email Routing 이 이 Worker 로 넘긴 수신 메일.
   * 핸들러가 아무것도 하지 않고 리턴하면 메일이 버려지므로, 반드시 저장하거나 거부한다.
   */
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    // raw 는 단일 사용 스트림이다 — 먼저 한 번만 버퍼링한다
    const rawBuffer = await new Response(message.raw).arrayBuffer();

    try {
      const result = await ingestInbound(makeDb(env), env.BLOBS, {
        rawBuffer,
        envelopeFrom: message.from,
        envelopeTo: message.to,
        headers: message.headers,
      });
      console.log(
        `수신 저장: ${message.from} → ${message.to} (id=${result.messageId}, 첨부 ${result.attachmentCount}개)`,
      );
    } catch (error) {
      console.error(`수신 저장 실패 (${message.from} → ${message.to})`, error);

      // 저장이 실패해도 메일을 잃지 않도록, 검증된 주소로 넘겨둔다.
      // (Firestore 장애, 색인 문제, 파싱 실패 등에 대한 안전망)
      if (env.FALLBACK_FORWARD) {
        try {
          await message.forward(env.FALLBACK_FORWARD);
          console.warn(`안전망 포워딩: ${env.FALLBACK_FORWARD}`);
          return;
        } catch (forwardError) {
          console.error("안전망 포워딩도 실패", forwardError);
        }
      }

      // 포워딩도 못 했으면 예외를 던져 Cloudflare 가 재시도하게 한다
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
