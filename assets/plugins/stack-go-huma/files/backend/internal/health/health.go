// Package health serves liveness and readiness.
//
// /health/live says the process is running and never touches dependencies.
// /health/ready checks each dependency the API needs to serve requests and
// answers 503 when one is unavailable, so traffic is only sent when it can be
// handled.
package health

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
)

// Probe returns nil when the database answers.
type Probe func(ctx context.Context) error

// DatabaseProbe checks the database over a new connection every time. A
// pooled connection to a database that stopped responding would leave the
// check waiting; here the connection and the query are both bounded by the
// timeout, and the connection is always closed.
func DatabaseProbe(url string, timeout time.Duration) Probe {
	return func(ctx context.Context) error {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		config, err := pgx.ParseConfig(url)
		if err != nil {
			return err
		}
		config.ConnectTimeout = timeout
		config.RuntimeParams["statement_timeout"] = strconv.FormatInt(timeout.Milliseconds(), 10)
		conn, err := pgx.ConnectConfig(ctx, config)
		if err != nil {
			return err
		}
		defer func() {
			closing, stop := context.WithTimeout(context.Background(), timeout)
			defer stop()
			_ = conn.Close(closing)
		}()
		_, err = conn.Exec(ctx, "SELECT 1")
		return err
	}
}

type liveOutput struct {
	Body struct {
		Status string `json:"status" example:"ok"`
	}
}

type readyOutput struct {
	Status int
	Body   struct {
		Status string `json:"status" enum:"ready,not-ready"`
		Checks struct {
			Database string `json:"database" enum:"ok,unavailable"`
		} `json:"checks"`
	}
}

// Register adds the health routes to the API.
func Register(api huma.API, probe Probe, logger *slog.Logger) {
	huma.Register(api, huma.Operation{
		OperationID: "live",
		Method:      http.MethodGet,
		Path:        "/health/live",
		Summary:     "The process is running",
		Tags:        []string{"health"},
	}, func(context.Context, *struct{}) (*liveOutput, error) {
		output := &liveOutput{}
		output.Body.Status = "ok"
		return output, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "ready",
		Method:      http.MethodGet,
		Path:        "/health/ready",
		Summary:     "The API can serve requests",
		Tags:        []string{"health"},
		Responses: map[string]*huma.Response{
			"503": {Description: "A dependency is unavailable"},
		},
	}, func(ctx context.Context, _ *struct{}) (*readyOutput, error) {
		output := &readyOutput{Status: http.StatusOK}
		output.Body.Status, output.Body.Checks.Database = "ready", "ok"
		if err := probe(ctx); err != nil {
			// Any failure means not ready; the detail is logged, not returned.
			logger.WarnContext(ctx, "database readiness check failed", "error", err)
			output.Status = http.StatusServiceUnavailable
			output.Body.Status, output.Body.Checks.Database = "not-ready", "unavailable"
		}
		return output, nil
	})
}
