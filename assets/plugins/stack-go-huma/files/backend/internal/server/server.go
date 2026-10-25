// Package server builds the API: its routes and documentation.
package server

import (
	"log/slog"
	"net/http"

	"backend/internal/config"
	"backend/internal/health"
	"backend/internal/items"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// New returns the API's HTTP handler.
func New(cfg config.Config, store items.Store, probe health.Probe, logger *slog.Logger) http.Handler {
	router := chi.NewMux()
	router.Use(middleware.Recoverer)

	api := humachi.New(router, humaConfig(cfg))
	health.Register(api, probe, logger)
	items.Register(api, store)
	return router
}

func humaConfig(cfg config.Config) huma.Config {
	settings := huma.DefaultConfig("{{liftoff.name}} API", "0.1.0")
	// Responses stay plain JSON, without the $schema links Huma adds by default.
	settings.CreateHooks = nil
	settings.DocsRenderer = huma.DocsRendererScalar
	if !cfg.DocsEnabled {
		settings.OpenAPIPath, settings.DocsPath, settings.SchemasPath = "", "", ""
	}
	return settings
}
