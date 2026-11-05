package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"backend/internal/config"
	"backend/internal/items"
)

// memoryStore keeps items in memory, so these tests need no database.
type memoryStore struct {
	items []items.Item
	err   error
}

func (s *memoryStore) List(context.Context) ([]items.Item, error) { return s.items, s.err }

func (s *memoryStore) Create(_ context.Context, name string) (items.Item, error) {
	if s.err != nil {
		return items.Item{}, s.err
	}
	item := items.Item{ID: int64(len(s.items) + 1), Name: name, CreatedAt: time.Now().UTC()}
	s.items = append(s.items, item)
	return item, nil
}

type testAPI struct {
	handler http.Handler
}

func newAPI(t *testing.T, cfg config.Config, store items.Store, probe func(context.Context) error) testAPI {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return testAPI{New(cfg, store, probe, logger)}
}

func ready(context.Context) error { return nil }

func (a testAPI) do(t *testing.T, method, path, body string) (int, string) {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	a.handler.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}

func TestHealth(t *testing.T) {
	down := func(context.Context) error { return errors.New("down") }
	api := newAPI(t, config.Defaults(), &memoryStore{}, down)
	if code, body := api.do(t, http.MethodGet, "/health/live", ""); code != 200 || !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("live: %d %s", code, body)
	}
	if code, body := api.do(t, http.MethodGet, "/health/ready", ""); code != 503 ||
		!strings.Contains(body, `"status":"not-ready"`) || !strings.Contains(body, `"database":"unavailable"`) {
		t.Fatalf("ready while down: %d %s", code, body)
	}
	up := newAPI(t, config.Defaults(), &memoryStore{}, ready)
	if code, body := up.do(t, http.MethodGet, "/health/ready", ""); code != 200 || !strings.Contains(body, `"status":"ready"`) {
		t.Fatalf("ready: %d %s", code, body)
	}
}

func TestItems(t *testing.T) {
	api := newAPI(t, config.Defaults(), &memoryStore{}, ready)
	if code, body := api.do(t, http.MethodGet, "/items", ""); code != 200 || strings.TrimSpace(body) != "[]" {
		t.Fatalf("empty list: %d %s", code, body)
	}
	code, body := api.do(t, http.MethodPost, "/items", `{"name":"first"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	var created struct {
		ID        int64  `json:"id"`
		Name      string `json:"name"`
		CreatedAt string `json:"created_at"`
	}
	if err := json.Unmarshal([]byte(body), &created); err != nil || created.ID != 1 || created.Name != "first" {
		t.Fatalf("created item: %s (%v)", body, err)
	}
	if _, err := time.Parse(time.RFC3339, created.CreatedAt); err != nil {
		t.Fatalf("created_at: %v", err)
	}
	if code, body := api.do(t, http.MethodGet, "/items", ""); code != 200 || !strings.Contains(body, `"name":"first"`) {
		t.Fatalf("list: %d %s", code, body)
	}
	for _, payload := range []string{`{}`, `{"name":""}`, `{"name":"` + strings.Repeat("x", 201) + `"}`, `{"name":"x","extra":1}`} {
		if code, body := api.do(t, http.MethodPost, "/items", payload); code != http.StatusUnprocessableEntity {
			t.Fatalf("accepted %s: %d %s", payload, code, body)
		}
	}
}

func TestItemsReportStoreFailures(t *testing.T) {
	api := newAPI(t, config.Defaults(), &memoryStore{err: errors.New("database gone")}, ready)
	if code, _ := api.do(t, http.MethodGet, "/items", ""); code != http.StatusInternalServerError {
		t.Fatalf("list with a failing store: %d", code)
	}
	if code, _ := api.do(t, http.MethodPost, "/items", `{"name":"x"}`); code != http.StatusInternalServerError {
		t.Fatalf("create with a failing store: %d", code)
	}
}

func TestDocs(t *testing.T) {
	api := newAPI(t, config.Defaults(), &memoryStore{}, ready)
	code, body := api.do(t, http.MethodGet, "/openapi.json", "")
	if code != 200 {
		t.Fatalf("openapi: %d", code)
	}
	var document struct {
		OpenAPI string                     `json:"openapi"`
		Info    struct{ Title string }     `json:"info"`
		Paths   map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal([]byte(body), &document); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/health/live", "/health/ready", "/items"} {
		if _, ok := document.Paths[path]; !ok {
			t.Fatalf("OpenAPI document lacks %s", path)
		}
	}
	if !strings.HasPrefix(document.OpenAPI, "3.1") {
		t.Fatalf("OpenAPI version %s", document.OpenAPI)
	}
	if code, body := api.do(t, http.MethodGet, "/docs", ""); code != 200 || !strings.Contains(body, "scalar") {
		t.Fatalf("docs: %d", code)
	}

	cfg := config.Defaults()
	cfg.DocsEnabled = false
	off := newAPI(t, cfg, &memoryStore{}, ready)
	for _, path := range []string{"/openapi.json", "/docs"} {
		if code, _ := off.do(t, http.MethodGet, path, ""); code != http.StatusNotFound {
			t.Fatalf("%s with docs off: %d", path, code)
		}
	}
}
