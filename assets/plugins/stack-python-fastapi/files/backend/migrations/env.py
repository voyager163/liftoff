"""Alembic environment: migrations run against the configured database."""

from __future__ import annotations

from alembic import context
from sqlalchemy import Connection

import app.models  # noqa: F401  (registers the models on Base.metadata)
from app.config import load_settings
from app.database import Base, make_engine

target_metadata = Base.metadata


def run(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


def main() -> None:
    connection = context.config.attributes.get("connection")
    if connection is not None:
        run(connection)
        return
    if context.is_offline_mode():
        context.configure(
            url=load_settings().database_url, target_metadata=target_metadata, literal_binds=True
        )
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = make_engine(load_settings().database_url)
    with engine.connect() as live:
        run(live)


main()
