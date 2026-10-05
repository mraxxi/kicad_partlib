# Work Plan: `KICAD_PART_LIBRARY` — a personal parts inventory

Audience: an LLM coding agent working in a fresh repo at
`/home/archvan/Documents/Kicad/KICAD_PART_LIBRARY`.
Read this whole file, then the `AGENTS.md` you create in Phase 0, before writing code.
Work phase by phase. Commit after each phase. Do not start a phase until the
previous phase's acceptance checks pass.

---

## 0. Context

### Why this project exists
`KICAD_CUSTOM_LIB` (the sibling repo, `mraxxi/kicad_customlib`) answers *"what
does this part look like in KiCad"* — symbols, footprints, 3D models. It
deliberately refuses to answer *"do I have one, what did it cost, and where do
I buy another"*. Its own GUI plan says so explicitly:

> * Part inventory, stock quantities, BOM reconciliation or purchasing. A separate project owns this.
> * Writing stock, inventory or GUI state into `.kicad_sym` / `.kicad_mod` / `provenance.json`.

This is that separate project. It tracks, for the parts actually on the bench:
detailed specs, current market price and availability, the price actually paid,
stock on hand, and the LCSC part number to reorder by. It must work from either
of two machines.

### The one structural difference from the sibling repo
`KICAD_CUSTOM_LIB`'s founding rule is *the disk is the source of truth; there is
no database, so nothing can drift*. That rule cannot survive here: stock on hand
is mutable state that no amount of scanning can derive. So this project inverts
it — **the database is the source of truth** — and pays for that inversion with
the guardrails in §2. Every other convention from the sibling repo is kept, and
§1 lists them.

### Decisions already made by the owner — do not re-litigate

| Decision | Detail |
|---|---|
| **Store** | **Cloudflare D1 is the only store.** No local source of truth, no persistent mirror, no inventory data in git. Git tracks code and docs only. The offline/outage tradeoff was spelled out and accepted; §2.6 is the agreed mitigation, and it is a *backup*, not a fallback store. |
| **GUI** | **Mandatory, PySide6/Qt** (6.11.2 already installed system-wide via pacman). But **CLI first** — the GUI arrives in Phase 5, after the engine works, so the project is useful early. |
| **Core purity** | `core/` is **stdlib-only** and must never import Qt. The CLI must run on a machine with no PySide6. Qt lives only in `gui/`. |
| **Controller** | A **toolkit-free view-model**, headlessly tested. Carried over verbatim from the sibling repo, where it is called "the single most important constraint in this plan". |
| **Part identity** | **The LCSC C-number is the primary identity.** A part with no C-number still exists, and simply does without the features that need one (live price, live stock). It may carry an *equivalent* C-number — basis `mpn` \| `spec` \| `type` \| `manual` — whose prices are surfaced as **indicative only**, never as this part's price. |
| **Money** | **USD only**, stored as integer **micro-USD** (`$0.0021` → `2100`). No floats anywhere in a money path. |
| **Distributor data** | **Opt-in, cached, never required.** The tool is fully usable with hand-typed figures. A fetch failure is never fatal; stale data is shown as "last known, N days old". |
| **KiCad coupling** | **Standalone.** One loose, unvalidated `lib_id` text field pointing into `KICAD_CUSTOM_LIB`. No project/BOM reading in v1. This repo never writes to the sibling repo. |
| **Locations** | **Not in v1.** Designed in full in `docs/deferred/locations-and-labels.md` (a Phase 0 deliverable) so a later agent can add it without redesigning. |

### Verified platform facts — treat as given, do not re-derive

Measured on this machine, 2026-10-05:

| Fact | Value |
|---|---|
| Python | 3.14.7 |
| PySide6 | 6.11.2, **pacman** (`local/pyside6`), not pip |
| PyQt6 also present | 6.11.0 — ignore it; pick PySide6 and never import both |
| Tk | 8.6 available (irrelevant here, but the fallback exists) |
| sqlite3 | 3.53.4 (matters: the test double must speak a dialect D1 accepts) |
| `wrangler` | on `PATH` at `/usr/bin/wrangler` |
| Sibling repo remote | `https://github.com/mraxxi/kicad_customlib` → suggest `kicad_partlib` here |

**Cloudflare D1 free tier**, from the official limits and pricing pages:

| Limit | Free | Consequence here |
|---|---|---|
| Databases / account | 10 | One is plenty |
| Max database size | **500 MB** | 2,000 parts ≈ 2 MB. Non-issue. |
| Storage / account | 5 GB | Non-issue |
| **Rows read / day** | **5,000,000** | Metered by rows *scanned*, not returned — so unindexed scans cost. §2.3 |
| **Rows written / day** | **100,000** | A 5,000-row CSV import is 5% of a day. §2.4 |
| Max row / BLOB | 2 MB | Never store datasheets or models — store URLs |
| Max SQL statement | 100 KB | §2.4 batching |
| **Max bound params / query** | **100** | **The real constraint on bulk insert.** §2.4 |
| Max query duration | 30 s | Set client timeouts below this |
| Time Travel | **7 days** | The *only* other safety net. §2.6 |

REST endpoint, which stdlib `urllib.request` can call with no dependency:

```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query
Authorization: Bearer <token>
Content-Type: application/json
{"sql": "SELECT ...", "params": [...]}
```

**Why D1 is right here and wrong for the sibling repo** — record this so it is
never revisited: KiCad resolves a `lib_id` by reading the *filesystem*. It
cannot load a symbol out of a database, so a D1-backed `KICAD_CUSTOM_LIB` would
have to materialise files locally anyway and git would still be doing the real
work. Add the 2 MB row cap (below the existing 1.6 MB `TPA3255DDV.step`, and
other models will exceed it) and the 500 MB database cap, and D1 there is a
strict regression. Inventory rows are small, structured, queryable and never
read by KiCad — the opposite case on every axis.

### LCSC data sources, as actually verified

There is no friendly public API. Three tiers, in descending reliability:

1. **Official OpenAPI** — `https://ips.lcsc.com/rest/wmsc2agent/product/info/{product_number}`,
   authenticated with `key` + `nonce` + `timestamp` + `signature`. The
   endpoint family is `wmsc2agent` and includes order submission, so it is
   aimed at resellers; **how a hobbyist obtains a key is not documented**. The
   signature algorithm is not documented either. Implement behind config; do
   not block on it.
2. **Anonymous web endpoints** — `GET https://lcsc.com/api/global/additional/search?q=<pn>`
   works; the bulk `wmsc.lcsc.com` search returns 403 to anonymous clients, and
   `POST https://lcsc.com/api/products/search` needs a CSRF token and cookies
   bootstrapped from a category page. Fragile by construction.
3. **Manual entry** — always available, always authoritative for what you paid.

Therefore the fetcher is a **provider plugin** (§6.4): one small module per
source, each free to break without taking anything else down.

---

## 1. Conventions carried over from `KICAD_CUSTOM_LIB`

Keep these. They are why that repo is pleasant to work in. Cite them in `AGENTS.md`.

- **Stdlib-only core.** `from __future__ import annotations` at the top of every
  module; `dataclasses`; `pathlib.Path`; explicit `typing` imports
  (`Dict, List, Optional, Sequence, Tuple` — not PEP 585/604 shorthand, matching
  the sibling repo).
