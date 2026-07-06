(function () {
  // Token: from ?token= (persist to localStorage) or previously stored.
  const params = new URLSearchParams(location.search);
  let token = params.get("token");
  if (token) localStorage.setItem("tc_token", token);
  else token = localStorage.getItem("tc_token") || "";

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
  let ws, backoff = 500;
  // Which stream the composer currently targets: the single Telegram stream,
  // or a specific web-created topic. Defaults to Telegram until a topic is picked.
  let currentTarget = { kind: "telegram" };

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
  }
  function hideWorking() {
    if (!workingEl) return;
    if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
    workingEl.hidden = true;
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

  function add(role, text) {
    const d = document.createElement("div");
    d.className = "msg " + role;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function addImage(caption, b64) {
    const d = document.createElement("div");
    d.className = "msg assistant";
    if (caption) { const c = document.createElement("div"); c.textContent = caption; d.appendChild(c); }
    const img = document.createElement("img");
    img.src = "data:image/png;base64," + b64;
    d.appendChild(img);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  }

  function sendText(text, echo) {
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return false;
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
        : "kind=web&project=" + encodeURIComponent(tgt.project) + "&id=" + encodeURIComponent(tgt.id);
      const resp = await fetch("/api/history?" + qs, { headers: { Authorization: "Bearer " + token } });
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
    if (currentTarget.kind === "telegram") button.classList.add("active");
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

  function makeConvButton(project, conv) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topic";
    if (conv.active) button.classList.add("active");
    button.dataset.id = conv.id || "";

    const title = document.createElement("span");
    title.className = "topic-title";
    title.textContent = conv.title || conv.id || "제목 없음";
    button.appendChild(title);

    if (conv.summary) {
      const summary = document.createElement("span");
      summary.className = "topic-summary";
      summary.textContent = conv.summary;
      button.appendChild(summary);
    }

    button.addEventListener("click", () => {
      if (!conv.id) return;
      // Keep the shared active pointer in sync for the sidebar highlight.
      sendText("!chat use " + project.name + " " + conv.id, false);
      selectTarget({ kind: "web", project: project.name, id: conv.id });
    });
    return button;
  }

  function renderConversations(data) {
    if (!topicList) return;
    topicList.replaceChildren();

    if (data && data.telegram) {
      topicList.appendChild(makeTelegramButton(data.telegram));
    }

    const activeProject = data && data.active && data.active.project;
    const projects = Array.isArray(data && data.projects) ? data.projects : [];
    if (projects.length === 0) {
      const empty = document.createElement("div");
      empty.className = "topic-empty";
      empty.textContent = "대화가 없습니다";
      topicList.appendChild(empty);
      return;
    }

    const projectsToRender = projects.slice().sort((a, b) => {
      if (a.name === activeProject) return -1;
      if (b.name === activeProject) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });

    for (const project of projectsToRender) {
      const conversations = Array.isArray(project.conversations) ? project.conversations : [];
      const group = document.createElement("section");
      group.className = "topic-group";

      const head = document.createElement("div");
      head.className = "topic-project";
      if (project.name === activeProject) head.classList.add("active");

      const name = document.createElement("span");
      name.className = "topic-project-name";
      name.textContent = project.name || "프로젝트";
      head.appendChild(name);

      const count = document.createElement("span");
      count.className = "topic-project-count";
      count.textContent = String(conversations.length);
      head.appendChild(count);
      group.appendChild(head);

      if (conversations.length === 0) {
        const empty = document.createElement("div");
        empty.className = "topic-empty";
        empty.textContent = "대화 없음";
        group.appendChild(empty);
        topicList.appendChild(group);
        continue;
      }

      // Web-created chats and the shared active conversation are shown by default;
      // other (telegram/legacy) conversations tuck behind a toggle so the web
      // sidebar isn't cluttered with chats made from Telegram.
      const webConvs = [];
      const tgConvs = [];
      for (const conv of conversations) {
        if (conv.active || conv.channel === "web") webConvs.push(conv);
        else tgConvs.push(conv);
      }

      for (const conv of webConvs) group.appendChild(makeConvButton(project, conv));

      if (tgConvs.length > 0) {
        let open = false;
        const holder = document.createElement("div");
        holder.className = "topic-section";
        holder.hidden = true;
        for (const conv of tgConvs) holder.appendChild(makeConvButton(project, conv));

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "topic-section-toggle";
        const label = () => (open ? "▾ " : "▸ ") + "텔레그램 대화 (" + tgConvs.length + ")";
        toggle.textContent = label();
        toggle.addEventListener("click", () => {
          open = !open;
          holder.hidden = !open;
          toggle.textContent = label();
        });
        group.appendChild(toggle);
        group.appendChild(holder);
      }

      topicList.appendChild(group);
    }
  }

  // Locate the active conversation in a list_conversations payload: prefer the
  // explicit active ref (project + conversationId), fall back to the per-conv
  // active flag. Returns { project, conv } or null.
  function findActiveConversation(data) {
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
    try {
      const resp = await fetch("/api/conversations", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!resp.ok) throw new Error("status " + resp.status);
      const data = await resp.json();
      renderConversations(data);
      updateCurrentTopic(data);
    } catch (err) {
      if (!topicList) return;
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
    ws.onopen = () => { statusEl.textContent = "연결됨"; statusEl.className = "on"; backoff = 500; selectTarget(currentTarget); };
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
      const resp = await fetch("/api/upload", { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
      if (!resp.ok) { add("system", "업로드 실패: " + resp.status); hideWorking(); }
      fileEl.value = ""; input.value = "";
      if (fileNameEl) { fileNameEl.textContent = ""; fileNameEl.hidden = true; }
      resizeInput();
      return;
    }
    const text = input.value.trim();
    if (sendText(text, true)) {
      showWorking();
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
  if (newChat) newChat.addEventListener("click", () => {
    // A web-created chat is managed only in the web sidebar (origin=web tagging).
    if (sendText("!chat new", true)) window.setTimeout(loadConversations, 500);
  });
  resizeInput();
  loadConversations();
  connect();
})();
