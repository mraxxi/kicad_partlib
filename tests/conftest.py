"""Shared fixtures.

Nothing here touches the network. The whole suite runs against an in-memory
SQLite database that is built from the real migration files, so the schema the
tests exercise is the schema that ships -- not a hand-maintained copy that can
drift from it.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# Qt must be told to run headless BEFORE PySide6 is imported anywhere
# --------------------------------------------------------------------------
# This runs at module scope, during collection, which is the only point early
# enough: Qt reads QT_QPA_PLATFORM when the platform plugin loads, and that
# happens on the first PySide6 import. Set it later and the suite tries to open
# a real window -- passing locally where there is a display and failing in CI,
# which is the most annoying possible failure mode.
#
# `setdefault`, not assignment, so a developer can force a real window with
# `QT_QPA_PLATFORM=xcb pytest` to actually look at something.
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import sqlite3
from pathlib import Path
from typing import List

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "migrations"


# --------------------------------------------------------------------------
# Capability probes -- reusable skips
# --------------------------------------------------------------------------
# Probe for the capability rather than sniffing the platform, because either
# platform can be configured the other way.
import shutil

has_wrangler = pytest.mark.skipif(
    shutil.which("wrangler") is None,
    reason="wrangler is not installed",
)

try:  # pragma: no cover - the import is the test
    import PySide6  # noqa: F401

    _HAS_QT = True
except Exception:  # pragma: no cover
    _HAS_QT = False

needs_qt = pytest.mark.skipif(not _HAS_QT, reason="PySide6 is not installed")


# --------------------------------------------------------------------------
# Migrations
# --------------------------------------------------------------------------
def migration_files() -> List[Path]:
    """Every migration, in the order it must be applied.

    Sorted by filename, which is why they are zero-padded (`0001_`, `0002_`):
    `10` must not sort before `2`.
    """
    return sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql"))


def apply_migrations(conn: sqlite3.Connection) -> None:
    """Apply every migration to an open connection, in order."""
    for path in migration_files():
        conn.executescript(path.read_text(encoding="utf-8"))


@pytest.fixture
def db() -> sqlite3.Connection:
    """An in-memory database with the real schema applied.

    Foreign keys are ON. SQLite leaves them off by default, so a test suite that
    does not enable them will happily accept an event pointing at a part that
    does not exist -- and D1 enables them, so the test would be lying.
    """
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    yield conn
    conn.close()


# --------------------------------------------------------------------------
# Small builders, so a test reads as what it is testing
# --------------------------------------------------------------------------
NOW = "2026-10-05T00:00:00.000Z"


def add_part(conn: sqlite3.Connection, part_id: str = "C23179", **cols: object) -> str:
    """Insert a minimal valid part and return its id."""
    cols.setdefault("lcsc_pn", part_id if part_id.startswith("C") else None)
    cols.setdefault("created_at", NOW)
    cols.setdefault("updated_at", NOW)
    names = ", ".join(["id"] + list(cols))
    marks = ", ".join(["?"] * (len(cols) + 1))
    conn.execute(
        f"INSERT INTO parts({names}) VALUES({marks})", [part_id] + list(cols.values())
    )
    return part_id


def add_event(
    conn: sqlite3.Connection,
    part_id: str,
    kind: str,
    delta_qty: int,
    *,
    event_id: str | None = None,
    or_ignore: bool = False,
    **cols: object,
) -> str:
    """Append a stock event. Returns its `event_id`."""
    event_id = event_id or f"ev-{kind}-{delta_qty}-{len(cols)}"
    cols.setdefault("device", "test-device")
    cols.setdefault("occurred_at", NOW)
    cols.setdefault("recorded_at", NOW)
    names = ", ".join(["event_id", "part_id", "kind", "delta_qty"] + list(cols))
    marks = ", ".join(["?"] * (4 + len(cols)))
    verb = "INSERT OR IGNORE INTO" if or_ignore else "INSERT INTO"
    conn.execute(
        f"{verb} stock_events({names}) VALUES({marks})",
        [event_id, part_id, kind, delta_qty] + list(cols.values()),
    )
    return event_id


def stock_of(conn: sqlite3.Connection, part_id: str) -> int:
    """Stock on hand, the way the tool computes it: a sum of deltas."""
    row = conn.execute(
        "SELECT COALESCE(SUM(delta_qty), 0) FROM stock_events WHERE part_id = ?",
        (part_id,),
    ).fetchone()
    return row[0]