- **`argparse`**, not click/typer. `build_parser()`, `main(argv=None) -> int`,
  `sys.exit(main())`. `RawDescriptionHelpFormatter` with a long `epilog` of real
  invocations. Subcommands via `set_defaults(func=cmd_x)`, dispatched as
  `args.func(args)`. Global `--debug` switches a one-line error for a traceback.
- **Exit codes** `EXIT_OK = 0`, `EXIT_ERROR = 1`, `EXIT_ABORTED = 2`.
- **An error funnel in `main()`**: known domain exceptions → `error: {exc}` on
  stderr; bare `except Exception` → `unexpected error: {type}: {exc}` plus
  "re-run with `--debug` for a full traceback". Each module defines its own
  exception type.
- **Atomic local writes** — `mkstemp` in the destination directory, `write`,
  `flush`, `os.fsync`, `os.replace`, `unlink` the temp on any `BaseException`.
  Applies to exports, caches and config.
- **Every mutating command prints its plan first.** `--dry-run` stops there,
  `--yes` skips the prompt, and **a non-interactive run without `--yes` is
  refused** — scoped per §2.5.
- **A refused action always says why**, in one sentence, with identical wording
  in the CLI and the GUI (the sibling repo's `RepoStatus.blockers()` pattern:
  one `Dict[action, reason]` map, both front-ends render it).
- **`pytest.ini`** exactly as the sibling's, adapted:
  ```ini
  [pytest]
  testpaths = tests
  pythonpath = . scripts
  filterwarnings = error
  ```
  `filterwarnings = error` is not negotiable.
- **Tests**: `tests/` is an importable package; module-level functions, no
  classes, grouped by banner comments; **full-sentence snake_case names that
  read as assertions** — `test_a_retried_event_insert_does_not_double_count`,
  not `test_insert_retry`. Capability probes over platform sniffing. Reusable
  module-level skips (`needs_display`, `has_wrangler`).
- **Comment style**: 74-dash section banners. Docstrings explain *why*, and
  **record the bug that motivated the code** — this is the sibling repo's most
  valuable habit. Keep it.
- **`CHANGELOG.md`**: one `## [Unreleased]`, no version numbers, `###` headings
  per phase or Keep-a-Changelog verb with a human subtitle. Bullets lead with a
  **bold symptom in the owner's words**, then mechanism, then root cause.
  Measurements over adjectives.
- **Data-file style** (for exports and config): JSON, `indent=2`, sorted keys,
  trailing newline, LF, UTF-8, a top-level `"version"` integer, **empty fields
  omitted rather than written as `""`**, dates as bare `YYYY-MM-DD` where a time
  would only add churn.
- **Config fails soft, data fails loud.** GUI preferences fall back to defaults
  on corruption; anything authoritative raises with an actionable message and
  leaves the file untouched. The sibling repo's `provenance.py` states this
  asymmetry and forbids "fixing" it. Same here.
- **Config lives outside the repo**: `$XDG_CONFIG_HOME/kicad_partlib/`.
- **Never block the event loop.** The sibling repo's hardest-won lesson, and it
  applies doubly here because *every* operation is a network call.

### What is deliberately dropped
- **Plan-then-apply for single-record edits.** Ceremony on "I used 12
  resistors" is friction, and §2.5 replaces the safety it provided with
  something stronger (an append-only ledger and an audit log). Plan-then-apply
  is kept for bulk and destructive operations.
- **`core/vcs.py`.** Git carries no data here. If a sync view is ever wanted it
  is for the code, and `git` on the command line is enough.

---

## 2. Architecture: the database is the source of truth

### 2.1 Stock is never a stored number, and every event is a delta
A `stock_events` table is **append-only**. Current stock is `SUM(delta_qty)`.
Events are **immutable**: a mistake is corrected by appending a reversing
`correction` event that names the event it reverses, never by `UPDATE` or
`DELETE`.

Kinds: `purchase` (+, carries unit price and order reference), `consume` (−,
optional free-text project note), `adjust` (±, reason required), `stocktake`,
`scrap` (−), `correction` (±, carries `reverses`).

**A stocktake stores a delta, not an absolute.** This is the single most
important correction to the first draft of this plan, which had `stocktake` set
an absolute count that reset the running total. That made replay
**order-dependent**, and an order-dependent ledger across two machines loses
events silently — which for an inventory is the worst possible failure, because
it produces a *plausible* number with no error anywhere.

So a stocktake event records all three of:

| Field | Meaning |
|---|---|
| `counted_qty` | what was actually on the shelf |
| `basis_qty` | what the ledger said at the moment of counting |
| `delta_qty` | `counted_qty − basis_qty` — **the only field arithmetic touches** |

Now every event kind is a delta and `SUM(delta_qty)` is **commutative**: it does
not matter what order events are replayed in, so a late-arriving event adds
correctly instead of being absorbed by a reset, and `correction` means exactly
the same thing wherever it lands. The stocktake has not lost its meaning — it has
moved out of arithmetic, where it was dangerous, and into *reporting*, where it
is useful: "the count on 2026-03-01 found 97, the ledger said 100, a −3
adjustment was recorded." Shrinkage becomes a report you can run.

Two consequences to honour rather than paper over:

- **A stocktake cannot be back-dated, and the CLI must refuse it in a sentence.**
  A count is an assertion about the shelf at the moment you looked; offering to
  record one in the past is offering a feature that cannot be implemented
  correctly.
- If events land with a higher `seq` that describe a period *before* a stocktake,
  that stocktake's `basis_qty` is now stale. That is **detectable, and a
  warning** — "a stocktake's basis changed after it was recorded" — never a
  silent recomputation. Same instinct as `provenance.json` in the sibling repo:
  advisory metadata warns, and stale advisory data is never an error.

This is also what buys the project its history: *price actually paid* is derived
from `purchase` events (last paid, weighted average, total spend), never stored
denormalised, and so it cannot disagree with itself.

### 2.1a Quantities and what a purchase actually cost
Two domain traps, both cheap now and expensive later:

- **`qty` is always in pieces.** Decided once, never negotiated. A purchase
  carries `pack_count` and `pack_size` as provenance and computes
  `qty = pack_count × pack_size`, echoing it back before commit
  ("5 × 1000 = 5000 pieces — correct?"). Entering a reel as `qty = 1` looks
  entirely plausible on screen and is invisible forever afterwards.
- **An `orders` table from day one** — `order_ref`, `shipping_micros`,
  `fees_micros`, `placed_at` — with `order_ref` on the purchase event. Without
  it, an $8 shipping charge cannot be amortised across a 40-line LCSC order, and
  "what did this reel actually cost me, landed" is permanently unanswerable.
  That is the number that matters most, so it cannot be an afterthought.

### 2.2 Ordering is by server-assigned sequence, not client clock
`stock_events.seq INTEGER PRIMARY KEY AUTOINCREMENT`. **Replay orders by `seq`.**

> **Verified on the real D1 engine**, not assumed — `wrangler d1 execute --local`
> runs D1's own code path with no account. `AUTOINCREMENT`, partial indexes
> (`CREATE INDEX … WHERE`), common table expressions and `INSERT OR IGNORE`
> against a `UNIQUE` column all work. The D1 SQL docs do not state this, so the
> probe is worth keeping as a test rather than re-litigating from documentation.
>
> **`seq` is monotonic but NOT gapless.** The probe inserted three statements,
> one a duplicate, and left 2 rows with `max_seq = 3`: *an ignored insert still
> consumes a sequence number.* Harmless for ordering, which is all §2.2 needs —
> but never infer a count, a density or completeness from `seq`, and in
> particular a future "pull everything since sequence N" sync must treat gaps as
> normal. This is exactly the kind of assumption that looks fine for a year.

