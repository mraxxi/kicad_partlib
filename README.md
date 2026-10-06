# kicad_partlib

A personal electronic-parts inventory and purchasing app: what is on the bench, what each lot really cost (landed, in rupiah), what to buy next for a project and where it is cheapest. Built for one owner who repairs and resells hardware and designs boards in KiCad, with parts arriving from **LCSC orders** and from **salvaged boards**.

One Cloudflare Worker, **D1 as the only store**, React UI served from the same Worker, behind Cloudflare Access. Runs on the Workers Free plan. It is the sibling of [`kicad_customlib`](https://github.com/mraxxi/kicad_customlib), which owns symbols, footprints and 3D models; this repository tracks stock and money and never touches that one.

## What it does

| | |
|---|---|
| **Inventory** | Parts table with search, filters and sorting; stock as lots (a reel, a bag, a salvaged batch); use, adjust, count, scrap, move and mark parts; locations; part pages with full move history. |
| **Salvage** | Donor boards and a keyboard-first harvest form. Salvaged value is an *estimate*, kept apart from money actually spent. |
| **LCSC import** | Order exports become parts, lots and receive moves; **cart exports** become project needs plus an LCSC quote. Both preview first and are safe to repeat. |
| **Purchasing** | Projects and what they need, stock shared across projects, supplier quotes with MOQ and price breaks, landed-cost ranking, purchase recap with order shipping once per supplier, "mark ordered" that freezes the cost, LCSC cart CSV export. |
| **Specs** | Each part's specs stored as numbers. **Value** is the part's most important spec and **Key specs** the next few (a MOSFET shows `30V` and `N-ch · 50A · 20mΩ@10V · 12nC`). Sort by any spec, then by the next (a sort chain with editable presets), filtered to one kind of part. Filled from LCSC's own labelled parameters and, for passives, from the description. |
| **Dashboard** | Stock value (paid for vs estimated), what to reorder, untested salvage, today's database usage against the free limits. |

## How it is built

- **Worker**: [Hono](https://hono.dev) + zod, TypeScript strict. Auth is Cloudflare Access; the Worker also verifies the Access JWT and **refuses everything when Access is not configured**.
- **Database**: D1 via bindings, plain SQL migrations in `migrations/`. Stock changes only through an **append-only `stock_moves` ledger** (triggers refuse update and delete); the per-lot quantity is a cache recomputed from it.
- **Web**: React, TanStack Table (virtualised) and Query, served as static assets by the Worker.
- **Domain logic is pure** (`src/domain/`): CSV and quantity parsing, import and cart plans, purchasing maths, specs. It runs without a database and is what the tests lean on.
- **Money is an integer** everywhere; the exchange rate is frozen on each order.
- **Plan, then apply** for anything that touches rows you did not name: imports, ordering, bulk enrichment. Planning writes nothing, and the tests prove it.

```
src/domain/     pure functions (no I/O)        migrations/     append-only SQL
src/db/         D1 access, bound params only   tests/          Vitest on a real local D1
src/worker/     routes, Access, LCSC fetch     docs/           design notes and setup
src/web/        React app                      scripts/        LCSC proof of concept
```

## Run it

```bash
npm install
cp .dev.vars.example .dev.vars                      # blanks the Access settings for local use
npx wrangler d1 migrations apply DB --local         # build the local database
npm run build:web && npm run dev                    # http://localhost:8787
```

```bash
npm test            # offline; a real local D1 built from the shipped migrations
npm run typecheck
```

## Deploy

Create the D1 database and put the Worker behind Cloudflare Access, then set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`. Step by step in [`docs/d1-setup.md`](docs/d1-setup.md).

```bash
npx wrangler d1 migrations apply DB --remote        # migrations first
npm run deploy
```

Take an export before a bulk change (`wrangler d1 export`): D1's Time Travel restores the whole database or nothing.

## Documentation

| | |
|---|---|
| [`AGENTS.md`](AGENTS.md) | The rules and conventions: read this before changing anything. |
| [`docs/spec-enrichment.md`](docs/spec-enrichment.md) | How specs, Key specs and sort chains work, and why. |
| [`docs/worker-pivot.md`](docs/worker-pivot.md) | Why the project moved to this stack, and what carried over. |
| [`docs/lcsc-poc-report.md`](docs/lcsc-poc-report.md) | The LCSC parameter labels seen per category. |
| [`docs/deferred/`](docs/deferred) | Designs for features not built yet. |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed, and the reasoning. |

## Notes

- LCSC's product-detail endpoint used for specs is **undocumented**; it is isolated in one file and everything still works without it (specs from descriptions, manual entry).
- The next planned piece is the KiCad link: importing a schematic BOM into a project's needs and indexing the `kicad_customlib` symbols.
