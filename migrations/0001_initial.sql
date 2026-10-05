-- --------------------------------------------------------------------------
-- 0001_initial -- the whole schema, as decided in the work plan's phase 0.
--
-- Every statement is individually idempotent (IF NOT EXISTS / OR IGNORE), so
-- replaying this file is a no-op. That matters because the REST API gives no
-- atomic multi-statement write: a migration can land half-applied, and the
-- recovery is to run it again.
--
-- Rules that this file encodes, and which must not be "simplified" later:
--   * Stock is never a stored number. It is SUM(delta_qty) over stock_events.
--   * EVERY event is a delta, including a stocktake, so replay is commutative
--     and cannot lose a late-arriving event.
--   * Money is integer micro-USD. No floats in a money path, ever.
--   * Quantities are always pieces.
--   * `id` IS the LCSC C-number for parts that have one.
-- --------------------------------------------------------------------------


-- --------------------------------------------------------------------------
-- meta -- small key/value facts about the database itself
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- schema_version   which migration the database is at.
-- min_code_version the oldest tool version allowed to WRITE here. Bumped by a
--                  migration that changes meaning. The two-machine failure
--                  this prevents: migrate on machine A, then machine B -- still
--                  on last week's checkout -- writes into a schema its code
--                  does not understand. The tool checks this once on connect
--                  and refuses to write if it is older, saying to git pull.
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version',   '1');
INSERT OR IGNORE INTO meta(key, value) VALUES ('min_code_version', '0.1.0');


