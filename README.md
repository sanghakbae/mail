# sanghak.kr 메일 시스템

`@sanghak.kr` 의 **모든 주소로 메일을 받고**, 그 주소로 **메일을 보내는** 자체 웹메일.

- 수신: Cloudflare Email Routing catch-all → Worker `email()` 핸들러 → MIME 파싱 → Firestore + R2 저장
- 발송: 웹메일 → Worker `/api/send` → Cloudflare Email Sending 바인딩
- UI: GitHub Pages (`mail.sanghak.kr`), 아이디/비밀번호 로그인
- API: Cloudflare Worker (`mail-api.sanghak.kr`)
- DB: Firestore (메시지·메일함·계정), R2 (원본 MIME·첨부파일 바이트)

```
                     ┌──────────────────────────┐
  누군가 → MX →      │ Cloudflare Email Routing │
  *@sanghak.kr       │      (catch-all)         │
                     └────────────┬─────────────┘
                                  ↓ email()
  mail.sanghak.kr          ┌──────────────┐        ┌───────────┐
  (GitHub Pages) ─fetch──→ │    Worker    │ ─────→ │ Firestore │
   웹메일 UI               │ mail-api.sanghak.kr│        └───────────┘
                           └──────┬───────┘        ┌───────────┐
                                  ├──────────────→ │    R2     │
                                  ↓ send_email     └───────────┘
                           Cloudflare Email Sending → 외부 수신자
```

UI 와 API 는 같은 등록 도메인(`sanghak.kr`)이라 세션 쿠키를 `Domain=sanghak.kr` 로 공유한다.
CORS 는 `ALLOWED_ORIGINS` 에 등록된 출처만 허용한다.

## 구성 요소

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | Worker 엔트리포인트. `fetch()` = API, `email()` = 수신 처리 |
| `src/api.ts` | 로그인·메일함·목록·읽기·플래그·발송 REST API, CORS |
| `src/auth.ts` | PBKDF2 비밀번호 해시, HMAC 서명 세션 쿠키 |
| `src/mail.ts` | MIME 파싱, 스레드 묶기, 스니펫, 첨부 저장 |
| `src/firestore.ts` | 서비스 계정 JWT 로 Firestore REST 호출 (Worker 에서 firebase-admin 을 못 쓴다) |
| `site/` | 의존성 없는 단일 파일 웹메일 SPA |

## 설정 순서

### 1. Firebase (Firestore)

1. Firebase 콘솔에서 프로젝트를 만들고 **Firestore Database** 를 생성한다 (Native 모드).
2. **프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성** 으로 JSON 키를 받는다.
3. `wrangler.jsonc` 의 `FIREBASE_PROJECT_ID` 를 실제 프로젝트 ID 로 바꾼다.

Firestore 는 클라이언트가 직접 접근하지 않는다 (Worker 만 서비스 계정으로 접근).
따라서 보안 규칙은 전부 거부로 두는 편이 안전하다:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```

### 2. Firestore 복합 색인

메시지 목록은 `mailbox` / `direction` / 플래그 + `received_at DESC` 로 정렬한다.
Firestore 는 이런 조합에 복합 색인을 요구한다. 첫 호출 때 응답에 색인 생성 링크가
포함되므로 그 링크로 만들면 된다. 미리 만들려면 `messages` 컬렉션에 대해:

- `mailbox ASC, direction ASC, is_trashed ASC, is_spam ASC, received_at DESC`
- `mailbox ASC, direction ASC, is_trashed ASC, received_at DESC`
- `mailbox ASC, is_starred ASC, is_trashed ASC, received_at DESC`
- `mailbox ASC, is_trashed ASC, received_at DESC`
- `thread_id ASC, received_at ASC`
- `message_id ASC`

(`mailbox` 없이 전체 조회도 하므로 `mailbox` 를 뺀 같은 조합도 필요하다.)

### 3. Cloudflare 시크릿

```bash
wrangler secret put GCP_SERVICE_ACCOUNT   # 서비스 계정 JSON 전체를 붙여넣는다
wrangler secret put SESSION_SECRET        # openssl rand -hex 32
wrangler secret put SETUP_TOKEN           # 최초 계정 생성용, 쓰고 나면 지운다
```

### 4. R2 버킷

```bash
wrangler r2 bucket create sanghak-mail-blobs
```

### 5. 배포

```bash
wrangler deploy
```

`mail-api.sanghak.kr` 커스텀 도메인이 자동으로 붙는다.

### 6. 최초 관리자 계정 만들기

```bash
curl -X POST https://mail-api.sanghak.kr/api/setup \
  -H "x-setup-token: $SETUP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"admin","password":"충분히-긴-비밀번호","display_name":"배상학"}'
```

끝나면 `SETUP_TOKEN` 시크릿을 삭제한다: `wrangler secret delete SETUP_TOKEN`

### 7. 수신 메일을 Worker 로 넘기기

지금은 catch-all 이 개인 Gmail 로 포워딩되고 있다. 웹메일에 쌓이게 하려면:

```bash
# catch-all 을 Worker 로 변경
wrangler email routing rules catch-all update --worker sanghak-mail
```

또는 대시보드 → Email Routing → Catch-all 에서 동작을 **Worker** 로 바꾼다.

> 순서 주의: **6번(계정 생성)과 Firestore 설정이 끝난 뒤에** 바꿔야 한다.
> Firestore 가 준비되지 않은 상태에서 넘기면 수신 저장이 실패한다.

### 8. GitHub Pages + DNS

1. 이 레포의 **Settings → Pages → Source** 를 **GitHub Actions** 로 설정한다.
2. Cloudflare DNS 에 CNAME 을 추가한다:
   `mail` → `sanghakbae.github.io` (**프록시 끄기 / DNS only** — GitHub 이 직접 인증서를 발급해야 한다)
3. Settings → Pages 에서 커스텀 도메인 `mail.sanghak.kr` 을 확인하고 **Enforce HTTPS** 를 켠다.

### 9. DMARC (권장)

현재 SPF 는 있지만 DMARC 레코드가 없다. TXT 레코드를 추가한다:

```
_dmarc.sanghak.kr  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@sanghak.kr"
```

운영이 안정되면 `p=quarantine` → `p=reject` 로 조인다.

## 로컬 개발

```bash
npm install
npm run dev      # API  → http://localhost:8787
npm run dev:ui   # UI   → http://localhost:8080/index.dev.html
```

`.dev.vars` 에 `FIREBASE_PROJECT_ID` 와 `GCP_SERVICE_ACCOUNT` 를 채워야 로그인이 된다.
`index.dev.html` 은 `config.dev.js`(localhost:8787) 를 쓰고, 배포에서는 제외된다.

```bash
npm test         # 인증·파싱·변환 단위 테스트
npm run typecheck
```

## 알려진 제약

- **발송에는 Workers 유료 플랜이 필요하다.** Cloudflare Email Sending 은 유료 플랜 전용이라,
  Free 플랜에서는 `wrangler email sending enable` 이 `Unauthorized (2036)` 로 실패한다.
  수신은 Free 플랜에서도 동작한다.
- **검색은 전문 검색이 아니다.** Firestore 에 전문 색인이 없어, 최근 500 건을 가져와
  메모리에서 걸러낸다. 메일이 많아지면 외부 검색 색인이 필요하다.
- **IMAP/SMTP 클라이언트로는 접속할 수 없다.** 브라우저 웹메일 전용이다.
- **첨부파일 발송은 아직 UI 에 없다.** API 레벨에서는 Email Sending 이 지원한다.
- HTML 본문은 스크립트를 막은 `sandbox` iframe 안에서만 렌더링한다.