This is the quiet payoff of the D1-only choice, and it must be stated plainly in
`AGENTS.md`: with two machines and a single authoritative database, ordering is
globally consistent and **immune to clock skew**. A client-timestamp ordering
would have needed a tie-break rule and would still have been wrong whenever one
laptop's clock drifted. The human-supplied `ts` is kept as *metadata* — when the
owner says it happened — and is never the authority for ordering.

Because §2.1 makes every event a delta, `seq` is **not** needed for arithmetic —
`SUM(delta_qty)` is order-independent. `seq` earns its place for two other
reasons, both of which matter:

1. **It makes checkpoints permanently valid** (§2.3). No event can ever appear
   below an existing `through_seq`, so a checkpoint never needs invalidating.
   With clock ordering, one back-dated event would invalidate every checkpoint
   after it and require cache-busting machinery.
2. It gives a stable, reproducible audit order for `inv history`.

**Split the one timestamp into two**, because conflating them is what made
back-dating dangerous in the first draft:

| Field | Meaning |
|---|---|
| `occurred_at` | when it happened in the world. User-editable. Used for reports. **Never** for arithmetic. |
| `recorded_at` | when the row was written. Never user-editable. |

Store both as fixed-width ISO-8601 UTC text (`2026-10-05T04:12:33.481Z`) so a
lexicographic sort is a chronological sort, and add a mechanical test that every
timestamp written matches that regex.

### 2.3 Stock for every part, and the read budget that was wrong
Now that every event is a delta (§2.1), the query is simply:

```sql
CREATE INDEX ix_ev ON stock_events(part_id, seq);

SELECT p.id, COALESCE(SUM(e.delta_qty), 0) AS qty
FROM parts p LEFT JOIN stock_events e ON e.part_id = p.id
GROUP BY p.id;
```

The `LEFT JOIN` from `parts` is load-bearing: a part with **no events at all**
must yield `0`, not vanish. Getting that backwards is the obvious bug, and it was
verified in sqlite along with the three other cases that matter. Keep the
all-parts and single-part variants as **separate SQL**, each filtered at its own
entry point — bolting `WHERE p.id = ?` onto the all-parts query still scanned all
of `parts` when measured.

**The budget in the first draft of this plan was wrong, and the error is worth
recording.** It counted `parts` and omitted `stock_events` entirely. D1 meters
`rows_read` as rows *scanned*, and this aggregate scans the whole ledger:

| | Rows scanned per full refresh | × 50 refreshes/day | vs 5 M cap |
|---|---|---|---|
| First draft's claim | — | "well under 1 M" | — |
| Reality, 2 k parts / 20 k events | ~22,000 | 1.1 M | 22% |
| Reality, year one at 20 events/part/yr | ~42,000 | 2.1 M | 42% |
| Reality, year three | ~82,000 | 4.1 M | **82%** |

So the cap is not comfortable, it is a **deadline** — and an index does not save
you, because it narrows which rows are scanned but `rows_read` still counts them.

**Checkpoints, designed now, built when measured.** One row per part:

```sql
CREATE TABLE stock_checkpoints(
  part_id TEXT PRIMARY KEY, through_seq INTEGER NOT NULL,
  qty INTEGER NOT NULL, computed_at TEXT NOT NULL);

-- monotone upsert: two racing devices converge, a stale one is ignored
INSERT INTO stock_checkpoints(part_id, through_seq, qty, computed_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(part_id) DO UPDATE SET
  through_seq = excluded.through_seq, qty = excluded.qty, computed_at = excluded.computed_at
WHERE excluded.through_seq > stock_checkpoints.through_seq;
```

Then `stock = checkpoint.qty + SUM(delta_qty) WHERE seq > through_seq` — bounded
at roughly one row per part plus a short tail, which *is* the budget the first
draft imagined it had. Checkpointing 2 k parts costs 2 k writes against the
100 k/day cap.

**This is only affordable because of `seq` (§2.2)**, and the plan must say so:
server-assigned ordering means no event can ever land below an existing
`through_seq`, so a checkpoint is valid forever. Frame it in `AGENTS.md` the way
`SqliteStore` is framed: **a checkpoint is not a stored stock level, it is a
cache with a proof attached** (`through_seq`) — derived, disposable, and
recomputable from the ledger at any time. That keeps §2.1's promise honest.

Build it behind `inv stock checkpoint` plus an automatic run when the tail
exceeds N events. The trigger to stop deferring is **measured**, not guessed —
see the `rows_read` instrumentation in Phase 1.

### 2.4 Retry-safety is the most important property in the project
With a network-only store, **an HTTP timeout leaves you genuinely unsure whether
the write landed**. Blind retry double-counts stock; not retrying loses it.

So: every event carries a **client-generated `event_id`** (uuid4 hex) with a
`UNIQUE` constraint, and every insert is `INSERT OR IGNORE`. A retry is then
free. The same id is reused across retries of the *same* logical event — generate
it once, before the first attempt, and keep it for the whole retry loop.

This single property turns three separate hazards into non-events:
- **Timeout** → retry with the same `event_id`. At most one row exists.
- **Daily write cap hit mid-import** → report `N of M applied; re-run to resume`,
  and re-running completes it. **Idempotent-and-resumable beats transactional**,
  which the REST API cannot give across requests anyway.
- **Partial bulk import** → same.

**But `event_id` only protects inserts.** The mutable `parts` row has no
equivalent, and the first draft of this plan left that hole open: retry
`UPDATE … WHERE id = ? AND rev = ?` after a timeout where the write *did* land,
and it reports zero rows changed — which §2.5 reads as a concurrency conflict.
The tool then tells the owner that the other machine edited this part when in
fact *they* did. Fix by carrying a client token in the same statement:

```sql
UPDATE parts SET …, rev = rev + 1, rev_token = ? WHERE id = ? AND rev = ?
```

After a timeout, read the row back: if `rev_token` is yours, your write landed.
That is the `event_id` trick applied to a mutable row.

**Batching shape — one bound parameter, not eight rows.** The obvious reading of
the 100-param cap is "~12 columns per event, so 8 rows per statement", which
makes a 2,000-row import 250+ round trips. The better shape passes the whole
batch as a **single JSON parameter**:

```sql
INSERT OR IGNORE INTO stock_events (event_id, part_id, kind, delta_qty, …)
SELECT json_extract(value,'$.event_id'), json_extract(value,'$.part_id'), …
FROM json_each(?)
```

One parameter, so the 100-param ceiling is irrelevant; the 100 KB *statement*
cap does not bind the payload because the payload is a parameter rather than
SQL, leaving the 2 MB string cap as the real limit. Hundreds of rows per request,
one statement, and byte-identical SQL on `SqliteStore`.

**Verified on the local D1 engine**: the `json_each(?)` insert succeeds, and
`typeof()` on the inserted column returns `integer` — so JSON carries types
through `json_extract` and micro-USD integers do not silently become TEXT. This
matters because the REST API documents `params` as an array of *strings*; if
plain bound params are stringly-typed on the wire, the JSON shape is not just
faster but more correct. **That REST-wire behaviour is still unverified** and is
probe P1 in Phase 0.

