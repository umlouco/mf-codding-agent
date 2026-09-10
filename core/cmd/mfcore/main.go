// Command mfcore is the compiled backend for the MF Agent VS Code extension.
//
// It speaks newline-delimited JSON-RPC 2.0 over stdio. Everything that matters
// lives here — the agent loop, tools, graph memory, MCP clients and browser
// control — so the TypeScript side stays a thin transport and UI shell.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/mflores/mfagent/core/internal/agent"
	"github.com/mflores/mfagent/core/internal/browser"
	"github.com/mflores/mfagent/core/internal/cognition"
	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/mcp"
	"github.com/mflores/mfagent/core/internal/memory"
	"github.com/mflores/mfagent/core/internal/rpc"
	"github.com/mflores/mfagent/core/internal/tools"
)

var version = "0.1.0"

type server struct {
	conn      *rpc.Conn
	cfg       *config.Config
	registry  *tools.Registry
	env       *tools.Env
	mem       *memory.Store
	cognition *cognition.Store
	mcpMgr    *mcp.Manager
	brw       *browser.Browser
	ag        *agent.Agent

	sessionMu sync.Mutex
	curSess   string
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "testing-hook" {
		os.Exit(runTestingHook(os.Stdin, os.Stderr))
	}
	// Subcommands are checked before flag parsing so `mfcore sh` can own its own
	// flags. With no subcommand this is the JSON-RPC server it has always been.
	if len(os.Args) > 1 && os.Args[1] == "sh" {
		os.Exit(runSh(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "scan" {
		os.Exit(runScan(os.Args[2:]))
	}

	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	out := bufio.NewWriterSize(os.Stdout, 1<<16)
	conn := rpc.NewConn(os.Stdin, out)

	s := &server{
		conn:     conn,
		registry: tools.NewRegistry(),
		mcpMgr:   mcp.NewManager(),
	}
	s.register()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		s.shutdown()
		cancel()
		os.Exit(0)
	}()

	if err := conn.Serve(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "mfcore:", err)
	}
	s.shutdown()
}

func (s *server) shutdown() {
	if s.mcpMgr != nil {
		s.mcpMgr.CloseAll()
	}
	if s.brw != nil {
		s.brw.Close()
	}
	if s.mem != nil {
		_ = s.mem.Close()
	}
	if s.cognition != nil {
		_ = s.cognition.Close()
	}
	tools.KillAllBgProcs()
}

func (s *server) log(level, msg string) {
	_ = s.conn.Notify("log", map[string]any{"level": level, "message": msg})
}

func (s *server) register() {
	s.conn.Register("initialize", s.onInitialize)
	// A chat turn runs for minutes; it must not block cancels or the
	// permission round-trip, so it needs asynchronous dispatch.
	s.conn.RegisterAsync("chat/send", s.onSend)
	s.conn.Register("chat/cancel", s.onCancel)
	s.conn.Register("chat/steer", s.onSteer)
	s.conn.Register("chat/reset", s.onReset)
	s.conn.Register("tools/list", s.onToolsList)
	// File and editor tools call back into the host; keep reading their replies.
	s.conn.RegisterAsync("tools/invoke", s.onToolsInvoke)
	s.conn.Register("memory/stats", s.onMemoryStats)
	s.conn.Register("memory/graph", s.onMemoryGraph)
	s.conn.Register("memory/search", s.onMemorySearch)
	s.conn.Register("memory/forget", s.onMemoryForget)
	s.conn.Register("memory/lessons", s.onMemoryLessons)
	s.conn.Register("memory/lessonUpsert", s.onMemoryLessonUpsert)
	s.conn.Register("memory/lessonDelete", s.onMemoryLessonDelete)
	s.conn.Register("mcp/status", s.onMCPStatus)
	s.conn.Register("browser/close", s.onBrowserClose)
	s.conn.Register("shutdown", func(ctx context.Context, _ json.RawMessage) (any, error) {
		s.shutdown()
		return map[string]any{"ok": true}, nil
	})
}
