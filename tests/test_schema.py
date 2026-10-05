"""The schema's promises, asserted.

These are the invariants the work plan calls expensive to change later. They are
tested here rather than trusted to the tool, because a constraint enforced by
the database holds even when a future caller forgets it -- and with a single
remote store there is no second copy of the data to recover from.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from tests.conftest import NOW, add_event, add_part, apply_migrations, stock_of


# --------------------------------------------------------------------------
# Migrations
# --------------------------------------------------------------------------
def test_applying_every_migration_twice_changes_nothing() -> None:
    """A half-applied migration must be safe to re-run.

    The REST API gives no atomic multi-statement write, so a migration can land
    partially applied and the only recovery is to run it again. That is only
    safe if every statement is individually idempotent.
    """
    conn = sqlite3.connect(":memory:")
    apply_migrations(conn)
    first = sorted(conn.execute("SELECT type, name, sql FROM sqlite_master"))

    apply_migrations(conn)
    second = sorted(conn.execute("SELECT type, name, sql FROM sqlite_master"))

    assert first == second
    conn.close()


def test_the_schema_records_its_own_version_and_a_minimum_code_version(db) -> None:
    """`min_code_version` is what stops a stale checkout writing here.

    The two-machine failure it prevents: migrate on machine A, walk to machine B
    which is still on last week's code, and B writes into a schema it does not
    understand.
    """
    meta = dict(db.execute("SELECT key, value FROM meta"))
    assert meta["schema_version"] == "1"
    assert meta["min_code_version"] == "0.1.0"


# --------------------------------------------------------------------------
# Identity
# --------------------------------------------------------------------------
def test_the_same_c_number_cannot_appear_on_two_parts(db) -> None:
    """Two rows for one physical part would split its stock invisibly.

    This is the failure the C-number-as-primary-key rule exists to prevent; the
    unique index is the second line of defence for a row that got a surrogate
    id by mistake.
    """
    add_part(db, "C23179")
    with pytest.raises(sqlite3.IntegrityError):
        add_part(db, "X-deadbeef", lcsc_pn="C23179")


def test_parts_without_a_c_number_coexist_freely(db) -> None:
    """A NULL lcsc_pn must not collide with another NULL one.

    A partial unique index (`WHERE lcsc_pn IS NOT NULL`) is what makes this
    work; a plain unique index would allow only one no-C-number part in the
    whole inventory.
    """
    add_part(db, "X-aaaa", lcsc_pn=None)
    add_part(db, "X-bbbb", lcsc_pn=None)
    assert db.execute("SELECT COUNT(*) FROM parts").fetchone()[0] == 2


def test_an_event_cannot_point_at_a_part_that_does_not_exist(db) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        add_event(db, "C-nonexistent", "purchase", 10)


# --------------------------------------------------------------------------
# Idempotency -- the single most important correctness property
# --------------------------------------------------------------------------
def test_a_retried_event_insert_does_not_double_count(db) -> None:
    """With a network-only store, a timeout leaves the outcome unknown.

    Blind retry would double-count stock and not retrying would lose it. The
    client-generated `event_id` plus UNIQUE plus INSERT OR IGNORE is what makes
    a retry free, and this is the test that must never be allowed to regress.
    """
    add_part(db, "C23179")
    for _ in range(5):  # the same logical event, retried five times
        add_event(db, "C23179", "purchase", 100, event_id="fixed-id", or_ignore=True)

    assert db.execute("SELECT COUNT(*) FROM stock_events").fetchone()[0] == 1
    assert stock_of(db, "C23179") == 100


def test_seq_is_monotonic_but_not_gapless(db) -> None:
    """An ignored insert still consumes a sequence number.

    Measured on the D1 engine, and recorded here so no future "pull everything
    since sequence N" sync assumes the numbering is dense.
    """
    add_part(db, "C23179")
    add_event(db, "C23179", "purchase", 10, event_id="a")
    add_event(db, "C23179", "purchase", 10, event_id="a", or_ignore=True)  # ignored
    add_event(db, "C23179", "purchase", 10, event_id="b")

    rows = db.execute("SELECT COUNT(*), MAX(seq) FROM stock_events").fetchone()
    assert rows[0] == 2, "the duplicate must not have been stored"
    assert rows[1] == 3, "but it did consume seq 2"


# --------------------------------------------------------------------------
# Stock is a sum of deltas, and that is what makes it order-independent
# --------------------------------------------------------------------------
def test_stock_is_the_sum_of_deltas_in_any_order(db) -> None:
    """The property an absolute-resetting stocktake would have destroyed.

    Replaying the same events in a different order must give the same answer,
    because across two machines the arrival order is not something either one
    controls.
    """
    add_part(db, "C1")
    add_part(db, "C2")

    events = [("purchase", 100), ("consume", -12), ("scrap", -3), ("adjust", 5)]
    for i, (kind, delta) in enumerate(events):
        add_event(db, "C1", kind, delta, event_id=f"fwd{i}")
    for i, (kind, delta) in enumerate(reversed(events)):
        add_event(db, "C2", kind, delta, event_id=f"rev{i}")

    assert stock_of(db, "C1") == stock_of(db, "C2") == 90


def test_a_part_with_no_events_has_zero_stock_rather_than_vanishing(db) -> None:
    """The LEFT JOIN in the all-parts query is load-bearing.

    Getting it backwards drops every part you have never transacted -- which
    looks like the inventory losing records.
    """
    add_part(db, "C23179")
    rows = db.execute(
        "SELECT p.id, COALESCE(SUM(e.delta_qty), 0) AS qty "
        "FROM parts p LEFT JOIN stock_events e ON e.part_id = p.id GROUP BY p.id"
    ).fetchall()
    assert rows == [("C23179", 0)]


def test_a_late_event_after_a_stocktake_adds_instead_of_being_swallowed(db) -> None:
    """The bug that the delta-stocktake rule exists to prevent.

    Under the old absolute-reset rule, a movement that arrived after the count
    but described a period before it was discarded with no error anywhere. Under
    a sum of deltas it simply adds.
    """
    add_part(db, "C23179")
    add_event(db, "C23179", "purchase", 100, event_id="buy")
    # A count found 97 while the ledger said 100: a -3 discrepancy.
    add_event(db, "C23179", "stocktake", -3, event_id="count", counted_qty=97, basis_qty=100)
    # Now the other machine's -5 finally lands.
    add_event(db, "C23179", "consume", -5, event_id="late")

    assert stock_of(db, "C23179") == 92


# --------------------------------------------------------------------------
# CHECK constraints -- the database refuses nonsense even if a caller forgets
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "label, kind, delta, extra",
    [
        ("a purchase cannot remove stock", "purchase", -5, {}),
        ("consuming cannot add stock", "consume", 5, {}),
        ("scrapping cannot add stock", "scrap", 5, {}),
        ("a stocktake needs what was counted", "stocktake", -3, {}),
        ("a correction must say what it reverses", "correction", -3, {}),
    ],
)
def test_the_database_refuses(db, label: str, kind: str, delta: int, extra: dict) -> None:
    add_part(db, "C23179")
    with pytest.raises(sqlite3.IntegrityError):
        add_event(db, "C23179", kind, delta, **extra)


def test_a_stocktake_whose_arithmetic_disagrees_is_refused(db) -> None:
    """`delta_qty` must equal `counted_qty - basis_qty`.

    Checked by the database rather than trusted to a caller, because this is the
    one field every stock figure is derived from.
    """
    add_part(db, "C23179")
    with pytest.raises(sqlite3.IntegrityError):
        add_event(db, "C23179", "stocktake", 99, counted_qty=97, basis_qty=100)


def test_a_consistent_stocktake_is_accepted(db) -> None:
    add_part(db, "C23179")
    add_event(db, "C23179", "stocktake", -3, counted_qty=97, basis_qty=100)
    assert stock_of(db, "C23179") == -3


# --------------------------------------------------------------------------
# The audit trigger
# --------------------------------------------------------------------------
def test_updating_a_part_writes_its_own_audit_row(db) -> None:
    """Written by a trigger, not by the caller.

    The REST API has no atomic multi-statement write, so "UPDATE then INSERT an
    audit row" can land one and lose the other. A trigger runs inside the
    implicit transaction that already wraps the UPDATE.
    """
    add_part(db, "C23179", mpn="OLD-MPN")
    db.execute(
        "UPDATE parts SET mpn = ?, rev = rev + 1, updated_at = ? WHERE id = ?",
        ("NEW-MPN", NOW, "C23179"),
    )

    rows = db.execute("SELECT part_id, old_json, new_json FROM audit_log").fetchall()
    assert len(rows) == 1
    part_id, old_json, new_json = rows[0]
    assert part_id == "C23179"
    assert json.loads(old_json)["mpn"] == "OLD-MPN"
    assert json.loads(new_json)["mpn"] == "NEW-MPN"


def test_inserting_a_part_does_not_write_an_audit_row(db) -> None:
    """The trigger is AFTER UPDATE only; a creation is not a change."""
    add_part(db, "C23179")
    assert db.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == 0


# --------------------------------------------------------------------------
# Checkpoints are a cache with a proof
# --------------------------------------------------------------------------
def test_a_checkpoint_plus_its_tail_equals_a_full_replay(db) -> None:
    """The property that lets the tool stop scanning the whole ledger."""
    add_part(db, "C23179")
    for i in range(10):
        add_event(db, "C23179", "purchase", 10, event_id=f"e{i}")

    through_seq, qty = db.execute(
        "SELECT MAX(seq), SUM(delta_qty) FROM stock_events WHERE part_id = 'C23179' AND seq <= 5"
    ).fetchone()
    db.execute(
        "INSERT INTO stock_checkpoints(part_id, through_seq, qty, computed_at) VALUES(?,?,?,?)",
        ("C23179", through_seq, qty, NOW),
    )

    tail = db.execute(
        "SELECT COALESCE(SUM(delta_qty), 0) FROM stock_events "
        "WHERE part_id = 'C23179' AND seq > ?",
        (through_seq,),
    ).fetchone()[0]
    assert qty + tail == stock_of(db, "C23179") == 100


def test_a_stale_checkpoint_writer_cannot_overwrite_a_newer_one(db) -> None:
    """The monotone upsert, so two racing devices converge.

    Without the WHERE clause the last writer wins, and a device that computed
    its checkpoint from an older view of the ledger would roll the figure back.
    """
    add_part(db, "C23179")
    upsert = (
        "INSERT INTO stock_checkpoints(part_id, through_seq, qty, computed_at) VALUES(?,?,?,?) "
        "ON CONFLICT(part_id) DO UPDATE SET through_seq=excluded.through_seq, "
        "qty=excluded.qty, computed_at=excluded.computed_at "
        "WHERE excluded.through_seq > stock_checkpoints.through_seq"
    )
    db.execute(upsert, ("C23179", 100, 500, NOW))
    db.execute(upsert, ("C23179", 50, 1, NOW))  # a stale writer

    assert db.execute(
        "SELECT through_seq, qty FROM stock_checkpoints WHERE part_id='C23179'"
    ).fetchone() == (100, 500)
