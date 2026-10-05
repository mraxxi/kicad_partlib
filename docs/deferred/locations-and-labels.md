> **Partly superseded (2026-10-06).** The Worker pivot made `locations` a real table in Phase 2 and replaced the event ledger with `stock_moves` + cached `lots.qty_on_hand`. The label/QR parts (`/l/<lot id>`) are Phase 5. Read this for the design intent, not the schema.

# Deferred design: physical locations and printed labels

**Status:** designed, not built. Deliberately out of v1.

This document exists so that whoever adds the feature — a future agent, or the
owner in six months — needs **no further design decisions**. Every open question
is answered here. If you disagree with an answer, change it deliberately and
update this file; do not rediscover it.

Read `AGENTS.md` first. The rules this design must not break are Rule B (stock is
never a stored number), Rule 4 (the read budget) and Rule 10 (plan-then-apply for
fan-out).

---

## 1. Why it was deferred

It is genuinely useful and genuinely not the point. v1 has to answer *"do I have
one, what did it cost, what can I replace it with"*. *"Which drawer is it in"* is
a second question, and shipping it late costs nothing because the schema already
carries the one column that cannot be retrofitted (§3).

## 2. The one decision that is easy to get wrong

**Per-location quantity must be derived from the ledger, exactly like total
stock.** It must *not* be a mutable `part_locations.qty` column.

The tempting design is a join table holding a number:

```sql
-- WRONG. Do not do this.
CREATE TABLE part_locations (part_id TEXT, location_id TEXT, qty INTEGER);
```

That gives the project a **second, drifting source of truth**. Within a month
`SUM(part_locations.qty)` and `SUM(stock_events.delta_qty)` disagree, and nothing
can tell you which is right — which is precisely the failure Rule B exists to
prevent. It is also unfixable after the fact: there is no way to reconstruct
*where* historical movements happened.

**So:** `stock_events.location_id` (already present, nullable, unused) becomes
live, and per-location stock is

```sql
SELECT location_id, SUM(delta_qty) AS qty
FROM stock_events WHERE part_id = ? GROUP BY location_id;
```

`location_id IS NULL` means **location-unknown**, which is the honest reading of
every event recorded before this feature existed. **Do not back-fill it to a
guess.** A `NULL` bucket showing "47 pcs, location unknown" is correct and
actionable; a fabricated "drawer 1" is neither.

---

## 3. Schema

`stock_events.location_id` already exists (`migrations/0001_initial.sql`), which
is why this feature is additive. The new migration adds only tables.

```sql
-- migrations/000N_locations.sql
-- Additive only. No existing row is modified, no event is rewritten.

CREATE TABLE IF NOT EXISTS locations (
    id         TEXT PRIMARY KEY,        -- short, human-typable: "D3-B7"
    label      TEXT NOT NULL,           -- "Drawer 3, bin B7"
    kind       TEXT NOT NULL CHECK (kind IN ('room','shelf','drawer','bin','reel','box','bag','other')),
    parent_id  TEXT REFERENCES locations(id),   -- nesting; NULL = top level
    note       TEXT,
    retired_at TEXT,                    -- soft-delete: a location with history
                                        -- must never be hard-deleted, or its
                                        -- events point at nothing
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_locations_parent ON locations(parent_id);

-- Makes the per-location rollup an index scan rather than a table scan.
-- Rule 4: rows read are metered by rows SCANNED.
CREATE INDEX IF NOT EXISTS ix_events_location
    ON stock_events(location_id, part_id) WHERE location_id IS NOT NULL;

-- Add 'transfer' to the kind CHECK?  ALREADY DONE in 0001_initial.sql.
-- Altering a CHECK constraint in SQLite means rebuilding the table, so the
-- cheap moment was before there was data. Nothing to do here.
```

Then drop and recreate `parts_audit_update` **only if** this migration adds
columns to `parts` (it does not). See `AGENTS.md` Rule 5 for why that trigger is
column-enumerated.

### Validation rules
* `parent_id` must not form a cycle — walk the chain on insert, max depth 8.
  A cycle makes the tree view infinite-loop.
