# KiCad Part Library (`KICAD_PART_LIBRARY`)

A personal inventory of the electronic parts actually on the bench — detailed
specs, current market price and availability, the price actually paid, stock on
hand, and the LCSC part number to reorder by. Usable from either machine.

A stdlib-only Python core and CLI, a PySide6 desktop app, and Cloudflare D1 as
the store.

> **Status: Phase 0.** The schema, the conventions and the documentation are in
> place and tested; the CLI and GUI are not written yet. See
> `kicad-partlib-plan.md` for the phase plan.

---

## Why it is built this way

**The database is the source of truth.** This is the deliberate opposite of its
sibling, [`KICAD_CUSTOM_LIB`](https://github.com/mraxxi/kicad_customlib), where
the disk is the truth and nothing can drift because there is no database. Stock
on hand is mutable state that no amount of scanning can derive, so a database is
unavoidable here — and everything below is the price paid for that.

There is **no local copy of the data**. Git tracks code and documentation only.
That is a choice, made knowingly: nothing works without a network connection,
and the mitigation is `inv backup` plus a gate that refuses risky bulk
operations without a fresh export.

**Stock is never a stored number.** It is the sum of an append-only ledger of
movements. Nothing stores a quantity, so nothing can disagree with itself — and
*what you paid* falls out of the same ledger instead of being a field that goes
stale.

**Every event is a delta, including a stocktake.** A count records what was on
the shelf, what the ledger claimed, and the difference. Only the difference is
arithmetic. That keeps the sum **commutative**, which is what stops two machines
losing each other's movements — an earlier design had a count reset the running
total, and across two machines that silently discards real events while still
showing a plausible number.

**A retried write can never double-count.** Every movement carries a
client-generated id with a uniqueness constraint, so when a request times out —
and with a network-only store you genuinely cannot tell whether it landed — you
just send it again.

---

## Layout

```
KICAD_PART_LIBRARY/
├── AGENTS.md                   # the operating rules. Read before changing code.
├── migrations/                 # ordered, append-only SQL. Never edit a shipped one.
├── scripts/
│   ├── inv_manager.py          # the CLI and GUI entry point
│   └── src/{core,providers,gui}/
├── tests/                      # runs entirely offline, against SQLite
├── docs/
│   ├── d1-setup.md             # create the database, scope the token
│   ├── schema.md               # every table, and why it is shaped that way
│   └── deferred/               # designed, deliberately not built
└── backups/                    # wrangler d1 export output (not in git)
```

---

## Setup

Full instructions, including the API token and a wrangler quirk specific to this
machine, are in **[`docs/d1-setup.md`](docs/d1-setup.md)**. In short:

```bash
# 1. The database
wrangler login
wrangler d1 create kicad-partlib
wrangler d1 migrations apply kicad-partlib

# 2. Credentials, outside the repo
mkdir -p ~/.config/kicad_partlib
$EDITOR ~/.config/kicad_partlib/secrets.json     # account id, database id, token
chmod 600 ~/.config/kicad_partlib/secrets.json

# 3. The tool
python -m venv --system-site-packages .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q
```

`--system-site-packages` is deliberate: PySide6 comes from pacman here, and
pip-installing a second copy into the venv shadows the system Qt libraries and
produces mismatched-ABI crashes.

**On the second machine**, setup is: clone, write `secrets.json`, run
`inv health`. There is no data to sync.

---

## Everyday use *(Phase 2 onwards — not yet implemented)*

```bash
inv add C23179 --type resistor --spec resistance=10k --spec tolerance=1%
inv show C23179
inv list --type resistor --low-stock

inv buy   C23179 --packs 5 --pack-size 1000 --unit-price 0.0021 --order LCSC-2026100412
inv use   C23179 12 --note "TPA3255 front-end v1"
inv count C23179 97                 # a stocktake: records counted vs. ledger
inv history C23179

inv refresh --all                   # market price and stock, opt-in
inv check                           # structured audit, non-zero exit on errors
inv backup                          # wraps `wrangler d1 export`
inv status                          # schema, backup age, measured quota usage
inv gui
```

Every mutating command with fan-out prints its plan first; `--dry-run` stops
there, `--yes` skips the prompt, and a non-interactive run without `--yes` is
refused.

---

## Parts without an LCSC part number

The C-number is the identity, so a part that has none — a salvaged reel, an
AliExpress bag, something from a drawer — gets a surrogate id and simply does
without the features that need a C-number. Live price and stock are the only
things lost.

Such a part can carry an **equivalent** C-number, declaring the basis (`mpn`,
`spec`, `type` or `manual`). Prices derived that way are labelled
**indicative** everywhere they appear, including in `--json`, and inventory
value is reported as two numbers — priced and indicatively-priced — rather than
one misleading total.

---

## What it will not do

* **Touch `KICAD_CUSTOM_LIB`.** Read-only is not even the rule; the rule is that
  this repository never opens it at all. The `lib_id` field is a loose,
  unvalidated note.
* **Keep a local copy of the inventory.** See *Why it is built this way*, and
  `docs/deferred/offline-mode.md` for what changing that would actually take.
* **Hide a stale figure.** A price always shows its age; past a threshold it
  reads *stale*. An equivalent-derived price is never presented as the part's own.
* **Silently resolve an edit conflict.** If the other machine changed a part
  first, you get a field-level diff and a choice — never last-write-wins.
* **Store a datasheet or a 3D model.** Rows are capped at 2 MB. It stores URLs.

---

## Development

```bash
.venv/bin/pytest -q
```

The suite runs offline, against an in-memory SQLite database built from the real
migration files — so the schema under test is the schema that ships. Tests
needing a real D1 database, `wrangler` or a display skip when those are absent.

**`AGENTS.md` documents the architecture, the invariants, and the facts measured
from D1 and Qt on this machine. Read it before changing anything under
`scripts/`.** In particular it records which SQL features D1 actually supports,
what the free-tier read budget really costs, and the two probes still open
against a live database.
# kicad_partlib
