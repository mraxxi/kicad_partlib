# AI Agent Operating Guidelines — `kicad_partlib`

> **Scope**: how AI coding assistants must interact with, modify and extend this
> repository. Read it whole before writing code.

A personal parts inventory and purchasing tool for one owner who repairs and
resells hardware and designs boards in KiCad. Parts arrive from **LCSC orders**
(CSV exports, USD) and **salvaged boards**. It tracks physical stock and money;
it replaces a Google Sheet. One Cloudflare Worker, **D1 as the only store**,
React UI served as static assets from the same Worker.

Sibling of [`KICAD_CUSTOM_LIB`](https://github.com/mraxxi/kicad_customlib), which
owns symbols, footprints and 3D models. **This repository never reads or writes
that one**; the link is by MPN / LCSC part number, and (Phase 4) a JSON index that
repo exports and this one ingests.

> **History.** Phase 0 designed a Python/PySide6/REST-client tool with a pure
> append-only ledger. The owner replaced it with this Worker stack on 2026-10-06;
> `docs/worker-pivot.md` records what was kept and why. Do not reintroduce Python,
> Qt, a local mirror of the data, or a REST token on a client machine.

---

## 1. Hard rules

1. **Workers Free plan only.** Budget every feature against §2. No paid-only
   features (Queues, Workers Paid CPU, Durable Object storage billing).
2. **Never lose stock history.** Quantity changes only through `stock_moves`.
   That table is append-only — triggers abort `UPDATE` and `DELETE`. A mistake is
   fixed by appending a reversing move. `lots.qty_on_hand` is a **cache**, written
   only by the one function that applies a move (and by import), recomputed as
   `SUM(delta)` for that lot — never incremented — so a replay cannot double-count.
   A test asserts `qty_on_hand == SUM(delta)` for every lot; keep it passing.
3. **Imports are idempotent.** The same file twice changes nothing, including no
   `import_runs` row. Keys: order = `(supplier, order_no)`; lot = its order line;
   receive move = `'rcv:<order_line_id>'`.
4. **Money is an integer, always.** Foreign prices are micro-units (USD × 1e6).
   A lot's cost is **micro-IDR** (IDR × 1e6) — *not* whole IDR, a deliberate
   deviation: a 0.0002 USD part is 3.3 IDR and whole-rupiah rounding is a 10%
   error. Decimal strings become integers in `src/domain/money.ts` and nowhere
   else; USD→IDR uses `BigInt` (3.9e6 × 1.7e10 overflows 2^53).
5. **The FX rate is frozen per order** at import time. `settings.fx.usd_idr_micro`
   is only the default for the form; it never changes an existing order.
6. **TypeScript strict, no `any` in domain code.** Tests may use it sparingly.
7. **Quantities are pieces.** A purchase that comes in packs carries
   `pack_count × pack_size` and echoes the product back before committing.

## 2. Free-tier budget (verified 2026-10-06)

Account-wide, resets 00:00 UTC; the account also hosts other Workers
(`pynvoice`, `t-hub-teacher-os`, `siskaeee-app`) that share these.

| Limit | Value |
|---|---|
| Worker requests | 100,000/day (static assets are free) |
| CPU per request | **10 ms** — no heavy libraries in the Worker |
| D1 rows **read** | 5,000,000/day — metered by rows **scanned**, not returned |
| D1 rows **written** | 100,000/day — **index writes count**, ≈4× a logical row |
| D1 bound params / query | **100** → use the `json_each(?)` shape for bulk |
| Max SQL statement | 100 KB |
| Subrequests | 50 external per request |

Since 2026-09-01 **D1 queries fail when a daily limit is hit.** Therefore:
- Every list endpoint is paginated and index-backed; no `SELECT *` without `LIMIT`.
- Every D1 call goes through `Meter` (`src/db/meter.ts`), which sums
  `meta.rows_read/rows_written` per request and flushes to `usage_daily`;
  `/api/usage` reports it. Hot queries get a `rows_read` ceiling in tests.
- **Measured:** importing the two real exports (100 lines) wrote **1,304 rows**
  (770 + 534). The plan's ~800 target was optimistic; it is ~1.3% of a day, so it
  is accepted — but don't add indexes to `parts`/`lots`/`stock_moves` casually,
  each costs a write on every insert.

Probes measured against D1 itself and still true: `json_each` + `json_extract`
preserve integer types; a multi-statement `db.batch()` is atomic (rolls back whole);
`AFTER/BEFORE` triggers fire and their writes are metered; `INSERT OR IGNORE`
on a UNIQUE conflict works; `AUTOINCREMENT` ids have **gaps** — never infer a
count from an id.

## 3. Stack

Hono + zod (`@hono/zod-validator`) on one Worker; D1 via bindings; migrations are
plain `.sql` applied with `wrangler d1 migrations apply`; React + TanStack
Table/Query as Workers static assets (`public/`, not built yet); Cloudflare
Access for auth; Vitest + `@cloudflare/vitest-pool-workers` against a real local
D1. Locale `id-ID` display, `Asia/Jakarta`, store UTC ISO-8601.

Pinned notes: `vitest` must stay `^4.1` (pool-workers 0.22 rejects 5.x);
`compatibility_date` is `2026-08-22` because the installed `workerd` rejects a
later one — raise it only when `npm ls workerd` supports it. Drizzle ORM was in
the plan and is **deliberately not used**: every query so far is an aggregate or a
`json_each` set-based write, which an ORM only obscures, and a hand-kept Drizzle schema
would be a second copy of the migrations to drift. Revisit only if plain CRUD grows.

**Measured, Phase 2:** a parts page reads 4 rows per part (the part, its lot, its
category, and the keyset scan) — the plan's "< 2 x page size" is unreachable with a
lot per part, and 4 x is negligible. The ledger (`stock_moves`) is never read to
list parts. The browser loads all pages (500 each) once and filters/sorts locally;
at 2,000 parts that is roughly 8,000 rows read per full refresh (0.16% of a day).

## 4. Conventions that carry over from the sibling repo

* **Plan-then-apply for anything with fan-out** (any operation touching a row the
  user did not name: import, bulk price refresh, merge, delete, migration).
  `plan()` is **pure** (`src/domain/`); apply recomputes the plan server-side and
  never trusts one sent by the client. Planning must write nothing — tested.
* **A refused action says why, in one full sentence**, identical wherever it is
  shown. Errors never echo `err.message` to the client (it can carry SQL).
* **Lots are homogeneous.** Changing part of a lot (3 of 10 turned out faulty; 5 went to another
  drawer) splits it: a new lot plus a matched pair of `transfer` moves. Changing a whole lot's
  location/condition is not a quantity change and writes no move. `lots.create_key` makes lot creation
  retry-safe; a stocktake is stored as a delta (`adjust`) with both numbers in the note.
* **Optimistic concurrency** on user-editable rows: `rev`. On a conflict, refuse
  and show a field-level diff; never silently re-send with the new `rev`.
* **Retry-safety first**: client-generated `move_id` (UNIQUE, `INSERT OR IGNORE`)
  for any move created by a request the browser may retry.
* **Config fails soft, data fails loud.**
* Domain logic lives in `src/domain/` as pure functions with no I/O, so it is
  unit-testable without D1 and reusable by a CLI later.

## 5. Auth

Cloudflare Access fronts the Worker, and the Worker **also verifies** the
`Cf-Access-Jwt-Assertion` JWT (issuer + audience) so a second hostname cannot
bypass it. It **fails closed**: with `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` unset,
every request is refused with a sentence saying why, unless
`ALLOW_UNAUTHENTICATED=true` (tests and `.dev.vars` only — never in
`wrangler.jsonc`). Service tokens (the future CLI) carry `common_name`, not `email`.

## 6. Repository layout

| Path | Description |
|---|---|
| `src/domain/` | Pure functions: csv, money, normalize, lcsc plan. No I/O. |
| `src/db/` | D1 access: `Meter`, import apply. Prepared statements, bound params only. |
| `src/worker/` | Hono app, Access middleware, routes |
| `src/web/` | React app (Vite, builds into `public/`); `npm run dev:web` proxies `/api` to `wrangler dev` |
| `migrations/` | Append-only SQL. **Never edit a shipped migration.** |
| `tests/` | Vitest; `fixtures/lcsc/*.csv` are the two real exports |
| `docs/` | Setup, pivot record, deferred designs |
| `backups/` | `wrangler d1 export` output — gitignored, the backup of record |

**Never interpolate into SQL.** Bound parameters only; for bulk use
`json_each(?)`. Table names in test helpers are the sole exception (constants).

## 7. Migrations

`wrangler d1 migrations apply kicad-partlib` (production) / `--env staging`.
Append-only; each statement individually idempotent (`IF NOT EXISTS`,
`OR IGNORE`). `ALTER TABLE ADD COLUMN` is not idempotent — probe `sqlite_master`
first. A batch applied by wrangler is atomic, so a migration cannot land half-way.

**`0002_worker_schema.sql` is destructive** (it drops the Phase-0 tables) and is
valid only because both databases were empty. wrangler records it in
`d1_migrations`, so it will not re-run; never run it by hand against real data.
Rehearse any future migration on `kicad-partlib-staging` first.

## 8. Backups

`wrangler d1 export kicad-partlib --output=backups/<utc>.sql`. Time Travel on the
free plan is **7 days, in place, all-or-nothing for the whole database**: a bad
bulk change to `parts` cannot be rolled back without also discarding every stock
move recorded since. So a weekly GitHub Action exports to a private repo (Phase
5), and a bulk apply should check for a recent export. `wrangler` is the backup
tool, not a fallback store.

## 9. Tests

```bash
npm test          # vitest, offline, real local D1 built from migrations/
npm run typecheck
```

The suite applies every real file in `migrations/` (so the tested schema is the
shipped one). Names read as assertions. Tests must *press the button*: call the
route, not just construct things. `tests/helpers.ts` `reset()` re-creates the
append-only triggers after clearing data — keep that when adding tables.

## 10. Adding an operation

1. Fan-out? → it needs a pure plan and a plan-mode response that writes nothing.
2. Decide in `src/domain/`; keep route handlers thin.
3. Make every write retry-safe and idempotent before making it correct.
4. Test the outcome, re-running it (idempotence), and that planning wrote nothing.
5. Record the *why* in a comment, including the bug that motivated it.

## 11. The owner's vocabulary (from the Google Sheet prototype)

`Parts Inventory & Purchasing.xlsx` is what made the owner want this app, and its
naming is the vocabulary they think in. Keep it; do not "tidy" it.

* **Categories** are `Group - Name` (`Passive - Resistor`, `IC - Audio`, `Discrete - MOSFET`,
  `Optoelectronics - LED`, `Crystal / Oscillator`, ...): 20 of them, seeded by
  migrations 0002/0003 and mirrored in `CATEGORY_NAMES` (a test checks they agree).
* **Condition**: `New / Tested OK / Untested / Faulty`. **Source**: `LCSC / Salvaged / Local Shop /
  Marketplace / Other`. **Need status**: `To buy / Ordered / Received / Covered by stock / Cancelled`.
  **Stock status** is derived, never stored: `Out` (<= 0), `Reorder` (< min), `OK`.
  **Authenticity risk**: `Low / Medium / High`. **Best pick** = rank 1 by landed cost per unit.
* **Human ids**: parts `P-0001`, donor boards `LB-001` / `PSU-001` / `RB-001`, requests `R-001`.
  Phase 2 should add a human `code` to parts (for labels); donors already have `code`.
* **Salvaged lots carry an *estimated value*, not a cost** (the sheet's "Est. Unit Value (Rp)"),
  and the dashboard reports salvaged value separately, labelled "estimated". Phase 2 needs a
  flag on `lots` (e.g. `cost_is_estimate`) so it is never summed silently with real cost.
* **Rate**: USD to IDR 17,893 (pluang.com, 2026-10-06), now the seeded default.
* **Cross-check, tested**: importing the two exports at that rate values the LCSC stock at
  Rp 1,271,866.647, the sheet's Dashboard figure. The sheet's 7 salvage rows are
  *examples to replace*, not data to migrate.
* The sheet's purchasing formulas (landed cost, recap with order shipping charged once per
  supplier and waived above a threshold, supplier `Order Shipping`/`Free Shipping Over`) are the
  acceptance fixture for Phase 3: port the sample rows as tests.

## 12. Status

| Phase | State |
|---|---|
| 0 Pivot, schema, Worker skeleton, Access | done |
| 1 LCSC import | **done**: API, domain, tests (99 parts/100 lots/100 moves; sheet value cross-check) and the browser form at `/` (preview, correct date/FX, apply). Migrations 0002 and 0003 are applied to **both** D1 databases (both were empty). Nothing is deployed yet and Access is not configured |
| 2 Inventory UI, locations, donors, dashboard | **done**: parts table (search/filter/sort), part detail with lots + history, stock actions (use, adjust, count, scrap, move/mark with lot split), add stock, locations and donors CRUD, keyboard-first harvest, dashboard with usage meters, part edit with `rev` conflict diff. Migration `0004` is applied **locally only** — apply to staging then production before deploying |
| 3 Purchasing (projects, needs, quotes, landed cost, recap, LCSC cart export) | schema not written yet |
| 4 KiCad link (BOM import, library index) | see `docs/deferred/bom-reconciliation.md` |
| 5 Labels/QR, FX cron, weekly backup Action, Sheet migration | - |
