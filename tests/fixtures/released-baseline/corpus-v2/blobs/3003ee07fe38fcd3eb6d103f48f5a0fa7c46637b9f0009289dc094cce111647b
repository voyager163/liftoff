import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'go' | 'stack'>;
import type { AddArtifact } from '../../template-types.js';


import { renderStandardSchema } from './configuration.js';
import { sourceString } from '../common/values.js';
import type { StandardApiProjectPlan } from '../../domain/project/contracts.js';


export function addGoArtifacts(add: AddArtifact, plan: StandardApiProjectPlan, context: GeneratorContext): void {
  add('go-backend-module', 'backend', ['backend', 'go.mod'], renderGoModule(plan, context));
  add('go-backend-checksums', 'backend', ['backend', 'go.sum'], renderGoChecksums(context));
  add('go-backend-makefile', 'backend', ['backend', 'Makefile'], renderGoMakefile(context));
  add('go-backend-main', 'backend', ['backend', 'cmd', 'api', 'main.go'], renderGoMain(plan));
  add('go-backend-migration-command', 'backend', ['backend', 'cmd', 'migrate', 'main.go'], renderGoMigrationCommand(plan, context));
  add('go-backend-api', 'backend', ['backend', 'internal', 'api', 'api.go'], renderGoApi(plan));
  add('go-backend-config', 'backend', ['backend', 'internal', 'config', 'config.go'], renderGoConfig(plan));
  add('go-runtime-config-example', 'configuration', ['runtime.config.example.json'], JSON.stringify({
    APP_NAME: plan.projectName,
    APP_ENV: 'dev',
    PORT: '8000',
    DATABASE_URL: `postgresql://postgres:postgres@localhost:5432/${plan.safeProjectName.replace(/-/g, '_')}`,
    REDIS_URL: 'redis://localhost:6379/0',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173'
  }, null, 2));
  add('go-backend-database', 'backend', ['backend', 'internal', 'database', 'database.go'], renderGoDatabase());
  add('go-backend-test-health', 'backend-test', ['backend', 'internal', 'api', 'api_test.go'], renderGoHealthTest(plan));
  add('database-go-migration', 'database', ['database', 'migrations', '0001_initial.sql'], renderGoMigration());
  add('database-schema', 'database', ['database', 'models', 'schema.sql'], renderStandardSchema(plan));
}

export function goModule(plan: StandardApiProjectPlan): string {
  return `example.com/${plan.packageName}/backend`;
}

export function renderGoModule(plan: StandardApiProjectPlan, context: GeneratorContext): string {
  return context.go.module;
}

export function renderGoChecksums(context: GeneratorContext): string {
  return context.go.checksums;
}

export function renderGoMakefile(context: GeneratorContext): string {
  return `.PHONY: test migrate

test:
	go test ./...

migrate:
	go run ./cmd/migrate
`;
}

export function renderGoMigrationCommand(plan: StandardApiProjectPlan, context: GeneratorContext): string {
  return `package main

import (
	"log"
	"os"
	"os/exec"

	"${goModule(plan)}/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	command := exec.Command("go", "run", "github.com/pressly/goose/v3/cmd/goose@${context.stack.goModules['go-backend'].tools['github.com/pressly/goose/v3']}", "-dir", "../database/migrations", "up")
	command.Env = append(os.Environ(), "GOOSE_DRIVER=postgres", "GOOSE_DBSTRING="+cfg.DatabaseURL)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		log.Fatal(err)
	}
}
`;
}

export function renderGoMain(plan: StandardApiProjectPlan): string {
  return `package main

import (
	"log"
	"net/http"

	"${goModule(plan)}/internal/api"
	"${goModule(plan)}/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("%s listening on :%s", cfg.AppName, cfg.Port)
	log.Fatal(http.ListenAndServe(":"+cfg.Port, api.New(cfg)))
}
`;
}

export function renderGoApi(plan: StandardApiProjectPlan): string {
  return `package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"${goModule(plan)}/internal/config"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
)

type statusOutput struct {
	Body struct {
		Status string \`json:"status"\`
	}
}

func New(settings config.Config) http.Handler {
	router := chi.NewRouter()
	router.Use(corsMiddleware(configuredOrigins(settings.CORSAllowedOrigins)))
	apiConfig := huma.DefaultConfig(settings.AppName+" API", "0.1.0")
	apiConfig.OpenAPIPath = "/openapi"
	apiConfig.DocsPath = ""
	api := humachi.New(router, apiConfig)

	huma.Get(api, "/health", func(context.Context, *struct{}) (*statusOutput, error) {
		output := &statusOutput{}
		output.Body.Status = "ok"
		return output, nil
	})
	huma.Get(api, "/ready", func(context.Context, *struct{}) (*statusOutput, error) {
		output := &statusOutput{}
		output.Body.Status = "ready"
		return output, nil
	})

	router.Get("/api", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, ${sourceString(JSON.stringify({ name: plan.projectName, stack: 'go-huma' }))})
	})
	router.Get("/scalar", scalarReference)
	return router
}

func configuredOrigins(value string) map[string]struct{} {
	origins := make(map[string]struct{})
	for _, origin := range strings.Split(value, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins[origin] = struct{}{}
		}
	}
	return origins
}

func corsMiddleware(allowedOrigins map[string]struct{}) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			origin := request.Header.Get("Origin")
			_, allowed := allowedOrigins[origin]
			if allowed {
				response.Header().Set("Access-Control-Allow-Origin", origin)
				response.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				response.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				response.Header().Add("Vary", "Origin")
			}
			if request.Method == http.MethodOptions {
				if origin != "" && !allowed {
					http.Error(response, "origin is not allowed", http.StatusForbidden)
					return
				}
				response.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(response, request)
		})
	}
}

func scalarReference(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(response, \`<!doctype html><html><head><title>API Reference</title></head><body><script id="api-reference" data-url="/openapi.json"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>\`)
}
`;
}

