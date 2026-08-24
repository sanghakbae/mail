/* sanghak.kr 웹메일 — 의존성 없는 단일 파일 SPA */

const CFG = window.MAIL_CONFIG || { apiBase: "", domain: "sanghak.kr" };

const FOLDERS = [
  { key: "inbox", label: "받은 메일" },
  { key: "sent", label: "보낸 메일" },
  { key: "starred", label: "중요" },
  { key: "spam", label: "스팸" },
  { key: "trash", label: "휴지통" },
];

const state = {
  me: null,
  folder: "inbox",
  mailbox: "",
  query: "",
  messages: [],
  selectedId: null,
  checked: new Set(),
  mailboxes: [],
  sendableAddresses: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ================= 유틸 ================= */

async function api(path, options = {}) {
  const res = await fetch(CFG.apiBase + path, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`서버 응답을 해석할 수 없다: ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) throw new Error((data && data.error) || `요청 실패 (${res.status})`);
  return data;
}

function esc(value) {
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
  if (date.toDateString() === now.toDateString()) {
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
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 주소를 색으로 — 같은 사람은 항상 같은 색이 된다 */
const AVATAR_COLORS = [
  "#c2510a", "#1f6f4a", "#2b5f9e", "#7a3ea1", "#a12f52",
  "#0f6d78", "#8a5a12", "#3b5bab", "#6b4a9e", "#9c3b2e",
];
function avatarFor(addr, name) {
  let hash = 0;
  for (const ch of String(addr || "?")) hash = (hash * 31 + ch.charCodeAt(0)) % 100000;
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  const source = (name || addr || "?").trim();
  const initial = source ? source[0].toUpperCase() : "?";
  return { color, initial };
}

let toastTimer = null;
function toast(message) {
  $(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

const isNarrow = () => window.matchMedia("(max-width: 700px)").matches;
const hasDrawer = () => window.matchMedia("(max-width: 1000px)").matches;

function setReading(on) {
  const app = $("#app");
  app.classList.toggle("reading", Boolean(on) && isNarrow());
  // 넓은 화면에서는 읽기 창 자체를 열고 닫아 빈 영역이 폭을 차지하지 않게 한다
  app.classList.toggle("has-msg", Boolean(on));
  if (!on) {
    state.selectedId = null;
    $("#reader").innerHTML = `
      <div class="empty">
        <p>읽을 메일을 선택하세요.</p>
        <p class="hint">j / k 로 이동, Enter 로 열기, e 읽음, s 중요, # 휴지통</p>
      </div>`;
  }
}

function setDrawer(open) {
  $("#app").classList.toggle("drawer-open", Boolean(open));
  $("#scrim").hidden = !open;
}


/* ---------- 확인 / 입력 모달 ----------
 * 브라우저 기본 confirm()/prompt() 는 인앱 브라우저나 웹뷰에서 차단되어
 * 아무 일도 일어나지 않는다. 그래서 직접 만든 모달로 대체한다.
 */

function dialog({ title, message, fields = [], confirmLabel = "확인", danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.style.zIndex = "70";
    backdrop.innerHTML = `
      <form class="modal modal-sm" id="dlg-form">
        <div class="modal-head"><h3>${esc(title)}</h3></div>
        ${message ? `<p class="dlg-msg">${esc(message)}</p>` : ""}
        ${fields
          .map(
            (f, i) => `<div class="field">
              ${f.label ? `<label for="dlg-f${i}">${esc(f.label)}</label>` : ""}
              <input id="dlg-f${i}" value="${esc(f.value ?? "")}"
                     placeholder="${esc(f.placeholder ?? "")}" ${i === 0 ? "autofocus" : ""} />
            </div>`,
          )
          .join("")}
        <div class="modal-actions">
          <button type="button" class="btn" id="dlg-cancel">취소</button>
          <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${esc(confirmLabel)}</button>
        </div>
      </form>
    `;
    document.body.appendChild(backdrop);

    const done = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") done(null);
    };
    document.addEventListener("keydown", onKey);

    backdrop.querySelector("#dlg-cancel").addEventListener("click", () => done(null));
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) done(null);
    });
    backdrop.querySelector("#dlg-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!fields.length) return done(true);
      const values = fields.map((_, i) => backdrop.querySelector(`#dlg-f${i}`).value.trim());
      done(values);
    });
    backdrop.querySelector("#dlg-f0")?.focus();
  });
}

const confirmDialog = (title, message, confirmLabel = "삭제") =>
  dialog({ title, message, confirmLabel, danger: true });

/* ================= 로그인 ================= */

