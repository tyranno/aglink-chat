package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
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

	// SIGINT/SIGTERM cancel ctx → the control client stops reconnecting and the
	// browser server drains and closes, so teleclaude's supervisor sees a clean
	// exit (and `!update`'s kill lets go of the .exe lock promptly) instead of a
	// hard kill mid-request.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hub := newBrowserHub()
	control := newControlClient(*controlAddr, ctok, hub)
	go control.run(ctx)

	srv := &browserServer{addr: *addr, token: btok, control: control, hub: hub}
	if err := srv.Start(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "server: %v\n", err)
		os.Exit(1)
	}
}

func defaultControlTokenPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".teleclaude", "chat_control.token")
}