* A location with any event referencing it is **retired, never deleted**
  (`retired_at`). Hard deletion would orphan history.
* `id` is typed by a human onto a label, so restrict it: `A-Z 0-9 - _`, max 16
  characters, case-insensitively unique. Reuse the sibling repo's naming
  discipline — reject names differing only by case, because they cannot coexist
  on Windows or macOS and will eventually be sorted by one.

---

## 4. The `transfer` event kind

Moving stock between locations is **net zero** overall but non-zero per location,
so it is **two rows**, not one:

```
transfer 50 pcs of C23179 from D3-B7 to SHELF2
  -> event A: kind='transfer', delta_qty=-50, location_id='D3-B7'
  -> event B: kind='transfer', delta_qty=+50, location_id='SHELF2'
```

Both rows share a `transfer_group` id so the pair is recoverable, and both carry
their own `event_id` so Rule 2 (retry-safety) still holds per row.

Add in the same migration:

```sql
ALTER TABLE stock_events ADD COLUMN transfer_group TEXT;
```

`ALTER TABLE ADD COLUMN` is **not** idempotent, so guard it by probing
`sqlite_master` first — `PRAGMA table_info` is less reliable here
(`AGENTS.md` §6).

**The hazard, and the required guardrail:** the two rows cannot be written
atomically, because one parameterised statement is the only atomic unit
(Rule 5). A crash between them leaves 50 pieces missing from `D3-B7` and
nowhere else — total stock is still right, but the per-location split is
broken.

Mitigations, all three:
1. Write the **destination (+) row first**. If only one row lands, stock is
   double-counted in the per-location view rather than vanished — visible and
   complainable rather than silent.
2. `inv check` reports any `transfer_group` without exactly two rows summing to
   zero, with the fix (`inv transfer --repair <group>`).
3. A negative per-location quantity is **always** a reportable finding, never
   rendered as fact.

---

## 5. CLI surface

```bash
inv locations                       # flat list with counts
inv locations --tree                # nested
inv location add D3-B7 --kind bin --parent DRAWER3 --label "Drawer 3, bin B7"
inv location retire D3-B7           # refuses if stock remains; --force moves it to unknown

inv where C23179                    # per-location breakdown, NULL bucket included
inv move  C23179 50 --from D3-B7 --to SHELF2
inv put   C23179 100 --at D3-B7     # location on a purchase
inv use   C23179 12  --from D3-B7   # location on a consume

inv label C23179 [C5678 ...]        # one or more labels
inv label --location D3-B7          # a bin label
inv label --all --low-stock         # a sheet for everything that needs reordering
```

`inv move` has **fan-out** (it writes two event rows and changes two locations'
apparent contents), so by Rule 10 it is plan-then-apply: `--dry-run` /
`--yes` / refused non-interactively without `--yes`.

`--at` / `--from` default to the part's only location when it has exactly one,
and are **required** when it has more than one. Guessing is how stock ends up in
the wrong drawer.

---

## 6. GUI surface

* A **Location** column in the parts table, showing `D3-B7` for a single
  location and `3 locations` otherwise. Sort via `Qt.UserRole` returning the
  location count then the label, per `AGENTS.md` §8 — never parse the display
  string.
* A **location filter** in the sidebar, as a tree mirroring `parent_id`, with a
  distinct **"Location unknown"** node for the `NULL` bucket. That node is the
  feature's own to-do list.
* In the part editor, a per-location breakdown with a **Move…** action.
* Column visibility persisted **by name** (`location`), never by index.

---

## 7. Labels

### Output format: SVG
Stdlib, exact, printable, no dependency, and inspectable in a browser before
wasting a sheet. **Not PDF** (needs a library), **not PNG** (resolution-dependent
and prints soft).

```
inv label --out labels.svg --sheet avery-l7651
```

### Sheet geometry, as data
A small table of named sheets, so adding one is data rather than code:

