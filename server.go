package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

//go:embed web
var webFS embed.FS

// browserConn is one connected browser; frames go through a buffered channel
// drained by a single writer (a full buffer drops the slow client).
type browserConn struct {
	send      chan wsFrame
	closeOnce sync.Once
	cancel    context.CancelFunc
}

func (b *browserConn) push(f wsFrame) {
	select {
	case b.send <- f:
	default:
		b.close()
	}
}
func (b *browserConn) close() { b.closeOnce.Do(func() { b.cancel() }) }

// browserHub fans control-API frames out to every connected browser.
type browserHub struct {
	mu    sync.RWMutex
	conns map[*browserConn]bool
}

func newBrowserHub() *browserHub { return &browserHub{conns: map[*browserConn]bool{}} }
func (h *browserHub) add(c *browserConn) {
	h.mu.Lock()
	h.conns[c] = true
	h.mu.Unlock()
}
func (h *browserHub) remove(c *browserConn) {
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
}
func (h *browserHub) broadcast(f wsFrame) {
	h.mu.RLock()
	conns := make([]*browserConn, 0, len(h.conns))
	for c := range h.conns {
		conns = append(conns, c)
	}
	h.mu.RUnlock()
	for _, c := range conns {
		c.push(f)
	}
}

type browserServer struct {
	addr, token string
	control     *controlClient
	hub         *browserHub
}

// browserMsg is a message from a browser (same shape as teleclaude's web UI sends).
type browserMsg struct {
	Type    string          `json:"type"`
	Text    string          `json:"text"`
	Kind    string          `json:"kind,omitempty"`
	ID      string          `json:"id,omitempty"`
	Title   string          `json:"title,omitempty"`
	Path    string          `json:"path,omitempty"`
	Backend string          `json:"backend,omitempty"`
	Target  json.RawMessage `json:"target,omitempty"`
}

func (s *browserServer) tokenOK(r *http.Request) bool {
	got := r.URL.Query().Get("token")
	if got == "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			got = strings.TrimPrefix(h, "Bearer ")
		}
	}
	if got == "" || s.token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func (s *browserServer) originOK(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "127.0.0.1" || host == "localhost"
}

func (s *browserServer) authOK(r *http.Request) bool { return s.originOK(r) && s.tokenOK(r) }

func (s *browserServer) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"127.0.0.1:*", "localhost:*"},
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	bc := &browserConn{send: make(chan wsFrame, 64), cancel: cancel}
	s.hub.add(bc)
	defer s.hub.remove(bc)
	defer c.Close(websocket.StatusNormalClosure, "")

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case f := <-bc.send:
				wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				werr := wsjson.Write(wctx, c, f)
				wcancel()
				if werr != nil {
					cancel()
					return
				}
			}
		}
	}()

	for {
		var m browserMsg
		if rerr := wsjson.Read(ctx, c, &m); rerr != nil {
			break
		}
		switch m.Type {
		case "send":
			s.forwardSend(m.Text, m.Target)
		case "web_new":
			_ = s.control.send(controlIn{Type: "web_new", Title: m.Title, Origin: "web"})
		case "web_setdir":
			_ = s.control.send(controlIn{Type: "web_setdir", ID: m.ID, Path: m.Path, Origin: "web"})
		case "web_rename":
			_ = s.control.send(controlIn{Type: "web_rename", ID: m.ID, Title: m.Title, Origin: "web"})
		case "web_delete":
			_ = s.control.send(controlIn{Type: "web_delete", ID: m.ID, Origin: "web"})
		case "set_channel_backend":
			_ = s.control.send(buildSetChannelBackendControlIn(m.Kind, m.ID, m.Backend))
		}
	}
	cancel()
}

