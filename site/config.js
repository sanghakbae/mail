// 웹메일 UI 가 호출할 API 주소.
//
// localhost 에서 열면 로컬 wrangler dev(8787) 를, 그 외에는 배포된 Worker 를 쓴다.
// 이렇게 자동으로 갈라주지 않으면, 로컬에서 프로덕션 API 로 로그인하게 되고
// 프로덕션이 내려주는 Domain=sanghak.kr; Secure 쿠키가 http://localhost 에서
// 거부되어 "로그인이 되지 않는" 것처럼 보인다.
(() => {
  const host = location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";

  window.MAIL_CONFIG = {
    apiBase: isLocal ? "http://localhost:8787" : "https://mail-api.sanghak.kr",
    domain: "sanghak.kr",
  };
})();