$("#toggle-pw").addEventListener("click", () => {
  const input = $("#login-pw");
  const btn = $("#toggle-pw");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  btn.textContent = showing ? "보기" : "숨기기";
  input.focus();
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const btn = $("#login-btn");
  const errorEl = $("#login-error");
  errorEl.textContent = "";

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
    await api("/api/login", { method: "POST", body: JSON.stringify({ id, password: pw }) });
    $("#login-pw").value = "";
    await boot();
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

/* ================= 사이드바 ================= */

$("#menu-btn").addEventListener("click", () => setDrawer(true));
$("#drawer-close").addEventListener("click", () => setDrawer(false));
$("#scrim").addEventListener("click", () => setDrawer(false));

function renderFolders() {
  const host = $("#folders");
  host.innerHTML = "";
  for (const folder of FOLDERS) {
    const btn = document.createElement("button");
    btn.className = "nav-item" + (state.folder === folder.key ? " active" : "");
    btn.innerHTML = `<span class="name">${esc(folder.label)}</span>`;
    btn.addEventListener("click", () => {
      state.folder = folder.key;
      state.selectedId = null;
      state.checked.clear();
      setReading(false);
      setDrawer(false);
      renderFolders();
      loadMessages();
    });
    host.appendChild(btn);
  }
}

function renderMailboxes() {
  const host = $("#mailboxes");
  host.innerHTML = "";

  const pick = (address) => {
    state.mailbox = address;
    state.selectedId = null;
    state.checked.clear();
    setReading(false);
    setDrawer(false);
    renderMailboxes();
    loadMessages();
  };

  const all = document.createElement("button");
  all.className = "nav-item" + (state.mailbox === "" ? " active" : "");
  all.innerHTML = `<span class="name">모든 주소</span>`;
  all.title = `${CFG.domain} 의 모든 주소`;
  all.addEventListener("click", () => pick(""));
  host.appendChild(all);

  if (!state.mailboxes.length) {
    const hint = document.createElement("div");
    hint.className = "nav-hint";
    hint.textContent = "등록한 주소가 없습니다";
    host.appendChild(hint);
  }

  for (const box of state.mailboxes) {
    const localPart = String(box.address).split("@")[0];
    const btn = document.createElement("button");
    btn.className = "nav-item" + (state.mailbox === box.address ? " active" : "");
    // 로그인 계정과 헷갈리지 않게 전체 주소를 그대로 보여준다
    btn.title = box.address;
    btn.innerHTML =
      `<span class="name">${esc(localPart)}<span class="addr-domain">@${esc(CFG.domain)}</span></span>`;
    btn.addEventListener("click", () => pick(box.address));
    host.appendChild(btn);
  }
}

$("#add-mailbox").addEventListener("click", async () => {
  const answer = await dialog({
    title: "메일 주소 추가",
    message: `@${CFG.domain} 앞에 올 이름을 입력하세요.`,
    fields: [{ label: "주소", placeholder: `예: contact` }],
    confirmLabel: "추가",
  });
  const localPart = answer?.[0];
  if (!localPart) return;
  try {
    const address = `${localPart.toLowerCase()}@${CFG.domain}`;
    await api("/api/mailboxes", { method: "POST", body: JSON.stringify({ address }) });
    toast(`${address} 추가됨`);
    await loadMailboxes();
  } catch (error) {
    toast(error.message);
  }
});

/* ================= 목록 ================= */

async function loadMailboxes() {
  // 사이드바용 — 직접 등록한 주소만
  state.mailboxes = (await api("/api/mailboxes")).mailboxes || [];
  // 보내는 주소 후보 — 자동 등록된 주소도 포함해야 그 주소로 답장할 수 있다
  state.sendableAddresses = (await api("/api/mailboxes?include_auto=1")).mailboxes || [];
  renderMailboxes();
}

async function loadMessages() {
  const host = $("#list");
  host.innerHTML = `<div class="empty">불러오는 중…</div>`;
  const params = new URLSearchParams({ folder: state.folder, limit: "200" });
  if (state.mailbox) params.set("mailbox", state.mailbox);
  if (state.query) params.set("q", state.query);

  try {
    state.messages = (await api(`/api/messages?${params}`)).messages || [];
    state.checked.clear();
    renderList();
  } catch (error) {
    host.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

/** 폴더별 일괄 처리 버튼. 휴지통에서는 영구 삭제와 복원을 보여준다. */
function bulkActionsFor(folder) {
  if (folder === "trash") {
    return [
      { key: "restore", label: "복원" },
      { key: "delete", label: "영구 삭제", danger: true },
    ];
  }
  const actions = [
    { key: "read", label: "읽음" },
    { key: "star", label: "중요" },
  ];
  if (folder !== "spam") actions.push({ key: "spam", label: "스팸" });
  else actions.push({ key: "unspam", label: "스팸 해제" });
  actions.push({ key: "trash", label: "휴지통" });
  return actions;
}

function renderBulkbar() {
  const bar = $("#bulkbar");
  const n = state.checked.size;
  bar.hidden = n === 0;
  if (!n) return;

  $("#bulk-count").textContent = `${n}개 선택`;
  $("#check-all").checked = n === state.messages.length;

  const host = $("#bulk-actions");
  host.innerHTML = "";
  for (const action of bulkActionsFor(state.folder)) {
    const btn = document.createElement("button");
    btn.className = "btn btn-sm" + (action.danger ? " btn-danger" : "");
    btn.textContent = action.label;
    btn.addEventListener("click", () => runBulk(action, btn));
    host.appendChild(btn);
  }
}

/** 선택한 메일에 일괄 작업을 적용한다 */
async function runBulk(action, btn) {
  const ids = Array.from(state.checked);
  if (!ids.length) return;

  if (action.key === "delete") {
    const ok = await confirmDialog(
      "영구 삭제",
      `${ids.length}개 메일을 완전히 삭제합니다. 첨부파일과 원본까지 지워지고 되돌릴 수 없습니다.`,
      "영구 삭제",
    );
    if (!ok) return;
  }

  const patch =
    action.key === "read" ? { is_read: true }
    : action.key === "star" ? { is_starred: true }
    : action.key === "spam" ? { is_spam: true }
    : action.key === "unspam" ? { is_spam: false }
    : action.key === "restore" ? { is_trashed: false }
    : action.key === "trash" ? { is_trashed: true }
    : null;

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "처리 중…";
  try {
    // 실패한 건을 따로 세서 부분 실패를 숨기지 않는다
    const results = await Promise.allSettled(
      ids.map((id) =>
        action.key === "delete"
          ? api(`/api/messages/${encodeURIComponent(id)}`, { method: "DELETE" })
          : api(`/api/messages/${encodeURIComponent(id)}`, {
              method: "PATCH",
              body: JSON.stringify(patch),
            }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) {
      toast(`${ids.length - failed.length}개 처리, ${failed.length}개 실패: ${failed[0].reason.message}`);
    } else {
      toast(`${ids.length}개 ${action.key === "delete" ? "삭제했습니다" : "처리했습니다"}.`);
    }

    // 보고 있던 메일이 사라졌으면 읽기 창을 닫는다
    if (state.selectedId && ids.includes(state.selectedId)) setReading(false);
    state.checked.clear();
    await loadMessages();
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderListHeader() {
  const folder = FOLDERS.find((f) => f.key === state.folder);
  $("#list-title").textContent = folder ? folder.label : state.folder;
  const scope = state.mailbox || "전체 주소";
  const unread = state.messages.filter((m) => !m.is_read).length;
  $("#list-sub").textContent =
    `${scope} · ${state.messages.length}개` + (unread ? ` · 안 읽음 ${unread}` : "");
}

function renderList() {
  const host = $("#list");
  renderBulkbar();
  renderListHeader();

  if (!state.messages.length) {
    host.innerHTML = `<div class="empty">메일이 없습니다.</div>`;
    return;
  }

  host.innerHTML = "";
  for (const msg of state.messages) {
    const sent = state.folder === "sent" || msg.direction === "out";
    const whoAddr = sent ? (msg.to_addrs || [])[0] || "" : msg.from_addr;
    const whoName = sent ? (msg.to_addrs || []).join(", ") : msg.from_name || msg.from_addr;
    const { color, initial } = avatarFor(whoAddr, sent ? whoAddr : msg.from_name);

    const tags = [];
    if (msg.is_starred) tags.push(`<span class="tag star">★ 중요</span>`);
    if (msg.has_attachments) tags.push(`<span class="tag">첨부</span>`);
    if (!state.mailbox) tags.push(`<span class="tag">${esc(msg.mailbox)}</span>`);

    const row = document.createElement("div");
    row.className =
      "msg-row" +
      (msg.is_read ? "" : " unread") +
      (state.selectedId === msg.id ? " selected" : "") +
      (state.checked.has(msg.id) ? " checked" : "");
    row.tabIndex = 0;
    row.dataset.id = msg.id;
    row.innerHTML = `
      <label class="check"><input type="checkbox" ${state.checked.has(msg.id) ? "checked" : ""} /></label>
      <span class="avatar" style="background:${color}">${esc(initial)}</span>
      <div class="msg-main">
        <div class="msg-line1">
          <span class="msg-who">${sent ? "→ " : ""}${esc(whoName)}</span>
          <span class="msg-when">${esc(formatWhen(msg.received_at))}</span>
        </div>
        <div class="msg-subject">${esc(msg.subject)}</div>
        <div class="msg-snippet">${esc(msg.snippet)}</div>
        ${tags.length ? `<div class="msg-tags">${tags.join("")}</div>` : ""}
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-act="star" title="중요">${msg.is_starred ? "★" : "☆"}</button>
        <button class="icon-btn" data-act="read" title="${msg.is_read ? "읽지 않음" : "읽음"}">${msg.is_read ? "◌" : "●"}</button>
        <button class="icon-btn" data-act="trash" title="휴지통">🗑</button>
      </div>
    `;

    row.querySelector(".check input").addEventListener("change", (event) => {
      event.stopPropagation();
      if (event.target.checked) state.checked.add(msg.id);
      else state.checked.delete(msg.id);
      row.classList.toggle("checked", event.target.checked);
      renderBulkbar();
    });
    row.querySelector(".check").addEventListener("click", (e) => e.stopPropagation());

    for (const btn of row.querySelectorAll(".row-actions .icon-btn")) {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const act = btn.dataset.act;
        if (act === "star") patchMessage(msg.id, { is_starred: !msg.is_starred });
        if (act === "read") patchMessage(msg.id, { is_read: !msg.is_read });
        if (act === "trash") patchMessage(msg.id, { is_trashed: !msg.is_trashed });
      });
    }

    row.addEventListener("click", () => openMessage(msg.id));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") openMessage(msg.id);
    });
    host.appendChild(row);
  }
}

$("#check-all").addEventListener("change", (event) => {
  if (event.target.checked) for (const m of state.messages) state.checked.add(m.id);
  else state.checked.clear();
  renderList();
});

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

/* ================= 읽기 ================= */

async function openMessage(id) {
  state.selectedId = id;
  renderList();
  setReading(true);

  const reader = $("#reader");
  reader.innerHTML = `<div class="empty">불러오는 중…</div>`;
  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    renderMessage(data.message, data.attachments || []);
    const row = state.messages.find((m) => m.id === id);
    if (row && !row.is_read) {
      row.is_read = true;
      renderList();
    }
  } catch (error) {
    reader.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function renderMessage(msg, attachments) {
  const { color, initial } = avatarFor(msg.from_addr, msg.from_name);
  const to = (msg.to_addrs || []).join(", ");
  const cc = (msg.cc_addrs || []).join(", ");

  $("#reader").innerHTML = `
    <div class="read-head">
      <div class="read-top">
        <button class="icon-btn drawer-only" id="back" aria-label="목록으로">←</button>
        <h2>${esc(msg.subject)}</h2>
      </div>

      <div class="read-from">
        <span class="avatar" style="background:${color}">${esc(initial)}</span>
        <div class="read-from-text">
          <div class="read-from-name">
            ${esc(msg.from_name || msg.from_addr)}
            <span class="read-from-addr">${esc(msg.from_addr)}</span>
          </div>
          <div class="meta">
            ${to ? `→ ${esc(to)}` : ""}${cc ? ` · 참조 ${esc(cc)}` : ""}
            · ${esc(new Date(msg.received_at).toLocaleString("ko-KR", {
              year: "2-digit", month: "numeric", day: "numeric",
              hour: "2-digit", minute: "2-digit",
            }))}
          </div>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" id="reply">답장</button>
        <button class="btn btn-sm" id="star">${msg.is_starred ? "중요 해제" : "중요"}</button>
        <button class="btn btn-sm" id="trash">${msg.is_trashed ? "복원" : "휴지통"}</button>
        <button class="btn btn-sm" id="spam">${msg.is_spam ? "스팸 해제" : "스팸"}</button>
        ${msg.is_trashed ? `<button class="btn btn-sm btn-danger" id="purge">영구 삭제</button>` : ""}
        ${msg.raw_key ? `<a class="btn btn-sm" href="${CFG.apiBase}/api/messages/${encodeURIComponent(msg.id)}/raw" target="_blank" rel="noopener">원본</a>` : ""}
      </div>
    </div>
    <div class="read-body" id="read-body"></div>
  `;

  const body = $("#read-body");
  if (msg.body_html) {
    // 발신자가 보낸 HTML 은 신뢰할 수 없다. 스크립트를 막은 sandbox iframe 안에서만 렌더링한다.
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
          (a) =>
            `<a href="${CFG.apiBase}/api/attachments/${encodeURIComponent(a.id)}" download>` +
            `${esc(a.filename)} <span class="size">${esc(formatBytes(a.size_bytes))}</span></a>`,
        )
        .join("");
    body.appendChild(box);
  }

  $("#back")?.addEventListener("click", () => setReading(false));
  $("#reply").addEventListener("click", () => openCompose({ replyTo: msg }));
  $("#star").addEventListener("click", () => patchMessage(msg.id, { is_starred: !msg.is_starred }));
  $("#trash").addEventListener("click", () => patchMessage(msg.id, { is_trashed: !msg.is_trashed }));
  $("#spam").addEventListener("click", () => patchMessage(msg.id, { is_spam: !msg.is_spam }));
  $("#purge")?.addEventListener("click", async () => {
    const ok = await confirmDialog(
      "영구 삭제",
      `"${msg.subject}" 을 완전히 삭제합니다. 첨부파일과 원본까지 지워지고 되돌릴 수 없습니다.`,
      "영구 삭제",
    );
    if (!ok) return;
    try {
      await api(`/api/messages/${encodeURIComponent(msg.id)}`, { method: "DELETE" });
      toast("삭제했습니다.");
      setReading(false);
      await loadMessages();
    } catch (error) {
      toast(error.message);
    }
  });
}

async function patchMessage(id, patch) {
  try {
    await api(`/api/messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await loadMessages();
    if (state.selectedId === id && !$("#app").classList.contains("reading")) {
      // 목록에서 사라졌으면 본문도 비운다
      if (!state.messages.some((m) => m.id === id)) {
        setReading(false);
      } else {
        await openMessage(id);
      }
    }
  } catch (error) {
    toast(error.message);
  }
}

/* ================= 작성 (리치 에디터) ================= */

const TOOLS = [
  { cmd: "bold", label: "B", title: "굵게", style: "font-weight:700" },
  { cmd: "italic", label: "I", title: "기울임", style: "font-style:italic" },
  { cmd: "underline", label: "U", title: "밑줄", style: "text-decoration:underline" },
  { cmd: "strikeThrough", label: "S", title: "취소선", style: "text-decoration:line-through" },
  { sep: true },
  { cmd: "insertUnorderedList", label: "•", title: "글머리 기호" },
  { cmd: "insertOrderedList", label: "1.", title: "번호 목록" },
  { cmd: "formatBlock:blockquote", label: "❝", title: "인용" },
  { sep: true },
  { cmd: "createLink", label: "🔗", title: "링크" },
  { cmd: "removeFormat", label: "✕", title: "서식 지우기" },
];

async function execTool(cmd) {
  if (cmd === "createLink") {
    // 선택 영역을 잃지 않도록 미리 저장해 둔다
    const sel = window.getSelection();
    const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const answer = await dialog({
      title: "링크 삽입",
      fields: [{ label: "주소", value: "https://" }],
      confirmLabel: "삽입",
    });
    const url = answer?.[0];
    if (!url) return;
    if (saved) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
    document.execCommand("createLink", false, url);
    return;
  }
  if (cmd.startsWith("formatBlock:")) {
    document.execCommand("formatBlock", false, cmd.split(":")[1]);
    return;
  }
  document.execCommand(cmd, false);
}

/**
 * 인용할 HTML 에서 위험하거나 본문이 아닌 요소를 걷어낸다.
 *
 * 특히 <style> 은 textContent 로 읽으면 CSS 규칙이 본문에 섞여 들어간다.
 * (예: "p{margin-top:0px}" 이 메일 내용으로 보이던 버그)
 */
function sanitizeQuoted(html) {
  const box = document.createElement("div");
  box.innerHTML = html;
  for (const el of box.querySelectorAll("style, script, meta, link, title, head, noscript")) {
    el.remove();
  }
  // 이벤트 핸들러와 javascript: 링크 제거
  for (const el of box.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return box.innerHTML;
}

/** 에디터 DOM 을 평문으로 — HTML 만 보는 클라이언트가 없도록 text 도 함께 보낸다 */
function editorToText(el) {
  const clone = el.cloneNode(true);
  // style/script 의 textContent 가 본문으로 새어 들어가지 않게 먼저 지운다
  for (const junk of clone.querySelectorAll("style, script, noscript")) junk.remove();
  for (const br of clone.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of clone.querySelectorAll("p, div, li, blockquote, tr")) {
    block.append("\n");
  }
  return (clone.textContent || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function openCompose({ replyTo } = {}) {
  const pool = state.sendableAddresses?.length ? state.sendableAddresses : state.mailboxes;
  const addresses = pool.length ? pool.map((b) => b.address) : [`hello@${CFG.domain}`];
  const defaultFrom = replyTo ? replyTo.mailbox : addresses[0];

  const quoted = replyTo
    ? `<br><br><div>--- ${esc(replyTo.from_name || replyTo.from_addr)} 님이 쓴 글 ---</div>` +
      `<blockquote>${
        replyTo.body_html
          ? sanitizeQuoted(replyTo.body_html)
          : esc(replyTo.body_text || replyTo.snippet || "").replace(/\n/g, "<br>")
      }</blockquote>`
    : "";

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <form class="modal modal-compose" id="compose-form">
      <div class="modal-head">
        <h3>${replyTo ? "답장 쓰기" : "새 메일 쓰기"}</h3>
        <button type="button" class="icon-btn" id="c-close" aria-label="닫기">✕</button>
      </div>

      <div class="compose-main">
        <div class="compose-head">
          <div class="field">
            <label for="c-from">보내는 주소</label>
            <select id="c-from">
              ${addresses
                .map((a) => `<option value="${esc(a)}" ${a === defaultFrom ? "selected" : ""}>${esc(a)}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label for="c-to">받는 사람 (쉼표로 구분)</label>
            <input id="c-to" value="${esc(replyTo ? replyTo.from_addr : "")}" inputmode="email" />
          </div>
          <div class="field">
            <label for="c-cc">참조 (선택)</label>
            <input id="c-cc" inputmode="email" />
          </div>
          <div class="field">
            <label for="c-subject">제목</label>
            <input id="c-subject" value="${esc(
              replyTo ? (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : "",
            )}" />
          </div>
        </div>

        <div class="field field-body">
          <label>내용</label>
          <div class="editor-toolbar" id="c-toolbar">
            ${TOOLS.map((t) =>
              t.sep
                ? `<span class="tool-sep"></span>`
                : `<button type="button" class="tool" data-cmd="${t.cmd}" title="${esc(t.title)}"
                     ${t.style ? `style="${t.style}"` : ""}>${t.label}</button>`,
            ).join("")}
          </div>
          <div class="editor" id="c-body" contenteditable="true"
               data-placeholder="내용을 입력하세요">${quoted}</div>
        </div>
      </div>

      <p class="error" id="c-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn" id="c-cancel">취소</button>
        <button type="submit" class="btn btn-primary" id="c-send">보내기</button>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  $("#c-cancel").addEventListener("click", close);
  $("#c-close").addEventListener("click", close);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });

  // 툴바
  const editor = $("#c-body");
  for (const btn of backdrop.querySelectorAll(".tool")) {
    // mousedown 을 막아 에디터의 선택 영역을 잃지 않게 한다
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", async () => {
      editor.focus();
      await execTool(btn.dataset.cmd);
      syncToolState();
    });
  }
  function syncToolState() {
    for (const btn of backdrop.querySelectorAll(".tool")) {
      const cmd = btn.dataset.cmd;
      if (!cmd || cmd.includes(":") || cmd === "createLink" || cmd === "removeFormat") continue;
      try {
        btn.classList.toggle("on", document.queryCommandState(cmd));
      } catch {
        /* 지원하지 않는 명령은 무시한다 */
      }
    }
  }
  editor.addEventListener("keyup", syncToolState);
  editor.addEventListener("mouseup", syncToolState);

  // 답장이면 인용문 위에 커서를 둔다
  editor.focus();
  if (replyTo) {
    const range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  $("#compose-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = $("#c-send");
    const errorEl = $("#c-error");
    errorEl.textContent = "";

    const to = $("#c-to").value.trim();
    if (!to) {
      errorEl.textContent = "받는 사람을 입력하세요.";
      return;
    }
    const html = editor.innerHTML.trim();
    const text = editorToText(editor);
    if (!text && !html) {
      errorEl.textContent = "내용을 입력하세요.";
      return;
    }

    btn.disabled = true;
    btn.textContent = "보내는 중…";
    try {
      await api("/api/send", {
        method: "POST",
        body: JSON.stringify({
          from: $("#c-from").value,
          to,
          cc: $("#c-cc").value,
          subject: $("#c-subject").value,
          text,
          html,
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
$("#fab-compose").addEventListener("click", () => openCompose());

/* ================= 키보드 단축키 ================= */

function moveSelection(delta) {
  if (!state.messages.length) return;
  const index = state.messages.findIndex((m) => m.id === state.selectedId);
  const next = Math.max(0, Math.min(state.messages.length - 1, (index < 0 ? -1 : index) + delta));
  const target = state.messages[next];
  state.selectedId = target.id;
  renderList();
  const row = $(`.msg-row[data-id="${CSS.escape(target.id)}"]`);
  row?.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (event) => {
  if (!state.me) return;
  if ($(".modal-backdrop")) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const selected = state.messages.find((m) => m.id === state.selectedId);

  switch (event.key) {
    case "j": moveSelection(1); break;
    case "k": moveSelection(-1); break;
    case "Enter": if (selected) openMessage(selected.id); break;
    case "c": event.preventDefault(); openCompose(); break;
    case "/": event.preventDefault(); $("#search").focus(); break;
    case "e": if (selected) patchMessage(selected.id, { is_read: true }); break;
    case "s": if (selected) patchMessage(selected.id, { is_starred: !selected.is_starred }); break;
    case "#": if (selected) patchMessage(selected.id, { is_trashed: !selected.is_trashed }); break;
    case "Escape": setReading(false); setDrawer(false); break;
    default: return;
  }
});

/* ================= 관리자 ================= */

$("#open-admin").addEventListener("click", () => {
  setDrawer(false);
  location.hash = "#admin";
});

/** #admin 으로 직접 들어올 수 있게 해시를 라우트로 쓴다 */
function syncHashRoute() {
  const wantAdmin = location.hash.replace(/^#\/?/, "") === "admin";
  const open = document.getElementById("admin-modal");
  if (wantAdmin && !open) {
    if (!state.me) return; // 로그인 후 boot() 에서 다시 확인한다
    if (!state.me.is_admin) {
      toast("관리자 권한이 없습니다.");
      history.replaceState(null, "", location.pathname + location.search);
      return;
    }
    openAdmin();
  } else if (!wantAdmin && open) {
    open.remove();
  }
}

window.addEventListener("hashchange", syncHashRoute);

function openAdmin() {
  const backdrop = document.createElement("div");
  backdrop.id = "admin-modal";
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal modal-admin">
      <div class="modal-head">
        <h3>관리자</h3>
        <button class="icon-btn" id="admin-x" aria-label="닫기">✕</button>
      </div>
      <div class="admin-tabs">
        <button class="admin-tab on" data-tab="users">계정</button>
        <button class="admin-tab" data-tab="addresses">메일 주소</button>
        <button class="admin-tab" data-tab="stats">통계</button>
        <button class="admin-tab" data-tab="system">시스템</button>
      </div>
      <div id="admin-body"><div class="empty">불러오는 중…</div></div>
      <div class="modal-actions">
        <button class="btn" id="admin-close">닫기</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.remove();
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  };
  $("#admin-close").addEventListener("click", close);
  $("#admin-x").addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });

  for (const tab of backdrop.querySelectorAll(".admin-tab")) {
    tab.addEventListener("click", () => {
      for (const t of backdrop.querySelectorAll(".admin-tab")) t.classList.remove("on");
      tab.classList.add("on");
      renderAdminTab(tab.dataset.tab);
    });
  }
  renderAdminTab("users");
}

async function renderAdminTab(tab) {
  const host = $("#admin-body");
  host.innerHTML = `<div class="empty">불러오는 중…</div>`;
  try {
    if (tab === "users") await renderAdminUsers(host);
    else if (tab === "addresses") await renderAdminAddresses(host);
    else if (tab === "stats") await renderAdminStats(host);
    else await renderAdminSystem(host);
  } catch (error) {
    host.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function renderAdminUsers(host) {
  const { users } = await api("/api/admin/users");
  host.innerHTML = `
    <div class="note">계정을 추가하면 그 사람이 웹메일에 로그인할 수 있습니다.
      쓸 수 있는 주소를 <code>*</code> 로 두면 sanghak.kr 의 모든 주소로 보낼 수 있습니다.</div>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr><th>아이디</th><th>이름</th><th>보낼 수 있는 주소</th><th>관리자</th><th>생성</th><th></th></tr></thead>
        <tbody>
          ${users
            .map(
              (u) => `<tr>
                <td><b>${esc(u.id)}</b></td>
                <td>${esc(u.display_name || "")}</td>
                <td>${esc((u.addresses || ["*"]).join(", "))}</td>
                <td>${u.is_admin ? "예" : "—"}</td>
                <td>${esc((u.created_at || "").slice(0, 10))}</td>
                <td>
                  <button class="btn btn-sm" data-edit="${esc(u.id)}">수정</button>
                  ${u.id === state.me.id ? "" : `<button class="btn btn-sm btn-danger" data-del="${esc(u.id)}">삭제</button>`}
                </td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <div class="modal-actions" style="justify-content:flex-start">
      <button class="btn btn-primary" id="admin-add-user">계정 추가</button>
      <button class="btn" id="admin-my-pw">내 비밀번호 변경</button>
    </div>
  `;

  $("#admin-add-user").addEventListener("click", () => userForm(null));
  $("#admin-my-pw").addEventListener("click", passwordForm);
  for (const btn of host.querySelectorAll("[data-edit]")) {
    btn.addEventListener("click", () =>
      userForm(users.find((u) => u.id === btn.dataset.edit)),
    );
  }
  for (const btn of host.querySelectorAll("[data-del]")) {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.del;
      const ok = await confirmDialog(
        "계정 삭제",
        `계정 "${id}" 을 삭제합니다. 되돌릴 수 없습니다.`,
      );
      if (!ok) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast(`${id} 삭제됨`);
        renderAdminTab("users");
      } catch (error) {
        toast(error.message);
      }
    });
  }
}

function userForm(user) {
  const editing = Boolean(user);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.style.zIndex = "60";
  backdrop.innerHTML = `
    <form class="modal modal-md" id="user-form">
      <h3>${editing ? `계정 수정 — ${esc(user.id)}` : "계정 추가"}</h3>
      ${
        editing
          ? ""
          : `<div class="field"><label for="u-id">아이디</label><input id="u-id" required /></div>`
      }
      <div class="field">
        <label for="u-name">표시 이름</label>
        <input id="u-name" value="${esc(user?.display_name || "")}" />
      </div>
      <div class="field">
        <label for="u-addr">보낼 수 있는 주소 (쉼표로 구분, * 는 전체)</label>
        <input id="u-addr" value="${esc((user?.addresses || ["*"]).join(", "))}" />
      </div>
      <div class="field">
        <label for="u-pw">${editing ? "새 비밀번호 (비워두면 유지)" : "비밀번호 (8자 이상)"}</label>
        <input id="u-pw" type="password" autocomplete="new-password" />
      </div>
      <div class="field">
        <label><input type="checkbox" id="u-admin" ${user?.is_admin ? "checked" : ""} /> 관리자 권한</label>
      </div>
      <p class="error" id="u-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn" id="u-cancel">취소</button>
        <button type="submit" class="btn btn-primary">저장</button>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $("#u-cancel").addEventListener("click", close);

  $("#user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = $("#u-error");
    errorEl.textContent = "";
    const addresses = $("#u-addr").value
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const payload = {
      display_name: $("#u-name").value.trim(),
      addresses: addresses.length ? addresses : ["*"],
      is_admin: $("#u-admin").checked,
    };
    const pw = $("#u-pw").value;
    if (pw) payload.password = pw;

    try {
      if (editing) {
        await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        const id = $("#u-id").value.trim();
        if (!id) throw new Error("아이디를 입력하세요.");
        if (!pw) throw new Error("비밀번호를 입력하세요.");
        await api("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({ ...payload, id, password: pw }),
        });
      }
      close();
      toast("저장했습니다.");
      renderAdminTab("users");
    } catch (error) {
      errorEl.textContent = error.message;
    }
  });
}

function passwordForm() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.style.zIndex = "60";
  backdrop.innerHTML = `
    <form class="modal modal-md" id="pw-form">
      <h3>내 비밀번호 변경</h3>
      <div class="field"><label for="p-cur">현재 비밀번호</label>
        <input id="p-cur" type="password" autocomplete="current-password" required /></div>
      <div class="field"><label for="p-new">새 비밀번호 (8자 이상)</label>
        <input id="p-new" type="password" autocomplete="new-password" required /></div>
      <p class="error" id="p-error"></p>
      <div class="modal-actions">
        <button type="button" class="btn" id="p-cancel">취소</button>
        <button type="submit" class="btn btn-primary">변경</button>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $("#p-cancel").addEventListener("click", close);

  $("#pw-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = $("#p-error");
    errorEl.textContent = "";
    try {
      await api("/api/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: $("#p-cur").value,
          new_password: $("#p-new").value,
        }),
      });
      close();
      toast("비밀번호를 변경했습니다.");
    } catch (error) {
      errorEl.textContent = error.message;
    }
  });
}

async function renderAdminAddresses(host) {
  const { mailboxes } = await api("/api/mailboxes?include_auto=1");
  host.innerHTML = `
    <div class="note">catch-all 이 Worker 로 연결되어 있으므로, 여기에 없는 주소로 온 메일도
      수신되고 자동으로 목록에 추가됩니다. 미리 등록하면 보내는 주소로 고를 수 있습니다.</div>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr><th>주소</th><th>표시 이름</th><th>자동 생성</th><th>생성</th><th></th></tr></thead>
        <tbody>
          ${
            mailboxes.length
              ? mailboxes
                  .map(
                    (m) => `<tr>
                      <td><b>${esc(m.address)}</b></td>
                      <td>${esc(m.label || "")}</td>
                      <td>${m.auto_created ? "예" : "—"}</td>
                      <td>${esc((m.created_at || "").slice(0, 10))}</td>
                      <td><button class="btn btn-sm btn-danger" data-del-addr="${esc(m.address)}">삭제</button></td>
                    </tr>`,
                  )
                  .join("")
              : `<tr><td colspan="5">등록된 주소가 없습니다.</td></tr>`
          }
        </tbody>
      </table>
    </div>
    <div class="modal-actions" style="justify-content:flex-start">
      <button class="btn btn-primary" id="admin-add-addr">주소 추가</button>
    </div>
  `;

  $("#admin-add-addr").addEventListener("click", async () => {
    const answer = await dialog({
      title: "메일 주소 추가",
      message: `@${CFG.domain} 앞에 올 이름을 입력하세요.`,
      fields: [{ label: "주소", placeholder: "예: contact" }],
      confirmLabel: "추가",
    });
    const localPart = answer?.[0];
    if (!localPart) return;
    try {
      await api("/api/mailboxes", {
        method: "POST",
        body: JSON.stringify({ address: `${localPart.toLowerCase()}@${CFG.domain}` }),
      });
      toast("추가했습니다.");
      await loadMailboxes();
      renderAdminTab("addresses");
    } catch (error) {
      toast(error.message);
    }
  });

  for (const btn of host.querySelectorAll("[data-del-addr]")) {
    btn.addEventListener("click", async () => {
      const address = btn.dataset.delAddr;
      const ok = await confirmDialog(
        "메일 주소 삭제",
        `${address} 을 목록에서 지웁니다. 이미 받은 메일은 그대로 남습니다.`,
      );
      if (!ok) return;
      try {
        await api(`/api/mailboxes/${encodeURIComponent(address)}`, { method: "DELETE" });
        toast("삭제했습니다.");
        await loadMailboxes();
        renderAdminTab("addresses");
      } catch (error) {
        toast(error.message);
      }
    });
  }
}

async function renderAdminStats(host) {
  const s = await api("/api/admin/stats");
  host.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="k">전체 메일</div><div class="v">${s.total}</div></div>
      <div class="stat"><div class="k">받은 메일</div><div class="v">${s.inbox}</div></div>
      <div class="stat"><div class="k">보낸 메일</div><div class="v">${s.sent}</div></div>
      <div class="stat"><div class="k">안 읽음</div><div class="v">${s.unread}</div></div>
      <div class="stat"><div class="k">스팸</div><div class="v">${s.spam}</div></div>
      <div class="stat"><div class="k">휴지통</div><div class="v">${s.trash}</div></div>
      <div class="stat"><div class="k">첨부파일</div><div class="v">${s.attachments}</div></div>
      <div class="stat"><div class="k">첨부 용량</div><div class="v">${formatBytes(s.attachment_bytes)}</div></div>
    </div>
    <h4 style="margin:22px 0 8px;font-size:13px">주소별</h4>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr><th>주소</th><th>전체</th><th>안 읽음</th></tr></thead>
        <tbody>
          ${
            s.per_mailbox.length
              ? s.per_mailbox
                  .map((m) => `<tr><td><b>${esc(m.mailbox)}</b></td><td>${m.total}</td><td>${m.unread}</td></tr>`)
                  .join("")
              : `<tr><td colspan="3">데이터가 없습니다.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

async function renderAdminSystem(host) {
  const s = await api("/api/admin/system");
  const yn = (v) => (v ? "정상" : "미설정");
  host.innerHTML = `
    <div class="table-wrap">
      <table class="grid">
        <tbody>
          <tr><th>메일 도메인</th><td>${esc(s.mail_domain)}</td></tr>
          <tr><th>API 호스트</th><td>${esc(s.api_host)}</td></tr>
          <tr><th>Firestore 프로젝트</th><td>${esc(s.firebase_project)}</td></tr>
          <tr><th>발송 경로</th><td>${esc(s.mail_provider)}${
            s.mail_provider === "resend"
              ? ` · API 키 ${s.resend_key ? "정상" : "미설정"}`
              : " · 검증된 주소로만 발송 가능 (샌드박스)"
          }</td></tr>
          <tr><th>발송 바인딩</th><td>${yn(s.send_binding)}</td></tr>
          <tr><th>첨부 저장소 (R2)</th><td>${yn(s.r2_binding)}</td></tr>
          <tr><th>세션 시크릿</th><td>${yn(s.session_secret)}</td></tr>
          <tr><th>최초 설정 토큰</th><td>${s.setup_token ? "남아 있음 (삭제 권장)" : "삭제됨"}</td></tr>
          <tr><th>수신 실패 안전망</th><td>${esc(s.fallback_forward || "없음")}</td></tr>
          <tr><th>허용 출처</th><td>${esc((s.allowed_origins || []).join(", "))}</td></tr>
        </tbody>
      </table>
    </div>
    ${
      s.setup_token
        ? `<div class="note" style="margin-top:14px">최초 계정을 만든 뒤에는
             <code>wrangler secret delete SETUP_TOKEN</code> 으로 지우는 것이 안전합니다.</div>`
        : ""
    }
  `;
}

/* ================= 부팅 ================= */

window.addEventListener("resize", () => {
  if (!isNarrow()) $("#app").classList.remove("reading");
  else if (state.selectedId) $("#app").classList.add("reading");
  if (!hasDrawer()) setDrawer(false);
});

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
  $("#who").textContent = `${state.me.display_name || state.me.id} (${state.me.id})`;
  $("#open-admin").classList.toggle("hidden", !state.me.is_admin);
  renderFolders();
  await loadMailboxes();
  await loadMessages();
  syncHashRoute();
}

boot();
