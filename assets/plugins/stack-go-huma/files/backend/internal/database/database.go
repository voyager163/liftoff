// Package database connects to PostgreSQL and applies the migrations.
package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var embedded embed.FS

// Migrations are the SQL migrations built into the binary.
func Migrations() fs.FS {
	migrations, err := fs.Sub(embedded, "migrations")
	if err != nil {
		panic(err) // the directory is embedded above, so this cannot fail
	}
	return migrations
}

// Connect returns a pool for the API. Connections open on first use; one
// that fails is closed and replaced on next use.
func Connect(ctx context.Context, url string, timeout time.Duration) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("database_url is not a valid PostgreSQL URL: %w", err)
	}
	config.ConnConfig.ConnectTimeout = timeout
	return pgxpool.NewWithConfig(ctx, config)
}

// Migrate applies every migration that has not run yet.
func Migrate(ctx context.Context, url string, timeout time.Duration) error {
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return fmt.Errorf("database_url is not a valid PostgreSQL URL: %w", err)
	}
	config.ConnectTimeout = timeout
	db := stdlib.OpenDB(*config)
	defer db.Close()
	provider, err := NewMigrator(db)
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}

// NewMigrator runs the built-in migrations against db.
func NewMigrator(db *sql.DB) (*goose.Provider, error) {
	return goose.NewProvider(goose.DialectPostgres, db, Migrations())
}
