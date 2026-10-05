# Reconciliation: Python/PySide6/REST design → Worker/React plan

Status: **decided and implemented through Phase 1** (owner answers, 2026-10-06: replace; name `kicad_partlib`; single user; start clean; same repo; production empty; audit log my call → dropped, `stock_moves` is the history). The text below is the original proposal, kept as the record; where it disagrees with `AGENTS.md`, `AGENTS.md` wins. The owner chose to *replace* the
Python/PySide6 design in `AGENTS.md` with the Worker/React plan (pasted
2026-10-06, "the Worker plan"). This document says what that means, row by row,
so the rewrite of `AGENTS.md` is a deliberate act and not a drift. `AGENTS.md`
and `migrations/0001_initial.sql` are **unchanged** until the open items in §5
are answered.

## 1. What is thrown away, kept, and changed

| Area | Current repo | Worker plan | Verdict |
|---|---|---|---|
| Runtime | Python 3.14 stdlib core + CLI | One Cloudflare Worker (Hono, TS strict) | **Replaced.** Python core, `providers/`, `inv_manager.py` are never written (only docs and tests exist today, so little is lost) |
| GUI | PySide6, controller/model split | React + TanStack Table/Query as Workers static assets | **Replaced.** AGENTS.md §8 (GUI boundary, QThreadPool, Qt tests) is deleted. Its *principle* survives: decisions live in `src/domain/`, pure and unit-tested |
| D1 access | Client → REST API with a scoped token | Worker binding via Drizzle | **Replaced.** Token/`secrets.json` (Rule 7) disappears; Cloudflare Access replaces it |
| Atomicity | One parameterised statement per request (Rule 5), audit via trigger | `db.batch()` is atomic in a Worker | **Relaxed.** Rule 5 was a limit of the REST path, not of D1. The trigger-based audit can stay or be replaced by a batch; decide in §5 |
| Stock model | Append-only `stock_events`, stock = `SUM(delta_qty)`, `stock_checkpoints` cache | `stock_moves` + cached `lots.qty_on_hand` updated in the same batch | **Conflict — see §2** |
| Retry-safety | `event_id` + `INSERT OR IGNORE`, `rev_token` (Rules 2–3) | Idempotency only specified for CSV import | **Keep.** Still needed: Worker requests time out and the UI retries. Port as a unique `move_id` per move and `rev` on editable rows |
| Money | Integer micro-USD | Integer IDR; foreign prices integer micro-units; FX frozen per order | **Superset.** Keep integer-only (Rule 8); add `fx_to_idr_micro` on orders |
| Quantities | Always pieces, `pack_count × pack_size` echo | `qty` on order lines | **Keep** pieces rule and the pack echo in the import preview |
| Plan-then-apply | Rule 10 | Plan → preview → apply for the LCSC import | **Keep**, as a pure `plan()` in `src/domain/` plus an apply endpoint |
| Specs | JSON for display, promoted typed columns (Rule 9) | `package`, `value` text columns | **Keep Rule 9.** The plan's `value` text cannot sort; keep `value_si` etc. |
| Backups | `inv backup`, export-before-bulk-apply | Weekly GitHub Action `wrangler d1 export` | **Keep intent**, drop the CLI wrapper; the Action is the backup of record. A bulk import should still check for a recent export |
| Migrations | wrangler applies; tool verifies `schema_version`/`min_code_version` | wrangler applies; Drizzle schema | **Keep** wrangler-applied SQL files. `min_code_version` is moot with a single deployed Worker; drop it |
| Offline | Explicitly refused (Rule A) | Not addressed; Worker is online-only | **Unchanged.** `docs/deferred/offline-mode.md` stays deferred |
| Two machines | Both run the tool with the token | Both open the same URL behind Access | **Simpler** |

## 2. The one real conflict: stored quantity vs. ledger

The Worker plan caches `lots.qty_on_hand` and updates it in the same `db.batch()`
as the `stock_moves` insert. `AGENTS.md` Rule B forbids any stored quantity and
spends a paragraph explaining why.

The reason for Rule B was **multi-writer replay across two machines over a
non-atomic REST path**. With a Worker, the insert and the cached-quantity update
land in one atomic batch, so the cache cannot drift from the ledger through a
partial write. That removes the main argument against it. What remains:

* The cache is only correct if **every** write path goes through the one
  function that does the batch. Make that a single `applyMove()` in the Worker
  and forbid direct `UPDATE lots SET qty_on_hand`.
* Keep moves as **deltas, including stocktake** (`counted`, `basis`, `delta`).
  This costs nothing under the plan and keeps `SUM(delta)` commutative.
