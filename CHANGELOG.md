# Changelog

All notable changes to this tooling. The inventory *data* lives in Cloudflare
D1 and is not tracked here; this file is about the code and the schema.

## [Unreleased]

### Pivot to a Worker stack, and Phase 1 (LCSC import)

- **Replaced the Python/PySide6/REST-client design** with one Cloudflare Worker
  (Hono, TypeScript strict), D1 bindings and a React UI. See `docs/worker-pivot.md`.
- **`0002_worker_schema.sql`** replaces the Phase-0 ledger tables (destructive;
  both databases were empty). `stock_moves` is append-only by trigger;
  `lots.qty_on_hand` is a cache recomputed from `SUM(delta)`, never incremented.
  Lot cost is micro-IDR rather than whole IDR (tiny parts would round badly).
- **`POST /api/import/lcsc`**: RFC 4180 parser, manufacturer normalisation
  (`DIODES` = `Diodes Incorporated`), category/value guesses, pure plan, one
  atomic idempotent batch. The two real exports give 99 parts, 100 lots, 100
  receive moves; re-importing changes nothing. A 100-line import writes ~1,300 rows.
- Cloudflare Access JWT verification that fails closed; per-request D1 usage
  metering into `usage_daily` and `/api/usage`.
- **`0003_sheet_vocabulary.sql`**: adopts the owner's 20 `Group - Name` categories and the original
  sheet's USD to IDR rate (17,893). The importer's LCSC stock value matches the sheet's (tested).
- **Import page** (`src/web`): choose the CSV, correct order number/date/FX/shipping, preview, apply.
  Apply is disabled once the form changes after a preview, and for a file already fully imported.
- Migrations 0002 and 0003 applied to production and staging (both empty beforehand).
- 39 tests against a real local D1 built from the shipped migrations.

### Earlier (Phase 0, Python design — superseded)

The original design notes remain in git history (`kicad-partlib-plan.md`).
