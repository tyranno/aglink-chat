package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestClient() *controlClient {
	return &controlClient{token: "t", pending: map[string]chan json.RawMessage{}}
}

// A request issued while the control socket is down must fail fast and leave no
// pending entry behind — otherwise every failed reload would grow the map and
// park an HTTP handler.
func TestControlClient_RequestWithNoConnectionFailsAndReleasesPending(t *testing.T) {
	c := newTestClient()

	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := c.request(controlIn{Type: "list_conversations"}); err == nil {
			t.Error("request must fail when the control API is not connected")
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("request blocked instead of failing fast")
	}

	c.pendMu.Lock()
	n := len(c.pending)
	c.pendMu.Unlock()
	if n != 0 {
		t.Errorf("pending holds %d entry(ies) after a failed request", n)
	}
}

// A reply that arrives after its caller gave up must not block the reader loop,
// and a reply for an id nobody is waiting on must not panic.
func TestControlClient_DeliverReplyIsNonBlocking(t *testing.T) {
	c := newTestClient()

	done := make(chan struct{})
	go func() {
		defer close(done)
		c.deliverReply("nobody-waiting", json.RawMessage(`{}`))
		// Two replies for one id: the buffered slot takes the first, the second
		// must be dropped rather than park the reader loop forever.
		rc := make(chan json.RawMessage, 1)
		c.pendMu.Lock()
		c.pending["r1"] = rc
		c.pendMu.Unlock()
		c.deliverReply("r1", json.RawMessage(`{"a":1}`))
		c.deliverReply("r1", json.RawMessage(`{"a":2}`))
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("deliverReply blocked the reader loop")
	}
}

// The browser token is compared in constant time, accepted from either the query
// string or a bearer header, and never satisfied by an empty value on either
// side.
func TestBrowserServer_TokenOK(t *testing.T) {
	s := &browserServer{token: "secret"}

	query := httptest.NewRequest(http.MethodGet, "/ws?token=secret", nil)
	if !s.tokenOK(query) {
		t.Error("query token should be accepted")
	}
	bearer := httptest.NewRequest(http.MethodGet, "/api/conversations", nil)
	bearer.Header.Set("Authorization", "Bearer secret")
	if !s.tokenOK(bearer) {
		t.Error("bearer token should be accepted")
	}

	for name, r := range map[string]*http.Request{
		"missing":     httptest.NewRequest(http.MethodGet, "/ws", nil),
		"wrong":       httptest.NewRequest(http.MethodGet, "/ws?token=nope", nil),
		"empty query": httptest.NewRequest(http.MethodGet, "/ws?token=", nil),
		"prefix":      httptest.NewRequest(http.MethodGet, "/ws?token=secretx", nil),
		"truncated":   httptest.NewRequest(http.MethodGet, "/ws?token=secre", nil),
	} {
		if s.tokenOK(r) {
			t.Errorf("%s token must be rejected", name)
		}
	}

	// A server with no token configured must reject everything, not accept it.
	none := &browserServer{token: ""}
	if none.tokenOK(query) {
		t.Error("an unconfigured token must never authenticate a request")
	}
}
