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
  const fileThumbEl = document.getElementById("file-thumb");
  const fileClearEl = document.getElementById("file-clear");
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
  // Admin surface (shown after capability probe).
  const adminControls = document.getElementById("admin-controls");
  const versionBadge = document.getElementById("version-badge");
  const backendBadge = document.getElementById("backend-badge");
  const btnConfig = document.getElementById("btn-config");
  const btnConnections = document.getElementById("btn-connections");
  const configOverlay = document.getElementById("config-overlay");
  const configText = document.getElementById("config-text");
  const configMsg = document.getElementById("config-msg");
  const connOverlay = document.getElementById("conn-overlay");
  const connBody = document.getElementById("conn-body");
  const dialogOverlay = document.getElementById("dialog-overlay");
  const dialogTitle = document.getElementById("dialog-title");
  const dialogBody = document.getElementById("dialog-body");
  const dialogFoot = document.getElementById("dialog-foot");
  const dialogClose = document.getElementById("dialog-close");
  const authHeaders = { Authorization: "Bearer " + token };
  let ws, backoff = 500;
  // Which stream the composer currently targets: a specific web conversation,
  // or (only if explicitly picked) the single Telegram stream. Web starts with
  // no target until an active web conversation is found or the user picks one.
  let currentTarget = null;

  // Conversations with frames that arrived while they weren't on screen. The
  // missed text itself isn't buffered here — the server persists every turn, so
  // opening the conversation reloads it via /api/history. This only drives the
  // unread badge in the topic list.
  const unread = new Set();

  // targetKey identifies a conversation. All non-web targets are the single
  // telegram stream, matching teleclaude's Target.SameConversation.
  function targetKey(t) {
    if (!t || t.kind !== "web") return "telegram";
    return "web:" + t.id;
  }

  // frameTarget is the conversation a frame belongs to. A frame with no target
  // came from an older server and means the telegram stream.
  function frameTarget(f) {
    return f.target || { kind: "telegram" };
  }

  function isCurrent(t) {
    return currentTarget != null && targetKey(t) === targetKey(currentTarget);
  }

  if (attachBtn) attachBtn.addEventListener("click", () => fileEl.click());

  // The thumbnail's object URL must be revoked when replaced/cleared, or each
  // paste/pick leaks the previous preview's memory for the life of the page.
  let fileThumbURL = null;
  function clearFileThumb() {
    if (fileThumbURL) { URL.revokeObjectURL(fileThumbURL); fileThumbURL = null; }
    if (fileThumbEl) { fileThumbEl.hidden = true; fileThumbEl.src = ""; }
  }
  function updateFileUI() {
    const f = fileEl.files[0];
    clearFileThumb();
    if (!f) {
      if (fileNameEl) { fileNameEl.textContent = ""; fileNameEl.hidden = true; }
      if (fileClearEl) fileClearEl.hidden = true;
      return;
    }
    if (fileNameEl) { fileNameEl.textContent = f.name; fileNameEl.hidden = false; }
    if (fileClearEl) fileClearEl.hidden = false;
    if (fileThumbEl && f.type && f.type.indexOf("image/") === 0) {
      fileThumbURL = URL.createObjectURL(f);
      fileThumbEl.src = fileThumbURL;
      fileThumbEl.hidden = false;
    }
  }
  if (fileEl) fileEl.addEventListener("change", updateFileUI);
  if (fileClearEl) fileClearEl.addEventListener("click", () => {
    fileEl.value = "";
    updateFileUI();
  });

  // Paste an image from the clipboard (Ctrl+V in the input) as a file attachment,
  // matching the 📎 flow: the filename shows in #file-name and the user still
  // types a caption and sends via the normal submit. A non-image paste falls
  // through to the default text paste (we don't preventDefault).
  if (input && fileEl) {
    input.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let blob = null;
      for (const it of items) {
        if (it.type && it.type.indexOf("image/") === 0) { blob = it.getAsFile(); break; }
      }
      if (!blob) return; // no image on the clipboard → let the text paste happen
      e.preventDefault();
      const ext = (blob.type.split("/")[1] || "png").split("+")[0]; // image/png→png, image/svg+xml→svg
      const file = new File([blob], "붙여넣은 이미지." + ext, { type: blob.type });
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileEl.files = dt.files;
      } catch (err) {
        return; // DataTransfer unsupported → silently skip (no crash)
      }
      fileEl.dispatchEvent(new Event("change")); // reuse the filename-display logic
    });
  }

  // Busy state is per conversation, not per screen: a turn running in another
  // topic must not paint (or keep painting) the indicator on the one you're
  // looking at. Keyed like targetKey(): "telegram" or "web:<id>".
  const working = new Map(); // key -> { startedAt, lastAliveAt }
  let workingTimer = null;

  // STALE_AFTER_MS: the server re-sends a "typing" frame roughly every 2
  // minutes for as long as the worker is genuinely still running (see
  // manager.go's runHeartbeat). If none has arrived in a while, that's a real
  // signal something's off (worker died without telling us, or the WS itself
  // dropped) — not just "still thinking". A generous multiple of the 2-minute
  // heartbeat avoids false positives from a single delayed tick.
  const STALE_AFTER_MS = 5 * 60 * 1000;

  // The push frames are the fast path; this poll is the safety net that ends a
  // turn whose "done" never arrived. It is authoritative in both directions:
  // it starts an indicator after a reconnect, and ends one that is stuck.
  const WORKER_POLL_MS = 3000;

  // A freshly submitted turn is not registered as a running worker until it
  // reaches runWorker — for the telegram stream that is *after* the routing LLM
  // call, which takes seconds. Clearing on absence before then would hide the
  // indicator while the turn is genuinely starting, so absence only counts once
  // the entry is older than this.
  const WORKING_GRACE_MS = 30 * 1000;

  function workingElapsedText(w) {
    const secs = Math.max(0, Math.floor((Date.now() - w.startedAt) / 1000));
    const elapsed = secs < 60 ? `${secs}초` : `${Math.floor(secs / 60)}분 ${secs % 60}초`;
    if (Date.now() - w.lastAliveAt > STALE_AFTER_MS) {
      return `⚠️ 작업 진행 중… (${elapsed} 경과, 서버 응답 확인 안 된 지 오래됨 — 멈췄을 수 있음)`;
    }
    return `작업 진행 중… (${elapsed} 경과)`;
  }

  // startWorking/stopWorking mutate the state; renderWorking is the only place
  // that touches the DOM, so the indicator always reflects the open conversation.
  function startWorking(key) {
    const now = Date.now();
    const w = working.get(key);
    if (w) w.lastAliveAt = now; // a typing frame is a live-signal, not a restart
    else working.set(key, { startedAt: now, lastAliveAt: now });
    renderWorking();
  }
  function stopWorking(key) {
    if (working.delete(key)) renderWorking();
  }
  function currentWorking() {
    return currentTarget ? working.get(targetKey(currentTarget)) : undefined;
  }
  function renderWorking() {
    if (!workingEl) return;
    const w = currentWorking();
    if (!w) {
      if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
      if (!workingEl.hidden) { workingEl.hidden = true; scrollToBottom(); }
      return;
    }
    const wasHidden = workingEl.hidden;
    workingEl.hidden = false;
    if (workingLabel) workingLabel.textContent = workingElapsedText(w);
    if (!workingTimer) {
      workingTimer = setInterval(() => {
        const cur = currentWorking();
        if (!cur) { renderWorking(); return; }
        if (workingLabel) workingLabel.textContent = workingElapsedText(cur);
      }, 1000);
    }
    if (wasHidden) scrollToBottom(); // the indicator shrinks the log
  }

  // workerKey maps a server-reported conversationId onto our target keys. The
  // telegram stream's conversation is literally "telegram" (see store.json).
  function workerKey(convID) {
    return convID === "telegram" ? "telegram" : "web:" + convID;
  }

  // pollWorkers reconciles the indicator against the server's list of running
  // workers. Absence only clears an entry past the grace window, so a turn that
  // has been submitted but not yet registered keeps its indicator.
  //
  // Idle tabs don't poll: with nothing showing, a typing frame is what starts an
  // indicator. force is used on reconnect, where frames may have been missed in
  // both directions.
  async function pollWorkers(force = false) {
    if (!force && working.size === 0) return;
    let data;
    try {
      const resp = await fetch("/api/workers", { headers: authHeaders });
      if (!resp.ok) return;
      data = await resp.json();
    } catch { return; } // offline: leave the state alone, ws.onclose handles it

    const active = new Set((data.workers || []).map((w) => workerKey(w.conversationId)));
    let changed = false;

    for (const key of active) {
      if (!working.has(key)) {
        const now = Date.now();
        working.set(key, { startedAt: now, lastAliveAt: now });
        changed = true;
      }
    }
    const now = Date.now();
    for (const [key, w] of [...working]) {
      if (!active.has(key) && now - w.startedAt > WORKING_GRACE_MS) {
        working.delete(key);
        changed = true;
      }
    }
    if (changed) renderWorking();
  }
  window.setInterval(pollWorkers, WORKER_POLL_MS);

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

  // User bubbles stay verbatim: what someone typed should be shown as typed, not
  // reinterpreted. Only worker/system output is Markdown. If markdown.js failed
  // to load, fall back to plain text rather than dropping the message.
  function add(role, text) {
    const d = document.createElement("div");
    d.className = "msg " + role;
    const md = window.TCMarkdown;
    if (role === "user" || !md) d.textContent = text;
    else { d.classList.add("md"); d.appendChild(md.renderMarkdown(text)); }
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

  // Esc closes the admin panels (config / connections) and any open dialog.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (configOverlay) configOverlay.hidden = true;
    if (connOverlay) connOverlay.hidden = true;
    if (dialogCancel) dialogCancel();
  });

  // --- Custom dialogs (replace window.prompt/confirm — no browser-native popups) ---
  // dialogCancel, when set, is the "resolve as cancelled" callback for whichever
  // dialog is currently open; Esc and click-outside both call it.
  let dialogCancel = null;

  function openDialog(title, build, cancelValue) {
    return new Promise((resolve) => {
      if (!dialogOverlay) { resolve(cancelValue); return; }
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        dialogCancel = null;
        dialogOverlay.hidden = true;
        resolve(val);
      };
      dialogCancel = () => finish(cancelValue);
      dialogTitle.textContent = title;
      dialogBody.replaceChildren();
      dialogFoot.replaceChildren();
      build(dialogBody, dialogFoot, finish);
      dialogOverlay.hidden = false;
      const firstField = dialogBody.querySelector("input");
      if (firstField) { firstField.focus(); firstField.select(); }
    });
  }

  // Replaces window.prompt(label, defaultValue). Resolves "" on cancel — same
  // as the original `prompt(...) || ""` call sites, so behavior is unchanged.
  function askText(title, label, defaultValue) {
    return openDialog(title, (body, foot, finish) => {
      if (label) {
        const l = document.createElement("div");
        l.className = "dialog-label";
        l.textContent = label;
        body.appendChild(l);
      }
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "dialog-input";
      inp.value = defaultValue || "";
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(inp.value); }
      });
      body.appendChild(inp);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dialog-btn-secondary";
      cancel.textContent = "취소";
      cancel.addEventListener("click", () => finish(""));
      const ok = document.createElement("button");
      ok.type = "button";
      ok.textContent = "확인";
      ok.addEventListener("click", () => finish(inp.value));
      foot.append(cancel, ok);
    }, "");
  }

  // Replaces window.confirm(message). opts: { okLabel, danger }.
  function askConfirm(title, message, opts) {
    opts = opts || {};
    return openDialog(title, (body, foot, finish) => {
      const m = document.createElement("div");
      m.className = "dialog-message";
      m.textContent = message;
      body.appendChild(m);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dialog-btn-secondary";
      cancel.textContent = "취소";
      cancel.addEventListener("click", () => finish(false));
      const ok = document.createElement("button");
      ok.type = "button";
      ok.textContent = opts.okLabel || "확인";
      if (opts.danger) ok.classList.add("dialog-btn-danger");
      ok.addEventListener("click", () => finish(true));
      foot.append(cancel, ok);
    }, false);
  }

  // A choice menu (replaces the "1/2/3 번호 입력" prompt). options:
  // [{ value, label, danger }]. Resolves the chosen value, or null on cancel.
  function askMenu(title, options) {
    return openDialog(title, (body, foot, finish) => {
      for (const opt of options) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "dialog-menu-btn" + (opt.danger ? " dialog-danger-outline" : "");
        b.textContent = opt.label;
        b.addEventListener("click", () => finish(opt.value));
        body.appendChild(b);
      }
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dialog-btn-secondary";
      cancel.textContent = "취소";
      cancel.addEventListener("click", () => finish(null));
      foot.append(cancel);
    }, null);
  }
  if (dialogClose) dialogClose.addEventListener("click", () => { if (dialogCancel) dialogCancel(); });
  if (dialogOverlay) dialogOverlay.addEventListener("click", (e) => {
    if (e.target === dialogOverlay && dialogCancel) dialogCancel();
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
    unread.delete(targetKey(tgt)); // opening it reloads everything below
    renderWorking(); // show this conversation's busy state, not the previous one's
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

  // Marks a topic button as having unseen frames.
  function applyUnread(button, key) {
    if (!unread.has(key)) return;
    button.classList.add("unread");
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    dot.title = "읽지 않은 새 응답";
    dot.textContent = "●";
    button.appendChild(dot);
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
    applyUnread(button, "telegram");
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
    applyUnread(button, "web:" + wc.id);
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
    menu.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const action = await askMenu("대화 관리", [
        { value: "rename", label: "✏️  이름 변경" },
        { value: "workdir", label: "📁  작업 폴더 변경" },
        { value: "delete", label: "🗑️  삭제", danger: true },
      ]);
      if (action === "rename") {
        const title = await askText("이름 변경", "새 이름", wc.title || "");
        if (title) { ws.send(JSON.stringify({ type: "web_rename", id: wc.id, title })); window.setTimeout(loadConversations, 400); }
      } else if (action === "workdir") {
        const path = await askText("작업 폴더 변경", "이 대화의 작업 폴더 경로", wc.workDir || "");
        if (path) { ws.send(JSON.stringify({ type: "web_setdir", id: wc.id, path })); window.setTimeout(loadConversations, 400); }
      } else if (action === "delete") {
        const ok = await askConfirm("대화 삭제", "이 대화를 삭제할까요? 되돌릴 수 없습니다.", { okLabel: "삭제", danger: true });
        if (ok) {
          if (currentTarget && currentTarget.kind === "web" && currentTarget.id === wc.id) { currentTarget = null; log.replaceChildren(); }
          unread.delete("web:" + wc.id); // no badge for a conversation that's gone
          ws.send(JSON.stringify({ type: "web_delete", id: wc.id }));
          window.setTimeout(loadConversations, 400);
        }
      }
    });
    button.appendChild(menu);
    return button;
  }

  // Sidebar items are grouped into two fixed channels: Telegram (always exactly
  // one conversation — the single global stream) and Web (however many topics
  // the user has created from the browser). The channel is where a conversation
  // came from, not just a label on it, so the heading makes that grouping explicit
  // rather than leaving telegram/web topics to look like one flat, mixed list.
  function channelHeading(text) {
    const h = document.createElement("div");
    h.className = "channel-heading";
    h.textContent = text;
    return h;
  }

  // Wraps a channel's conversation buttons so they can be indented under their
  // channel-heading (a visual parent/child relationship, not just adjacent rows).
  function channelGroup() {
    const g = document.createElement("div");
    g.className = "channel-group";
    return g;
  }

  function renderConversations(data) {
    if (!topicList) return;
    // Keep the header backend badge live: telegram.backend mirrors the global
    // active backend, refreshed on every conversations poll.
    if (data && data.telegram && data.telegram.backend) renderBackendBadge(data.telegram.backend);
    topicList.replaceChildren();

    if (data && data.telegram) {
      topicList.appendChild(channelHeading("📱 텔레그램 채널"));
      const group = channelGroup();
      group.appendChild(makeTelegramButton(data.telegram));
      topicList.appendChild(group);
    }

    const webConvs = Array.isArray(data && data.webConvs) ? data.webConvs : [];
    topicList.appendChild(channelHeading("💬 웹 채널"));
    const webGroup = channelGroup();
    if (webConvs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "topic-empty";
      empty.textContent = "＋로 새 대화를 만들어 보세요";
      webGroup.appendChild(empty);
      topicList.appendChild(webGroup);
      return;
    }

    for (const wc of webConvs) webGroup.appendChild(makeWebConvButton(wc));
    topicList.appendChild(webGroup);
  }

  // Locate the active conversation for the #current-topic header. Prefers an
  // active top-level web conversation (web-first flow; no project), falls
  // back to the legacy project/telegram active ref, then the per-conv active
  // flag. Returns { project, conv } or null.
  function findActiveConversation(data) {
    // The header must reflect what the user actually has open (currentTarget),
    // not a server-reported "active" flag — that flag is the store's own active
    // pointer, which can lag or point at a different conversation right after
    // switching channels (e.g. clicking 텔레그램 대화 doesn't itself change which
    // conversation the store considers "active"). Without this, the title could
    // keep showing the previous conversation while the log below had already
    // switched to a different one.
    if (currentTarget && currentTarget.kind === "telegram" && data && data.telegram) {
      return { project: "", conv: data.telegram };
    }
    if (currentTarget && currentTarget.kind === "web") {
      const webConvs = Array.isArray(data && data.webConvs) ? data.webConvs : [];
      const wc = webConvs.find((w) => w.id === currentTarget.id);
      if (wc) return { project: "", conv: wc };
    }

    // Fallback for the first load, before the user has clicked anything yet:
    // whatever the server reports as active.
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
      pollWorkers(true); // a turn may have started, finished, or both while we were away
    };
    ws.onclose = () => {
      statusEl.textContent = "연결 끊김"; statusEl.className = "off";
      // While disconnected we cannot know what is still running; the poll on
      // reconnect re-establishes the truth.
      working.clear();
      renderWorking();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
    ws.onmessage = (ev) => {
      let f; try { f = JSON.parse(ev.data); } catch { return; }
      const tgt = frameTarget(f);
      const key = targetKey(tgt);

      // Busy state belongs to the conversation, not the screen, so it is updated
      // before the render filter below. Dropping a "done" for an off-screen
      // conversation would strand its indicator the moment you switched away.
      if (f.type === "typing") startWorking(key);
      else if (f.type === "done") stopWorking(key);

      // Content for a conversation that isn't on screen must never be appended
      // to the one that is — that mixed the Telegram stream into web topics.
      // Flag it unread instead; opening it reloads the full text from history.
      if (!isCurrent(tgt)) {
        if (f.type === "text" || f.type === "image" || f.type === "user") {
          if (!unread.has(key)) {
            unread.add(key);
            loadConversations(); // repaint the list with the badge, once
          }
        }
        return;
      }

      if (f.type === "text") add("assistant", f.text);
      else if (f.type === "image") addImage(f.caption || "", f.data);
      else if (f.type === "user") add("user", f.text); // input echoed from another channel (e.g. Telegram)
    };
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (fileEl.files.length > 0) {
      const fd = new FormData();
      fd.append("file", fileEl.files[0]);
      fd.append("caption", input.value.trim());
      add("user", "📎 " + fileEl.files[0].name + (input.value.trim() ? " — " + input.value.trim() : ""));
      const uploadKey = targetKey(currentTarget);
      startWorking(uploadKey);
      const resp = await fetch("/api/upload", { method: "POST", headers: authHeaders, body: fd });
      if (!resp.ok) { add("system", "업로드 실패: " + resp.status); stopWorking(uploadKey); }
      fileEl.value = ""; input.value = "";
      updateFileUI();
      resizeInput();
      return;
    }
    const text = input.value.trim();
    if (sendText(text, true)) {
      startWorking(targetKey(currentTarget));
      input.value = "";
      resizeInput();
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
  if (newChat) newChat.addEventListener("click", async () => {
    const title = await askText("새 대화", "제목 (선택)", "");
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

  // Render the header version badge from a version payload (/api/capabilities or
  // /api/version). Shows the running version, turns amber with a ▲ when the
  // running build is behind the source tree, and puts full detail in the tooltip.
  function renderVersionBadge(v) {
    if (!versionBadge || !v) return;
    const running = v.version || "?";
    versionBadge.textContent = running + (v.updateAvailable ? " ▲" : "");
    versionBadge.classList.toggle("update-available", !!v.updateAvailable);
    let tip = "실행 중: " + running;
    if (v.commit) tip += " (" + v.commit + ")";
    if (v.buildTime) tip += " · " + v.buildTime;
    if (v.latestVersion) {
      tip += "\n최신 소스: " + v.latestVersion;
      if (v.latestCommit) tip += " (" + v.latestCommit + ")";
      tip += v.updateAvailable ? " → 업데이트 필요" : " (동일)";
    }
    versionBadge.title = tip;
  }

  // Render the header backend badge (claude / codex). The backend is global
  // (manager.Backend()); teleclaude reports it in the version payload and, live,
  // as data.telegram.backend on every conversations refresh — so a `!backend`
  // switch is reflected without an extra poll.
  function renderBackendBadge(backend) {
    if (!backendBadge) return;
    if (!backend) { backendBadge.hidden = true; return; }
    backendBadge.hidden = false;
    backendBadge.textContent = "🤖 " + backend;
    backendBadge.classList.toggle("backend-claude", backend === "claude");
    backendBadge.classList.toggle("backend-codex", backend === "codex");
    backendBadge.title = "현재 연결된 백엔드: " + backend;
  }

  async function bootstrapCapabilities() {
    try {
      const resp = await fetch("/api/capabilities", { headers: authHeaders });
      if (!resp.ok) return; // aglink-chat: 404 → admin UI stays hidden
      const cap = await resp.json();
      renderBackendBadge(cap.backend); // backend indicator is not admin-gated
      if (!cap.admin) return;
      if (adminControls) adminControls.hidden = false;
      renderVersionBadge(cap);
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

    // Version: running build vs latest source, so "update needed" is obvious.
    let ver = {};
    try { const vr = await fetch("/api/version", { headers: authHeaders }); if (vr.ok) ver = await vr.json(); } catch (e) { /* skip */ }
    connBody.appendChild(connHeading("버전"));
    connBody.appendChild(connRow("실행 중", (ver.version || "?") + (ver.commit ? " (" + ver.commit + ")" : "")));
    if (ver.latestVersion) {
      connBody.appendChild(connRow("최신 소스", ver.latestVersion + (ver.latestCommit ? " (" + ver.latestCommit + ")" : "")));
      const behind = (ver.latestCommitCount || 0) - (ver.commitCount || 0);
      if (ver.updateAvailable) {
        connBody.appendChild(connRow("상태", "업데이트 필요 (" + behind + "커밋 뒤처짐)", "conn-off"));
      } else {
        connBody.appendChild(connRow("상태", "최신", "conn-ok"));
      }
    }
    if (ver.buildTime) connBody.appendChild(connNote("빌드 시각: " + ver.buildTime));
    renderVersionBadge(ver); // keep the header badge in sync with fresh data

    // This web server — if you can read this panel, it is up. Shown first so the
    // aglink helper rows below are never mistaken for "is this page working?".
    connBody.appendChild(connHeading("이 웹 서버 (지금 보고 있는 화면)"));
    connBody.appendChild(connRow("상태", "정상 동작 중", "conn-ok"));
    connBody.appendChild(connRow("웹 채팅 주소", data.webChatAddr || "(미설정)"));

    // aglink helper features (aglink-chat / aglink-screen / aglink-web) — all
    // shown with ONE unified 3-state rule.
    connBody.appendChild(connHeading("aglink 보조 기능"));
    let features = [];
    try { const ar = await fetch("/api/aux", { headers: authHeaders }); if (ar.ok) features = (await ar.json()).features || []; } catch (e) { /* none */ }
    if (features.length === 0) {
      connBody.appendChild(connNote("상태 정보를 불러오지 못했습니다."));
    } else {
      const stateMap = {
        running: ["🟢 실행 중", "conn-ok"],
        idle:    ["⚪ 미사용", "conn-idle"],
        absent:  ["🔴 설치 안 됨", "conn-off"],
      };
      for (const f of features) {
        const [txt, cls] = stateMap[f.state] || ["⚫ 알 수 없음", ""];
        const label = f.label + (f.version ? " (" + f.version + ")" : "");
        connBody.appendChild(connRow(label, txt, cls));
        if (f.detail) connBody.appendChild(connNote("↳ " + f.detail));
      }
      connBody.appendChild(connNote("⚪ 미사용은 정상입니다(필요할 때만 실행). 🔴만 조치가 필요합니다."));
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
