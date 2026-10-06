# Part specs: Value, Key specs and sort chains

Status: **approved design, in progress.** Written 2026-10-06 after a planning conversation with the owner;
everything below was agreed unless marked *open*. Read `AGENTS.md` first. This supersedes the AI-first draft the
owner supplied (kept in spirit: search finds evidence, an LLM interprets it, application code decides what is stored).

## 1. The problem

`value` is derived only for resistors, capacitors and inductors (`guessValue`, `valueToSi`). Every other category
has a blank Value and cannot be sorted by what matters (a MOSFET's Vds or Rds(on), a regulator's output voltage).

## 2. The key finding

LCSC publishes **labelled, normalised parameters** for every part it lists, anonymously:
`GET https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=C269266` -> `result.paramVOList[]` with
`paramNameEn` ("Drain to Source Voltage"), `paramValueEn` ("30V") and `paramValueEnForSearch` (30.0, LCSC's own
number). It also returns the category (`catalogName`), `pdfUrl`, stock and prices. Labels remove the semantic
guesswork an LLM was proposed for ("20mA" is labelled "Quiescent Current"). Caveats: undocumented endpoint; a part LCSC
no longer lists returns `result: null` (e.g. C5240381, the V106 part); Worker egress to it is unverified (POC).

## 3. Three separate things (do not conflate them)

| Concern | Decision |
|---|---|
| **What the app knows** | Each part has named specs stored as **numbers in SI units** (`specs` JSON on the part) with provenance. |
| **What you see** | Two columns: **Value** = key spec #0, **Key specs** = the next few, ranked, cut off by column width (hover shows all). Full list on the part page. Optional per-spec columns appear when filtered to one category. |
| **What you sort by** | A **sort chain** over any spec (footprint included, naturally ordered). Built-in presets per family, editable. |

* **Value is never empty.** For a family with a defining quantity it is that (resistance, capacitance, inductance,
  crystal frequency, LDO Vout, LED colour). Otherwise it is the family's top-ranked spec (MOSFET: Vds). Key specs
  excludes whatever Value already shows. Unmapped families fall back to LCSC's own one-line title (not sortable).
* **The summary never hides specs when you sort.** Sorting by a spec highlights it inside the summary; the rest stay.
* **No automatic layout change** when you filter to one category; that only *unlocks* spec columns and the Sort-by menu.
* Spec sorting is offered only for **one category/family** (voltage means different things across families).
* Value column sorts by spec #0; in a mixed list rows group by category first.

