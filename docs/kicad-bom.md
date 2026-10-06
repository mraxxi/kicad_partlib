# KiCad BOM import

A project's **BOM section** (Projects > a project) imports KiCad's BOM CSV, shows which lines you have in stock and which you
must buy, and lets you correct every link by hand. Checked against a real export (2026-10-06) whose layout is `Designator, Footprint, Quantity, Value, LCSC Part #` with no MPN or
manufacturer column, the LCSC cell empty, bare footprints such as `0603`, and values such as `100n`, `3R3`, `2.7k`, `10uH` and `~`. It
parses with no configuration. The real file is not in the repository (public repo, no owner data in git);
`tests/fixtures/kicad/designator-layout.csv` is a small synthetic file in the same format (CRLF, UTF-8 BOM, quoted designator lists).
On such a file every line is keyed `value|footprint` and starts as **to identify**; the chip passives get suggestions from your
library (a part is only suggested if the library has that exact value and package), the ICs and connectors, whose Value is a part
name or a label, get none. Fill the LCSC / MPN columns in KiCad and those lines match on their own.

## The file

Schematic Editor > File > Export > BOM (or `kicad-cli sch export bom`). Columns read: `Refs`/`Reference`, `Value`, `Footprint`,
`Qty`, `DNP`, plus symbol fields named in the `bom.fields` setting (editable on the BOM section): LCSC (`LCSC`, `LCSC#`,
`JLCPCB Part`, ...), MPN (`MPN`, `MP`, ...), manufacturer (`MF`, ...). Comma, semicolon or tab delimited. `src/domain/kicadBom.ts`.

## Flow: plan, then apply

`POST /api/projects/:id/bom` with `apply: false` writes nothing and returns every line with what it matched and why; with
`apply: true` it recomputes the plan server-side and writes one atomic batch (`src/db/bom.ts`). The same file for the same board
count is a no-op that writes nothing.

## Matching (`src/domain/bomPlan.ts`)

Precedence, and the line shows which rule linked it:

1. a link you made by hand on this line (never replaced by a re-import)
2. the BOM's LCSC number = a part's C-number
3. the BOM's MPN (+ manufacturer when given) = a part's identity, the same key the order and cart imports use. With no manufacturer,
   an MPN matches only when exactly one part has it; several is a warning, not a guess
4. the link already stored on the line, then a link you made for the same line key in any other project ("remembered")

**Value + package never link.** A line like `10uF` + `C_0805` shows up to three parts as suggestions (exact value and package,
most stock first); you click to link. Anything that is not a plain resistance, capacitance or inductance gets no value suggestion.

**A part-name Value suggests by MPN** (`src/domain/bomNames.ts`). When a line has no LCSC number or MPN and its Value looks like a
part name (`NE5532AD`, `TPA3255DDV`), up to three library parts whose MPN starts with it are suggested, case and punctuation
ignored (`NE5532AD` finds `NE5532ADR` and `ne-5532 adrg4`). Order: exact name, then a footprint that fits, then most stock. Footprint
is only a tiebreaker. A name needs 5+ characters with a letter and a digit, must not be an electrical value, and must not start like a
connector or switch symbol (`Conn`, `Jack`, `USB`, ...); `~`, `SW`, `RED`, `OUT`, `balR` get nothing. No fuzzy matching, never a link.
Value suggestions win when both apply.

## Placeholders are BOM lines, not parts

A line you cannot identify yet stays **to identify** with its value and footprint. It is deliberately *not* a fake `parts` row:
that would appear in Parts, Enrich and stock, two placeholders without an MPN would collide on the identity key, and replacing
one with the real part would need a merge, which the app refuses. When the real part arrives (LCSC order or cart import, or
**New part** on the line, which takes a C-number LCSC lists or a typed MPN and flags the part for review), the line is linked to it.

## Needs

Linked, active lines make ordinary needs: pieces per board x boards, summed per part, so the buy list, stock allocation, landed
cost, the LCSC cart CSV and "Mark ordered" work unchanged. **The BOM only ever changes needs it created.** `needs.bom_owned`
records that:

| The part's need in this project | What an import (or a line edit) does |
|---|---|
| none | creates one, owned by the BOM |
| owned by the BOM, to buy / covered | follows the BOM's quantity |
| owned by the BOM, cancelled by the BOM (its line went away) | comes back when the line does |
| owned by the BOM, to buy, no active line left | cancelled (never deleted; reopen undoes it) |
| **typed by you**, or one whose quantity or status you edited (that hands it over: `updateNeed` clears `bom_owned`) | **left alone**; the preview says "you need 50 (set by you) and the BOM says 3; your number is kept" |
| ordered or received (frozen cost) | left alone; the preview says the quantity is frozen |
| cancelled by you | stays cancelled |

The preview lists every need it would create, change, cancel or leave alone, before anything is written (the same rule as the
cart import: "an existing need keeps its quantity and the plan says the cart disagrees"). A single line edit (link, unlink, DNP,
ignore) re-syncs only the part it had and the part it now has, in the same batch as the edit, and only if the revision check
passed; a stale edit changes nothing. Cart import keeps an existing need's quantity, so a cart never overrides a BOM either.

## Tables (migration `0009_bom.sql`)

`project_bom` (one BOM per project: boards, file name, sha256) and `bom_lines` (line key = LCSC number, else MPN, else
value|footprint; `part_id` NULL while to identify; `link_rule`; status active/dnp/ignored/removed; `fields_json` keeps the raw
row; `rev` for conflict checks). One column added to `needs` (`bom_owned`, default 0, see above); no change to `parts` or `stock_moves`.

## Free-tier cost

A 100-line BOM writes about 100 line rows plus up to 100 needs with their indexes (well under 1% of a day). Planning reads the
parts that match, plus candidate parts of the footprints' packages for suggestions (capped at 3,000 rows).

## Not built (still deferred: `docs/deferred/bom-reconciliation.md`)

Deducting stock when a board is built, reading `.kicad_sch` directly, `kicad_customlib` index sync, and cart import proposing
links for to-identify lines on its own.
