# AI Agent Operating Guidelines — KiCad Part Library (`KICAD_PART_LIBRARY`)

> **Scope**: how AI coding assistants (Claude, Gemini, ChatGPT, …) must
> interact with, modify and extend this repository.

A personal electronic-parts inventory: detailed specs, current market price and
availability, the price actually paid, stock on hand, and the LCSC part number
to reorder by — for the parts actually on the bench. Usable from either of two
machines. A stdlib-only Python core and CLI, a PySide6 GUI, and **Cloudflare D1
as the only store**.

This is the sibling of [`KICAD_CUSTOM_LIB`](https://github.com/mraxxi/kicad_customlib),
which owns symbols, footprints and 3D models and deliberately refuses to track
stock. **This repository never reads or writes that one.**

---

## 1. Architecture: two rules that explain everything else

### Rule A — The database is the source of truth
This is the **opposite** of the sibling repo, and the inversion is deliberate.
There, the disk is the source of truth and nothing can drift because there is no
database. Here, stock on hand is mutable state that no amount of scanning can
derive, so a database is unavoidable — and §3 is the price paid for it.

There is **no local copy of the data**. No mirror, no cache of record, no
inventory in git. Git tracks code and documentation. A clone on a new machine is
useless until it is pointed at the database.

> The owner chose this knowingly, after the offline/outage tradeoff was spelled
> out. **Do not "improve" it by adding a local mirror.** If offline operation is
> ever wanted, `docs/deferred/offline-mode.md` is the design; it is a project,
> not a patch.

### Rule B — Stock is never a stored number
`stock_events` is append-only, and stock on hand is `SUM(delta_qty)`. Nothing
anywhere stores a quantity. Events are **immutable**: a mistake is corrected by
appending a reversing `correction` event, never by `UPDATE` or `DELETE`.

**Every event is a delta, including a stocktake.** A stocktake records
`counted_qty` (what was on the shelf), `basis_qty` (what the ledger said) and
`delta_qty = counted_qty - basis_qty` — and only the delta is arithmetic.

An earlier design had a stocktake set an **absolute** count that reset the
running total. That made replay **order-dependent**, and across two machines an
order-dependent ledger loses events silently — which for an inventory is the
worst possible failure, because it produces a *plausible* number with no error
anywhere. Storing the delta makes `SUM()` commutative: a late-arriving event
adds in correctly, and a `correction` means the same thing wherever it lands.

Consequences to keep:
* **A stocktake cannot be back-dated**, and the CLI must refuse it in a
  sentence. A count is an assertion about the shelf at the moment you looked.
* If events land after a stocktake that describe a period before it, that
  stocktake's `basis_qty` is stale. **Warn; never silently recompute.** Same
  instinct as the sibling repo's `provenance.json`: advisory data warns, and
  stale advisory data is never an error.
* `stock_checkpoints` is **a cache with a proof attached** (`through_seq`), not
  a stored stock level. Derived, disposable, recomputable from the ledger at any
  time. Do not "simplify" it into a `parts.stock` column.

---

## 2. Verified facts — do not re-derive

Measured on this machine, 2026-10-05. Re-run the probes rather than
re-measuring, and treat these as given.

### 2.1 Platform
| Fact | Value |
|---|---|
| Python | 3.14.7 |
| PySide6 | 6.11.2, from **pacman** (`local/pyside6`), not pip |
| pytest / pytest-qt | 9.1.1 / 4.5.0 |
| sqlite3 | 3.53.4 |
| `wrangler` | 4.84.0 at `/usr/bin/wrangler` |

**PyQt5 (5.15.11) and PyQt6 (6.11.0) are also installed.** Importing two Qt
bindings into one process can crash it. **Never import `PyQt5` or `PyQt6`
anywhere in this repository** — PySide6 only. (`pyqtgraph` pulls PyQt in; do not
use it here.)

**`wrangler` cannot write its cache on this machine without help.** It walks up
from the working directory to the nearest `node_modules/.cache`, and a
root-owned `/home/archvan/node_modules` (from a `sudo npm` install of `9router`)
sits up-tree, so it fails with *"A permission error occurred while accessing the
file system."* An **empty project-local `node_modules/`** stops it walking up;
it is gitignored. `CACHE_DIR` does **not** override this — measured.

### 2.2 Cloudflare D1, free tier
| Limit | Free | Consequence |
|---|---|---|
| Databases / account | **10** | The owner already has 6. Only 4 slots are free — the "spare database for rehearsing migrations" idea is affordable but not unlimited. |
| Max database size | 500 MB | 2,000 parts ≈ 2 MB. Non-issue. |
| **Rows read / day** | **5,000,000** | Metered by rows **scanned**, not returned. See §3.3. |
| **Rows written / day** | **100,000** | A 2,000-row import is 2% of a day. |
| Max row / BLOB | 2 MB | Never store datasheets or models. Store URLs. |
| Max SQL statement | 100 KB | See the `json_each` batching shape, §3.4. |
| **Max bound params / query** | **100** | The reason for `json_each`, §3.4. |
| Max query duration | 30 s | Client timeouts must sit below this. |
| Time Travel | **7 days** | Restores **in place**, **all-or-nothing**. §3.5. |

REST endpoint, callable from stdlib `urllib.request` with no dependency:
```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query
Authorization: Bearer <token>
{"sql": "...", "params": [...]}
```

### 2.3 SQL feature probes
Run with `wrangler d1 execute <db> --local`, which runs D1's own engine with no
account. Encoded as tests in `tests/test_schema.py`.

| # | Probe | Answer |
|---|---|---|
| P2 | `INSERT … SELECT json_extract(value,'$.k') FROM json_each(?)` | **Works**, one bound param, and `typeof()` confirms **types survive** (an integer stays `integer`) |
| P4 | `AFTER UPDATE` trigger | **Fires.** One `UPDATE` → exactly one audit row |
| P5 | `sqlite_master` readable; `pragma_table_info('t')` as a table-valued function | **Both work** |
| P6 | `INTEGER PRIMARY KEY AUTOINCREMENT`, `INSERT OR IGNORE` on a UNIQUE conflict | Works. **`seq` is monotonic but NOT gapless** — an ignored insert still consumes a number |
| — | Partial index (`CREATE INDEX … WHERE`), CTEs (`WITH`) | **Both work** |

**`seq` has gaps.** Never infer a count, a density or completeness from it; in
particular a future "pull everything since sequence N" sync must treat gaps as
normal. This is exactly the assumption that looks fine for a year.

**Still open — these need a real database over REST, not `--local`:**

| # | Probe | Why it matters |
|---|---|---|
| P1 | Are bound `params` typed or stringly on the wire? | The REST docs describe `params` as an array of *strings*. If so, micro-USD integers could arrive as TEXT and break `SUM`. The `json_each` shape (P2) sidesteps it. |
| P3 | Is a semicolon-joined multi-statement `/query` atomic? | Decides whether migrations need a per-statement ledger keyed `(version, stmt_index)`. |
| P8 | Capture real wire bodies for 401, quota-exceeded, 30 s timeout | They become test fixtures for the error contracts in §4. |
| P9 | Is `meta.rows_read` for a `SUM … GROUP BY` over N rows ≈ N? | Makes §3.3's budget measured rather than assumed. |

### 2.4 Qt and the test suite
| Question | Measured answer |
|---|---|
| Does `filterwarnings = error` fight PySide6? | **No.** Importing PySide6 and building `QApplication`, `QAbstractTableModel`, `QSortFilterProxyModel`, `QTableView`, `QThreadPool`, `QRunnable`, `Signal` and `QTimer` raised **no warnings** on this stack. **No ignore list is needed yet** — add one only when a real warning appears, with a comment saying why. |
| Does an exception in a Qt slot get swallowed, as it did in Tk? | **No.** `pytest-qt` 4.5.0 catches it and **fails the test** ("Exceptions caught in Qt event loop"). So the sibling repo's failing-`report_callback_exception` machinery has no analogue to build. |

**But "press the button in the test" still applies.** pytest-qt surfaces the
exception only if something actually invokes the callback. Constructing a dialog
and inspecting it executes no command handler — in the sibling repo two missing
imports reached a user because nothing pressed anything.

### 2.5 LCSC data sources
No friendly public API. Three tiers, descending reliability:
1. **Official OpenAPI** — `https://ips.lcsc.com/rest/wmsc2agent/product/info/{pn}`,
   auth by `key` + `nonce` + `timestamp` + `signature`. The `wmsc2agent` family
   includes order submission, so it targets resellers; **how a hobbyist obtains
   a key is undocumented**, and so is the signature algorithm.
2. **Anonymous web** — `GET https://lcsc.com/api/global/additional/search?q=<pn>`
   works; the bulk `wmsc.lcsc.com` search 403s anonymously; `POST
   https://lcsc.com/api/products/search` needs a CSRF token and cookies
   bootstrapped from a category page. Fragile by construction.
3. **Manual entry** — always available, and always authoritative for what you paid.

Hence one small module per source under `providers/`, each free to break without
taking anything else down.

---

## 3. Golden rules

### Rule 1: Never interpolate into SQL
Bound parameters, always. The 100-param ceiling is **not** a reason to inline
literals — that is interpolation into a structured language, the same bug class
the sibling repo's Rule 1 bans (*"**Never** `re.sub` with an interpolated
replacement string"*), and here the blast radius is the whole database rather
than one file. Use the `json_each` shape in §3.4 instead.

### Rule 2: Retry-safety before anything else
With a network-only store, **an HTTP timeout leaves you genuinely unsure whether
the write landed.** Blind retry double-counts stock; not retrying loses it.

* **Inserts**: a client-generated `event_id` (uuid4 hex) with `UNIQUE`, and
  `INSERT OR IGNORE`. **Generate the id once per logical event and reuse it for
  every retry.** A retry is then free.
* **Updates**: `rev_token`. `UPDATE parts SET …, rev = rev + 1, rev_token = ?
  WHERE id = ? AND rev = ?` — after a timeout, read the row back; if the token
  is yours, your write landed. Without this, a retried update reports zero rows
  changed and the tool blames a conflict that never happened.

This is the property to test first and hardest. `tests/test_schema.py::
test_a_retried_event_insert_does_not_double_count` must never regress.

### Rule 3: On a `rev` conflict, refuse — never auto-retry
Re-sending the same payload with a freshly-read `rev` converts optimistic
concurrency into **last-write-wins** and silently discards the other machine's
edit. Retry is valid only when the new value can be re-derived from the new base
(`qty = qty + 1`), which a form full of text fields cannot.

Default: show a **field-level diff** — "changed on the other machine 20 minutes
ago: `voltage_rating` 25 V → 50 V. Keep theirs / keep yours / merge." Without
the diff the owner retypes everything, and by the third time they reach for
`--force`.

### Rule 4: The read budget is a deadline, not headroom
Rows read are metered by rows **scanned**. A naive full-ledger aggregate scans
every event on every query:

| Scale | Scanned per refresh | × 50/day | vs 5 M cap |
|---|---|---|---|
| 2 k parts / 20 k events (today) | ~22,000 | 1.1 M | 22% |
| year one | ~42,000 | 2.1 M | 42% |
| year three | ~82,000 | 4.1 M | **82%** |

An index narrows which rows are scanned but they are still counted. The fix is
`stock_checkpoints` (Rule B), and the trigger to build it is **measured**: the
Store accumulates `meta.rows_read` / `rows_written` per session and `inv status`
reports it. An earlier draft of the plan budgeted 250 k/day by counting `parts`
and forgetting the ledger entirely — instrumentation is what catches that class
of error, and a spreadsheet is what caused it.

### Rule 5: One parameterised statement is the only atomic unit
`BEGIN TRANSACTION` is rejected (D1 wraps each statement itself), atomic
multi-statement `batch()` is a Workers-runtime capability with **no HTTP
equivalent**, and a semicolon-joined statement list with a shared `params` array
is reported not to work. *(P3 — confirm over REST.)*

So "UPDATE the part, then INSERT an audit row" **cannot be one unit of work**.
The audit row is written by an `AFTER UPDATE` **trigger**, inside the implicit
transaction that already wraps the `UPDATE`. Verified: it fires, and
`SqliteStore` inherits it for free because the dialect is identical.

Cost, stated plainly: the trigger enumerates columns, so **adding a column to
`parts` means a migration that drops and recreates `parts_audit_update`**, and
trigger-written rows count against `rows_written`.

### Rule 6: Core is stdlib-only and never imports Qt
`core/` and `providers/` use the standard library alone — `urllib` talks to D1,
so there is no HTTP dependency. Qt lives only in `gui/`. The CLI must run on a
machine with no PySide6 at all, and there is a test that enforces it by making
the import fail.

### Rule 7: Secrets never enter the repository
`$XDG_CONFIG_HOME/kicad_partlib/secrets.json`, mode `0600`, with
`KICAD_PARTLIB_CF_TOKEN` / `..._CF_ACCOUNT_ID` / `..._CF_DATABASE_ID` env
overrides for CI. The token must be **D1-scoped and account-limited**; a
Cloudflare API token is otherwise far broader than this tool needs.

A test asserts **no error message ever contains the token** — construct every
error with a sentinel token in the environment and assert it appears in none of
them. Tokens leak into tracebacks, logs and bug reports.

### Rule 8: Money is integer micro-USD; quantities are pieces
`$0.0021` is `2100`. **No float ever reaches a money path** — that magnitude is
exactly where drift starts to matter. One module owns the rounding rule.

`qty` is **always pieces**, decided once and never negotiated. A purchase
carries `pack_count` and `pack_size` as provenance, computes
`qty = pack_count × pack_size`, and **echoes it back before committing**
("5 × 1000 = 5000 pieces — correct?"). Entering a reel as `qty = 1` looks
entirely plausible on screen and is invisible forever afterwards.

### Rule 9: JSON specs are for display; promote a key to filter or sort on it
`parts.specs` is freeform JSON for display. It **cannot** answer the single most
useful question an inventory has — "every ceramic cap between 10 n and 1 µ in
0402 that I have more than 50 of" — because `100n`, `100nF`, `0.1uF` and `1e-7`
neither sort nor compare. It is also why a specs column cannot sort correctly in
a table: `100nF` lands between `10nF` and `1uF`.

So: **promote a key to a typed column the moment you want to filter or sort on
it.** The promoted set is `package`, `value_si` (always SI base units),
`tolerance_pct`, `voltage_rating_v`, `current_rating_a`, `temp_coeff`, populated
from `specs` by the part-type template.

(A narrow `part_specs(part_id, key, num_value, …)` table is the more general
answer and is **rejected**: it multiplies rows scanned by ~10 on every refresh,
which Rule 4 cannot afford.)

### Rule 10: Plan-then-apply for anything with fan-out
> **Required for any operation that touches a row the user did not name.**

That is the rule, and it is mechanically checkable. It catches things that are
not "bulk" at all: changing a part's C-number invalidates its price cache;
changing its part type changes the spec template and may orphan spec keys; a
merge rewrites aliases. Plus the obvious ones — CSV import, bulk price refresh,
deletion, migrations.

A one-field edit is exempt because it has **no fan-out**, *not* because
`audit_log` makes it undoable. Undo-after and preview-before are not
substitutes: plan-then-apply's value in the sibling repo was never undo, it was
showing the blast radius first.

`--dry-run` stops at the plan, `--yes` skips the prompt, and a non-interactive
run without `--yes` is **refused**. Building a plan must not mutate anything,
including in-memory state — keep the sibling repo's `test_plan_purity.py`
discipline.

### Rule 11: A refused action always says why
One sentence, and **identical wording in the CLI and the GUI**. Follow the
sibling repo's `RepoStatus.blockers()` pattern: a single `Dict[action, reason]`
map that both front-ends render. A test asserts every reason is a full sentence.

---

## 4. Error contracts

Mirror the sibling repo's `core/vcs.py`: *"Nothing here raises on a git failure.
Every call returns a `GitResult` carrying the exit code and both streams, so a
caller can show the user what git actually said instead of a traceback."* The
Store returns a result object and never leaks `urllib.error.HTTPError`.

| Condition | Behaviour | Message must say |
|---|---|---|
| Timeout on a mutating call | **Do not retry blindly.** Re-read by `event_id` / `rev_token` and report what you found | "The write may or may not have landed. Checking… it did / it did not." |
| 401 / 403 | **Never retry.** Nothing was written | the config path and the exact permission required |
| Daily cap exceeded | Stop, report progress, name the resume command | "Wrote 1,240 of 2,000 rows before the daily write limit. Re-run `inv import --resume <run_id>` after 00:00 UTC; nothing is lost." |
| DNS / no route | Offline | "This tool keeps nothing locally, so no part data is available until the connection is back." |
| 5xx | Backoff, cap at 3 attempts, then report | the attempt count |
| Schema mismatch | **Refuse everything** | "The database schema is newer than this checkout. `git pull` on this machine first." |

**HTTP 200 is not success.** The Cloudflare API returns **200 with
`success: false`** for a SQL error, with the real message in `errors[]`. Check
the outer `success`, **then each statement's own `success`**, and surface
`errors[0].message`. Never `raise_for_status()` and assume. Pin the unwrapping
against a recorded response fixture so a shape change fails loudly rather than
at the next stocktake.

---

## 5. Repository layout

| Path | Description | Git |
|---|---|---|
| `migrations/` | Ordered, append-only `.sql`. **Never edit a shipped migration.** | Yes |
| `scripts/inv_manager.py` | The only entry point: CLI + `gui` subcommand | Yes |
| `scripts/src/core/` | Stdlib only. No Qt. | Yes |
| `scripts/src/providers/` | One fragile thing per file | Yes |
| `scripts/src/gui/` | PySide6 only | Yes |
| `tests/` | pytest suite; runs entirely offline | Yes |
| `docs/` | Setup, schema rationale, deferred designs | Yes |
| `backups/` | `wrangler d1 export` output — the backup of record | **No** |
| `node_modules/` | Empty; exists only to give wrangler a writable cache | **No** |
| `$XDG_CONFIG_HOME/kicad_partlib/` | Secrets and GUI preferences | **No** |

**Config fails soft, data fails loud.** GUI preferences fall back to defaults on
corruption; anything authoritative raises with an actionable message and leaves
the file untouched. The sibling repo's `provenance.py` states this asymmetry and
forbids "fixing" it. Same here.

---

## 6. Migrations

**`wrangler` applies them; this tool only verifies.**

```bash
wrangler d1 migrations list  kicad-partlib
wrangler d1 migrations apply kicad-partlib
```

* Append-only. **Never edit a shipped migration; add a new one.**
* Every statement individually idempotent (`CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`), because a migration can land half-applied and
  the recovery is to run it again. `tests/test_schema.py::
  test_applying_every_migration_twice_changes_nothing` enforces it.
* `ALTER TABLE ADD COLUMN` is **not** idempotent — probe the live schema from
  `sqlite_master` (a plain `SELECT`, confirmed readable) rather than
  `PRAGMA table_info`.
* **Rehearse on a second database** before touching the real one: seed it from an
  export, migrate it, then migrate production. (Budget: 4 free slots left.)
* `core/migrate.py` **verifies only** — reads the schema version, compares it
  against what the code expects, and **refuses to run** on a mismatch with the
  exact `wrangler` command to fix it. A tool that silently migrates the owner's
  only copy of the data is not what is wanted.
* **`min_code_version`** in `meta` guards the two-machine failure nobody plans
  for: migrate on machine A, walk to machine B still on last week's checkout,
  and B writes into a schema its code does not understand. Checked once per
  session on connect; an older device **refuses to write**.

---

## 7. Backups, and why a nag is not enough

`wrangler d1 export` is the sanctioned path, wrapped as `inv backup`, recorded in
the `backups` table so the check is a cheap read.

**Time Travel is weaker than it sounds**: 7 days on free, restores **in place**,
**all-or-nothing for the whole database**. So a bad bulk `UPDATE` on `parts` (a
CSV import that flattens 2,000 rows' specs) **cannot be undone without also
discarding every stock event recorded since.** The append-only ledger protects
stock; it does not protect `parts`. And `audit_log` lives in the same database
under the same 7 days, so the undo history has no second copy.

Therefore: **refuse any bulk mutating apply unless an export newer than N
minutes exists**, with `--skip-export` as the knowing override. That is the
sibling repo's pre-push audit with an explicit override, resting on the same
principle — "a single-user multi-machine setup, so the user is allowed to
overrule the tool knowingly."

`wrangler` is an optional external binary, treated like `zenity`/`kdialog`
there: used when present, never required, and its absence degrades to a loud
instruction rather than a crash. **The backup is not a fallback store.**

---

## 8. The GUI boundary

> **Keep logic out of widgets. If a decision can be made without Qt, it belongs
> in the controller or `core/`, with a headless test. This is the single most
> important constraint in this project.**

Carried over verbatim from the sibling repo, where it earned that billing.

* **Controller owns**: the working set, filter/sort state, **column definitions
  as data**, plan previews, every user-facing string including "last known, 4
  days old", and **every enable/disable decision together with its reason
  sentence**.
* **Qt layer owns**: a thin `QAbstractTableModel` delegating to the controller's
  row list, widget construction, signal wiring. Target ~80 lines for the adapter.
* **Do not make the controller a `QAbstractTableModel`.** That is the shortcut
  that destroys the property most worth having.
* Rows are frozen dataclasses with a **stable id, never display text**.

Two mechanical boundary tests: (1) the controller's source contains no `Qt`,
`QModel`, `Signal`, `QVariant` or `QAbstractItemModel` identifier — a leaked
`Qt.AlignRight` return value *is* a breach; (2) **the CLI runs with PySide6
unimportable**, via a `sys.meta_path` finder that raises on `PySide6`.

Performance specifics that matter at 5,000 rows:
* `filterAcceptsRow` reads a **precomputed lowercase search blob held as a plain
  Python list**, indexed directly — never `sourceModel().data(index, role)` per
  column per row per keystroke, which is 5k × ncols `QVariant` conversions per
  character. Debounce the search box 150 ms.
* Sort through a dedicated `Qt.UserRole` returning the **comparable** value; never
  parse strings in `lessThan`. This only works because Rule 9's typed columns exist.
* `beginResetModel` for a wholesale refresh; `dataChanged` for a single-part edit,
  so selection and scroll position survive.
* **Dynamic spec columns**: a fixed core set always, plus the current part type's
  template columns **only once the filter has narrowed to one part type**. The
  union of spec keys across 5,000 mixed parts is hundreds of empty columns.
  **Key persisted column width/order/visibility by spec-key name, never by column
  index** — the index's meaning changes when the spec set does, and a restored
  layout then applies the wrong width to the wrong column. Same bug the sibling
  repo already paid for with `iid`, new toolkit.

Threading — `QThreadPool` + signals, **not asyncio** (the Store is synchronous
stdlib `urllib` by design, and `qasync` would be a runtime dependency Rule 6
forbids):
* **A dedicated pool with `setMaxThreadCount(1)` for every mutating call**, so two
  writes never interleave. The sibling repo's rule transplanted: *"two git
  commands never contend for the index lock."* A second pool (2–4) for read-only
  price fetches.
* `QRunnable` cannot emit signals — use a small `_Signals(QObject)` holder.
  **Nothing in a worker may touch a model, a widget or controller state**; workers
  take plain inputs and return plain data, which is also what keeps them testable.
* **Drop results for superseded requests** via a monotonically increasing request
  id compared on arrival. Otherwise a slow refresh completing after a faster newer
  one repaints stale data: easy to miss, maddening to diagnose.
* `urlopen` does no connection pooling, so every call pays a TLS handshake
  (~100 ms to Cloudflare). A kept-alive `http.client.HTTPSConnection`
  **per worker thread** — not shared behind a lock, which would serialise the pool.

---

## 9. Running the tests

```bash
python -m venv --system-site-packages .venv   # PySide6 comes from pacman
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q
```

`--system-site-packages` matters: pip-installing a second PySide6 into the venv
would shadow the system Qt libraries and produce mismatched-ABI crashes.

The whole suite runs **offline**, against an in-memory SQLite database built from
the real migration files — so the schema the tests exercise is the schema that
ships, not a hand-maintained copy that can drift. Tests needing a real D1
database or `wrangler` skip when absent.

Conventions: `tests/` is an importable package; module-level functions, no
classes; **full-sentence names that read as assertions**
(`test_a_retried_event_insert_does_not_double_count`, not `test_insert_retry`);
capability probes over platform sniffing; `QT_QPA_PLATFORM=offscreen` set at
`conftest.py` **module scope**, before any PySide6 import, because Qt reads it
when the platform plugin loads.

---

## 10. Adding an operation

1. Decide whether it has **fan-out** (Rule 10). If so it needs a plan.
2. Put the decision in `core/`, not in a UI callback. If it can be decided
   without Qt, it must be.
3. Make every write **retry-safe** (Rule 2) before making it correct.
4. Add tests asserting both the outcome *and*, for a plan, that planning wrote
   nothing.
5. Wire it into the CLI (a `cmd_*` plus a subparser) and then, if it belongs
   there, the controller.
6. Record the *why* in the docstring — including the bug that motivated it. This
   is the sibling repo's most valuable habit.