Default key-spec order (#0 first), all user-editable:
resistor: resistance | power, tolerance, technology . capacitor: capacitance | voltage, dielectric, tolerance .
inductor: inductance | current, DCR, tolerance . MOSFET: Vds | channel, Id, Rds(on), Qg . diode: Vr (Zener: Vz) |
current, Vf, type . LDO: Vout | Iout, Vin max, dropout . op amp: gain-bandwidth | channels, slew, Vos, supply .
audio amp: output power | channels, class, supply, load . LED: colour (by wavelength) | Vf, If, brightness .
connector: positions | pitch, current, type . MCU: flash | clock, RAM, I/O, core . crystal: frequency | load C, ppm.
Default sort chains follow the same order with a sensible direction (resistor: resistance, power, footprint;
MOSFET: Vds desc, Rds(on) asc). Order of families to build: MOSFET, diode, LDO, op amp, audio, LED, connector, MCU, crystal.

## 4. Data model

* `part_enrichment(part_id PK, source, status 'ok'|'not_listed'|'error', schema_version, fetched_at, raw_json)`:
  the trimmed raw LCSC response. Separate from `parts` so list queries never read it, and so adding a family
  later **re-derives from stored data without refetching**.
* `parts.specs` JSON: `{ v:1, family, props: { vds: { n:30, u:'V', raw:'30V', src:'lcsc' }, rds_on: { n:0.02,
  u:'ohm', raw:'20mOhm@10V', cond:'Vgs=10V', src }, supply: { min, max, ... } } }`. Ranges carry min and max
  (each sortable). Text specs (N-channel, Class D) are filter/enum values, not sort keys. Floats are fine here
  (not money, AGENTS rule 8). **This revises rule 9**: numbers inside JSON are enough while filtering and sorting are
  client-side; promote to a real column only if a SQL query ever needs one.
* Provenance and precedence per spec: `manual` > `lcsc` > `description`. **A manual value is never overwritten.**
* `settings` rows `speclayout.<family>` (D1, shared across the owner's machines, unlike density/theme which are
  per browser): `{ order:[...], presets:[{ name, chain:[{ key, dir }] }] }`.

## 5. Code layout

`src/domain/quantity.ts` (parse "20mOhm@10V", "18V~53.5V", "+-20V", "-55C~+150C", "9V/us", "0.006%", tolerances;
generalises `valueToSi`; owns SI prefixes and units) . `src/domain/specs/` (registry per family: properties, LCSC
label aliases, description rules, default order and presets, family detection from LCSC `catalogName` with our category
as fallback; `summarize()` returns segments `[{ key, text }]` so the UI can highlight) . `src/db/enrichment.ts` .
`src/worker/enrichment.ts`. No new dependency.

## 6. Enrichment flow (a plan, never a silent write)

1. **Description rules** fill passives' key specs offline from text already stored (`125mW`, `+-1%`, `100V X7R`):
   about 72 of the owner's first 99 parts, no network.
2. **LCSC fetch** for the rest: `POST /api/enrich/lcsc {partIds}` fetches, stores the raw snapshot, maps labels,
   and returns **suggestions** per part (new / unchanged / conflict). At most 40 parts per request (Workers allow
   50 subrequests); the browser loops. Sequential with a small delay; results cached in `part_enrichment`.
3. **Review**: a preview per part and in bulk; `POST /api/enrich/apply` writes only the selected suggestions
   (rule 10: plan-then-apply; bulk applies need a recent export). Never overwrites `manual`.
4. **LLM fallback** (OpenRouter, behind a manual button, provider-abstracted) only for what LCSC and rules leave
   unmapped. Deferred until the data shows a real gap. Web research is deferred further.
5. Validation oracle: LCSC's `paramValueEnForSearch` is NOT in SI base units (it is per label: capacitance 1nF is
   1000, inductance 10uH is 10, force 1.6N is 160), so the check is that **for each label and unit, LCSC's number is a
   constant multiple of ours** across all parts (`tests/quantity.test.ts`). A wrong prefix or unit breaks the constancy.

## 7. UI

* **Needs review (N)** toggle on the Parts toolbar, **hidden when N = 0**; the dashboard count links to it.
* **Key specs** column; Value per section 3; optional spec columns (saved by spec key, per family).
* **Sort chain** popover: add/remove/reorder levels, flip direction, pick or **save a preset**, reset to built-in.
* **Settings > Spec layouts**: reorder a family's key specs, choose #0, edit presets (stored in D1).
* Part page: Key specs, then **All specs** (every raw LCSC parameter, read-only) so unmapped families lose nothing.

## 8. Phases and acceptance

| # | Phase | Done when |
|---|---|---|
| 0 | Needs-review filter **(done)** | toggle appears only when something is flagged; URL param; dashboard link |
| 1 | **Proof of concept (done; Worker egress still unverified, see section 11)** | real LCSC data fetched for the owner's parts and saved as fixtures; report of coverage, labels per category and agreement with LCSC's numbers; Worker egress verified. **Stop and review before building more.** |
| 2 | Quantity parser **(done)** + spec storage | parser agrees with LCSC numbers on the fixtures (it does: section 11); migration for `specs` and `part_enrichment` still to do |
| 3 | Passives from descriptions | R/C/L Key specs without any network |
| 4 | Table: Key specs, Value #0, spec columns, sort chain and presets | sorting a MOSFET list by Vds then Rds(on) works; summary never hides specs |
| 5 | Spec layout editing (Settings) | edits persist across machines |
| 6 | LCSC mapping, family by family, with review UI and bulk apply | each family has fixtures and agreement tests |
| 7 | LLM fallback | only if phase 6 leaves a gap the owner cares about |