// forwardSend relays a browser's typed input to teleclaude's control API. Commands
// go via handle_command, everything else via send_text; teleclaude fills in the
// owner chatID (we send 0) and applies rate-limiting / origin tagging / echo.
//
// target names the conversation the browser typed into. It must be relayed:
// teleclaude defaults a target-less send_text to the global telegram stream, so
// dropping it ran every web-topic message as a Telegram turn. A nil target is a
// browser that hasn't picked a conversation, and keeps the telegram default.
func (s *browserServer) forwardSend(text string, target json.RawMessage) {
	m, ok := buildSendControlIn(text, target)
	if !ok {
		return
	}
	if err := s.control.send(m); err != nil {
		log.Printf("[browser] forward send failed: %v", err)
	}
}

// buildSendControlIn is the pure part of forwardSend, split out so the target
// relay is testable without a live control connection. ok is false for input
// that should not be sent at all (empty after trimming).
func buildSendControlIn(text string, target json.RawMessage) (controlIn, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return controlIn{}, false
	}
	m := controlIn{Text: text, Origin: "web", Target: target}
	if strings.HasPrefix(text, "!") {
		m.Type = "handle_command"
	} else {
		m.Type = "send_text"
	}
	return m, true
}

func buildSetChannelBackendControlIn(kind, id, backend string) controlIn {
	if kind == "" {
		if id != "" {
			kind = "web"
		} else {
			kind = "telegram"
		}
	}
	target := map[string]string{"kind": kind}
	if id != "" {
		target["id"] = id
	}
	tgt, _ := json.Marshal(target)
	return controlIn{
		Type:    "set_channel_backend",
		Origin:  "web",
		Target:  json.RawMessage(tgt),
		Backend: backend,
	}
}

func buildUploadControlIn(path, caption string, target json.RawMessage) controlIn {
	return controlIn{
		Type:    "upload_attachment",
		Path:    path,
		Caption: caption,
		Origin:  "web",
		Target:  target,
	}
}

