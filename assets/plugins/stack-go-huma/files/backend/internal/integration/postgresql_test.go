//go:build integration

// Package integration tests the API against a real PostgreSQL database.
//
// Run them with: APP_DATABASE_URL=... go test -count=1 -tags integration ./internal/integration
// They fail, rather than skip, when no database is configured. Each run works
// in a new schema that is dropped afterwards, so the tables and data already
// in that database are never touched.
package integration

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"backend/internal/config"
	"backend/internal/database"
	"backend/internal/health"
	"backend/internal/items"
	"backend/internal/server"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestAgainstPostgreSQL(t *testing.T) {
	url := os.Getenv("APP_DATABASE_URL")
	if !regexp.MustCompile(`^postgres(ql)?://`).MatchString(url) {
		t.Fatal("integration tests need APP_DATABASE_URL pointing at PostgreSQL")
	}
	ctx := context.Background()
	suffix := make([]byte, 8)
	_, _ = rand.Read(suffix)
	schema := "test_" + hex.EncodeToString(suffix)

	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if _, err := admin.Exec(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(ctx, `DROP SCHEMA "`+schema+`" CASCADE`); err != nil {
			t.Error(err)
		}
	}()

	// Every connection uses only the new schema. SET after connecting wins
	// over anything in the URL.
	poolConfig, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, `SET search_path TO "`+schema+`"`)
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var current string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&current); err != nil || current != schema {
		t.Fatalf("current schema is %q (%v), not %q", current, err, schema)
	}

	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	migrator, err := database.NewMigrator(db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := migrator.Up(ctx); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := httptest.NewServer(server.New(config.Defaults(), items.PostgresStore{Pool: pool},
		health.DatabaseProbe(url, 2*time.Second), logger))
	defer api.Close()

	response, err := http.Get(api.URL + "/health/ready")
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("ready: %v %v", response, err)
	}
	response.Body.Close()
	response, err = http.Post(api.URL+"/items", "application/json", strings.NewReader(`{"name":"from integration"}`))
	if err != nil || response.StatusCode != http.StatusCreated {
		t.Fatalf("create: %v %v", response, err)
	}
	response.Body.Close()
	listed, err := items.PostgresStore{Pool: pool}.List(ctx)
	if err != nil || len(listed) != 1 || listed[0].Name != "from integration" {
		t.Fatalf("list: %v %v", listed, err)
	}

	// The down migration works too.
	if _, err := migrator.DownTo(ctx, 0); err != nil {
		t.Fatal(err)
	}
	var tables int
	if err := pool.QueryRow(ctx,
		"SELECT count(*) FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'items'",
		schema).Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("items table after migrating down: %d (%v)", tables, err)
	}
}
