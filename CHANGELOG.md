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

- **The databases exist, and the migration is applied.** `kicad-partlib` and
  `kicad-partlib-staging` (region APAC), taking the account to 8 of its 10 free
  slots. The rehearse-then-promote workflow from `docs/d1-setup.md` was used for
  its own first migration rather than merely described: staging first, 21
  commands, then production. Production holds the schema and **zero rows**.

### Phase 0 — probes answered against the live database

The remaining probes were run on `kicad-partlib-staging`, which is what it is
for. Three of them changed something.

- **A multi-statement batch IS atomic (P3)** — a valid `INSERT` followed by a
  primary-key violation left **zero** rows. So a migration file cannot land
  half-applied, and the per-statement migrations ledger keyed
  `(version, stmt_index)` that was being held in reserve is **not needed**. This
  contradicts the assumption the design was carrying. The caveat that keeps the
  audit trigger: it was measured **without bound params**, and the reported
  failure mode is specifically multi-statement *plus* a shared `params` array —
  which is the case every real write falls into. Rule 5 now states both cases
  and assumes the pessimistic one where it is unsettled.

- **`rows_written` counts index writes, roughly 4× (P4).** One
  `UPDATE parts` reported `rows_written = 4`; inserting two rows reported 8. So
  "a 2,000-row import is 2% of the daily cap" was wrong by that factor — it is
  nearer 8%. Still comfortable, but the multiplier is now written down where a
  bulk operation will be planned, and the `parts_audit_update` trigger's own row
  is part of it.

- **`rows_read` really is rows scanned (P9).** 20 parts + 200 events = 220 rows;
  the full stock aggregate reported `rows_read = 239`. Metering is proportional
  to table size, which makes Rule 4's budget — and therefore the case for
  `stock_checkpoints` — measured rather than estimated.

- Confirmed on the real database rather than only the local engine: `json_each`
  preserves types (`typeof` → `integer`), the `AFTER UPDATE` trigger fires, and
  `seq` really does skip a number on an ignored insert (202 rows, `max_seq`
  203).

### Phase 0 — the REST probes, and a correction

With the API token in place, the last three probes ran against the raw endpoint.
One of them corrected this project's own documentation.

- **Bound parameters are properly typed (P1).** `2100` comes back as
  `typeof=integer`, `'2100'` as `text`, `1.5` as `real`, and `SUM` over bound
  integers returns `3000` as an `integer`. The REST documentation describes
  `params` as "an array of strings", which is misleading. **Micro-USD amounts are
  safe as plain bound parameters**, so the `json_each(?)` shape is now a
  *performance* choice for bulk inserts rather than a correctness requirement —
  which removes a worry from the import design.

- **Multi-statement with a shared `params` array is rejected outright (P3b)** —
  HTTP 400, code 7400, *"params with multiple statements is not supported"*.
  Since every write this tool makes carries user data and therefore uses bound
  parameters, **one parameterised statement per request is the only atomic unit
  available**. That is now settled rather than cautiously assumed, and it is the
  measured justification for writing the audit row from a trigger.

- **Fixed: a SQL error returns HTTP 400, not 200.** `AGENTS.md` asserted that
  *"HTTP 200 is not success — the API returns 200 with `success: false` for a SQL
  error"*. **It does not.** That claim arrived via a design review and was
  written down without being verified. Measured taxonomy: bad token → **401**
  / code 10000; malformed request → **400** / 7400; SQL error and constraint
  violation → **400** / 7500; unknown database → **404** / 7404.

  So distinct conditions **share HTTP 400**, which means classification must key
  on `errors[].code` and never on the status — the same conclusion the wrong
  claim was reaching for, but for the real reason. The defensible half survives:
  the body carries an outer `success` *and* a per-statement `success`, and
  `errors[0].message` is the only text worth showing a user.

- **The wire bodies are committed** as `tests/fixtures/d1_responses.json`, with
  12 tests pinning them (`tests/test_d1_fixtures.py`) so the phase-1 Store has a
  fixed target and a Cloudflare response-shape change fails loudly. Among them a
  guard that no fixture contains a credential, because a fixture is exactly the
  kind of file that ends up pasted into an issue. Also noted from `meta`:
  **`total_attempts` shows D1 retries internally**, which is worth knowing before
  layering another retry on top.

- Only the **daily-limit** body remains uncaptured; it cannot be obtained without
  deliberately burning the account's 100,000 daily write budget. Handled
  generically, and the fixture file says to capture it if it is ever seen.

33 tests, still entirely offline.
