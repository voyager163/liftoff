"""An example resource. Replace it with your own."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_session
from app.models import Item

router = APIRouter(prefix="/items", tags=["items"])
SessionDependency = Annotated[Session, Depends(get_session)]


class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    created_at: datetime


@router.get("")
def list_items(session: SessionDependency) -> list[ItemRead]:
    items = session.scalars(select(Item).order_by(Item.id)).all()
    return [ItemRead.model_validate(item) for item in items]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_item(payload: ItemCreate, session: SessionDependency) -> ItemRead:
    item = Item(name=payload.name)
    session.add(item)
    session.commit()
    session.refresh(item)
    return ItemRead.model_validate(item)
