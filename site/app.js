/* sanghak.kr 웹메일 — 의존성 없는 단일 파일 SPA */

const CFG = window.MAIL_CONFIG || { apiBase: "", domain: "sanghak.kr" };

const state = {
  me: null,
  folder: "inbox",
  mailbox: "", // 빈 문자열 = 전체 주소
  query: "",
  messages: [],
  selectedId: null,
  mailboxes: [],
};

const FOLDERS = [
  { key: "inbox", label: "받은 메일" },
  { key: "sent", label: "보낸 메일" },
  { key: "starred", label: "중요" },
  { key: "spam", label: "스팸" },
  { key: "trash", label: "휴지통" },
];

const $ = (sel) => document.querySelector(sel);

/* ---------- 유틸 ---------- */

function api(path, options = {}) {
  return fetch(CFG.apiBase + path, {
    ...options,
    credentials: "include", // 세션 쿠키를 크로스 서브도메인으로 보낸다
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  }).then(async (res) => {
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`서버 응답을 해석할 수 없다: ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error((data && data.error) || `요청 실패 (${res.status})`);
    return data;
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString("ko-KR", {
    month: "numeric",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
}

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer = null;
function toast(message) {
  const existing = $(".toast");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

/* ---------- 로그인 ---------- */

// 비밀번호 표시 토글
$("#toggle-pw").addEventListener("click", () => {
  const input = $("#login-pw");
  const btn = $("#toggle-pw");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  btn.textContent = showing ? "보기" : "숨기기";
  btn.setAttribute("aria-label", showing ? "비밀번호 표시" : "비밀번호 숨기기");
  input.focus();
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("#login-btn");
  const errorEl = $("#login-error");
  errorEl.textContent = "";

  // 서버까지 가지 않아도 되는 입력 실수는 여기서 잡는다
  const id = $("#login-id").value.trim();
  const pw = $("#login-pw").value;
  if (!id || !pw) {
    errorEl.textContent = "아이디와 비밀번호를 모두 입력하세요.";
    (!id ? $("#login-id") : $("#login-pw")).focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = "로그인 중…";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ id, password: pw }),
    });
    $("#login-pw").value = "";
    await // 화면 폭이 바뀌면 분할/전환 모드를 다시 판단한다
window.addEventListener("resize", () => {
  if (!isNarrow()) $("#app").classList.remove("reading");
  else if (state.selectedId) $("#app").classList.add("reading");
});

boot();
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "로그인";
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  state.me = null;
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
});

/* ---------- 사이드바 ---------- */

function renderFolders() {
  const host = $("#folders");
  host.innerHTML = "";
  for (const folder of FOLDERS) {
    const btn = document.createElement("button");
    btn.className = "nav-item" + (state.folder === folder.key ? " active" : "");
    btn.innerHTML = `<span class="name">${escapeHtml(folder.label)}</span>`;
    btn.addEventListener("click", () => {
      state.folder = folder.key;
      state.selectedId = null;
      setReading(false);
      renderFolders();
      loadMessages();
    });
    host.appendChild(btn);
  }
}

function renderMailboxes() {
  const host = $("#mailboxes");
  host.innerHTML = "";

  const all = document.createElement("button");
  all.className = "nav-item" + (state.mailbox === "" ? " active" : "");
  all.innerHTML = `<span class="name">전체</span>`;
  all.addEventListener("click", () => {
    state.mailbox = "";
    state.selectedId = null;
    setReading(false);
    renderMailboxes();
    loadMessages();
  });
  host.appendChild(all);

  for (const box of state.mailboxes) {
    const btn = document.createElement("button");
    btn.className = "nav-item" + (state.mailbox === box.address ? " active" : "");
    btn.innerHTML = `<span class="name">${escapeHtml(box.label || box.address)}</span>`;
    btn.title = box.address;
    btn.addEventListener("click", () => {
      state.mailbox = box.address;
      state.selectedId = null;
      setReading(false);
      renderMailboxes();
      loadMessages();
    });
    host.appendChild(btn);
  }
}

$("#add-mailbox").addEventListener("click", async () => {
  const localPart = prompt(`추가할 주소의 @ 앞부분을 입력하세요 (@${CFG.domain})`);
  if (!localPart) return;
  const address = `${localPart.trim().toLowerCase()}@${CFG.domain}`;
  try {
    await api("/api/mailboxes", { method: "POST", body: JSON.stringify({ address }) });
    toast(`${address} 추가됨`);
    await loadMailboxes();
  } catch (error) {
    toast(error.message);
  }
});

/* ---------- 목록 ---------- */

async function loadMailboxes() {
  const data = await api("/api/mailboxes");
  state.mailboxes = data.mailboxes || [];
  renderMailboxes();
}

async function loadMessages() {
  const host = $("#list");
  host.innerHTML = `<div class="empty">불러오는 중…</div>`;
  const params = new URLSearchParams({ folder: state.folder });
  if (state.mailbox) params.set("mailbox", state.mailbox);
  if (state.query) params.set("q", state.query);

  try {
    const data = await api(`/api/messages?${params}`);
    state.messages = data.messages || [];
    renderList();
  } catch (error) {
    host.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderList() {
  const host = $("#list");
  if (!state.messages.length) {
    host.innerHTML = `<div class="empty">메일이 없습니다.</div>`;
    return;
  }
  host.innerHTML = "";
  for (const msg of state.messages) {
    const who =
      state.folder === "sent"
        ? `→ ${(msg.to_addrs || []).join(", ")}`
        : msg.from_name
          ? `${msg.from_name} <${msg.from_addr}>`
          : msg.from_addr;

    const badges = [];
    if (msg.is_starred) badges.push("★");
    if (msg.has_attachments) badges.push("첨부");
    if (!state.mailbox) badges.push(msg.mailbox);

    const row = document.createElement("button");
    row.className =
      "msg-row" +
      (msg.is_read ? "" : " unread") +
      (state.selectedId === msg.id ? " selected" : "");
    row.innerHTML = `
      <div class="top">
        <span class="who">${escapeHtml(who)}</span>
        <span class="when">${escapeHtml(formatWhen(msg.received_at))}</span>
      </div>
      <div class="subj">${escapeHtml(msg.subject)}</div>
      <div class="snip">${escapeHtml(msg.snippet)}</div>
      ${badges.length ? `<div class="badges">${escapeHtml(badges.join(" · "))}</div>` : ""}
    `;
    row.addEventListener("click", () => openMessage(msg.id));
    host.appendChild(row);
  }
}

let searchTimer = null;
$("#search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value.trim();
  searchTimer = setTimeout(() => {
    state.query = value;
    loadMessages();
  }, 300);
});

$("#refresh").addEventListener("click", () => loadMessages());

/* ---------- 읽기 ---------- */

const isNarrow = () => window.matchMedia("(max-width: 700px)").matches;

/** 좁은 화면에서는 목록과 본문을 번갈아 보여준다 */
function setReading(on) {
  $("#app").classList.toggle("reading", Boolean(on) && isNarrow());
}

async function openMessage(id) {
  state.selectedId = id;
  renderList();
  setReading(true);
  const reader = $("#reader");
  reader.innerHTML = `<div class="empty">불러오는 중…</div>`;
  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    renderMessage(data.message, data.attachments || []);
    // 읽음 처리가 서버에서 됐으니 목록도 맞춰준다
    const row = state.messages.find((m) => m.id === id);
    if (row && !row.is_read) {
      row.is_read = true;
      renderList();
    }
  } catch (error) {
    reader.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderMessage(msg, attachments) {
  const reader = $("#reader");
  const to = (msg.to_addrs || []).join(", ");
  const cc = (msg.cc_addrs || []).join(", ");

  reader.innerHTML = `
    <div class="read-head">
      <h2>${escapeHtml(msg.subject)}</h2>
      <div class="meta">
        <div><b>${escapeHtml(msg.from_name || msg.from_addr)}</b> &lt;${escapeHtml(msg.from_addr)}&gt;</div>
        <div>받는 사람: ${escapeHtml(to)}${cc ? ` · 참조: ${escapeHtml(cc)}` : ""}</div>
        <div>${escapeHtml(new Date(msg.received_at).toLocaleString("ko-KR"))} · ${escapeHtml(formatBytes(msg.size_bytes))} · ${escapeHtml(msg.mailbox)}</div>
      </div>
      <div class="actions">
        <button class="btn back-btn" id="back">← 목록</button>
        <button class="btn btn-primary" id="reply">답장</button>
        <button class="btn" id="star">${msg.is_starred ? "중요 해제" : "중요 표시"}</button>
        <button class="btn" id="trash">${msg.is_trashed ? "휴지통에서 복원" : "휴지통으로"}</button>
        <button class="btn" id="spam">${msg.is_spam ? "스팸 해제" : "스팸 신고"}</button>
        ${msg.raw_key ? `<a class="btn" href="${CFG.apiBase}/api/messages/${encodeURIComponent(msg.id)}/raw" target="_blank" rel="noopener">원본 보기</a>` : ""}
      </div>
    </div>
    <div class="read-body" id="read-body"></div>
  `;

  const body = $("#read-body");
  if (msg.body_html) {
    // 발신자가 보낸 HTML 은 신뢰할 수 없다.
    // 스크립트 실행과 폼 전송을 막은 sandbox iframe 안에서만 렌더링한다.
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = msg.body_html;
    body.appendChild(frame);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = msg.body_text || "(본문 없음)";
    body.appendChild(pre);
  }

  if (attachments.length) {
    const box = document.createElement("div");
    box.className = "attachments";
    box.innerHTML =
      `<h4>첨부파일 ${attachments.length}개</h4>` +
      attachments
        .map(
          (att) =>
            `<a href="${CFG.apiBase}/api/attachments/${encodeURIComponent(att.id)}" download>${escapeHtml(att.filename)} <span style="color:var(--muted)">${escapeHtml(formatBytes(att.size_bytes))}</span></a>`,
        )
        .join("");
    body.appendChild(box);
  }

  $("#back").addEventListener("click", () => setReading(false));
  $("#reply").addEventListener("click", () => openCompose({ replyTo: msg }));
  $("#star").addEventListener("click", () => patchMessage(msg.id, { is_starred: !msg.is_starred }));
  $("#trash").addEventListener("click", () => patchMessage(msg.id, { is_trashed: !msg.is_trashed }));
  $("#spam").addEventListener("click", () => patchMessage(msg.id, { is_spam: !msg.is_spam }));
}

async function patchMessage(id, patch) {
  try {
    await api(`/api/messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    toast("변경했습니다.");
    await loadMessages();
    if (state.selectedId === id) await openMessage(id);
  } catch (error) {
    toast(error.message);
  }
}

/* ---------- 작성 ---------- */

function openCompose({ replyTo } = {}) {
  const addresses = state.mailboxes.length
    ? state.mailboxes.map((b) => b.address)
    : [`hello@${CFG.domain}`];

  const defaultFrom = replyTo ? replyTo.mailbox : addresses[0];
  const quoted = replyTo
    ? `\n\n---\n${replyTo.from_name || replyTo.from_addr} 님이 쓴 글:\n` +
      (replyTo.body_text || replyTo.snippet || "")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    : "";

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <form class="modal" id="compose-form">
      <h3>${replyTo ? "답장 쓰기" : "새 메일 쓰기"}</h3>
      <div class="field">
        <label for="c-from">보내는 주소</label>
        <select id="c-from">
          ${addresses
            .map(
              (a) =>
                `<option value="${escapeHtml(a)}" ${a === defaultFrom ? "selected" : ""}>${escapeHtml(a)}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div class="field">
        <label for="c-to">받는 사람 (쉼표로 구분)</label>
        <input id="c-to" value="${escapeHtml(replyTo ? replyTo.from_addr : "")}" required />
      </div>
      <div class="field">
        <label for="c-cc">참조 (선택)</label>
        <input id="c-cc" />
      </div>
      <div class="field">
        <label for="c-subject">제목</label>
        <input id="c-subject" value="${escapeHtml(
          replyTo ? (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : "",
        )}" />
      </div>
      <div class="field">
        <label for="c-body">내용</label>
        <textarea id="c-body">${escapeHtml(quoted)}</textarea>
      </div>
      <p class="error" id="c-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn" id="c-cancel">취소</button>
        <button type="submit" class="btn btn-primary" id="c-send">보내기</button>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  $("#c-cancel").addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });

  $("#compose-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = $("#c-send");
    const errorEl = $("#c-error");
    errorEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "보내는 중…";
    try {
      await api("/api/send", {
        method: "POST",
        body: JSON.stringify({
          from: $("#c-from").value,
          to: $("#c-to").value,
          cc: $("#c-cc").value,
          subject: $("#c-subject").value,
          text: $("#c-body").value,
          ...(replyTo ? { reply_to_message_id: replyTo.id } : {}),
        }),
      });
      close();
      toast("보냈습니다.");
      loadMessages();
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "보내기";
    }
  });
}

$("#compose-btn").addEventListener("click", () => openCompose());

/* ---------- 부팅 ---------- */

async function boot() {
  try {
    state.me = await api("/api/me");
  } catch {
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
    return;
  }
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#who").textContent = state.me.display_name || state.me.id;
  renderFolders();
  await loadMailboxes();
  await loadMessages();
}

// 화면 폭이 바뀌면 분할/전환 모드를 다시 판단한다
window.addEventListener("resize", () => {
  if (!isNarrow()) $("#app").classList.remove("reading");
  else if (state.selectedId) $("#app").classList.add("reading");
});

boot();