* Add a **reconcile check**: `qty_on_hand = SUM(delta)` per lot, run in tests
  and exposed as an admin endpoint. This turns the cache into what
  `stock_checkpoints` was — derived and verifiable — without a second table.
* `stock_checkpoints` is deleted; `lots.qty_on_hand` replaces it. Hard rule 2 of
  the Worker plan ("never lose stock history") is satisfied by append-only
  `stock_moves` plus no-edit/no-delete on that table.

**Recommendation:** adopt the Worker plan's cached `qty_on_hand`, with
`applyMove()` as the sole writer and the reconcile test. Amend Rule B to say
"stock is *derived* from the ledger; the cache is verified, never trusted".

## 3. Schema mapping (current `0001_initial.sql` → plan §3)

| Current | Plan | Action |
|---|---|---|
| `parts` (id = C-number or `X-<uuid>`, `rev`, `rev_token`, `merged_into`, typed spec columns) | `parts` (integer id, `lcsc_code UNIQUE`, `UNIQUE(mpn, manufacturer_norm)`) | Keep one `parts` table. Prefer the plan's integer id + `lcsc_code`; **the C-number-as-PK trick is no longer needed**, and the plan's `manufacturer_norm` is what solves `DIODES` vs `Diodes Incorporated`. Carry over `value_si`, `voltage_rating_v`, etc. and `rev` |
| `stock_events` | `stock_moves` | Rename; add `lot_id`; reasons per plan. Keep the stocktake CHECK constraints |
| (none) | `lots`, `donors`, `locations`, `categories`, `suppliers` | New. Absorbs the previously deferred `locations-and-labels.md` — **that doc is now partly obsolete and should be reduced to labels/QR** |
| `orders` (`order_ref`, shipping, fees) | `orders` + `order_lines` | Extend with `supplier_id`, `fx_to_idr_micro`, `duties_idr`, `source_file_sha256` |
| `price_cache` | `quotes` | Different intent: `price_cache` is a fetched LCSC price; `quotes` are per-supplier listings entered by hand. Keep both only if live LCSC price fetching survives (it was a fragile `providers/` module — drop unless wanted) |
| `audit_log` + trigger | none | Keep, or drop in favour of `stock_moves` history plus an `updated_at`. Open item |
| `backups`, `import_runs` | `import_runs`; backups via Action | Keep `import_runs`; drop `backups` table if the Action owns backups |
| `meta` | `settings` | Merge |
| (none) | `projects`, `needs`, `part_aliases`, `usage_daily` | New (Phases 3, 1, 2) |

Because the database is documented as empty, the migration route is **a new
`0001_init.sql` replacing the current one**, not an additive `0002`. That edits
a "shipped" migration, which `AGENTS.md` §6 forbids; it is acceptable only
because nothing is applied to real data. **Confirm the production DB is still
empty before doing this** (§5, item 2).

## 4. Phase order for the rewrite

0. Rewrite `AGENTS.md` (hard rules from the Worker plan §0, plus the surviving
   rules above: retry-safety, refusal-with-reason, integer money, pieces,
   plan-then-apply, delta stocktake). Delete Python-only sections. Update
   `README.md`, `wrangler.toml` → `wrangler.jsonc`, and the tests dir.
1. Skeleton, `0001_init.sql`, LCSC import (as planned; fixtures needed — §5).
2. Inventory UI and dashboard, with `/api/usage`.
3. Purchasing.
4. KiCad link (needs a `lib_manager.py export-index` in the sibling repo).
5. Quality of life.

Existing artefacts to reuse: `tests/fixtures/d1_responses.json` is REST-specific
and becomes irrelevant; the SQL feature probes in `AGENTS.md` §2.3 (json_each,
trigger firing, `rows_written` ≈ 4× incl. indexes, `seq` gaps) still hold and
should be moved to `docs/d1-facts.md`.

## 5. Open items I need answered before writing code

1. **The plan's three questions:** name (`kicad_partlib` vs the current repo
   name `KICAD_PART_LIBRARY`); single user vs a read-only view for resale
   customers/helpers; start clean vs fold in earlier code (my read: clean).
2. **Is the production D1 still empty?** Needed to justify replacing `0001`.
3. **The two LCSC fixtures** (`WM2509100613`, `WM2408250114`) are not in the
   repo; Phase 1's acceptance test (99 parts, 100 lots) needs them.
4. **Audit log:** keep the trigger-written `audit_log`, or rely on move history?
5. **The memory note** "D1 is the only store" still holds (the Worker plan uses
   D1 only). The "no local mirror" and CLI-first decisions do not carry over; I
   will update memory once you confirm.
6. **Same repo or new repo?** The plan says a new `kicad_partlib` repo; this
   directory has history and docs. I would rewrite in place.
