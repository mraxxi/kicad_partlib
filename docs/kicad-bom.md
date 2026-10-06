# KiCad BOM import

A project's **BOM section** (Projects > a project) imports KiCad's BOM CSV, shows which lines you have in stock and which you
must buy, and lets you correct every link by hand. Written against KiCad's default export; **not yet verified against a real
export from the owner's KiCad 10** (the column-name map exists so that can be fixed without a release).

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
most stock first); you click to link. Anything that is not a plain resistance, capacitance or inductance gets no suggestion.

## Placeholders are BOM lines, not parts

A line you cannot identify yet stays **to identify** with its value and footprint. It is deliberately *not* a fake `parts` row:
that would appear in Parts, Enrich and stock, two placeholders without an MPN would collide on the identity key, and replacing
one with the real part would need a merge, which the app refuses. When the real part arrives (LCSC order or cart import, or
**New part** on the line, which takes a C-number LCSC lists or a typed MPN and flags the part for review), the line is linked to it.

## Needs

Linked, active lines make ordinary needs: pieces per board x boards, summed per part, so the buy list, stock allocation, landed
cost, the LCSC cart CSV and "Mark ordered" work unchanged.

- The BOM is the source for the quantity of a part it links: a re-import (or a link edit) sets the need to the BOM's number.
- An **ordered or received** need is never changed: its cost is frozen.
- A part with no active line left (line removed from the BOM, ignored, DNP, unlinked) gets its **to-buy** need **cancelled**, never
  deleted; reopening it undoes that. This applies to a need that was typed by hand for the same part too.
- Cart import keeps an existing need's quantity, so a cart never overrides a BOM.

## Tables (migration `0009_bom.sql`)

`project_bom` (one BOM per project: boards, file name, sha256) and `bom_lines` (line key = LCSC number, else MPN, else
value|footprint; `part_id` NULL while to identify; `link_rule`; status active/dnp/ignored/removed; `fields_json` keeps the raw
row; `rev` for conflict checks). No change to `parts`, `needs` or `stock_moves`.

## Free-tier cost

A 100-line BOM writes about 100 line rows plus up to 100 needs with their indexes (well under 1% of a day). Planning reads the
parts that match, plus candidate parts of the footprints' packages for suggestions (capped at 3,000 rows).

## Not built (still deferred: `docs/deferred/bom-reconciliation.md`)

Deducting stock when a board is built, reading `.kicad_sch` directly, `kicad_customlib` index sync, and cart import proposing
links for to-identify lines on its own.
