package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// wsFrame is the browser-facing envelope (identical to teleclaude's), forwarded
// verbatim to browsers.
type wsFrame struct {
	Type    string `json:"type"`
	Text    string `json:"text,omitempty"`
	Caption string `json:"caption,omitempty"`
	Data    string `json:"data,omitempty"`
	// Target names the conversation the frame belongs to. The browser renders both
	// the telegram stream and web topics, so without this it would append every
	// frame to whatever conversation is on screen. A missing target means the
	// telegram stream. Decoded and re-encoded here, so the field must exist.
	Target *frameTarget `json:"target,omitempty"`
}

// frameTarget mirrors teleclaude's Target.
type frameTarget struct {
	Kind    string `json:"kind"`
	Project string `json:"project,omitempty"`
	ID      string `json:"id,omitempty"`
}

// controlOut is what teleclaude's control API sends us: a browser frame or a reply.
type controlOut struct {
	Kind  string          `json:"kind"` // "frame" | "reply"
	Frame *wsFrame        `json:"frame,omitempty"`
	ReqID string          `json:"reqID,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// controlIn is what we send to teleclaude's control API.
type controlIn struct {
	Type    string          `json:"type"`
	ReqID   string          `json:"reqID,omitempty"`
	ChatID  int64           `json:"chatID,omitempty"`
	Text    string          `json:"text,omitempty"`
	Origin  string          `json:"origin,omitempty"`
	Path    string          `json:"path,omitempty"`
	Caption string          `json:"caption,omitempty"`
	ID      string          `json:"id,omitempty"`
	Title   string          `json:"title,omitempty"`
	Target  json.RawMessage `json:"target,omitempty"`
	Body    string          `json:"body,omitempty"` // set_config: edited config.yaml text
}

// controlClient maintains one connection to teleclaude's loopback control API,
// reconnecting with backoff (same pattern aglink-web uses for its Chrome keepalive).
// Outbound frames are broadcast to browsers; replies resolve pending requests.
type controlClient struct {
	addr, token string
	hub         *browserHub

	writeMu sync.Mutex
	connMu  sync.RWMutex
	conn    *websocket.Conn

	pendMu  sync.Mutex
	pending map[string]chan json.RawMessage
	seq     atomic.Uint64
}

func newControlClient(addr, token string, hub *browserHub) *controlClient {
	return &controlClient{addr: addr, token: token, hub: hub, pending: map[string]chan json.RawMessage{}}
}

func (c *controlClient) run(ctx context.Context) {
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		err := c.connectOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		log.Printf("[control] disconnected (%v); reconnecting in %s", err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func (c *controlClient) connectOnce(ctx context.Context) error {
	u := "ws://" + c.addr + "/control?token=" + url.QueryEscape(c.token)
	dctx, dcancel := context.WithTimeout(ctx, 10*time.Second)
	conn, _, err := websocket.Dial(dctx, u, nil)
	dcancel()
	if err != nil {
		return err
	}
	// coder/websocket defaults to a 32KiB read limit, which a full get_history
	// reply (e.g. the telegram stream after many turns) can exceed — the read
	// then fails with "message too big", silently dropping the connection (and
	// with it every in-flight request(), which only surfaces 10s later as a
	// generic timeout). History payloads are plain JSON text with no attachment
	// data, so 8MiB is a large, cheap ceiling rather than a tight fit.
	conn.SetReadLimit(8 << 20)
	c.setConn(conn)
	defer c.setConn(nil)
	defer conn.Close(websocket.StatusNormalClosure, "")
	log.Printf("[control] connected to teleclaude at %s", c.addr)

	for {
		var o controlOut
		if rerr := wsjson.Read(ctx, conn, &o); rerr != nil {
			return rerr
		}
		switch o.Kind {
		case "frame":
			if o.Frame != nil {
				c.hub.broadcast(*o.Frame)
			}
		case "reply":
			c.deliverReply(o.ReqID, o.Data)
		}
	}
}

func (c *controlClient) setConn(conn *websocket.Conn) {
	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()
}
func (c *controlClient) getConn() *websocket.Conn {
	c.connMu.RLock()
	defer c.connMu.RUnlock()
	return c.conn
}

func (c *controlClient) send(m controlIn) error {
	conn := c.getConn()
	if conn == nil {
		return errors.New("control API not connected")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return wsjson.Write(wctx, conn, m)
}

// request sends a message with a fresh reqID and waits for the matching reply.
func (c *controlClient) request(m controlIn) (json.RawMessage, error) {
	id := fmt.Sprintf("r%d", c.seq.Add(1))
	m.ReqID = id
	rc := make(chan json.RawMessage, 1)
	c.pendMu.Lock()
	c.pending[id] = rc
	c.pendMu.Unlock()
	defer func() {
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
	}()
	if err := c.send(m); err != nil {
		return nil, err
	}
	select {
	case data := <-rc:
		return data, nil
	case <-time.After(10 * time.Second):
		return nil, errors.New("control request timed out")
	}
}

func (c *controlClient) deliverReply(id string, data json.RawMessage) {
	c.pendMu.Lock()
	rc := c.pending[id]
	c.pendMu.Unlock()
	if rc != nil {
		select {
		case rc <- data:
		default:
		}
	}
}