## 9. Out of scope (deliberately)

Range filters (sorting first; revisit when the owner says it is useful), vector search/RAG/agents, PDF parsing,
a KV cache (D1 is enough), elaborate confidence scoring (provenance tier is enough), spec sorting across mixed families.

## 10. Open items

* The first build uses LCSC's undocumented endpoint; if it breaks, description rules still work and the stored raw
  snapshots stay usable.
* The owner's cart export (`export_cart_*.csv`: Index, LCSC#, MPN, Manufacturer, Package, Customer #, Description, RoHS,
  Quantity, MOQ, Multiple, Unit Price, Extended Price, Product Link) is a different format from the purchase export.
  It is used as extra POC data; importing a cart as buy-list needs is a possible later feature.

## 11. Proof of concept results (2026-10-06)

Scripts in `scripts/poc-lcsc/` (`fetch.mjs`, `report.mjs`, `preview.mjs`, `egress-worker.mjs`); fixtures in
`tests/fixtures/lcsc-detail/` (111 trimmed responses, 172 KB); generated inventory in `docs/lcsc-poc-report.md`.

* **Coverage:** 110 of 111 parts returned labelled parameters (99%). The one miss is C5240381 (the V106 part), which LCSC
  no longer lists. 109 parts carry at least one LCSC-normalised number.
* **Labels are consistent within an LCSC category**, so a per-family label map is practical. They are not consistent
  across categories, and a few families have optional labels (a MOSFET's `Type` is missing on 2 of 8; its channel
  polarity is then in `Number`: "1 P-Channel").
* **Parser vs LCSC:** `parseQuantity` agrees with LCSC's own numbers on **393 values across 101 label groups with zero
  inconsistencies** (constant multiple per label). About 150 distinct value shapes occur; all are covered.
* **Passives come straight from LCSC too** (power, tolerance, voltage, temperature coefficient/dielectric, technology,
  DCR, saturation current), so the description-rule step is mainly for parts without a C-number.
* **Summaries read well** (`preview.mjs`): `AON7410 | 30V | N-Channel 50A 20mOhm@10V 12nC@10V`,
  `TPA3116D2DADR | 50W@4Ohm | 2-Channel Class D 4.5V~26V`, `RP2350A | 150MHz | ARM Cortex-M33`.

Design consequences the data forced (all adopted):

1. **Value = the first AVAILABLE spec in importance order.** RP2040/RP2350 have no program-storage size; their Value
   becomes the clock speed. A part with no parameters at all (RC4580IDR) falls back to LCSC's one-line title.
2. **Conditions matter when sorting.** Rds(on) is quoted at different gate voltages (`20mOhm@10V`, `12mOhm@2.5V`, none).
   Sorting on the bare number mixes conditions (12 mOhm @ 2.5 V is not "worse" than 20 mOhm @ 10 V). The condition is
   stored and always shown, and when the visible rows mix conditions the sort header says so ("Rds(on): 3 conditions").
3. **Display units belong to the registry, not the parser.** Slew rate must read `9V/us` (the parser holds V/s), memory
   sizes must read `2KB` (binary), wavelengths `513nm`.
4. **Multiple labels can feed one spec** (channel polarity from `Type`, else `Number`), and a spec can be a range with
   both ends sortable (supply voltage).
5. **Dual-supply alternatives** (`-18V~-2.25V;2.25V~18V`) and multi-power ratings (`315Wx2@4Ohm;600Wx1@2Ohm`) are lists;
   the registry picks the headline alternative and the part page shows all.

**Not verified: Worker egress.** Whether Cloudflare's servers can call `wmsc.lcsc.com` is untested: a `wrangler dev
--remote` preview is blocked by Access on the account's workers.dev hostnames. Safest way to settle it: when the fetch
route is built (phase 6), deploy it first on its own, behind Access, and call it once from the signed-in browser.
If Cloudflare is blocked, the fallback is to fetch from the owner's computer with `scripts/poc-lcsc/fetch.mjs`-style
tooling and upload the raw snapshots.
