package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"backend/internal/config"
)

func environment(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}

func TestServesUntilCancelled(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	// No database is needed to start: the pool connects on first use.
	go func() { done <- serve(ctx, config.Defaults(), listener) }()

	port := listener.Addr().(*net.TCPAddr).Port
	var response *http.Response
	for attempt := 0; attempt < 50; attempt++ {
		if response, err = http.Get(fmt.Sprintf("http://127.0.0.1:%d/health/live", port)); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("live: %v %v", response, err)
	}
	response.Body.Close()
	if err := healthcheck(context.Background(), port); err != nil {
		t.Fatalf("healthcheck against a live API: %v", err)
	}

	// Shutdown waits for open connections, so the client closes its idle ones.
	http.DefaultClient.CloseIdleConnections()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not stop")
	}
}

func TestHealthcheckFailsWhenNotLive(t *testing.T) {
	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer unhealthy.Close()
	port, _ := strconv.Atoi(unhealthy.URL[strings.LastIndex(unhealthy.URL, ":")+1:])
	if err := run(context.Background(), []string{"healthcheck"}, environment(map[string]string{"APP_PORT": strconv.Itoa(port)})); err == nil {
		t.Fatal("healthcheck passed against an unhealthy API")
	}
	unhealthy.Close()
	if err := healthcheck(context.Background(), port); err == nil {
		t.Fatal("healthcheck passed with nothing listening")
	}
}

func TestRejectsBadArgumentsAndConfiguration(t *testing.T) {
	if err := run(context.Background(), []string{"launch"}, environment(nil)); err == nil ||
		!strings.Contains(err.Error(), "use no arguments, migrate or healthcheck") {
		t.Fatalf("unknown command: %v", err)
	}
	if err := run(context.Background(), nil, environment(map[string]string{"APP_PORT": "eighty"})); err == nil {
		t.Fatal("started with an invalid port")
	}
	cfg := config.Defaults()
	cfg.DatabaseURL = "not a url ::"
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := serve(context.Background(), cfg, listener); err == nil {
		t.Fatal("served with an invalid database URL")
	}
}