-- --------------------------------------------------------------------------
-- parts
-- --------------------------------------------------------------------------
-- `id` is the LCSC C-number ("C23179") for any part that has one, and
-- "X-<uuid4hex>" for one that does not. This is not cosmetic: it is what stops
-- two machines creating two rows for the same physical part and splitting its
-- stock across both with nothing noticing. With the C-number as the primary
-- key, INSERT OR IGNORE settles that race for free.
CREATE TABLE IF NOT EXISTS parts (
    id                  TEXT PRIMARY KEY,

    lcsc_pn             TEXT,          -- NULL for a part with no C-number
    mpn                 TEXT,
    manufacturer        TEXT,
    description         TEXT,
    part_type           TEXT,          -- drives the spec template

    -- Freeform specs, for DISPLAY ONLY. The rule, which belongs in AGENTS.md:
    -- promote a key to a typed column below the moment you want to filter or
    -- sort on it. JSON text cannot answer "every ceramic cap between 10n and
    -- 1u in 0402 that I have more than 50 of", because '100n', '100nF',
    -- '0.1uF' and '1e-7' neither sort nor compare.
    specs               TEXT NOT NULL DEFAULT '{}',

    -- Promoted typed columns. Populated from `specs` by the part-type template.
    package             TEXT,
    value_si            REAL,          -- always SI base units: ohms, farads, henries
    tolerance_pct       REAL,
    voltage_rating_v    REAL,
    current_rating_a    REAL,
    temp_coeff          TEXT,          -- X7R, C0G, ... (categorical, not numeric)

    datasheet_url       TEXT,

    -- A loose, deliberately UNVALIDATED reference into KICAD_CUSTOM_LIB, of
    -- the form "<Category>:<Symbol>". This repo never reads or writes that one.
    lib_id              TEXT,

    -- An "equivalent" C-number for a part that has none of its own, so a price
    -- can be shown for it. Prices derived this way are INDICATIVE and must
    -- never be presented as this part's own price, nor summed into inventory
    -- value without being reported separately.
    equivalent_lcsc_pn  TEXT,
    equivalent_basis    TEXT CHECK (equivalent_basis IN ('mpn', 'spec', 'type', 'manual')),

    min_stock           INTEGER,       -- reorder threshold; NULL = untracked
    unit                TEXT NOT NULL DEFAULT 'pcs',
    notes               TEXT,
    tags                TEXT,          -- JSON array

    -- Identity merge. A part entered without a C-number that later acquires
    -- one is merged by setting this; events are NEVER rewritten, only the
    -- alias is followed. Present from day one because retrofitting identity
    -- merge onto a live event log is the most expensive change available.
    merged_into         TEXT REFERENCES parts(id),

    -- Optimistic concurrency. `rev_token` is what distinguishes "the other
    -- machine edited this" from "my own write landed but the response timed
    -- out": after a timeout, read the row back and check whether the token is
    -- yours. Without it, a retried update reports zero rows changed and the
    -- tool blames a conflict that never happened.
    rev                 INTEGER NOT NULL DEFAULT 0,
    rev_token           TEXT,

    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- A second line of defence on identity: the same C-number must not appear on
-- two different rows even if one of them got a surrogate id by mistake.
CREATE UNIQUE INDEX IF NOT EXISTS ux_parts_lcsc_pn
    ON parts(lcsc_pn) WHERE lcsc_pn IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_parts_type     ON parts(part_type);
CREATE INDEX IF NOT EXISTS ix_parts_merged   ON parts(merged_into) WHERE merged_into IS NOT NULL;


-- --------------------------------------------------------------------------
-- stock_events -- append-only. The source of truth for stock on hand.
-- --------------------------------------------------------------------------
-- Stock is SUM(delta_qty). Nothing stores a quantity.
--
-- A STOCKTAKE IS A DELTA. It records what was counted, what the ledger said at
-- the moment of counting, and the difference -- and only the difference is
-- arithmetic. An earlier draft of this design had a stocktake set an ABSOLUTE
-- count that reset the running total, which made replay order-dependent; with
-- two machines that silently discards real movements and still produces a
-- plausible number. Storing the delta instead makes SUM() commutative, so a
-- late-arriving event adds in correctly and a correction means the same thing
-- wherever it lands.
--
-- Consequence, enforced in the tool rather than here: a stocktake cannot be
-- back-dated. A count is an assertion about the shelf at the moment you looked.
CREATE TABLE IF NOT EXISTS stock_events (
    -- Server-assigned ordering. Immune to clock skew between the two machines,
    -- and what makes stock_checkpoints permanently valid: no event can ever
    -- land below an existing through_seq.
    --
    -- NOTE: seq is monotonic but NOT gapless -- an INSERT OR IGNORE that is
    -- ignored still consumes a number (measured). Never infer a count, a
    -- density or completeness from seq.
    seq                 INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Client-generated, UNIQUE, and the single most important correctness
    -- property in the project. With a network-only store, a timeout leaves you
    -- genuinely unsure whether the write landed; blind retry double-counts and
    -- not retrying loses the event. Generate this once per logical event, reuse
    -- it across every retry, and INSERT OR IGNORE makes the retry free.
    event_id            TEXT NOT NULL UNIQUE,

    part_id             TEXT NOT NULL REFERENCES parts(id),

    -- 'transfer' is listed now although locations are deferred
    -- (docs/deferred/locations-and-labels.md). Altering a CHECK constraint in
    -- SQLite means rebuilding the table, so the cheap moment to include it is
    -- before there is any data.
    kind                TEXT NOT NULL CHECK (kind IN (
                            'purchase', 'consume', 'adjust',
                            'stocktake', 'scrap', 'correction', 'transfer')),

    -- The only field any arithmetic touches. Pieces, always.
    delta_qty           INTEGER NOT NULL,

    -- Stocktakes only: what was on the shelf, and what the ledger claimed.
    -- Kept so discrepancy and shrinkage are reportable.
    counted_qty         INTEGER,
    basis_qty           INTEGER,

    -- Integer micro-USD. $0.0021 is 2100. Never a float.
    unit_price_micros   INTEGER,

    -- Purchase provenance, so "1 reel" cannot be entered as qty = 1. The tool
    -- computes delta_qty = pack_count * pack_size and echoes it back for
    -- confirmation before committing.
    pack_count          INTEGER,
    pack_size           INTEGER,

    order_ref           TEXT REFERENCES orders(order_ref),
    reverses            TEXT,          -- event_id this correction reverses
    note                TEXT,
    device              TEXT NOT NULL, -- which machine recorded it

    -- Reserved for the deferred locations feature. Nullable and unused on
    -- purpose: adding a column later is easy, but back-filling MEANING into
    -- events that were recorded without one is not, so every event written
    -- before locations exist is honestly location-unknown rather than guessed.
    location_id         TEXT,

    -- Two timestamps doing two different jobs. Conflating them is what makes
    -- back-dating unsafe. Fixed-width ISO-8601 UTC so lexicographic sort is
    -- chronological sort.
    occurred_at         TEXT NOT NULL, -- when it happened. Reports only.
    recorded_at         TEXT NOT NULL, -- when the row was written. Not editable.

    -- A stocktake's three quantities must agree, checked by the database
    -- rather than trusted to a caller.
    CHECK (kind <> 'stocktake' OR (
               counted_qty IS NOT NULL
           AND basis_qty   IS NOT NULL
           AND delta_qty   = counted_qty - basis_qty)),

    -- Direction sanity. A purchase cannot remove stock; consuming cannot add.
    CHECK (kind <> 'purchase' OR delta_qty >= 0),
    CHECK (kind NOT IN ('consume', 'scrap') OR delta_qty <= 0),

    -- A correction must say what it corrects.
    CHECK (kind <> 'correction' OR reverses IS NOT NULL)
);

-- The hot index. Rows read are metered by rows SCANNED, so this is a bill and
-- not merely a latency question.
CREATE INDEX IF NOT EXISTS ix_events_part_seq ON stock_events(part_id, seq);
CREATE INDEX IF NOT EXISTS ix_events_order    ON stock_events(order_ref) WHERE order_ref IS NOT NULL;


-- --------------------------------------------------------------------------
-- orders -- so landed cost is answerable
-- --------------------------------------------------------------------------
-- Without this, an $8 shipping charge cannot be amortised across a 40-line
-- LCSC order, and "what did this reel actually cost me, delivered" is
-- permanently unanswerable -- which is the number that matters most.
CREATE TABLE IF NOT EXISTS orders (
    order_ref        TEXT PRIMARY KEY,
    vendor           TEXT,
    shipping_micros  INTEGER NOT NULL DEFAULT 0,
    fees_micros      INTEGER NOT NULL DEFAULT 0,
    placed_at        TEXT,
    created_at       TEXT NOT NULL
);


-- --------------------------------------------------------------------------
-- stock_checkpoints -- a cache with a proof attached
-- --------------------------------------------------------------------------
-- NOT a stored stock level. `through_seq` is the proof: the checkpoint is
-- exactly the sum of every event up to that seq, so stock is
-- checkpoint.qty + SUM(delta_qty) WHERE seq > through_seq. Derived,
-- disposable, recomputable from the ledger at any time.
--
-- It exists because the naive full-ledger aggregate scans every event on every
-- query: ~22k rows scanned per refresh at 2k parts today, ~82k by year three,
-- which at 50 refreshes a day is 82% of the 5M/day read cap. The cap is a
-- deadline, not headroom.
--
-- Written with a monotone upsert so two racing devices converge and a stale
-- writer is ignored rather than winning.
CREATE TABLE IF NOT EXISTS stock_checkpoints (
    part_id      TEXT PRIMARY KEY REFERENCES parts(id),
    through_seq  INTEGER NOT NULL,
    qty          INTEGER NOT NULL,
    computed_at  TEXT NOT NULL
);


-- --------------------------------------------------------------------------
-- price_cache -- append-only snapshots, so price history accrues for free
-- --------------------------------------------------------------------------
-- Keyed by C-NUMBER, not by part id, because a price is a fact about a
-- C-number rather than about a part. That is also why `indicative` is NOT a
-- column here: whether a price is indicative depends on the part -> C-number
-- edge (parts.equivalent_lcsc_pn), not on the price itself.
--
-- `price_breaks` holds the whole ladder as JSON. LCSC quotes tiers, so a single
-- price with no quantity attached is ambiguous and the UI must say which tier
-- it is showing.
CREATE TABLE IF NOT EXISTS price_cache (
    lcsc_pn      TEXT NOT NULL,
    provider     TEXT NOT NULL,
    fetched_at   TEXT NOT NULL,
    stock_qty    INTEGER,
    price_breaks TEXT,                      -- JSON: [{"qty":10,"micros":2100}, ...]
    currency     TEXT NOT NULL DEFAULT 'USD',
    raw          TEXT,                      -- provider payload, for debugging a parser
    PRIMARY KEY (lcsc_pn, provider, fetched_at)
);

CREATE INDEX IF NOT EXISTS ix_price_latest ON price_cache(lcsc_pn, fetched_at DESC);


-- --------------------------------------------------------------------------
-- audit_log -- written by a TRIGGER, not by the caller
-- --------------------------------------------------------------------------
-- The REST API has no atomic multi-statement write, so "UPDATE the part, then
-- INSERT an audit row" can land one and lose the other. A trigger writes the
-- audit row inside the implicit transaction that already wraps the UPDATE,
-- which is genuinely atomic and cannot be forgotten by a caller.
--
-- Cost, stated plainly: the trigger enumerates columns, so adding a column to
-- `parts` means a migration that drops and recreates this trigger. Trigger-
-- written rows also count against the daily rows_written budget.
CREATE TABLE IF NOT EXISTS audit_log (
    audit_id  TEXT PRIMARY KEY,
    part_id   TEXT NOT NULL,
    at        TEXT NOT NULL,
    old_json  TEXT NOT NULL,
    new_json  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_part ON audit_log(part_id, at DESC);

DROP TRIGGER IF EXISTS parts_audit_update;
CREATE TRIGGER parts_audit_update AFTER UPDATE ON parts
BEGIN
    INSERT INTO audit_log(audit_id, part_id, at, old_json, new_json)
    VALUES (
        lower(hex(randomblob(16))),
        OLD.id,
        NEW.updated_at,
        json_object(
            'lcsc_pn', OLD.lcsc_pn, 'mpn', OLD.mpn, 'manufacturer', OLD.manufacturer,
            'description', OLD.description, 'part_type', OLD.part_type, 'specs', OLD.specs,
            'package', OLD.package, 'value_si', OLD.value_si,
            'tolerance_pct', OLD.tolerance_pct, 'voltage_rating_v', OLD.voltage_rating_v,
            'current_rating_a', OLD.current_rating_a, 'temp_coeff', OLD.temp_coeff,
            'datasheet_url', OLD.datasheet_url, 'lib_id', OLD.lib_id,
            'equivalent_lcsc_pn', OLD.equivalent_lcsc_pn, 'equivalent_basis', OLD.equivalent_basis,
            'min_stock', OLD.min_stock, 'unit', OLD.unit, 'notes', OLD.notes,
            'tags', OLD.tags, 'merged_into', OLD.merged_into, 'rev', OLD.rev
        ),
        json_object(
            'lcsc_pn', NEW.lcsc_pn, 'mpn', NEW.mpn, 'manufacturer', NEW.manufacturer,
            'description', NEW.description, 'part_type', NEW.part_type, 'specs', NEW.specs,
            'package', NEW.package, 'value_si', NEW.value_si,
            'tolerance_pct', NEW.tolerance_pct, 'voltage_rating_v', NEW.voltage_rating_v,
            'current_rating_a', NEW.current_rating_a, 'temp_coeff', NEW.temp_coeff,
            'datasheet_url', NEW.datasheet_url, 'lib_id', NEW.lib_id,
            'equivalent_lcsc_pn', NEW.equivalent_lcsc_pn, 'equivalent_basis', NEW.equivalent_basis,
            'min_stock', NEW.min_stock, 'unit', NEW.unit, 'notes', NEW.notes,
            'tags', NEW.tags, 'merged_into', NEW.merged_into, 'rev', NEW.rev
        )
    );
END;


-- --------------------------------------------------------------------------
-- backups -- so the pre-bulk export gate is a cheap read
-- --------------------------------------------------------------------------
-- Time Travel on the free tier is 7 days, restores IN PLACE, and is
-- all-or-nothing for the whole database. So restoring after a botched bulk
-- import would also discard every stock event recorded since. The append-only
-- ledger protects stock; it does not protect `parts`.
--
-- Hence the tool REFUSES a bulk mutating apply unless an export newer than N
-- minutes is recorded here, with an explicit --skip-export override.
CREATE TABLE IF NOT EXISTS backups (
    ran_at      TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    sha256      TEXT,
    row_counts  TEXT,                       -- JSON {"parts": 1203, ...}
    bytes       INTEGER
);


-- --------------------------------------------------------------------------
-- import_runs -- makes a bulk import resumable without any local state
-- --------------------------------------------------------------------------
-- Resume state is derived from D1 by import_run_id, so a half-finished import
-- needs no local mirror to recover: re-running reconciles against what is
-- already there and the event_id UNIQUE constraint makes it idempotent.
CREATE TABLE IF NOT EXISTS import_runs (
    import_run_id TEXT PRIMARY KEY,
    source        TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    planned_rows  INTEGER,
    applied_rows  INTEGER,
    note          TEXT
);
