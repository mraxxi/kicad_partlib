# The schema, and why each part of it is shaped that way

`migrations/0001_initial.sql` is the authority; this file is the reasoning. If
the two disagree, the migration is right and this file is stale — fix it.

---

## The shape in one picture

```
parts ──────────┬──< stock_events >──── orders
  │             │         │
  │             │         └── location_id (reserved, unused in v1)
  │             └──< stock_checkpoints   (a cache with a proof)
  │
  ├──< audit_log            (written by a TRIGGER, never by a caller)
  └── equivalent_lcsc_pn ──> price_cache (keyed by C-number, not by part)

meta          schema_version, min_code_version
backups       so the pre-bulk export gate is a cheap read
import_runs   so a bulk import resumes with no local state
```

---

## `parts`

### `id` is the C-number
For a part with an LCSC part number, **`id` *is* that number** (`C23179`).
Otherwise it is `X-<uuid4hex>`.

This is not cosmetic. Two machines entering the same physical part would
otherwise produce two rows, stock would split across both, and nothing would
notice. With the C-number as the primary key, `INSERT OR IGNORE` settles that
race for free. `ux_parts_lcsc_pn` is the second line of defence for a row that
got a surrogate id by mistake.

The index is **partial** (`WHERE lcsc_pn IS NOT NULL`) because a plain unique
index would allow only one no-C-number part in the entire inventory — `NULL`
collides with `NULL` in a plain unique index in some engines and the partial
form removes the question.

### `merged_into`
Present from day one, unused in v1. A part entered without a C-number that later
acquires one needs a merge path, and the rule is that **events are never
rewritten, only the alias is followed**. Retrofitting identity merge onto a live
event log is the most expensive change available, and providing for it now is
nearly free.

### `specs` vs the promoted typed columns
`specs` is freeform JSON **for display only**. The promoted columns — `package`,
`value_si`, `tolerance_pct`, `voltage_rating_v`, `current_rating_a`,
`temp_coeff` — are what filtering and sorting use.

The reason is concrete: `100n`, `100nF`, `0.1uF` and `1e-7` are the same
capacitance and none of them sort or compare as text. So JSON cannot answer
*"every ceramic cap between 10 n and 1 µ in 0402 that I have more than 50 of"*,
which is the single most useful question an inventory has. It is also why a
specs column cannot sort correctly in a table: `100nF` lands between `10nF` and
`1uF`.

`value_si` is **always SI base units** — ohms, farads, henries. One unit, no
prefix, no ambiguity. `temp_coeff` is TEXT because `X7R`/`C0G` are categorical,
not numeric.

A narrow `part_specs(part_id, key, num_value, …)` table is the more general
design and was **rejected**: it multiplies rows scanned by ~10 on every refresh,
and rows read are metered.

### `rev` and `rev_token`
`rev` is optimistic concurrency. `rev_token` is what distinguishes *"the other
machine edited this"* from *"my own write landed but the response timed out"* —
after a timeout, read the row back and check whether the token is yours.
Without it a retried update reports zero rows changed and the tool blames a
conflict that never happened.

### `lib_id`
A **deliberately unvalidated** `<Category>:<Symbol>` reference into
`KICAD_CUSTOM_LIB`. This repository never reads or writes that one. A dangling
reference is an `inv check` finding, never an error.

### `equivalent_lcsc_pn` / `equivalent_basis`
For a part with no C-number of its own, so that *some* price can be shown.
Prices derived this way are **indicative** and must never be presented as the
part's own, nor silently summed into inventory value. Consequence: total
inventory value reports **two numbers**, priced and indicatively-priced, or it is
quietly wrong.

`equivalent_basis` is `mpn` | `spec` | `type` | `manual`, so the UI can say *how
much* to trust it. A `CHECK` constraint enforces the set; `NULL` passes, which is
correct for a part with no equivalent.

---

## `stock_events` — the only source of truth for stock

### Every event is a delta
Stock is `SUM(delta_qty)`. Nothing stores a quantity.

**A stocktake stores a delta too**, with `counted_qty` and `basis_qty` kept
alongside for reporting. An earlier design had a stocktake set an **absolute**
count that reset the running total; that made replay **order-dependent**, and
across two machines an order-dependent ledger discards real movements silently
while still producing a plausible number. A sum of deltas is commutative, so a
late-arriving event adds correctly and a correction means the same thing wherever
it lands.

Three `CHECK` constraints encode this so a caller cannot get it wrong:

```sql
CHECK (kind <> 'stocktake' OR (counted_qty IS NOT NULL AND basis_qty IS NOT NULL
                               AND delta_qty = counted_qty - basis_qty))
CHECK (kind <> 'purchase' OR delta_qty >= 0)
CHECK (kind NOT IN ('consume','scrap') OR delta_qty <= 0)
CHECK (kind <> 'correction' OR reverses IS NOT NULL)
```

### `seq`
`INTEGER PRIMARY KEY AUTOINCREMENT`, assigned by the server. It is **not** needed
for arithmetic — that is what making every event a delta bought. It earns its
place by making `stock_checkpoints` **permanently valid**: no event can ever land
below an existing `through_seq`, so a checkpoint never needs invalidating. With
clock ordering, one back-dated event would invalidate every checkpoint after it.

