// 웹메일 UI 가 호출할 API 주소.
// UI 는 GitHub Pages(mail.sanghak.kr), API 는 Cloudflare Worker(mail-api.sanghak.kr) 에 있다.
window.MAIL_CONFIG = {
  apiBase: "https://mail-api.sanghak.kr",
  domain: "sanghak.kr",
};
