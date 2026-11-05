// Command api runs the API.
//
//	api              serve the API on the configured host and port
//	api migrate      apply the database migrations
//	api healthcheck  exit 0 when the API on this machine is live (for containers)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"backend/internal/config"
	"backend/internal/database"
	"backend/internal/health"
	"backend/internal/items"
	"backend/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.LookupEnv); err != nil {
		fmt.Fprintln(os.Stderr, "api:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, lookup func(string) (string, bool)) error {
	cfg, err := config.Load(lookup)
	if err != nil {
		return err
	}
	command := ""
	if len(args) > 0 {
		command = args[0]
	}
	switch {
	case command == "" && len(args) == 0:
		listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
		if err != nil {
			return err
		}
		return serve(ctx, cfg, listener)
	case command == "migrate" && len(args) == 1:
		return database.Migrate(ctx, cfg.DatabaseURL, cfg.DatabaseTimeout())
	case command == "healthcheck" && len(args) == 1:
		return healthcheck(ctx, cfg.Port)
	default:
		return fmt.Errorf("unknown arguments %q; use no arguments, migrate or healthcheck", args)
	}
}

func serve(ctx context.Context, cfg config.Config, listener net.Listener) error {
	level := new(slog.LevelVar)
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	pool, err := database.Connect(ctx, cfg.DatabaseURL, cfg.DatabaseTimeout())
	if err != nil {
		return err
	}
	defer pool.Close()

	handler := server.New(cfg, items.PostgresStore{Pool: pool},
		health.DatabaseProbe(cfg.DatabaseURL, cfg.DatabaseTimeout()), logger)
	return serveHTTP(ctx, handler, listener, logger, 10*time.Second)
}

// serveHTTP serves until ctx is cancelled, then lets running requests finish
// for up to grace. Requests still running after that are cancelled, so
// nothing they wait for, such as a query to a database that stopped
// answering, can keep the process or its connections open.
func serveHTTP(ctx context.Context, handler http.Handler, listener net.Listener, logger *slog.Logger, grace time.Duration) error {
	requests, cancelRequests := context.WithCancel(context.Background())
	defer cancelRequests()
	httpServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return requests },
	}
	failed := make(chan error, 1)
	go func() { failed <- httpServer.Serve(listener) }()
	logger.Info("listening", "address", listener.Addr().String())

	select {
	case err := <-failed:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	err := httpServer.Shutdown(shutdown)
	if errors.Is(err, context.DeadlineExceeded) {
		logger.Warn("cancelled requests still running after the shutdown grace period", "grace", grace)
		cancelRequests()
		return httpServer.Close()
	}
	return err
}

func healthcheck(ctx context.Context, port int) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	url := fmt.Sprintf("http://127.0.0.1:%d/health/live", port)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d", url, response.StatusCode)
	}
	return nil
}
