(function () {
  // Token: explicit ?token= wins, then the token the server injects into the page
  // (Teleclaude embedded server; undefined under aglink-chat → harmless), then
  // previously stored. Keeps the page authenticated regardless of stale
  // localStorage or which loopback host was opened.
  const params = new URLSearchParams(location.search);
  let token = params.get("token") || window.__TC_TOKEN__ || localStorage.getItem("tc_token") || "";
  if (token) localStorage.setItem("tc_token", token);

  const log = document.getElementById("log");
  const statusEl = document.getElementById("status");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const fileEl = document.getElementById("file");
  const fileNameEl = document.getElementById("file-name");
  const attachBtn = document.getElementById("attach-btn");
  const topicList = document.getElementById("topic-list");
  const currentTopic = document.getElementById("current-topic");
  const currentProject = document.getElementById("current-project");
  const currentTitle = document.getElementById("current-title");
  const currentId = document.getElementById("current-id");
  const refreshTopics = document.getElementById("refresh-topics");
  const newChat = document.getElementById("new-chat");
  const shell = document.getElementById("shell");
  const toggleSidebar = document.getElementById("toggle-sidebar");
  const workingEl = document.getElementById("working");
  const workingLabel = document.getElementById("working-label");
  // Composer (floating button → modal).
  const composerFab = document.getElementById("compose-fab");
  const composerOverlay = document.getElementById("composer-overlay");
  const composerClose = document.getElementById("composer-close");
  // Admin surface (Teleclaude embedded only; shown after capability probe).
  const adminControls = document.getElementById("admin-controls");
  const versionBadge = document.getElementById("version-badge");
  const btnConfig = document.getElementById("btn-config");
  const btnConnections = document.getElementById("btn-connections");
  const configOverlay = document.getElementById("config-overlay");
  const configText = document.getElementById("config-text");
  const configMsg = document.getElementById("config-msg");
  const connOverlay = document.getElementById("conn-overlay");
  const connBody = document.getElementById("conn-body");
  const authHeaders = { Authorization: "Bearer " + token };
  let ws, backoff = 500;
  // Which stream the composer currently targets: a specific web conversation,
  // or (only if explicitly picked) the single Telegram stream. Web starts with
  // no target until an active web conversation is found or the user picks one.
  let currentTarget = null;

  if (attachBtn) attachBtn.addEventListener("click", () => fileEl.click());
  if (fileEl) fileEl.addEventListener("change", () => {
    if (!fileNameEl) return;
    if (fileEl.files.length > 0) { fileNameEl.textContent = fileEl.files[0].name; fileNameEl.hidden = false; }
    else { fileNameEl.textContent = ""; fileNameEl.hidden = true; }
  });

  let workingTimer = null, workingStart = 0;
  function workingElapsedText() {
    const secs = Math.max(0, Math.floor((Date.now() - workingStart) / 1000));
    if (secs < 60) return `작업 진행 중… (${secs}초)`;
    return `작업 진행 중… (${Math.floor(secs / 60)}분 ${secs % 60}초)`;
  }
  function showWorking() {
    if (!workingEl) return;
    if (workingTimer) return; // already showing
    workingStart = Date.now();
    workingEl.hidden = false;
    if (workingLabel) workingLabel.textContent = workingElapsedText();
    workingTimer = setInterval(() => {
      if (workingLabel) workingLabel.textContent = workingElapsedText();
    }, 1000);
    scrollToBottom(); // the indicator shrinks the log; keep the newest message visible
  }
  function hideWorking() {
    if (!workingEl) return;
    if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
    workingEl.hidden = true;
    scrollToBottom();
  }

  function applySidebarHidden(hidden) {
    if (!shell) return;
    shell.classList.toggle("sidebar-hidden", hidden);
    if (toggleSidebar) toggleSidebar.setAttribute("aria-pressed", String(hidden));
  }
  if (toggleSidebar) {
    let sidebarHidden = localStorage.getItem("tc_sidebar_hidden") === "1";
    applySidebarHidden(sidebarHidden);
    toggleSidebar.addEventListener("click", () => {
      sidebarHidden = !sidebarHidden;
      localStorage.setItem("tc_sidebar_hidden", sidebarHidden ? "1" : "0");
      applySidebarHidden(sidebarHidden);
    });
  }

  // Scroll the log to the very bottom AFTER the browser has laid out the new
  // content. A synchronous scrollTop set can run before reflow (and before the
  // #working indicator toggles resize the log), leaving the newest message
  // partly clipped — a double rAF guarantees layout is settled first.
  function scrollToBottom() {
    if (!log) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    });
  }

  function add(role, text) {
    const d = document.createElement("div");
    d.className = "msg " + role;
    d.textContent = text;
    log.appendChild(d);
    scrollToBottom();
    return d;
  }
  function addImage(caption, b64) {
    const d = document.createElement("div");
    d.className = "msg assistant";
    if (caption) { const c = document.createElement("div"); c.textContent = caption; d.appendChild(c); }
    const img = document.createElement("img");
    img.src = "data:image/png;base64," + b64;
    img.addEventListener("load", scrollToBottom); // image height is unknown until decoded
    d.appendChild(img);
    log.appendChild(d);
    scrollToBottom();
  }

  function resizeInput() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  }

  // Composer modal control.
  function openComposer() {
    if (!composerOverlay) return;
    composerOverlay.hidden = false;
    if (input) { input.focus(); resizeInput(); }
  }
  function closeComposer() {
    if (!composerOverlay) return;
    composerOverlay.hidden = true;
  }
  if (composerFab) composerFab.addEventListener("click", openComposer);
  if (composerClose) composerClose.addEventListener("click", closeComposer);
  if (composerOverlay) composerOverlay.addEventListener("click", (e) => {
    if (e.target === composerOverlay) closeComposer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeComposer();
    if (configOverlay) configOverlay.hidden = true;
    if (connOverlay) connOverlay.hidden = true;
  });

  function sendText(text, echo) {
    if (!text) return false;
    if (!currentTarget) {
      add("system", "먼저 대화를 선택하거나 ＋로 새 대화를 만들어 주세요.");
      return false;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (echo) add("user", text);
    ws.send(JSON.stringify({ type: "send", text, target: currentTarget }));
    return true;
  }

  // Load and render stored history for a target, then hand off to the live
  // stream (frames keep appending after this). Falls back silently on error
  // so whatever is already shown stays put.
  async function selectTarget(tgt) {
    currentTarget = tgt;
    try {
      const qs = tgt.kind === "telegram"
        ? "kind=telegram"
        : "kind=web&id=" + encodeURIComponent(tgt.id);
      const resp = await fetch("/api/history?" + qs, { headers: authHeaders });
      if (resp.ok) {
        const data = await resp.json();
        log.replaceChildren();
        for (const turn of (data.turns || [])) {
          add(turn.role === "user" ? "user" : "assistant", turn.text);
        }
      }
    } catch (e) { /* keep whatever is shown; live continues */ }
    loadConversations(); // refresh highlight (and #current-topic header)
  }

  function makeTelegramButton(tg) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topic telegram-topic";
    if (currentTarget && currentTarget.kind === "telegram") button.classList.add("active");
    const title = document.createElement("span");
    title.className = "topic-title";
    title.textContent = "📱 " + (tg.title || "텔레그램 대화");
    button.appendChild(title);
    if (tg.project) {
      const sub = document.createElement("span");
      sub.className = "topic-summary";
      sub.textContent = "작업: " + tg.project;
      button.appendChild(sub);
    }
    button.addEventListener("click", () => selectTarget({ kind: "telegram" }));
    return button;
  }

  // Top-level web conversations (per-conversation workDir, web-first flow).
  // Distinct from the legacy project-topic buttons below.
  function makeWebConvButton(wc) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topic";
    if (currentTarget && currentTarget.kind === "web" && currentTarget.id === wc.id) button.classList.add("active");
    button.dataset.id = wc.id;
    const title = document.createElement("span");
    title.className = "topic-title";
    title.textContent = "💬 " + (wc.title || wc.id);
    button.appendChild(title);
    if (wc.workDir) {
      const sub = document.createElement("span");
      sub.className = "topic-summary";
      sub.textContent = "📁 " + wc.workDir;
      button.appendChild(sub);
    }
    button.addEventListener("click", (e) => {
      if (e.target && e.target.dataset && e.target.dataset.gear) return;
      selectTarget({ kind: "web", id: wc.id });
    });
    // ⋯ management menu: rename / change workdir / delete.
    const menu = document.createElement("span");
    menu.textContent = "⋯";
    menu.dataset.gear = "1";
    menu.className = "topic-menu";
    menu.title = "대화 관리";
    menu.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const action = window.prompt("대화 관리 — 번호 입력:\n1) 이름 변경\n2) 작업 폴더 변경\n3) 삭제", "1");
      if (action === "1") {
        const title = window.prompt("새 이름:", wc.title || "");
        if (title) { ws.send(JSON.stringify({ type: "web_rename", id: wc.id, title })); window.setTimeout(loadConversations, 400); }
      } else if (action === "2") {
        const path = window.prompt("이 대화의 작업 폴더 경로:", wc.workDir || "");
        if (path) { ws.send(JSON.stringify({ type: "web_setdir", id: wc.id, path })); window.setTimeout(loadConversations, 400); }
      } else if (action === "3") {
        if (window.confirm("이 대화를 삭제할까요? 되돌릴 수 없습니다.")) {
          if (currentTarget && currentTarget.kind === "web" && currentTarget.id === wc.id) { currentTarget = null; log.replaceChildren(); }
          ws.send(JSON.stringify({ type: "web_delete", id: wc.id }));
          window.setTimeout(loadConversations, 400);
        }
      }
    });
    button.appendChild(menu);
    return button;
  }

  function renderConversations(data) {
    if (!topicList) return;
    topicList.replaceChildren();

    if (data && data.telegram) {
      topicList.appendChild(makeTelegramButton(data.telegram));
    }

    const webConvs = Array.isArray(data && data.webConvs) ? data.webConvs : [];
    if (webConvs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "topic-empty";
      empty.textContent = "＋로 새 대화를 만들어 보세요";
      topicList.appendChild(empty);
      return;
    }

    for (const wc of webConvs) topicList.appendChild(makeWebConvButton(wc));
  }

  // Locate the active conversation for the #current-topic header. Prefers an
  // active top-level web conversation (web-first flow; no project), falls
  // back to the legacy project/telegram active ref, then the per-conv active
  // flag. Returns { project, conv } or null.
  function findActiveConversation(data) {
    const webConvs = Array.isArray(data && data.webConvs) ? data.webConvs : [];
    const activeWeb = webConvs.find((w) => w.active);
    if (activeWeb) return { project: "", conv: activeWeb };

    const projects = Array.isArray(data && data.projects) ? data.projects : [];
    const activeProject = data && data.active && data.active.project;
    const activeId = data && data.active && data.active.conversationId;
    if (activeProject && activeId) {
      for (const p of projects) {
        const convs = Array.isArray(p.conversations) ? p.conversations : [];
        for (const c of convs) {
          if (p.name === activeProject && c.id === activeId) return { project: p.name, conv: c };
        }
      }
    }
    for (const p of projects) {
      const convs = Array.isArray(p.conversations) ? p.conversations : [];
      for (const c of convs) {
        if (c.active) return { project: p.name, conv: c };
      }
    }
    return null;
  }

  // Always-visible header showing which conversation is active, so it stays
  // legible even when the sidebar is collapsed or scrolled.
  function updateCurrentTopic(data) {
    if (!currentTopic) return;
    const found = findActiveConversation(data);
    if (!found) {
      if (currentProject) currentProject.textContent = "";
      if (currentId) currentId.textContent = "";
      if (currentTitle) { currentTitle.textContent = "대화 미선택"; currentTitle.classList.add("empty"); }
      return;
    }
    const { project, conv } = found;
    if (currentProject) currentProject.textContent = project || "";
    if (currentTitle) {
      currentTitle.textContent = conv.title || conv.id || "제목 없음";
      currentTitle.classList.remove("empty");
    }
    if (currentId) currentId.textContent = conv.id ? "#" + conv.id : "";
  }

  async function loadConversations() {
    if (!topicList) return;
    try {
      const resp = await fetch("/api/conversations", { headers: authHeaders });
      if (!resp.ok) throw new Error("status " + resp.status);
      const data = await resp.json();
      renderConversations(data);
      updateCurrentTopic(data);
      if (!currentTarget) {
        const act = (data.webConvs || []).find((w) => w.active);
        if (act) selectTarget({ kind: "web", id: act.id });
      }
    } catch (err) {
      topicList.replaceChildren();
      const d = document.createElement("div");
      d.className = "topic-empty";
      d.textContent = "대화 목록을 불러오지 못했습니다";
      topicList.appendChild(d);
    }
  }

  function connect() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      statusEl.textContent = "연결됨"; statusEl.className = "on"; backoff = 500;
      if (currentTarget) selectTarget(currentTarget); else loadConversations();
    };
    ws.onclose = () => {
      statusEl.textContent = "연결 끊김"; statusEl.className = "off";
      hideWorking();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
    ws.onmessage = (ev) => {
      let f; try { f = JSON.parse(ev.data); } catch { return; }
      if (f.type === "text") add("assistant", f.text);
      else if (f.type === "image") addImage(f.caption || "", f.data);
      else if (f.type === "user") add("user", f.text); // input echoed from another channel (e.g. Telegram)
      else if (f.type === "typing") showWorking();
      else if (f.type === "done") hideWorking();
    };
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (fileEl.files.length > 0) {
      const fd = new FormData();
      fd.append("file", fileEl.files[0]);
      fd.append("caption", input.value.trim());
      add("user", "📎 " + fileEl.files[0].name + (input.value.trim() ? " — " + input.value.trim() : ""));
      showWorking();
      const resp = await fetch("/api/upload", { method: "POST", headers: authHeaders, body: fd });
      if (!resp.ok) { add("system", "업로드 실패: " + resp.status); hideWorking(); }
      fileEl.value = ""; input.value = "";
      if (fileNameEl) { fileNameEl.textContent = ""; fileNameEl.hidden = true; }
      resizeInput();
      closeComposer();
      return;
    }
    const text = input.value.trim();
    if (sendText(text, true)) {
      showWorking();
      input.value = "";
      resizeInput();
      closeComposer();
      window.setTimeout(loadConversations, 500);
    }
  });

  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  if (refreshTopics) refreshTopics.addEventListener("click", loadConversations);
  if (newChat) newChat.addEventListener("click", () => {
    const title = prompt("새 대화 제목 (선택):", "") || "";
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "web_new", title: title }));
    // After creation, refresh and select the newest web conv.
    window.setTimeout(async () => {
      await loadConversations();
      try {
        const resp = await fetch("/api/conversations", { headers: authHeaders });
        const data = await resp.json();
        if (data.webConvs && data.webConvs.length) selectTarget({ kind: "web", id: data.webConvs[0].id });
      } catch (e) { /* ignore; sidebar will still refresh on next loadConversations */ }
    }, 400);
  });

  // --- Admin surface (Teleclaude embedded only) -----------------------------

  async function bootstrapCapabilities() {
    try {
      const resp = await fetch("/api/capabilities", { headers: authHeaders });
      if (!resp.ok) return; // aglink-chat: 404 → admin UI stays hidden
      const cap = await resp.json();
      if (!cap.admin) return;
      if (adminControls) adminControls.hidden = false;
      if (versionBadge) versionBadge.textContent = "v " + (cap.version || "?");
    } catch (e) { /* admin UI stays hidden */ }
  }

  // Note: the !update command still exists on the backend (type via chat or
  // Telegram); the header trigger button was removed per feedback — it is a
  // dev-time action, not needed in normal use.

  async function openConfig() {
    if (!configOverlay) return;
    if (configMsg) configMsg.textContent = "";
    try {
      const resp = await fetch("/api/config", { headers: authHeaders });
      configText.value = resp.ok ? await resp.text() : "(불러오기 실패: " + resp.status + ")";
    } catch (e) { configText.value = "(불러오기 오류)"; }
    configOverlay.hidden = false;
  }
  async function saveConfig() {
    if (configMsg) configMsg.textContent = "저장 중…";
    try {
      const resp = await fetch("/api/config", { method: "PUT", headers: authHeaders, body: configText.value });
      if (resp.status === 204) { if (configMsg) configMsg.textContent = "저장됨 — 핫리로드 적용"; }
      else { const t = await resp.text(); if (configMsg) configMsg.textContent = "실패: " + t; }
    } catch (e) { if (configMsg) configMsg.textContent = "오류: " + e; }
  }
  if (btnConfig) btnConfig.addEventListener("click", openConfig);
  const configCloseBtn = document.getElementById("config-close");
  if (configCloseBtn) configCloseBtn.addEventListener("click", () => { configOverlay.hidden = true; });
  const configSaveBtn = document.getElementById("config-save");
  if (configSaveBtn) configSaveBtn.addEventListener("click", saveConfig);
  if (configOverlay) configOverlay.addEventListener("click", (e) => { if (e.target === configOverlay) configOverlay.hidden = true; });

  function connHeading(text) {
    const h = document.createElement("div");
    h.className = "conn-heading";
    h.textContent = text;
    return h;
  }
  function connRow(k, v, cls) {
    const row = document.createElement("div"); row.className = "conn-row";
    const kk = document.createElement("span"); kk.className = "k"; kk.textContent = k;
    const vv = document.createElement("span"); if (cls) vv.className = cls; vv.textContent = v;
    row.append(kk, vv);
    return row;
  }
  function connNote(text) {
    const n = document.createElement("div"); n.className = "topic-summary"; n.textContent = text;
    return n;
  }
  async function openConnections() {
    if (!connOverlay || !connBody) return;
    connBody.replaceChildren();
    let data = {};
    try { const resp = await fetch("/api/status", { headers: authHeaders }); if (resp.ok) data = await resp.json(); } catch (e) { /* show defaults */ }

    // This web server — if you can read this panel, it is up. Shown first so the
    // aglink-chat row below is never mistaken for "is this page working?".
    connBody.appendChild(connHeading("이 웹 서버 (지금 보고 있는 화면)"));
    connBody.appendChild(connRow("상태", "정상 동작 중", "conn-ok"));
    connBody.appendChild(connRow("웹 채팅 주소", data.webChatAddr || "(미설정)"));

    // External aglink-chat relay process — a SEPARATE program that connects to
    // the control API. "연결 안 됨" here does NOT mean this page is broken.
    connBody.appendChild(connHeading("aglink-chat 릴레이 (별도 프로세스)"));
    connBody.appendChild(connRow("제어 API", data.chatControlEnabled ? "켜짐" : "꺼짐"));
    connBody.appendChild(connRow("제어 API 주소", data.chatControlAddr || "(미설정)"));
    connBody.appendChild(connRow(
      "릴레이 프로세스 접속",
      data.aglinkConnected ? ("접속됨 (" + (data.aglinkClients || 0) + "개)") : "접속 없음",
      data.aglinkConnected ? "conn-ok" : "conn-off"));
    connBody.appendChild(connNote("이 항목은 별도 aglink-chat 프로그램이 제어 API로 붙어 있는지 여부입니다. 이 웹페이지 동작과는 무관합니다."));

    // aglink-* control plugins (aglink-screen / aglink-web) — rebuilt by !update.
    connBody.appendChild(connHeading("aglink 플러그인"));
    let plugins = [];
    try { const presp = await fetch("/api/plugins", { headers: authHeaders }); if (presp.ok) plugins = (await presp.json()).plugins || []; } catch (e) { /* none */ }
    if (plugins.length === 0) {
      connBody.appendChild(connNote("플러그인 정보를 불러오지 못했습니다."));
    } else {
      for (const p of plugins) {
        let val, cls;
        if (!p.installed) { val = "설치 안 됨"; cls = "conn-off"; }
        else { val = (p.version ? p.version : "설치됨") + (p.binary ? " · 빌드 있음" : " · 빌드 없음"); cls = "conn-ok"; }
        connBody.appendChild(connRow(p.name, val, cls));
      }
    }

    connBody.appendChild(connNote("주소/포트 변경은 ⚙ 설정에서 config.yaml을 편집한 뒤 재시작하세요."));
    connOverlay.hidden = false;
  }
  if (btnConnections) btnConnections.addEventListener("click", openConnections);
  const connCloseBtn = document.getElementById("conn-close");
  if (connCloseBtn) connCloseBtn.addEventListener("click", () => { connOverlay.hidden = true; });
  if (connOverlay) connOverlay.addEventListener("click", (e) => { if (e.target === connOverlay) connOverlay.hidden = true; });

  resizeInput();
  bootstrapCapabilities();
  loadConversations();
  connect();
})();