func (s *browserServer) handleConversations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	data, err := s.control.request(controlIn{Type: "list_conversations"})
	if err != nil {
		http.Error(w, "control API error", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(data)
}

// handleWorkers proxies the browser's active-worker poll to teleclaude. The
// browser uses it to reconcile its working indicator: a conversation absent from
// this list is idle, whatever push frames did or didn't arrive.
func (s *browserServer) handleWorkers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	data, err := s.control.request(controlIn{Type: "get_active_workers"})
	if err != nil {
		http.Error(w, "control API error", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(data)
}

// handleHistory proxies the browser's stored-history request to teleclaude's
// control API (get_history), matching the embedded server's /api/history so the
// shared app.js works identically here.
func (s *browserServer) handleHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "telegram"
	}
	tgt, _ := json.Marshal(map[string]string{
		"kind": kind, "project": r.URL.Query().Get("project"), "id": r.URL.Query().Get("id"),
	})
	data, err := s.control.request(controlIn{Type: "get_history", Target: json.RawMessage(tgt)})
	if err != nil {
		http.Error(w, "control API error", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(data)
}

// handleWebconvRename renames a web conversation and WAITS for teleclaude to
// confirm the write landed, so the browser can refresh its list only after the
// new title is durable. The old path was a fire-and-forget ws.send with no ack,
// which let a fast page reload re-fetch /api/conversations before the rename
// finished and show the stale title. Uses s.control.request (blocks for the
// reply / times out) rather than s.control.send.
func (s *browserServer) handleWebconvRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	data, err := s.control.request(controlIn{Type: "web_rename", ID: body.ID, Title: body.Title, Origin: "web"})
	if err != nil {
		http.Error(w, "control API error", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(data)
}

func (s *browserServer) handleChannelBackend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		Kind    string `json:"kind"`
		ID      string `json:"id"`
		Backend string `json:"backend"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	data, err := s.control.request(buildSetChannelBackendControlIn(body.Kind, body.ID, body.Backend))
	if err != nil {
		http.Error(w, "control API error", http.StatusBadGateway)
		return
	}
	var m struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(data, &m)
	if m.OK {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Error(w, m.Error, http.StatusBadRequest)
}

// --- Admin endpoints (proxied to teleclaude via the control API) -------------
// aglink-chat is the primary frontend, so it exposes the same /api/* the
// embedded teleclaude web server does. Version/config/aux data lives in
// teleclaude; we relay it. All require the browser token (authOK).

func (s *browserServer) proxyControl(w http.ResponseWriter, req controlIn) {
	data, err := s.control.request(req)
	if err != nil {
		http.Error(w, "control API error", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(data)
}

func (s *browserServer) handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.proxyControl(w, controlIn{Type: "get_version"})
}

func (s *browserServer) handleAux(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.proxyControl(w, controlIn{Type: "get_aux"})
}

// handleCapabilities marks aglink-chat as admin-capable (it is the primary
// frontend) and folds in the version payload so the badge renders immediately.
func (s *browserServer) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	m := map[string]any{}
	if data, err := s.control.request(controlIn{Type: "get_version"}); err == nil {
		_ = json.Unmarshal(data, &m)
	}
	m["admin"] = true
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(m)
}

func (s *browserServer) handleConfig(w http.ResponseWriter, r *http.Request) {
	if !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodGet:
		data, err := s.control.request(controlIn{Type: "get_config"})
		if err != nil {
			http.Error(w, "control API error", http.StatusBadGateway)
			return
		}
		var m struct {
			Config string `json:"config"`
			Error  string `json:"error"`
		}
		_ = json.Unmarshal(data, &m)
		if m.Error != "" {
			http.Error(w, m.Error, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(m.Config))
	case http.MethodPut:
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		data, err := s.control.request(controlIn{Type: "set_config", Body: string(body)})
		if err != nil {
			http.Error(w, "control API error", http.StatusBadGateway)
			return
		}
		var m struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &m)
		if m.OK {
			w.WriteHeader(http.StatusNoContent)
		} else {
			http.Error(w, m.Error, http.StatusBadRequest)
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleSettings proxies the structured settings schema/update to teleclaude via
// the control API (get_settings / set_settings). GET returns the schema JSON;
// PUT sends a JSON updates map and maps the {ok,error} reply to 204/400.
func (s *browserServer) handleSettings(w http.ResponseWriter, r *http.Request) {
	if !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodGet:
		data, err := s.control.request(controlIn{Type: "get_settings"})
		if err != nil {
			http.Error(w, "control API error", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	case http.MethodPut:
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		data, err := s.control.request(controlIn{Type: "set_settings", Body: string(body)})
		if err != nil {
			http.Error(w, "control API error", http.StatusBadGateway)
			return
		}
		var m struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &m)
		if m.OK {
			w.WriteHeader(http.StatusNoContent)
		} else {
			http.Error(w, m.Error, http.StatusBadRequest)
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleStatus reports this frontend's own bind address for the "이 웹 서버"
// panel section (aglink helper status comes from /api/aux).
func (s *browserServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{"webChatAddr": s.addr})
}

// handleUpload saves the uploaded file under ~/.teleclaude/attachments (shared
// with teleclaude on the same machine), then relays its path via the control
// API's upload_attachment (teleclaude ingests it through the same pipeline the
// embedded server used). Mirrors teleclaude's webchat handleUpload.
func (s *browserServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !s.authOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	file, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "no file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	home, err := os.UserHomeDir()
	if err != nil {
		http.Error(w, "no home", http.StatusInternalServerError)
		return
	}
	dir := filepath.Join(home, ".teleclaude", "attachments")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, "mkdir failed", http.StatusInternalServerError)
		return
	}
	ext := filepath.Ext(hdr.Filename)
	savePath := filepath.Join(dir, fmt.Sprintf("%d%s", time.Now().UnixMilli(), ext))
	out, err := os.Create(savePath)
	if err != nil {
		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}
	defer out.Close()
	if _, err := io.Copy(out, file); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	var target json.RawMessage
	if raw := strings.TrimSpace(r.FormValue("target")); raw != "" {
		target = json.RawMessage(raw)
	}
	if err := s.control.send(buildUploadControlIn(savePath, r.FormValue("caption"), target)); err != nil {
		http.Error(w, "control send failed", http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *browserServer) handleIndex(w http.ResponseWriter, r *http.Request) {
	// Serve the SPA shell for the app routes. app.js reads location.pathname and
	// renders the chat view or the /setting view. Anything else is a real 404.
	if r.URL.Path != "/" && r.URL.Path != "/setting" {
		http.NotFound(w, r)
		return
	}
	b, err := webFS.ReadFile("web/index.html")
	if err != nil {
		http.Error(w, "ui missing", http.StatusInternalServerError)
		return
	}
	// Inject the current valid token so the page authenticates regardless of the
	// URL's ?token=, stale localStorage, or which loopback host was opened —
	// critical after the frontend swap so a browser that was on teleclaude's
	// embedded server keeps working. Loopback-only + same-origin (CORS) keeps the
	// token unreadable to cross-origin pages. json.Marshal escapes it for <script>.
	tokJSON, _ := json.Marshal(s.token)
	inject := []byte("<script>window.__TC_TOKEN__=" + string(tokJSON) + ";</script></head>")
	b = bytes.Replace(b, []byte("</head>"), inject, 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, must-revalidate")
	_, _ = w.Write(b)
}

func (s *browserServer) Start(ctx context.Context) error {
	staticSub, err := fs.Sub(webFS, "web")
	if err != nil {
		return err
	}
	// noStore forces the browser to refetch web assets so a normal refresh never
	// runs stale app.js against a freshly deployed server.
	noStore := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store, must-revalidate")
			h.ServeHTTP(w, r)
		})
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/conversations", s.handleConversations)
	mux.HandleFunc("/api/workers", s.handleWorkers)
	mux.HandleFunc("/api/history", s.handleHistory)
	mux.HandleFunc("/api/webconv/rename", s.handleWebconvRename)
	mux.HandleFunc("/api/channel/backend", s.handleChannelBackend)
	mux.HandleFunc("/api/upload", s.handleUpload)
	mux.HandleFunc("/api/capabilities", s.handleCapabilities)
	mux.HandleFunc("/api/version", s.handleVersion)
	mux.HandleFunc("/api/aux", s.handleAux)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/api/settings", s.handleSettings)
	mux.Handle("/static/", noStore(http.StripPrefix("/static/", http.FileServer(http.FS(staticSub)))))
	mux.HandleFunc("/", s.handleIndex)

	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	log.Printf("[aglink-chat] browser UI on http://%s/?token=%s", s.addr, s.token)
	srv := &http.Server{Handler: mux}

	// Also serve the IPv6 loopback (::1) so a browser that resolves "localhost" to
	// IPv6 — common on Windows/Chrome — can connect. Best-effort: IPv4 still works
	// if this bind fails (e.g. IPv6 disabled). Mirrors teleclaude's old server so
	// an already-open tab reconnects seamlessly after the frontend swap.
	if v6 := ipv6LoopbackAddr(s.addr); v6 != "" {
		if ln6, err6 := net.Listen("tcp", v6); err6 != nil {
			log.Printf("[aglink-chat] IPv6 loopback %s not bound: %v (IPv4 still served)", v6, err6)
		} else {
			log.Printf("[aglink-chat] also http://%s/", v6)
			go func() { _ = srv.Serve(ln6) }()
		}
	}

	// Graceful shutdown: on ctx cancel (SIGINT/SIGTERM relayed by the caller),
	// drain in-flight requests and close both listeners so the process exits
	// cleanly instead of being killed mid-write. srv.Shutdown covers every
	// listener this srv serves (IPv4 + the IPv6 mirror above).
	go func() {
		<-ctx.Done()
		log.Printf("[aglink-chat] 종료 신호 수신 — graceful shutdown 중…")
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// ipv6LoopbackAddr returns the "[::1]:port" form of an IPv4-loopback / localhost
// listen address, or "" if addr is not one we should mirror onto IPv6.
func ipv6LoopbackAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}
	if host == "127.0.0.1" || strings.EqualFold(host, "localhost") {
		return net.JoinHostPort("::1", port)
	}
	return ""
}

func genToken() string {
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