| name | page | cols × rows | label | pitch | margin |
|---|---|---|---|---|---|
| `avery-l7651` | A4 | 5 × 13 | 38.1 × 21.2 mm | 40.6 × 21.2 mm | 7.75 / 10.7 mm |
| `avery-l7160` | A4 | 3 × 7 | 63.5 × 38.1 mm | 66.0 × 38.1 mm | 7.0 / 15.1 mm |
| `generic-24` | A4 | 3 × 8 | 63.5 × 33.9 mm | 66.0 × 33.9 mm | 7.0 / 12.9 mm |

Emit **millimetre user units** (`width="210mm" viewBox="0 0 210 297"`) so a
browser's "actual size" print is correct. Add registration crosses at the page
corners and a `--calibrate` flag that prints a geometry-only sheet, because every
printer scales slightly and the first sheet is always wasted finding out.

### Label content
```
┌─────────────────────────┐
│ ▞▚▞▚  C23179            │   QR, then the id
│ ▚▞▚▞  10kΩ 1% 0603      │   value / package
│ ▞▚▞▚  RC0603FR-0710KL   │   MPN
└─────────────────────────┘
```
Content is a **controller decision**, not a drawing decision — same boundary as
the GUI (`AGENTS.md` §8), so it is testable headlessly.

### QR code: pure stdlib, and pin the parameters
Encode `partlib:<part_id>` — a URI scheme, so a future phone app can register
for it. `partlib:C23179` is 17 bytes.

**Pin these, do not leave them open:**
* **Mode**: byte. Alphanumeric mode excludes lowercase and `:`.
* **Version 2** (25 × 25 modules) at **EC level M** holds 32 bytes — comfortable
  for a `C`-number id, and 25 modules fits a 21 mm label at 4 modules/mm.
* **Version 3** (29 × 29, 44 bytes at M) for the longer `X-<uuid4hex>` surrogate
  ids, which are 40 bytes. **Pick the version from the payload length**; do not
  hardcode one, or surrogate-id labels will silently fail to encode.
* EC level **M** (15%): a bin label gets handled, not soaked.
* Mask: evaluate all 8 and pick the lowest penalty, per the spec. Hardcoding
  mask 0 produces scanner-hostile codes for some payloads.

Roughly 150–200 lines: GF(256) tables, Reed–Solomon remainder, the version-2/3
layouts, the four penalty rules. **It must be tested against a decoder, not by
eye** — a wrong generator polynomial produces a plausible-looking grid that no
scanner reads. Options, in order: `zbarimg` if installed (skip the test when
absent, as the sibling repo does with `kicad-cli`), else a table of
payload → expected module grid generated once from a known-good encoder and
committed as a fixture.

---

## 8. Acceptance checks for the future phase

* `inv location add` rejects a cycle, a bad id, and a case-only duplicate.
* `inv where` on a part with events predating this feature reports them under
  **location unknown**, not under a guessed location.
* `inv move` is refused non-interactively without `--yes`, and `--dry-run` writes
  nothing (assert planning purity, per the sibling repo's `test_plan_purity.py`).
* A transfer killed between its two rows leaves total stock correct, and
  `inv check` reports the unbalanced `transfer_group` with a suggested fix.
* Per-location sums equal total stock for every part, as a property test over
  randomised event sequences.
* Retiring a location holding stock is refused with a sentence; `--force` moves
  that stock to location-unknown and says how much it moved.
* A generated sheet prints at correct physical size (verified once with a ruler,
  then pinned by asserting the SVG's `mm` geometry).
* Every generated QR decodes back to `partlib:<part_id>` — for a `C`-number id
  **and** for an `X-<uuid4hex>` surrogate, which is the case that exercises the
  version bump.
* The read cost of `inv where` is measured from `meta.rows_read`, not assumed
  (Rule 4).

---

## 9. What this design deliberately does not do

* **No per-location minimum stock.** Reorder thresholds are a property of the
  part, not of a drawer.
* **No capacity or dimensions on a location.** Modelling whether a bin is full is
  a different project.
* **No barcode scanning input.** The QR is for *looking a part up on a phone*.
  Scanner-driven stock entry needs a different interaction model and is a
  separate deferred design.
* **No automatic location assignment.** Nothing guesses where a new part went.
