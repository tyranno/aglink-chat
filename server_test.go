package main

import (
	"encoding/json"
	"testing"
)

// The browser's target must survive the relay to teleclaude. Dropping it made
// teleclaude fall back to the global telegram stream, so every message typed
// into a web topic ran as a Telegram turn.
func TestBuildSendControlIn_RelaysTarget(t *testing.T) {
	tgt := json.RawMessage(`{"kind":"web","id":"conv-7"}`)

	m, ok := buildSendControlIn("hello", tgt)
	if !ok {
		t.Fatal("non-empty text should be sent")
	}
	if m.Type != "send_text" {
		t.Errorf("type = %q, want send_text", m.Type)
	}
	if m.Origin != "web" {
		t.Errorf("origin = %q, want web", m.Origin)
	}
	if string(m.Target) != string(tgt) {
		t.Errorf("target = %s, want %s", m.Target, tgt)
	}
}

// Commands carry the target too — a "!" message typed in a web topic belongs to
// that topic, not to the telegram stream.
func TestBuildSendControlIn_CommandKeepsTarget(t *testing.T) {
	tgt := json.RawMessage(`{"kind":"web","id":"conv-7"}`)

	m, ok := buildSendControlIn("!status", tgt)
	if !ok {
		t.Fatal("command should be sent")
	}
	if m.Type != "handle_command" {
		t.Errorf("type = %q, want handle_command", m.Type)
	}
	if string(m.Target) != string(tgt) {
		t.Errorf("target = %s, want %s", m.Target, tgt)
	}
}

// A browser with no conversation selected sends no target; teleclaude then
// defaults to the telegram stream.
func TestBuildSendControlIn_NilTargetStaysNil(t *testing.T) {
	m, ok := buildSendControlIn("hi", nil)
	if !ok {
		t.Fatal("non-empty text should be sent")
	}
	if m.Target != nil {
		t.Errorf("target = %s, want nil", m.Target)
	}
}

func TestBuildSendControlIn_RejectsBlank(t *testing.T) {
	if _, ok := buildSendControlIn("   ", nil); ok {
		t.Error("blank text must not be sent")
	}
}

func TestBuildSetChannelBackendControlIn(t *testing.T) {
	m := buildSetChannelBackendControlIn("web", "conv-7", "codex")
	if m.Type != "set_channel_backend" {
		t.Errorf("type = %q, want set_channel_backend", m.Type)
	}
	if m.Backend != "codex" {
		t.Errorf("backend = %q, want codex", m.Backend)
	}
	if m.Origin != "web" {
		t.Errorf("origin = %q, want web", m.Origin)
	}
	want := json.RawMessage(`{"id":"conv-7","kind":"web"}`)
	var gotMap, wantMap map[string]string
	_ = json.Unmarshal(m.Target, &gotMap)
	_ = json.Unmarshal(want, &wantMap)
	if gotMap["kind"] != wantMap["kind"] || gotMap["id"] != wantMap["id"] {
		t.Errorf("target = %s, want %s", m.Target, want)
	}
}

func TestBuildUploadControlIn_RelaysTarget(t *testing.T) {
	tgt := json.RawMessage(`{"kind":"web","id":"conv-7"}`)

	m := buildUploadControlIn("C:\\tmp\\image.png", "caption", tgt)

	if m.Type != "upload_attachment" {
		t.Errorf("type = %q, want upload_attachment", m.Type)
	}
	if m.Path != "C:\\tmp\\image.png" {
		t.Errorf("path = %q", m.Path)
	}
	if m.Caption != "caption" {
		t.Errorf("caption = %q", m.Caption)
	}
	if m.Origin != "web" {
		t.Errorf("origin = %q, want web", m.Origin)
	}
	if string(m.Target) != string(tgt) {
		t.Errorf("target = %s, want %s", m.Target, tgt)
	}
}
