package database

import (
	"context"
	"io/fs"
	"testing"
	"time"
)

func TestMigrationsAreBuiltIn(t *testing.T) {
	names, err := fs.Glob(Migrations(), "*.sql")
	if err != nil || len(names) == 0 || names[0] != "00001_create_items.sql" {
		t.Fatalf("migrations: %v %v", names, err)
	}
}

func TestReportsUnusableDatabases(t *testing.T) {
	ctx := context.Background()
	if _, err := Connect(ctx, "not a url ::", time.Second); err == nil {
		t.Fatal("connected with an invalid URL")
	}
	if err := Migrate(ctx, "not a url ::", time.Second); err == nil {
		t.Fatal("migrated with an invalid URL")
	}
	// Nothing listens on port 1.
	if err := Migrate(ctx, "postgresql://app@127.0.0.1:1/app", time.Second); err == nil {
		t.Fatal("migrated a database that is not there")
	}
}