**`seq` is monotonic but NOT gapless** — an `INSERT OR IGNORE` that is ignored
still consumes a number (measured on the D1 engine). Never infer a count, a
density or completeness from it.

### `event_id`
Client-generated uuid4 hex, `UNIQUE`, and the single most important correctness
property in the project. With a network-only store a timeout leaves the outcome
unknown; blind retry double-counts and not retrying loses the event. Generate it
**once per logical event**, reuse it for every retry, and `INSERT OR IGNORE`
makes the retry free.

### `occurred_at` vs `recorded_at`
Two timestamps doing two different jobs, because conflating them is what makes
back-dating unsafe:

* `occurred_at` — when it happened in the world. User-editable. **Reports only,
  never arithmetic.**
* `recorded_at` — when the row was written. Not user-editable.

Both fixed-width ISO-8601 UTC (`2026-10-05T04:12:33.481Z`) so a lexicographic
sort is a chronological sort.

### `pack_count` / `pack_size`
Purchase provenance, so "1 reel" cannot be entered as `qty = 1`. The tool
computes `delta_qty = pack_count × pack_size` and echoes it back before
committing. Entering a reel as 1 looks entirely plausible on screen and is
invisible forever afterwards.

### `unit_price_micros`
Integer micro-USD. `$0.0021` is `2100`. **No float ever reaches a money path** —
that magnitude is exactly where drift starts to matter.

### `location_id`
Nullable and unused in v1, on purpose. Adding a column later is easy, but
**back-filling meaning** into events recorded without one is not: every event
written before locations exist is honestly location-unknown rather than guessed.
See `docs/deferred/locations-and-labels.md`.

`'transfer'` is likewise already in the `kind` CHECK set, because altering a
CHECK constraint in SQLite means rebuilding the table and the cheap moment was
before there was any data.

---

## `orders`
Without this, an $8 shipping charge cannot be amortised across a 40-line LCSC
order, and *"what did this reel actually cost me, delivered"* is permanently
unanswerable — which is the number that matters most for a semi-pro. A single
`price_paid` column on `parts` would be lossy the moment the same part is bought
twice at different prices, which is why price lives on the **event**.

---

## `stock_checkpoints` — a cache with a proof attached
**Not** a stored stock level. `through_seq` is the proof: the row is exactly the
sum of every event up to that `seq`, so

```
stock = checkpoint.qty + SUM(delta_qty) WHERE seq > through_seq
```

Derived, disposable, recomputable from the ledger at any time. **Do not
"simplify" it into a `parts.stock` column** — that is the second source of truth
the whole design exists to avoid.

It exists because rows read are metered by rows **scanned**, and the naive
aggregate scans the whole ledger every time: ~22,000 rows per refresh at 2,000
parts today, ~82,000 by year three, which at 50 refreshes a day is 82% of the
5 M/day cap. The cap is a deadline, not headroom.

Written with a **monotone upsert** (`WHERE excluded.through_seq >
stock_checkpoints.through_seq`) so two racing devices converge and a device that
computed its figure from an older view of the ledger is ignored rather than
rolling the number back.

---

## `price_cache`
Keyed by **C-number, not part id**, because a price is a fact about a C-number
rather than about a part. That is also why `indicative` is **not** a column here:
whether a price is indicative depends on the part → C-number edge
(`parts.equivalent_lcsc_pn`), not on the price itself.

`price_breaks` holds the **whole ladder** as JSON. LCSC quotes tiers, so a single
price with no quantity attached is ambiguous and the UI must say which tier it is
showing.

The primary key includes `fetched_at`, so snapshots **append** and price history
accrues for free. `raw` keeps the provider payload, which is what makes a broken
parser diagnosable after the fact.

---

## `audit_log` and the trigger
Written by `parts_audit_update`, an `AFTER UPDATE` trigger — **not** by the
caller. One parameterised statement is the only atomic unit the REST API offers,
so "UPDATE the part, then INSERT an audit row" can land one and lose the other.
A trigger runs inside the implicit transaction that already wraps the `UPDATE`.

**Cost, stated plainly:** the trigger enumerates columns, so **adding a column
to `parts` requires a migration that drops and recreates the trigger**. Forget
that and the new column is silently missing from history. Trigger-written rows
also count against the daily `rows_written` budget.

There is no `AFTER INSERT` trigger: creating a part is not a change, and the row
itself is the record.

---

## `backups` and `import_runs`
`backups` makes the pre-bulk export gate a cheap read instead of a filesystem
scan: the tool **refuses a bulk mutating apply unless an export newer than N
minutes is recorded**, because Time Travel restores in place and all-or-nothing
and would discard every stock event since.

`import_runs` makes a bulk import resumable **with no local state** — resume is
derived from D1 by `import_run_id`, and `event_id` uniqueness makes re-running
idempotent. Idempotent-and-resumable beats transactional, which the REST API
cannot offer across requests anyway.
