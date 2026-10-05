# Deferred design: BOM reconciliation against a KiCad project

**Status:** stub. Deliberately out of v1 — the owner chose "standalone, loose
reference only".

---

## The feature

Point the tool at a KiCad project and get a per-line report:

```
$ inv bom ~/Documents/Kicad/TPA3255-NOBS_2026-V1
line  qty  part                         have    status
R1-R4   4  C23179  10k 0603 1%            847   ok
C11     2  C1525   100n 0603 X7R           18   ok
U3      1  C97521  TPA3255DDV               0   SHORT 1
J2      1  (not in inventory)               -   UNKNOWN
...
Short 2 lines. Order list written to lcsc-order.csv
```

Plus an LCSC order CSV for the shortfall, in the format LCSC's bulk-paste
accepts.

## Why it is deferred, and what keeps the door open

The owner's v1 decision was explicit: standalone, with one **loose, unvalidated**
`parts.lib_id` text field pointing into `KICAD_CUSTOM_LIB`. That field is the
hinge this feature turns on and it already exists, so nothing here is blocked.

Note that the sibling repo scoped inventory *out* for this project's benefit —
its GUI plan says *"Part inventory, stock quantities, BOM reconciliation or
purchasing. A separate project owns this."* So this repository is the right home
for it whenever it is wanted.

## Decisions already made that this must respect

* **This repository never writes to `KICAD_CUSTOM_LIB`**, and never to a
  `.kicad_sch` / `.kicad_pcb` / `.kicad_sym` / `.kicad_mod`. Read-only, always.
  (`AGENTS.md`, header.)
* Reading a BOM is a **read**, so it needs no plan. Recording consumption from
  one has fan-out across many parts, so by Rule 10 it does.
* `lib_id` stays **unvalidated** as a part field. A dangling reference is a
  `inv check` finding, never an error that blocks anything.

## Open questions to settle before building

1. **How to get the BOM.** `kicad-cli sch export bom` is the sanctioned route
   and avoids parsing S-expressions, but it must be treated as optional and
   absent-tolerant — the sibling repo's `AGENTS.md` §7.4 documents that
   `kicad-cli`'s exit codes are *asymmetrically* trustworthy and is worth
   re-reading before relying on one. Parsing `.kicad_sch` directly would mean
   copying its `core/s_expr.py`, which is a real cost and a second copy to keep
   correct.
2. **Matching.** By `lib_id`? By MPN? By the schematic's own `LCSC` field, which
   is what JLCPCB assembly workflows populate? Probably all three, in a stated
   precedence, reporting which rule matched so a wrong match is visible.
3. **DNP and variants.** A BOM line marked do-not-populate must not count as
   short. Multi-variant projects have more than one true answer.
4. **Whether consumption is recorded at all.** "Tell me what I'm short of" is
   the useful 90%; "deduct a build from stock" is a different, riskier feature
   that writes many events at once and needs a reversible build id.

## Acceptance sketch

* A project using only KiCad's own libraries reports every line as `UNKNOWN`
  without erroring.
* A dangling `lib_id` is a `check` finding, not a crash.
* The order CSV pastes into LCSC's bulk order form unmodified.
* Nothing in the KiCad project is modified — asserted by hashing the project
  tree before and after.
