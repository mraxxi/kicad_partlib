# kicad_partlib

A personal parts inventory and purchasing tool: stock on hand, what each lot
actually cost (landed, in IDR), where to reorder, and what to buy for a project.
One Cloudflare Worker, **D1 as the only store**, runs on the Workers Free plan.
Sibling of [`KICAD_CUSTOM_LIB`](https://github.com/mraxxi/kicad_customlib), which
owns symbols and footprints.

> **Status: Phase 1.** LCSC CSV import (plan → apply) works and is tested against
> two real order exports. The inventory UI is next. See `AGENTS.md` §11.

```bash
npm install
npm test              # offline; real local D1 built from migrations/
npm run typecheck
npm run build:web && npm run dev   # open http://localhost:8787; copy .dev.vars.example to .dev.vars first
                                    # and apply migrations locally: npx wrangler d1 migrations apply DB --local
```

Rules, limits and conventions: **`AGENTS.md`**. Setup of D1 and deploy:
`docs/d1-setup.md`. Why the stack changed from the original Python design:
`docs/worker-pivot.md`.

## Importing an LCSC order

Open the app, choose the CSV, check the details, preview, apply. Or via the API:

`POST /api/import/lcsc` with `{filename, csv}`. Without `apply: true` it returns
the plan (new parts, matched parts, duplicates, warnings) and writes nothing;
with it, one atomic batch applies it. Order number and date come from the
filename; the USD→IDR rate is typed per order and frozen on it.
