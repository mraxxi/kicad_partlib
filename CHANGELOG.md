# Changelog

All notable changes to this tooling. The inventory *data* lives in Cloudflare
D1 and is not tracked here; this file is about the code and the schema.

## [Unreleased]

### Phase 0 — Scaffolding, and the decisions that are expensive to change

The repository, the schema, the conventions and the documentation. **No
production code**, on purpose: everything here is either a decision that is
costly to revisit later or a measurement that stops a later phase guessing.

- **The schema, as `migrations/0001_initial.sql`.** Nine tables, with every
  column commented as to *why* it exists and the reasoning collected in
  `docs/schema.md`. Applying it twice is a no-op, asserted by a test, because
  the REST API offers no atomic multi-statement write and a half-applied
  migration's only recovery is to run it again.

- **A stocktake stores a delta, not an absolute count.** The first draft of the
  design had a count set an absolute quantity that reset the running total. That
  made replay **order-dependent**, and an order-dependent ledger across two
  machines discards real movements *silently while still producing a plausible
  number* — the worst available failure for an inventory. A stocktake now records
  `counted_qty`, `basis_qty` and the computed `delta_qty`, so stock is
  `SUM(delta_qty)`: commutative, clock-independent, and correct when an event
  arrives late. The count has not lost its meaning, it has moved out of
  arithmetic and into reporting, which is also where shrinkage becomes a report
  you can run.

- **Five `CHECK` constraints that bite**, each verified by a test: a purchase
  cannot remove stock, consuming and scrapping cannot add it, a stocktake must
  carry both quantities *and* agree with their difference, and a correction must
  say what it reverses. Enforced by the database rather than trusted to a caller,
  because with a single remote store there is no second copy to recover from.

- **Retry-safety, as the property everything else rests on.** With a
  network-only store an HTTP timeout leaves you genuinely unsure whether the
  write landed: blind retry double-counts stock and not retrying loses it. Every
  event carries a client-generated `event_id` with `UNIQUE`, written with
  `INSERT OR IGNORE`, so a retry is free. `parts` gets the same treatment via
  `rev_token`, which was missing from the first draft — without it a retried
  `UPDATE` reports zero rows changed and the tool blames a conflict that never
  happened.

- **The audit log is written by a trigger.** One parameterised statement is the
  only atomic unit the D1 REST API offers (`BEGIN TRANSACTION` is rejected, and
  atomic `batch()` is a Workers-runtime capability with no HTTP equivalent), so
  "UPDATE the part, then INSERT an audit row" can land one and lose the other.
  `parts_audit_update` runs inside the implicit transaction that already wraps
  the `UPDATE`. The cost is recorded where it will be read: adding a column to
  `parts` now requires a migration that recreates the trigger.

- **`stock_checkpoints`, designed as a cache with a proof attached.** The first
  draft budgeted 250 k rows read per day and reached that figure by counting
  `parts` and forgetting the ledger entirely. Measured properly: the naive
  aggregate scans ~22,000 rows per refresh at today's scale, ~82,000 by year
  three, which at 50 refreshes a day is **82% of the 5 M/day free-tier cap**. The
  cap is a deadline, not headroom. `through_seq` is the proof that keeps the
  checkpoint honest, and the monotone upsert is what makes two racing devices
  converge instead of letting a stale writer roll the number back.

- **Measured facts, so later phases stop guessing** (`AGENTS.md` §2). Against
  D1's own engine via `wrangler d1 execute --local`: `AUTOINCREMENT`, partial
  indexes, CTEs, `AFTER UPDATE` triggers, `json_each(?)`, `sqlite_master` and
  `pragma_table_info()` all work. Two findings worth the trouble:
  - **`seq` is monotonic but not gapless** — an ignored `INSERT OR IGNORE` still
    consumes a sequence number. Three statements, one a duplicate, left 2 rows
    with `max_seq = 3`. Harmless for ordering, fatal for any future
    "pull everything since sequence N" that assumes density.
  - **`json_each(?)` carries types.** `typeof()` on a column inserted through
    `json_extract` returns `integer`, so the one-bound-parameter bulk-insert
    shape does not stringify micro-USD amounts. This replaces the first draft's
    "≤ 8 rows per statement", which would have made a 2,000-row import 250+
    round trips instead of under 20.

- **Qt measured rather than feared.** `filterwarnings = error` plus PySide6
  6.11.2 on Python 3.14.7 raised **no warnings** across `QApplication`,
  `QAbstractTableModel`, `QSortFilterProxyModel`, `QTableView`, `QThreadPool`,
  `QRunnable`, `Signal` and `QTimer` — so no ignore list is needed yet, and one
  should only appear with a comment saying why. And `pytest-qt` 4.5.0 **does**
  fail a test when a slot raises, so the sibling repo's hardest-won Tk lesson
  (an exception routed to `report_callback_exception`, letting `invoke()` return
  normally and the test pass with the bug in place) has no analogue to rebuild
  here. "Press the button in the test" still applies: pytest-qt only surfaces
  what something actually invokes.

- **A hazard specific to this machine.** PyQt5 *and* PyQt6 are installed
  alongside PySide6, and importing two Qt bindings into one process can crash
  it. `AGENTS.md` bans importing `PyQt5`/`PyQt6` anywhere in this repository.

- **wrangler could not write its cache here.** `wrangler d1 list` failed with
  *"A permission error occurred while accessing the file system"* against
  `/home/archvan/node_modules/.cache/wrangler`: wrangler walks up to the nearest
  `node_modules`, and a root-owned one left by a `sudo npm` install of `9router`
  sits above this project. An empty, gitignored project-local `node_modules/`
  stops it walking up. `CACHE_DIR` does not override this — measured, not
  assumed.

- **Deferred designs, written as designs rather than wishes.**
  `docs/deferred/locations-and-labels.md` specifies the whole feature — schema,
  the `transfer` event pair and the non-atomicity guardrail it needs, CLI and GUI
  surface, SVG sheet geometry, and pinned QR parameters (byte mode, version
  chosen from payload length, EC level M, all eight masks evaluated) — so that
  adding it later needs no new decisions. It also answers the question most
  likely to be got wrong: **per-location quantity must be derived from the
  ledger**, via the nullable `location_id` that ships unused in
  `0001_initial.sql`, and not stored as a mutable number. Also
  `bom-reconciliation.md` and `offline-mode.md`, the latter existing mainly to
  make sure the D1-only decision is revisited deliberately rather than eroded.

- **21 tests, offline.** The suite builds an in-memory SQLite database from the
  real migration files, so the schema under test is the schema that ships rather
  than a hand-maintained copy that can drift. Foreign keys are enabled in the
  fixture, because SQLite leaves them off by default and D1 does not — a suite
  that forgets would accept an event pointing at a part that does not exist.

#### Still open, and recorded as such
Four probes need a live database over REST and cannot be answered with
`--local`: whether bound `params` are typed or stringly on the wire (P1),
whether a semicolon-joined multi-statement `/query` is atomic (P3, which decides
whether migrations need a per-statement ledger), the real wire bodies for 401 /
quota-exceeded / timeout so they can become fixtures (P8), and whether
`meta.rows_read` matches the scanned-row estimate above (P9).