export function renderGoConfig(plan: StandardApiProjectPlan): string {
  return `package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

type Config struct {
	AppName            string
	AppEnv             string
	Port               string
	CloudProvider      string
	AzureRegion        string
	DatabaseURL        string
	RedisURL           string
	MessagingTransport string
	BlobEndpoint       string
	CORSAllowedOrigins string
}

var resolved = sync.OnceValues(load)

func Load() (Config, error) {
	return resolved()
}

func load() (Config, error) {
	selected, explicit := os.LookupEnv("LIFTOFF_ENV_FILE")
	if !explicit {
		selected = filepath.Join("..", "runtime.config.json")
	}
	values := map[string]string{}
	content, err := os.ReadFile(selected)
	if err != nil {
		if explicit || !errors.Is(err, os.ErrNotExist) {
			return Config{}, fmt.Errorf("read runtime configuration: %w", err)
		}
	} else {
		var decoded map[string]any
		if err := json.Unmarshal(content, &decoded); err != nil {
			return Config{}, fmt.Errorf("runtime configuration must be a JSON object of string values: %w", err)
		}
		if decoded == nil {
			return Config{}, fmt.Errorf("runtime configuration must be a JSON object of string values")
		}
		for name, item := range decoded {
			text, ok := item.(string)
			if !ok {
				return Config{}, fmt.Errorf("runtime configuration value %q must be a string", name)
			}
			values[name] = text
		}
	}
	value := func(name, fallback string) string {
		if current, supplied := os.LookupEnv(name); supplied {
			return current
		}
		if current, supplied := values[name]; supplied {
			return current
		}
		return fallback
	}
	databaseURL := value("DATABASE_URL", "")
	redisURL := value("REDIS_URL", "")
	if databaseURL == "" || redisURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL and REDIS_URL are required")
	}
	port := value("PORT", "8000")
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return Config{}, fmt.Errorf("PORT must be an integer from 1 to 65535")
	}
	return Config{
		AppName:            value("APP_NAME", ${sourceString(plan.projectName)}),
		AppEnv:             value("APP_ENV", "dev"),
		Port:               port,
		CloudProvider:      value("CLOUD_PROVIDER", "${plan.provider.id}"),
		AzureRegion:        value("AZURE_REGION", "${plan.region.slug}"),
		DatabaseURL:        databaseURL,
		RedisURL:           redisURL,
		MessagingTransport: value("MESSAGING_TRANSPORT", "redis-streams"),
		BlobEndpoint:       value("BLOB_ENDPOINT", ""),
		CORSAllowedOrigins: value("CORS_ALLOWED_ORIGINS", "http://localhost:5173"),
	}, nil
}
`;
}

export function renderGoDatabase(): string {
  return `package database

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return pgxpool.New(ctx, databaseURL)
}
`;
}

export function renderGoHealthTest(plan: StandardApiProjectPlan): string {
  return `package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"${goModule(plan)}/internal/config"
)

func TestHealthAndReady(t *testing.T) {
	handler := New(config.Config{AppName: ${sourceString(plan.projectName)}, CORSAllowedOrigins: "http://localhost:5173"})
	for _, path := range []string{"/health", "/ready"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s returned %d", path, response.Code)
		}
	}
}

func TestCorsPreflightForLocalFrontend(t *testing.T) {
	handler := New(config.Config{AppName: ${sourceString(plan.projectName)}, CORSAllowedOrigins: "http://localhost:5173"})
	request := httptest.NewRequest(http.MethodOptions, "/api", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	request.Header.Set("Access-Control-Request-Method", http.MethodGet)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("preflight returned %d", response.Code)
	}
	if origin := response.Header().Get("Access-Control-Allow-Origin"); origin != "http://localhost:5173" {
		t.Fatalf("unexpected allow origin %q", origin)
	}
}
`;
}

export function renderGoMigration(): string {
  return `-- +goose Up
CREATE TABLE app_records (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE app_records;
`;
}
