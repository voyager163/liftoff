-- +goose Up
CREATE TABLE items (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE items;
