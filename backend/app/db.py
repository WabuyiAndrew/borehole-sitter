from __future__ import annotations

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def _normalize_database_url(url: str) -> str:
    value = url.strip()
    if value.startswith("postgres://"):
        value = "postgresql+psycopg2://" + value[len("postgres://") :]
    elif value.startswith("postgresql://") and "+psycopg2" not in value:
        value = "postgresql+psycopg2://" + value[len("postgresql://") :]
    return value


raw_database_url = os.getenv("DATABASE_URL", "").strip()
DATABASE_URL = _normalize_database_url(raw_database_url) if raw_database_url else "sqlite:///./drillscout.db"

connect_args: dict[str, object] = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