Never inline literals to dodge the param cap — that is interpolation into a
structured language, the exact bug class the sibling repo's Rule 1 bans
("**Never** `re.sub` with an interpolated replacement string"), and here the
blast radius is the whole database rather than one file.

### 2.5 Atomicity, audit, and what replaces plan-then-apply

**There is no multi-statement atomic write over the REST API.** `BEGIN
TRANSACTION` is rejected (D1 wraps each statement itself), and atomic
multi-statement `batch()` is a Workers-runtime capability with no HTTP
equivalent; a semicolon-joined statement list combined with a shared `params`
array is reported not to work. **Treat one parameterised statement as the only
atomic unit available.** (Marked unverified — probe P3.)

That breaks the first draft's "update the part, then insert an `audit_log` row":
a timeout can land one and lose the other. The fix is a **trigger**, so the
database writes the audit row inside the implicit transaction wrapping the
single `UPDATE`:

```sql
CREATE TRIGGER parts_audit AFTER UPDATE ON parts BEGIN
  INSERT INTO audit_log(audit_id, part_id, old_json, new_json, at)
  VALUES (hex(randomblob(16)), OLD.id, json_object(…OLD…), json_object(…NEW…), …);
END;
```

**Verified on the local D1 engine**: the trigger is accepted and fires — one
`UPDATE` produced exactly one audit row. It is genuinely atomic, it cannot be
forgotten by a caller, and `SqliteStore` inherits it for free because the
dialect is identical, which preserves the test-double property. State the cost
plainly: the trigger enumerates columns, so adding a column means a migration
that drops and recreates it, and trigger-written rows count against
`rows_written`.

So the three mechanisms are:

1. **Stock is never destructively updated** — append-only, so nothing is lost.
2. **Part edits are audited by trigger**, atomically.
3. **Optimistic concurrency** on part edits: `rev` plus the `rev_token` of §2.4.

**On a `rev` conflict, refuse — never auto-retry.** Re-sending the same payload
with the freshly-read `rev` silently converts optimistic concurrency into
last-write-wins and discards the other machine's edit. Retry is only valid when
the new value can be re-derived from the new base (`qty = qty + 1`), which a
form full of text fields cannot. The default is to **show a field-level diff** —
"changed on the other machine 20 minutes ago: `voltage_rating` 25 V → 50 V. Keep
theirs / keep yours / merge." Without the field-level diff the owner retypes
everything, and by the third time they will reach for `--force`.

