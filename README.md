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
| `src/sender.ts` | 발송 어댑터 (Cloudflare 바인딩 / Resend REST) |
| `src/validate.ts` | 입력 검증 (Firestore 예약 ID 등) |
| `site/` | 의존성 없는 단일 파일 웹메일 SPA |
| `scripts/` | 운영 스크립트 (계정 관리, 진단). `COLLECTION_PREFIX` 를 인식한다 |

## 설정 순서

### 1. Firebase (Firestore)

프로젝트: **`mail-b5391`** (`wrangler.jsonc` 에 이미 설정되어 있다)

1. Firebase 콘솔에서 **Firestore Database** 를 생성한다 (Native 모드).
2. **프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성** 으로 JSON 키를 받는다.
   웹 SDK 설정(`apiKey`, `appId` 등)으로는 안 된다 — 그건 브라우저용 공개 설정이라
   서버에서 Firestore 에 관리자 권한으로 접근할 수 없다.

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
npm run dev:ui   # UI   → http://localhost:8080
```

`config.js` 가 접속 호스트를 보고 API 주소를 고른다 — localhost 면 `http://localhost:8787`,
그 외에는 배포된 Worker. 따로 열어야 하는 개발용 HTML 은 없다.

> 로컬에서 프로덕션 API 로 로그인하면 세션이 유지되지 않는다.
> 프로덕션은 쿠키를 `Domain=sanghak.kr; Secure` 로 내려주는데, `http://localhost` 에서는
> 브라우저가 그 쿠키를 거부한다. 그래서 위처럼 자동으로 갈라준다.

### 개발 데이터 분리

`.dev.vars` 의 `COLLECTION_PREFIX="dev_"` 로 개발환경은 `dev_users`, `dev_messages` 등
별도 컬렉션을 쓴다. 같은 Firebase 프로젝트를 쓰지만 운영 데이터와 섞이지 않는다.
(Firestore 데이터베이스를 새로 만들 권한이 없어도 되는 방식)

개발환경은 계정이 비어 있으므로 처음에 하나 만들어야 한다:

```bash
curl -X POST http://localhost:8787/api/setup \
  -H "x-setup-token: dev-setup-token" \
  -H 'content-type: application/json' \
  -d '{"id":"dev","password":"devdevdev"}'
```

```bash
npm test         # 인증·파싱·변환 단위 테스트
npm run typecheck
```

## 발송 경로

Cloudflare Email Sending 은 도메인이 온보딩되기 전까지 **샌드박스**로 동작한다.
Email Routing 에 검증된 목적지 주소로만 보낼 수 있고, 그 외에는
`E_RECIPIENT_NOT_ALLOWED: destination address is not a verified address` 가 난다.

그래서 발송 경로를 교체할 수 있게 분리했다 (`src/sender.ts`).

| `MAIL_PROVIDER` | 동작 |
| --- | --- |
| `auto` (기본) | `RESEND_API_KEY` 시크릿이 있으면 Resend, 없으면 Cloudflare 바인딩 |
| `resend` | 항상 Resend REST API |
| `cloudflare` | 항상 send_email 바인딩 |

### Resend 로 전환하기

1. [resend.com](https://resend.com) 에 가입하고 **Domains → Add Domain** 으로
   `sanghak.kr` 을 추가한다.
2. Resend 가 알려주는 DNS 레코드(SPF TXT, DKIM CNAME/TXT)를 Cloudflare DNS 에 넣는다.
   기존 수신용 MX·SPF 는 건드리지 않는다 — 발송용 레코드만 추가한다.
3. API 키를 발급받아 시크릿으로 등록한다:
   ```bash
   wrangler secret put RESEND_API_KEY
   ```
4. 끝. `MAIL_PROVIDER=auto` 이므로 키가 등록되는 순간 전환된다 (재배포 불필요).

관리자 → 시스템 탭에서 현재 어느 경로가 쓰이는지 확인할 수 있다.

### 임시 방편 (플랜 변경 없이)

특정 주소로만 보내면 되는 경우, 그 주소를 Email Routing 목적지로 등록하면
Cloudflare 경로로도 발송된다. 등록하면 해당 주소로 인증 메일이 가고,
링크를 클릭해야 활성화된다.

```bash
wrangler email routing addresses create someone@example.com
wrangler email routing addresses list
```

## 보안 설계

- 비밀번호는 PBKDF2-SHA256 으로만 저장한다. Workers 런타임이 반복 10만 회를 상한으로
  두기 때문에, 10만 회를 6라운드 연쇄해 권장 작업량(60만 회 상당)을 맞춘다.
- 세션은 HMAC 서명 쿠키다. 사용자 문서의 `token_version` 을 함께 서명하므로,
  비밀번호가 바뀌면 다른 기기에 남아 있던 세션이 모두 끊긴다.
- 계정마다 쓸 수 있는 주소를 지정할 수 있고(`addresses`), 이 권한은 **보내기뿐 아니라
  읽기에도** 적용된다. 목록·본문·첨부·원본·스레드 모두 권한 밖 메일함은 걸러낸다.
- 발신자가 보낸 HTML 은 `sandbox` iframe 안에서만 렌더링한다.
  `allow-scripts` 와 `allow-same-origin` 은 주지 않으므로 스크립트가 실행되지 않고
  부모 문서에 접근할 수도 없다. `allow-popups` 만 열어 본문의 링크가 새 탭으로
  열리게 한다. 폼 전송(`allow-forms`)은 막아둔다 — 본문 안에서 정보를 입력받는
  피싱을 차단하기 위해서다.
- 본문은 `color-scheme: light` 로 고정한 문서로 감싼다. 부모의 `light dark` 가
  상속되면 다크모드에서 본문 기본 글자색이 흰색이 되어, 흰 배경 위 글씨가 사라진다.
- 답장·전달 시 인용문에서는 `style`/`script` 와 이벤트 핸들러를 제거한다.

## 알려진 제약

- **Cloudflare 경로로는 검증된 주소로만 발송된다.** 도메인 온보딩(`wrangler email sending enable`)이
  Free 플랜에서 `Unauthorized (2036)` 로 막힌다. 아무 주소로나 보내려면 Workers 유료 플랜으로
  온보딩하거나, 위 "발송 경로" 절대로 Resend 를 쓴다. 수신은 Free 플랜에서도 정상이다.
- **검색은 전문 검색이 아니다.** Firestore 에 전문 색인이 없어, 최근 500 건을 가져와
  메모리에서 걸러낸다. 메일이 많아지면 외부 검색 색인이 필요하다.
- **IMAP/SMTP 클라이언트로는 접속할 수 없다.** 브라우저 웹메일 전용이다.
- **목록은 한 번에 200건까지** 불러온다. 그보다 많으면 검색으로 좁혀야 한다.
- 관리자 통계는 Firestore 집계 쿼리(COUNT/SUM)를 쓴다. 주소별 건수는 주소마다
  한 번씩 세므로, 주소가 아주 많아지면 느려질 수 있다.
- 자동 새로고침은 60초 간격이며, 탭이 보이고 작성/선택 중이 아닐 때만 동작한다.
- **첨부파일 발송 한도**: 파일당 10MB, 합계 20MB, 최대 10개.
- HTML 본문은 스크립트를 막은 `sandbox` iframe 안에서만 렌더링한다.
