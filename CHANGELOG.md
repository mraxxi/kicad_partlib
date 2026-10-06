# Changelog

All notable changes to this tooling. The inventory *data* lives in Cloudflare
D1 and is not tracked here; this file is about the code and the schema.

## [Unreleased]

### Part images

- A **picture of the part** (LCSC's first image) on the part page and in the side panel beside the parts table. Design, free-tier
  cost and what is still unverified: `docs/part-images.md`.
- LCSC publishes each picture at several sizes, so the Worker stores the **900x900 JPEG (about 60 KB) exactly as LCSC sends it**: no
  resizing anywhere (the smaller 96 and 224 px versions look blurry because the part is small in the photo). Shown at 160 px in
  the side panel and 360 px on the part page. Bytes live in their own table `part_images` (migration `0007`), never read by a list.
- **Enrich page** has a "Fetch part images" button (parts with a C-number and no image); a part page offers "Fetch image".
- 194 tests. Migration `0007` is not applied anywhere yet.

### Importing an LCSC cart export

- **Import page** now has two tabs: the order export (parts that arrived) and the **cart export** (parts to buy).
- A cart becomes **needs** in a project you choose (or a new one) and an **LCSC quote** per line from the cart's price and
  MOQ, converted at the rate you type. Preview first: new parts, parts you already have, **in stock** and **will buy**
  per line, warnings (no price, quantity not a multiple, the project already needs a different amount).
- Safe to repeat: existing needs keep their quantity, quotes with price breaks are left alone, the same cart twice changes
  nothing. The LCSC cart exported from the buy list afterwards matches what was imported (tested).
- The shared "create or match parts" statements moved to `partStatements` so both importers use the same code.
- 183 tests.

### Spec enrichment: Value, Key specs and sort chains

- **Value is spec #0**: the first spec a part has, in its family's importance order, never blank for a part LCSC knows.
  **Key specs** shows the next few; widening the column shows more, hover shows all. 11 families: resistor, capacitor,
  inductor, MOSFET, diode, LDO, op amp, audio amp, LED, header/connector, MCU.
- **Sort chain** on the Parts toolbar (appears when the visible rows are one family): sort by any spec, then break ties by
  the next; built-in presets per family (e.g. MOSFET: Vds high-to-low then Rds(on) low-to-high), your own can be saved.
  The sorted spec is highlighted inside the summary, the rest stay visible; test conditions that differ (Rds(on) at 10 V vs
  2.5 V) are flagged. Footprints sort naturally (0201, 0402, 0603...). Optional per-spec columns via Columns.
- **Specs from LCSC**: `Enrich` page and a "Fetch from LCSC" button on each part: fetch, review, apply selected. Passives
  can also be filled offline from their description. Specs you enter by hand are never overwritten.
- **Settings > Spec layouts**: reorder a family's specs (which one is Value), how many Key specs show, edit presets; stored
  in the database so every machine shares them.
- **Part page**: every spec with its source (by hand / LCSC / description), manual entry, and "All specs LCSC lists".
- Migration `0006` (`parts.specs`, `part_enrichment`). 171 tests.

### Spec enrichment: groundwork and proof of concept

Design recorded in `docs/spec-enrichment.md` (read it before touching specs). Nothing user-visible changes except one filter.

- **Needs review (N)** toggle on the Parts toolbar, hidden when nothing is flagged; the dashboard count links to it
  (`#/parts?review=1`).
- **`src/domain/quantity.ts`**: parses LCSC-style value strings (`20mOhm@10V`, `4.5V~26V`, `+-100ppm/C`, `9V/us`,
  `2KB`, `315Wx2@4Ohm;600Wx1@2Ohm`, ...) into SI numbers; the application owns units, not an LLM.
- **Proof of concept** (`scripts/poc-lcsc/`): LCSC's product-detail endpoint returned labelled parameters for 110 of
  111 of the owner's parts; the parser agrees with LCSC's own numbers on 393 values with zero inconsistencies.
  Fixtures in `tests/fixtures/lcsc-detail/`; the owner's cart export added as `tests/fixtures/lcsc/export_cart_*.csv`.
- Worker egress to LCSC is still unverified (see the doc).
- 129 tests.

### Editing a part (fixing a broken import)

The part page could only edit description, category, minimum, notes and the datasheet. Now it also edits **value**
and **footprint** and the **needs-review** flag (cleared automatically when you add a description to a part LCSC
gave none for), and, behind a confirmation, **MPN, manufacturer and C-number**.

- Identity changes are plan-then-apply: the first request changes nothing and shows what is linked to the part; a
  change that would make the part identical to another is refused. Past orders keep their original text, and a
  re-import does not undo a correction (tested).
- 94 tests.

### UI pass — the Parts table and wide screens

Prompted by two complaints: the table's horizontal scrollbar sat at the bottom of 100 rows, and the layout stopped
at 1100 px so an ultrawide (2560x1080) mostly showed margin.

- **The table scrolls inside its own box** (sticky header, always-visible scrollbars) sized to the window; the page
  itself no longer scrolls on the Parts view. Rows are **virtualised**: 5,000 parts render ~45 rows and scroll instantly.
- **Fills the screen**: the Description column absorbs spare width, so there is no blank strip on wide monitors.
  Part and MPN stay pinned while you scroll sideways.
- **Columns**: Value, Footprint and LCSC # up front (the owner's priority order); a column chooser (show/hide, reorder),
  drag-to-resize, double-click to reset a width. Saved per column id, never by position (AGENTS.md §8). The rupee
  column is now "Worth" so it no longer collides with the component "Value".
- **Value sorts by magnitude and unit** (10nF < 100nF < 1uF; milli vs mega by case), via `valueToSi`/`valueSortKey` in
  the domain (tested). Text order gets this wrong; a typed `value_si` column is still the long-term fix (rule 9).
- **Filters live in the URL** (`#/parts?q=0603&st=ok`): back, refresh and "back to all parts" keep your view and
  scroll position. Active filters show as removable chips.
- **Side panel**: on screens >= 1400 px a row opens the part beside the table; arrow keys move the selection, Enter
  opens the full page, Esc closes, `/` focuses search.
- **Settings page**: row density (compact/comfortable), side panel on/off, theme (system/light/dark), reset the saved
  table layout. Stored in this browser only (`localStorage`, fails soft); each machine keeps its own.
- `npm run build:web` now clears old hashed assets first.
- 86 tests.

### Phase 3 — purchasing

- **Migration `0005`**: `projects`, `needs` (one per project+part; frozen `ordered_*` cost), `quotes` (one per
  part+supplier, price breaks, MOQ, listing shipping, risk, `quoted_at`).
- **`src/domain/purchasing.ts`** (pure): stock allocation, price breaks, landed-cost ranking, supplier choice with
  override, order grouping, recap, spend slices, price matrix, order-shipping rule, LCSC cart CSV. The owner's sheet
  sample rows are ported as the acceptance fixture and reproduce to the rupiah.
- **API/UI**: Projects (add needs, create missing parts), Buy list (edit need/spares/priority/supplier inline, recap,
  matrix, mark ordered with a preview, LCSC cart download), Suppliers (shipping, free-shipping threshold), Quotes on
  each part. Importing an LCSC order closes the buy-list lines it fulfils and says so in the preview.
- Fixes three sheet errors: shared stock, per-line MOQ/shipping, ordered lines skewing ranking (AGENTS.md §11).
- 82 tests.

### Phase 2 — inventory UI

- **Migration `0004`**: `parts.min_qty` (reorder threshold, per part), `lots.create_key` (retry-safe lot
  creation), partial index for reorder queries.
- **API**: keyset-paged parts with stock aggregated in one pass over lots; part detail with lots and
  history; `PATCH` with `rev` and a field-level conflict diff; `applyMove` (the only code that changes a
  lot's quantity; recomputes from the ledger); stocktake-as-delta; partial-lot reclassify via split;
  manual stock; locations and donors CRUD; harvest (find-or-create parts, salvaged lots with *estimated*
  value kept apart from money spent); dashboard; sentence-style validation errors.
- **UI**: Dashboard, Parts (TanStack Table, search/filter/sort), Part detail, Salvage with a
  keyboard-first harvest form, Locations, Import; usable at phone width.
- Not using Drizzle (see AGENTS.md §3). Local dev needs `.dev.vars` blanking the Access settings.
- 61 tests.

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
