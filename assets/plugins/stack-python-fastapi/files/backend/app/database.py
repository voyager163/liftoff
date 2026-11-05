"""Database engine, sessions and the model base class."""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import Request
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    """Base class for every model; Alembic reads its metadata."""


def make_engine(url: str, timeout_seconds: float = 2.0) -> Engine:
    connect_args: dict[str, object] = {}
    if url.startswith("postgresql"):
        connect_args["connect_timeout"] = max(1, int(timeout_seconds))
    return create_engine(url, pool_pre_ping=True, connect_args=connect_args)


def get_session(request: Request) -> Iterator[Session]:
    factory: sessionmaker[Session] = request.app.state.sessions
    with factory() as session:
        yield session
