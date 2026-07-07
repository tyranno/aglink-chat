package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
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
	Type   string          `json:"type"`
	Text   string          `json:"text"`
	ID     string          `json:"id,omitempty"`
	Title  string          `json:"title,omitempty"`
	Path   string          `json:"path,omitempty"`
	Target json.RawMessage `json:"target,omitempty"`
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
			s.forwardSend(m.Text)
		case "web_new":
			_ = s.control.send(controlIn{Type: "web_new", Title: m.Title, Origin: "web"})
		case "web_setdir":
			_ = s.control.send(controlIn{Type: "web_setdir", ID: m.ID, Path: m.Path, Origin: "web"})
		case "web_rename":
			_ = s.control.send(controlIn{Type: "web_rename", ID: m.ID, Title: m.Title, Origin: "web"})
		case "web_delete":
			_ = s.control.send(controlIn{Type: "web_delete", ID: m.ID, Origin: "web"})
		}
	}
	cancel()
}

// forwardSend relays a browser's typed input to teleclaude's control API. Commands
// go via handle_command, everything else via send_text; teleclaude fills in the
// owner chatID (we send 0) and applies rate-limiting / origin tagging / echo.
func (s *browserServer) forwardSend(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	m := controlIn{Text: text, Origin: "web"}
	if strings.HasPrefix(text, "!") {
		m.Type = "handle_command"
	} else {
		m.Type = "send_text"
	}
	if err := s.control.send(m); err != nil {
		log.Printf("[browser] forward send failed: %v", err)
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

func (s *browserServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	// Next round: save the multipart file to disk, then control upload_attachment
	// {path,caption}. Kept a clean 501 for now so the roundtrip milestone is minimal.
	http.Error(w, "file upload not yet implemented in aglink-chat", http.StatusNotImplemented)
}

func (s *browserServer) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	b, err := webFS.ReadFile("web/index.html")
	if err != nil {
		http.Error(w, "ui missing", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *browserServer) Start() error {
	staticSub, err := fs.Sub(webFS, "web")
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/conversations", s.handleConversations)
	mux.HandleFunc("/api/history", s.handleHistory)
	mux.HandleFunc("/api/upload", s.handleUpload)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticSub))))
	mux.HandleFunc("/", s.handleIndex)

	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	log.Printf("[aglink-chat] browser UI on http://%s/?token=%s", s.addr, s.token)
	srv := &http.Server{Handler: mux}
	return srv.Serve(ln)
}

func genToken() string {
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
