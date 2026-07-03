package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: aglink-chat <serve>")
		os.Exit(1)
	}
	switch os.Args[1] {
	case "serve":
		serveCmd(os.Args[2:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func serveCmd(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:1717", "browser-facing HTTP/WS address")
	controlAddr := fs.String("control-addr", "127.0.0.1:17170", "teleclaude control-API address to connect to")
	controlToken := fs.String("control-token", "", "teleclaude control token (default: read ~/.teleclaude/chat_control.token)")
	token := fs.String("token", "", "browser auth token (default: generated + printed)")
	_ = fs.Parse(args)

	ctok := *controlToken
	if ctok == "" {
		if b, err := os.ReadFile(defaultControlTokenPath()); err == nil {
			ctok = strings.TrimSpace(string(b))
		}
	}
	if ctok == "" {
		fmt.Fprintln(os.Stderr, "no control token: pass --control-token or ensure ~/.teleclaude/chat_control.token exists (start teleclaude with chat_control.enabled: true first)")
		os.Exit(1)
	}

	btok := *token
	if btok == "" {
		btok = genToken()
	}

	hub := newBrowserHub()
	control := newControlClient(*controlAddr, ctok, hub)
	go control.run(context.Background())

	srv := &browserServer{addr: *addr, token: btok, control: control, hub: hub}
	if err := srv.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "server: %v\n", err)
		os.Exit(1)
	}
}

func defaultControlTokenPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".teleclaude", "chat_control.token")
}
