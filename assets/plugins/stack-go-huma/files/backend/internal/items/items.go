// Package items is an example resource. Replace it with your own.
package items

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Item is one stored item.
type Item struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

// Store keeps items. PostgresStore is the real one; tests use a fake.
type Store interface {
	List(ctx context.Context) ([]Item, error)
	Create(ctx context.Context, name string) (Item, error)
}

// PostgresStore keeps items in the items table.
type PostgresStore struct {
	Pool *pgxpool.Pool
}

func (s PostgresStore) List(ctx context.Context) ([]Item, error) {
	rows, err := s.Pool.Query(ctx, "SELECT id, name, created_at FROM items ORDER BY id")
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Item])
}

func (s PostgresStore) Create(ctx context.Context, name string) (Item, error) {
	var item Item
	err := s.Pool.QueryRow(ctx,
		"INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at", name,
	).Scan(&item.ID, &item.Name, &item.CreatedAt)
	return item, err
}

type listOutput struct {
	Body []Item
}

type createInput struct {
	Body struct {
		Name string `json:"name" minLength:"1" maxLength:"200"`
	}
}

type createOutput struct {
	Body Item
}

// Register adds the item routes to the API.
func Register(api huma.API, store Store) {
	huma.Register(api, huma.Operation{
		OperationID: "list-items",
		Method:      http.MethodGet,
		Path:        "/items",
		Summary:     "List items",
		Tags:        []string{"items"},
	}, func(ctx context.Context, _ *struct{}) (*listOutput, error) {
		list, err := store.List(ctx)
		if err != nil {
			return nil, err
		}
		if list == nil {
			list = []Item{}
		}
		return &listOutput{Body: list}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "create-item",
		Method:        http.MethodPost,
		Path:          "/items",
		Summary:       "Create an item",
		Tags:          []string{"items"},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, input *createInput) (*createOutput, error) {
		item, err := store.Create(ctx, input.Body.Name)
		if err != nil {
			return nil, err
		}
		return &createOutput{Body: item}, nil
	})
}