Undo is an **ordinary rev-checked edit that writes its own audit row** ("undo of
`<audit_id>`"), not a magic restore — and undo of an edit whose row has changed
since must refuse, not clobber.

**The plan-then-apply rule, drawn properly.** The first draft exempted
single-record edits because `audit_log` gives undo. That reasoning is wrong:
undo-after and preview-before are not substitutes, and plan-then-apply's value
in the sibling repo was never undo — it was showing the blast radius first
("attach a `plan.warn(...)` for anything the user should know, especially when
existing projects will break"). A one-field edit is exempt because it has **no
fan-out**, not because it is undoable. So the rule, which is mechanically
checkable:

> **Plan-then-apply is required for any operation that touches a row the user
> did not name.**

That catches things that are not "bulk" at all: changing a part's C-number
invalidates its price cache; changing its part type changes the spec template and
may orphan spec keys; a part merge rewrites aliases. Plus the obvious ones — CSV
import, bulk price refresh, deletion, migrations. And keep the sibling repo's
`test_plan_purity.py` discipline verbatim: building a plan must not mutate
in-memory state either.

### 2.6 Backup, and the gate that a nag cannot replace
`wrangler d1 export <db> --output=<file>.sql` is the sanctioned path and
`wrangler` is already installed. The tool wraps it as `inv backup`, writes to a
configured directory with a dated filename, records the run in a
`backups(ran_at, row_counts, sha256, path)` table so the check is a cheap read,
and **`inv status` reports the age of the newest backup** — loudly past 14 days,
in both the CLI and the GUI status bar.

**Time Travel is weaker than it sounds, and this changes the design.** On the
free tier it is 7 days, it restores **in place**, and it is **all-or-nothing for
the whole database** — branching and cloning are not available. So a bad bulk
`UPDATE` on `parts` (a CSV import that flattens 2,000 rows' specs) **cannot be
undone without also discarding every stock event recorded since.** The
append-only ledger protects stock; it does not protect `parts`. And `audit_log`
lives in the same database under the same 7 days, so the undo history has no
second copy either.

Therefore a nag is not enough for the dangerous case: **refuse any bulk mutating
apply unless an export newer than N minutes exists**, with `--skip-export` as the
knowing override. That is exactly the sibling repo's `sync push` auditing first
and offering an explicit override, and it rests on the same stated principle —
"this is a single-user multi-machine setup, so the user is allowed to overrule
the tool knowingly."

`wrangler` is an external optional binary, treated like `zenity`/`kdialog` in the
sibling repo: used when present, never required, and its absence degrades to a
loud instruction rather than a crash. The backup is **not a fallback store**, and
`AGENTS.md` must not let it drift into one.

### 2.7 Secrets
`$XDG_CONFIG_HOME/kicad_partlib/secrets.json`, mode `0600`, **never in the
repo**, with `KICAD_PARTLIB_CF_TOKEN` / `..._CF_ACCOUNT_ID` / `..._CF_DATABASE_ID`
env overrides for CI. The token is **D1-scoped and account-limited** — document
creating it that way, because a Cloudflare API token is otherwise far broader
than this tool needs. A `401`/`403` must produce a message naming the config
path and the exact permission required, never a bare traceback.

---

## 3. Repository layout

```
KICAD_PART_LIBRARY/
├── AGENTS.md                      # operating guidelines (Phase 0)
├── README.md                      # setup + everyday use
├── CHANGELOG.md
├── pytest.ini
├── requirements-dev.txt
├── .gitignore  .gitattributes
├── .github/workflows/ci.yml
├── docs/
│   ├── d1-setup.md                # create the DB, scope the token, first migration
│   ├── schema.md                  # tables, with the reasoning per column
│   └── deferred/
│       ├── locations-and-labels.md    # Phase 0 deliverable, see §7
│       ├── bom-reconciliation.md      # the KICAD_CUSTOM_LIB bridge, deferred
│       └── offline-mode.md            # what a local mirror would take, if ever
├── migrations/
│   ├── 0001_initial.sql
│   └── 0002_….sql                 # append-only; never edit a shipped migration
├── scripts/
│   ├── inv_manager.py             # the only entry point: CLI + `gui` subcommand
│   └── src/
│       ├── core/                  # stdlib only, no Qt, no network except d1.py
│       │   ├── store.py           # the Store interface (~8 methods)
│       │   ├── d1.py              # D1Store: REST over urllib, retries, errors
│       │   ├── sqlite_store.py    # SqliteStore: same SQL, local file — test double
│       │   ├── migrate.py         # VERIFIES the schema version; wrangler applies
│       │   ├── models.py          # Part, StockEvent, PriceSnapshot dataclasses
│       │   ├── identity.py        # C-number validation, local ids, equivalents
│       │   ├── stock.py           # replay, the aggregate query, stocktake rules
│       │   ├── money.py           # micro-USD integers, parsing, formatting
│       │   ├── specs.py           # freeform specs + per-type templates
│       │   ├── parts.py           # CRUD, rev-checked, audit-logged
│       │   ├── importer.py        # CSV/clipboard bulk import, planned
│       │   ├── market.py          # price/stock snapshots, staleness
│       │   ├── backup.py          # wrangler wrapper + backup-age reporting
│       │   └── check.py           # structured audit with severities
│       ├── providers/             # one fragile thing per file
│       │   ├── base.py            # Provider protocol; failure is never fatal
│       │   ├── manual.py
│       │   ├── lcsc_web.py        # anonymous, CSRF-bootstrapped, best-effort
│       │   └── lcsc_openapi.py    # official, HMAC-signed, needs a key
│       └── gui/                   # PySide6 only
│           ├── controller.py      # toolkit-free view-model, headlessly tested
│           ├── models.py          # QAbstractTableModel + proxy
│           ├── main_window.py  part_editor.py  stock_dialog.py
│           ├── workers.py         # QThreadPool + signals; no blocking calls
│           └── settings.py        # fails soft, outside the repo
└── tests/
```

### Schema, in outline
`migrations/0001_initial.sql` creates:

- **`parts`** — `id TEXT PRIMARY KEY`. **For a part with a C-number, `id` *is*
  the C-number** (`C23179`); otherwise a prefixed surrogate `X-<uuid4hex>`. This
  is what stops two machines creating two rows for one part and splitting its
  stock across both with nothing noticing: `INSERT OR IGNORE` dedupes the race
  for free. Belt as well as braces:
  `CREATE UNIQUE INDEX … ON parts(lcsc_pn) WHERE lcsc_pn IS NOT NULL`.
  - **`merged_into TEXT` must exist from day one.** A part entered without a
    C-number that later acquires one needs a merge path, and the rule is that
    **events are never rewritten — only the alias is followed**. Retrofitting
    identity merge onto a live event log is the most expensive change on this
    list, and it is nearly free to provide for now.
  - Then `mpn`, `manufacturer`, `description`, `part_type`, `specs` (JSON text),
    `datasheet_url`, `lib_id` (loose, unvalidated), `equivalent_lcsc_pn`,
    `equivalent_basis`, `min_stock`, `unit` (default `pcs`), `notes`, `tags`,
    `rev` INTEGER, `rev_token` TEXT (§2.4), `created_at`, `updated_at`.
  - **Promoted typed columns**, decided now: `package`, `value_si REAL`,
    `tolerance_pct REAL`, `voltage_rating_v REAL`, `current_rating_a REAL`,
    `temp_coeff`. Because **the freeform `specs` JSON cannot answer the single
    most useful question an inventory has** — "every ceramic cap between 10 n and
    1 µ in 0402 that I have more than 50 of" — since `100n`, `100nF`, `0.1uF`
    and `1e-7` neither sort nor compare. It is also why a specs column cannot
    sort correctly in the GUI: `100nF` lands between `10nF` and `1uF`. The rule
    to write into `AGENTS.md`: **JSON is for display; promote a key to a typed
    column the moment you want to filter or sort on it.** The per-part-type
    template populates them. (A narrow `part_specs(part_id, key, num_value, …)`
    table is the more general answer and is rejected here: it multiplies rows
    scanned by ~10 on every refresh, which §2.3 cannot afford.)
- **`stock_events`** — `seq INTEGER PRIMARY KEY AUTOINCREMENT`,
  `event_id TEXT UNIQUE NOT NULL`, `part_id`, `kind`, **`delta_qty`** (the only
  arithmetic field), `counted_qty`, `basis_qty` (stocktakes only),
  `unit_price_micros`, `pack_count`, `pack_size`, `order_ref`, `reverses`,
  `note`, `device`, `occurred_at`, `recorded_at`, and a **nullable
  `location_id`** that §7 will need (see §8.4). Index on `(part_id, seq)`.
- **`orders`** — `order_ref PRIMARY KEY`, `shipping_micros`, `fees_micros`,
  `placed_at`. Landed cost, per §2.1a.
- **`stock_checkpoints`** — per §2.3. A cache with a proof.
- **`price_cache`** — keyed by **C-number, not part id**, because it holds facts
  about a C-number rather than about a part. `provider`, `fetched_at`,
  `stock_qty`, `price_breaks` (JSON — LCSC quotes a *ladder*, and a single
  `price_micros` with no quantity attached is ambiguous). `indicative` belongs on
  the **part → C-number edge**, not here. Consequence: "total inventory value"
  must report **two numbers**, priced and indicatively-priced, or it is quietly
  wrong, and an indicative price is never rendered at the same visual weight as
  a real one.
- **`audit_log`** — `audit_id`, `part_id`, `at`, `device`, `old_json`,
  `new_json`. Written by the trigger in §2.5.
- **`backups`** — `ran_at`, `row_counts`, `sha256`, `path`. Per §2.6.

Every column gets a comment in `docs/schema.md` saying *why it exists*, in the
sibling repo's voice.

---

## 4. Phases

Each phase ends with a commit and must pass its acceptance checks first.

### Phase 0 — Scaffolding and the decisions that are expensive to change
Set up the repo, and settle in writing the things that are costly to revisit:
**part identity** (§0 table), **micro-USD integers**, **`seq`-ordered immutable
events**, **`event_id` idempotency**, **the `Store` interface**, and
**`core/` never importing Qt**.

- `git init`; `.gitignore` (`__pycache__/`, `.venv/`, `*.pyc`, `.pytest_cache/`,
  `secrets.json`, `backups/`, `.directory`, `.DS_Store`); `.gitattributes`
  (`* text=auto eol=lf`, `*.sql text eol=lf`).
- `pytest.ini`, `requirements-dev.txt` (`pytest>=8.0`, `pytest-qt>=4.4`; a
  comment noting the tool itself needs only the stdlib plus PySide6 for the GUI,
  and that PySide6 is pacman-installed here, so **do not** pip-install it on Arch).
- `AGENTS.md` and `README.md` skeletons; `CHANGELOG.md` with `## [Unreleased]`.
- `docs/d1-setup.md`, `docs/schema.md`.
- **`docs/deferred/locations-and-labels.md` in full** — the owner asked for this
  specifically, see §7. Also stub `bom-reconciliation.md` and `offline-mode.md`.
- `migrations/0001_initial.sql`.

**Probes.** Run each against a throwaway D1 database, write up the exact command
and the measured answer in `AGENTS.md`, then treat them the way the sibling repo
treats its platform constraints: *"Treat them as given; re-deriving them wastes
time."* Four are already answered against the local engine and need only
confirming over REST.

| # | Probe | Status |
|---|---|---|
| P1 | Are bound `params` typed or stringly on the wire? Bind `123` and `"123"` into an INTEGER column, read back `typeof(col)`. | **open — REST only** |
| P2 | `INSERT … SELECT json_extract(value,'$.k') FROM json_each(?)`, and how large a JSON param round-trips. | ✅ works locally; types survive (`typeof → integer`) |
| P3 | Is a semicolon-joined multi-statement `/query` atomic? Send a good INSERT then a constraint-violating one; see whether the first survives. | **open — REST only** |
| P4 | Do `AFTER UPDATE` triggers fire, and are trigger-written rows counted in `meta.rows_written`? | ✅ fires locally; the `rows_written` half is open |
| P5 | Is `sqlite_master` readable? Is `pragma_table_info('t')` readable as a table-valued function? | ✅ both locally |
| P6 | `INTEGER PRIMARY KEY AUTOINCREMENT` behaviour, and what `INSERT OR IGNORE` reports on a UNIQUE conflict. | ✅ works; **`seq` has gaps** (§2.2) |
| P7 | Is an expression index on `json_extract(specs,'$.k')` accepted? | open |
| P8 | Capture the **real wire bodies** for 401, quota-exceeded, and a 30 s timeout. These become test fixtures. | open — REST only |
| P9 | Confirm `meta.rows_read` for a `SUM … GROUP BY` over N rows is ≈ N, so §2.3's budget is measured rather than assumed. | open — REST only |

**Acceptance:** `pytest -q` runs (even with one trivial test); `.gitattributes`
present; a verified-constraints section in `AGENTS.md` with one row per probe and
its measured answer; captured error bodies committed as fixtures; the
PySide6-with-`filterwarnings = error` cost measured now rather than discovered in
Phase 5; the deferred-design doc complete enough that a future agent needs no
further decisions from the owner. **No production code in this phase.**

### Phase 1 — The store layer, tested entirely offline
`core/store.py` (interface), `core/sqlite_store.py`, `core/d1.py`,
`core/migrate.py`.

- `Store` is narrow: `query`, `execute`, `batch`, `migrate`, `schema_version`,
  `health`. Both implementations satisfy it; **one shared test suite runs against
  both**, with the D1 half skipped unless credentials are present
  (`has_d1 = pytest.mark.skipif(...)`).
- `D1Store`: `urllib.request`, bounded retries with jittered backoff on 5xx and
  timeouts **only** (never on 4xx), client timeout below D1's 30 s, and typed
  exceptions — `D1AuthError`, `D1LimitError` (distinguishing the daily write
  cap), `D1TimeoutError`, `D1SchemaError`. Every one carries a message that says
  what to do next.
- **HTTP 200 is not success.** The Cloudflare API wraps results as
  `{"result": [{"results": […], "success": …, "meta": {…}}], "success": …,
  "errors": […]}` and returns **200 with `success: false`** for a SQL error, with
  the real message in `errors[]`. So `D1Store` must check the outer `success`,
  **then each statement's own `success`**, and surface `errors[0]["message"]` —
  never `raise_for_status()` and assume. Treating 200 as "it worked" is the
  single easiest way to lose a write silently in this design. Pin the unwrapping
  in a test against a recorded response fixture, so a shape change fails loudly
  rather than at the next stocktake.
- `meta` carries `rows_read` / `rows_written`. **Accumulate them per session and
  expose them in `inv status`** — it is the only honest way to know how much of
  the 5 M / 100 k daily budget the tool actually spends, and it makes §2.3's
  arithmetic checkable instead of theoretical.
- **Migrations are `wrangler`'s job, not ours.** `wrangler 4.84.0` ships
  `wrangler d1 migrations list|apply`, which tracks applied files in its own
  table. Hand-rolling this was in the first draft of this plan and is now
  **dropped**: it would duplicate a sanctioned tool and own the
  half-applied-migration risk for no gain. So:
  - `migrations/000N_name.sql`, append-only, **never edit a shipped migration**.
  - Applying them is `wrangler d1 migrations apply <db>` — a deliberate,
    dev-time act, documented in `docs/d1-setup.md`.
  - `core/migrate.py` shrinks to *verification only*: read the schema version,
    compare against the version the code expects, and **refuse to run** on a
    mismatch with a message naming the exact `wrangler` command to fix it. A
    tool that silently migrates the owner's only copy of the data is not what
    is wanted here.
  - Keep every migration statement **individually** idempotent
    (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) and assert in a
    test that applying every migration twice is a no-op. `ALTER TABLE ADD
    COLUMN` is *not* idempotent — probe the live schema from `sqlite_master`
    (a plain `SELECT`, confirmed readable) rather than `PRAGMA table_info`.
  - **Rehearse every migration on a second D1 database.** The free tier allows
    10, and that is an asset this plan was not using: seed a staging database
    from an export, migrate it, and only then touch the real one. That retires
    most of the half-applied risk before it can occur.
  - **The two-machine failure nobody plans for:** migrate on machine A, walk to
    machine B which still has last week's checkout, and B writes into a schema
    its code does not understand. Add **`min_code_version`** to the schema and
    check it once per session on connect; a device whose code is older than the
    live schema **refuses to write**, with a sentence saying to `git pull`. This
    is the direct analogue of why the sibling repo's `sync pull` re-audits what
    arrived.
  - If probe P3 shows a multi-statement `/query` is *not* atomic, fall back to a
    per-statement migrations ledger keyed `(version, stmt_index)` so an
    interrupted migration resumes exactly where it stopped instead of being a
    mystery. Decide this from P3's measured answer, not from preference.

Also worth using rather than rebuilding: `wrangler d1 info` (database size, for
`inv status`), `wrangler d1 time-travel` (restore), `wrangler d1 insights`
(which queries are actually costing rows read — the honest way to revisit §2.3).

**Acceptance:** the shared suite passes against `SqliteStore` with no network;
applying all migrations twice is a no-op; `inv_manager.py health` reports the
schema version against a real D1 database and refuses clearly on a mismatch.

### Phase 2 — The engine and a CLI that is already useful
`identity.py`, `money.py`, `models.py`, `specs.py`, `parts.py`, `stock.py`,
`check.py`, and the `argparse` CLI.

```bash
inv add C23179 --type resistor --spec resistance=10k --spec tolerance=1% --spec power=0.1W
inv add --local --mpn SOMETHING --equivalent C23179 --equivalent-basis mpn
inv show C23179
inv list --type resistor --low-stock --json
inv buy    C23179 100 --unit-price 0.0021 --order LCSC-2026100412
inv use    C23179 12 --note "TPA3255 front-end v1"
inv count  C23179 97 --note stocktake
inv correct <event_id> --reason "logged against the wrong part"
inv history C23179
inv check
inv backup
inv status
```

**Acceptance:** a part can be added, bought, consumed, counted and corrected
end-to-end against a real D1 database; `inv history` shows the ledger with
`seq`; a deliberately-killed `inv buy` (`SIGKILL` mid-request), re-run, yields
**exactly one** event — the idempotency property, as a test; stock for 500 parts
is one query, asserted by counting statements issued.

### Phase 3 — Price, availability, and staleness that is visible
`market.py` and `providers/`.

- `Provider` protocol: `fetch(lcsc_pn) -> PriceSnapshot | None`. **A provider
  that raises is caught, logged and skipped** — never fatal, never retried into
  a hang. Each provider declares whether it needs credentials.
- `manual.py` always works. `lcsc_web.py` is best-effort and documents its own
  fragility in its docstring. `lcsc_openapi.py` is implemented behind config and
  skipped without a key.
- Snapshots append to `price_snapshots`, so price history accrues. Display is
  always `price (fetched N days ago)`; past a configurable threshold it reads
  **stale**. A price derived from an *equivalent* C-number is labelled
  **indicative** everywhere it appears, including in `--json`.
- `inv refresh [--all | <id>...]` is plan-then-apply and reports per-part
  outcomes; one failure never stops the batch.

**Acceptance:** with the network unplugged, every command still works and prices
show their true age; `inv refresh --all` on 50 parts reports successes and
failures individually; an equivalent-derived price is never presented as the
part's own.

### Phase 4 — Bulk import, quota, backup
`importer.py`. CSV in, with a column mapper, `--dry-run` showing exactly what
would be created versus updated, batched as **one JSON parameter per request via
`json_each(?)`** (§2.4), and **resumable**: re-run state is derived from D1 by
`import_run_id`, so resuming needs no local mirror and creates nothing twice.

Also lands here: `inv stock checkpoint` (§2.3), `inv quota` reporting *measured*
`rows_read`/`rows_written` accumulated from `meta`, and `inv backup` with the
`backups` row and the pre-bulk export gate of §2.6.

**Acceptance:** a 2,000-row CSV imports in **under ~20 requests**, not 250; the
plan states the write count *and* the session's measured usage before you
confirm; the import killed halfway and re-run produces an identical database
(assert row counts and a checksum of the ledger); a bulk apply is **refused**
without a fresh export, and `--skip-export` overrides it loudly; a full-inventory
read after checkpointing costs ~1 row per part, **measured from `meta`, not
assumed**.

### Phase 5 — The PySide6 GUI
`gui/`, with the boundary drawn as in the sibling repo.

- **`controller.py` imports no Qt** and is tested headlessly. If a decision can
  be made without Qt, it belongs there or in `core/`. Frozen dataclass rows with
  a stable id, never display text, as the identity.
- **`QAbstractTableModel` + `QSortFilterProxyModel`**, not `QTableWidget` —
  this is the entire reason Qt was chosen. At 5,000 rows the pairing is
  sub-frame; what makes it slow at this size is going *through* the model API to
  filter. So: override `filterAcceptsRow` against a **precomputed lowercase
  search blob held as a plain Python list** in the source model, indexed
  directly — never `sourceModel().data(index, role)` per column per row per
  keystroke, which is 5k × ncols `QVariant` conversions per character. Debounce
  the search box with a 150 ms `QTimer`. Sort via a dedicated `Qt.UserRole`
  returning the **comparable** value and have `lessThan` use it; never parse
  strings in `lessThan` — and note this only works because §3's promoted typed
  columns exist. The Qt layer cannot fix `100nF` sorting between `10nF` and
  `1uF`; only the data model can.
- `beginResetModel`/`endResetModel` for a wholesale refresh, but `dataChanged`
  for a single-part edit, so **selection and scroll position survive**.
- **Dynamic spec columns are a view-model problem, not a widget problem.** The
  union of spec keys across 5,000 mixed parts is hundreds of mostly-empty
  columns and is not a useful table. Correct shape: a fixed core column set
  always, **plus the current part type's template columns only once the filter
  has narrowed to one part type** — a view-model decision with a headless test.
  And **key persisted column width/order/visibility by spec-key name, never by
  column index**: the index's meaning changes the moment the spec set changes,
  and a restored layout then applies the wrong width to the wrong column. That
  is the same bug the sibling repo already paid for ("`iid` is a stable
  identity, never display text"), in a new toolkit.
- **`workers.py`: `QThreadPool` + signals** — not asyncio, because the Store is
  synchronous stdlib `urllib` *by design* (core must stay Qt-free and
  stdlib-only) and `qasync` would be a new runtime dependency the house rules
  forbid. Specifics:
  - **A dedicated pool with `setMaxThreadCount(1)` for every mutating call**, so
    two writes never interleave — the sibling repo's rule transplanted ("every
    git call runs on a worker thread, one at a time, so two git commands never
    contend for the index lock"). A second pool of 2–4 threads for read-only
    price fetches.
  - `QRunnable` cannot emit signals: use a tiny `_Signals(QObject)` holder with
    `done`/`failed`, default `AutoConnection` so delivery lands on the GUI
    thread. **Nothing in a worker may touch a model, a widget or controller
    state** — workers take plain inputs and return plain data, which is also
    what keeps the controller testable.
  - **Drop results for superseded requests** via a monotonically increasing
    request id compared on arrival. Without it a slow refresh completing after a
    faster newer one repaints stale data: easy to miss, maddening to diagnose.
  - `urllib.request.urlopen` does no connection pooling, so every call pays a
    TLS handshake (~100 ms to Cloudflare). A kept-alive
    `http.client.HTTPSConnection` **per worker thread** is worth it — per-thread,
    not shared behind a lock, since a lock would serialise the read pool.
  - Nothing in `gui/` ever calls a `Store` method on the GUI thread — assert it.
- A status bar carrying: database reachability, the backup age from §2.6, and
  the write-cap headroom if it has been seen to be low.
- Settings in `$XDG_CONFIG_HOME/kicad_partlib/gui.json`, **failing soft**,
  geometry keyed per screen resolution (the sibling repo's convention).
- Tests: `pytest-qt` (dev-only, like `pytest`), and three mechanism details that
  are otherwise learned painfully:
  - **`QT_QPA_PLATFORM=offscreen` must be set before any PySide6 import** —
    `os.environ.setdefault(...)` at `tests/conftest.py` module scope, and no test
    module may import PySide6 at collection time unguarded. Get the ordering
    wrong and tests pass locally while failing in CI, or the reverse.
  - **`filterwarnings = error` plus PySide6 is a landmine.** Qt and shiboken emit
    `DeprecationWarning` and `ResourceWarning` that `pytest.ini` will promote to
    failures. Expect targeted ignores, each with a comment saying *why* it
    exists. Measure this cost in Phase 0, not here.
  - **Press every button in a test** — the sibling repo's hardest-won habit,
    with a *different mechanism* in Qt. Its `CHANGELOG` records that Tk routes a
    callback exception to `report_callback_exception`, so `invoke()` returned
    normally and the first version of that test passed with the bug still in
    place. In PySide6 an exception in a slot invoked from C++ goes to
    `sys.excepthook`, so `button.click()` may not propagate either. Install a
    failing `sys.excepthook` in the fixture and **verify it against the running
    interpreter** rather than assuming — this is the trap that already reached a
    user once.
- **Two mechanical boundary tests**, in the style of the sibling's
  `test_no_module_hardcodes_a_padding`: (1) the controller's source contains no
  `Qt`, `QModel`, `Signal`, `QVariant` or `QAbstractItemModel` identifier — a
  leaked `Qt.AlignRight` return value *is* a breach; (2) **the CLI runs with
  PySide6 unimportable**, simulated by a `sys.meta_path` finder that raises on
  `PySide6`. The second is what actually protects the "CLI needs no Qt" promise,
  and it costs about fifteen lines.

**Acceptance:** the table sorts and filters 5,000 rows without stutter; pulling
the network mid-session surfaces an error in the status bar and leaves the window
responsive; every action is reachable from the CLI too.

### Phase 6 — Documentation and CI
- `AGENTS.md` and `README.md` complete, in the sibling repo's voice, carrying
  §2's reasoning so the D1-only tradeoff and its guardrails are not rediscovered.
- `.github/workflows/ci.yml`: matrix `ubuntu/windows/macos` × Python
  `3.12`/`3.14`, explicit `timeout-minutes: 15`, `QT_QPA_PLATFORM=offscreen`,
  `pytest -q`, then `inv check --local` as a gate. **No D1 credentials in CI** —
  the whole suite runs against `SqliteStore`.
- A line-endings job, as in the sibling repo.

---

## 5. The three biggest risks, and the cheapest mitigation for each

| Risk | Mitigation |
|---|---|
| **The ledger silently loses events.** The first draft's absolute-resetting stocktake made replay order-dependent; across two machines that discards real movements and nothing ever flags it. The worst kind of inventory bug, because it yields a *plausible* number. | One rule change: the stocktake stores `delta_qty` computed at write time, keeping `counted_qty`/`basis_qty` for reporting. Stock becomes `SUM(delta_qty)` — commutative, order-independent, correct under late arrival. §2.1. About a day's work, and it is also what makes checkpoints valid forever. |
| **A write whose outcome is unknown** (timeout, cap, crash) double-counts or loses stock. | `event_id` UNIQUE + `INSERT OR IGNORE` for inserts, `rev_token` for updates — the id generated once per logical event and reused across retries. §2.4. Test this first and hardest. |
| **The read budget runs out in year one.** The first draft's 250 k/day counted `parts` and omitted the ledger; the real figure is ~20× that and grows without bound. | `stock_checkpoints` with a monotone upsert, plus **measured** `rows_read`/`rows_written` from `meta` surfaced in `inv status`. §2.3. Instrumentation is what catches this class of arithmetic error; a spreadsheet is what caused it. |
| **No atomic multi-statement write**, and the first draft assumed one. The part-edit-plus-audit pair, and any migration, can land half-done — and the tempting workaround (inline the literals, drop the params) is the interpolation bug the sibling repo's Rule 1 bans, with the database as blast radius instead of one file. | One statement per request, always. An `AFTER UPDATE` trigger writes the audit row inside the implicit transaction (verified). Migrations rehearsed on a second free-tier database, with a per-statement ledger if P3 says it is needed. §2.5. |
| **Time Travel cannot undo a bad bulk write.** 7 days, in place, all-or-nothing — so restoring after a botched import also discards every stock event since. | Refuse a bulk apply without a fresh export, recorded in `backups`; `--skip-export` as the knowing override. §2.6. |
| **A fragile scraped LCSC endpoint rots** and takes working features with it. | Providers isolated one-per-file behind a protocol; a raising provider is caught and skipped; manual entry always works; every displayed price carries its own age. §0 / Phase 3. |

---

## 6. Open items that do not block Phase 0

- **`git-lfs` or R2 for `*.step`/`*.wrl`** in the *sibling* repo. A real
  question, unrelated to this project, recorded in the sibling's plan as a
  deferral. Do not bundle it in here.
- **BOM reconciliation** — reading a KiCad project and reporting have / short /
  unknown per line, with an LCSC order list for the shortfall. The owner chose
  standalone for v1; the `lib_id` field keeps the door open.
  `docs/deferred/bom-reconciliation.md`.
- **An LCSC OpenAPI key.** Worth an application; the plan does not depend on one.

---

## 7. `docs/deferred/locations-and-labels.md` — required content

The owner asked for this to be written well enough that a future agent can
integrate it without redesigning. It must specify, not merely suggest:

- **Schema**: a `locations` table (`id`, `label`, `kind` drawer/bin/reel/box,
  `parent_id` for nesting, `note`) and a `part_locations` join
  (`part_id`, `location_id`, `qty`) — with the hard question answered
  explicitly: **per-location quantity must be derived from the ledger too**, by
  adding a nullable `location_id` to `stock_events`, not stored as a mutable
  number. Otherwise the project grows a second, drifting source of truth, which
  is exactly what §2.1 exists to prevent.
- **Migration**: the next-numbered `migrations/000N_locations.sql`, additive
  only, with every existing event treated as location-unknown rather than
  back-filled to a guess.
- **A `transfer` event kind** — net zero, moving `qty` between two locations.
- **CLI surface**: `inv where <id>`, `inv move <id> <qty> --from A --to B`,
  `inv locations [--tree]`.
- **GUI surface**: a location column, a location filter, and a per-part
  breakdown in the editor.
- **Labels**: a printable sheet generator producing **SVG** (stdlib, exact,
  printable, no dependency) with a QR code encoding `partlib:<part_id>`.
  QR generation in pure stdlib is ~150 lines for the byte mode and fixed error
  correction this needs; specify version/EC level and sheet geometry (e.g.
  Avery-style grid, configurable) rather than leaving it open.
- **Acceptance checks** for the future phase, in the same shape as §4.

---

## 8. Things to get right in Phase 0 because they are expensive later

Collected here so they are not buried in prose:

Every one of these touches either the event log or the identity of a part, which
is why they cannot wait.

1. **Part identity**: `id` *is* the C-number for C-number parts, `X-<uuid4hex>`
   otherwise — **plus `merged_into`**, and the rule that events are never
   rewritten, only the alias followed. Retrofitting identity merge onto a live
   event log is the most expensive change on this list.
2. **Every event is a delta.** The stocktake stores `counted_qty`, `basis_qty`
   and the computed `delta_qty`; back-dating a stocktake is refused. §2.1.
3. **`occurred_at` vs `recorded_at`** as two separate fixed-width ISO-8601 UTC
   fields. Conflating them is what makes back-dating unsafe.
4. **`seq INTEGER PRIMARY KEY AUTOINCREMENT`**, with a client `event_id` UNIQUE
   for idempotency. Retro-fitting idempotency onto a ledger that already holds
   ambiguous duplicates means deciding by hand which of two identical rows was
   real.
5. **Micro-USD integers**, one module owning the rounding rule, and the `orders`
   table so shipping can be amortised. A float that reaches the database is
   permanent, and `0.0021` is exactly the magnitude where it starts to matter.
6. **`qty` is always pieces**; `pack_count`/`pack_size` are provenance.
7. **The promoted typed spec columns, named explicitly.** JSON is display-only.
8. **`stock_events` column set**, including the nullable `location_id` that §7
   will need. Adding a column later is easy; *back-filling meaning* into events
   recorded without it is not — so add it nullable now and leave it null, with
   `AGENTS.md` saying why it is there and unused.
9. **Audit via trigger**, not a second statement. §2.5.
10. **`min_code_version`** in the schema, so a stale checkout refuses to write.
11. **`core/` never imports Qt**, and nothing but the Store layer imports `d1`.
    Enforce both with meta-tests on day one; it is trivial now and a painful
    untangling on day ninety.
12. **Checkpoints are a cache with a proof**, never a source of truth. Writing
    that sentence into `AGENTS.md` now is what stops a later agent "simplifying"
    it into a stored stock column.

## 9. Verification, end to end

```bash
# Setup, once per machine
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
# PySide6 comes from pacman on Arch; do not pip-install it here.

# The whole suite, no network, no credentials
.venv/bin/pytest -q

# Against a real D1 database (credentials from the config or env)
.venv/bin/python scripts/inv_manager.py health
.venv/bin/python scripts/inv_manager.py check

# The idempotency property, by hand, because it is the one that matters
.venv/bin/python scripts/inv_manager.py buy C23179 100 --unit-price 0.0021 --yes
#   ... kill it mid-flight, then re-run the identical command ...
.venv/bin/python scripts/inv_manager.py history C23179    # exactly one event

# Offline behaviour
sudo ip link set <iface> down
.venv/bin/python scripts/inv_manager.py list     # must fail with a clear message,
                                                 # naming the config path, not a traceback

# The GUI
.venv/bin/python scripts/inv_manager.py gui
```

On the second machine, the only setup is: clone, create
`$XDG_CONFIG_HOME/kicad_partlib/secrets.json`, run `inv health`. There is no
data to sync — which is the whole point of the choice made in §0.
