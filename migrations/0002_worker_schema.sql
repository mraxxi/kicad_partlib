-- --------------------------------------------------------------------------
-- 0002_worker_schema -- replaces the Phase-0 ledger schema (0001) wholesale.
--
-- Why DROP, and why it is safe: the project pivoted from a Python/REST client
-- to a Cloudflare Worker (docs/worker-pivot.md). 0001 was applied to both
-- databases but never held a row -- checked on production and staging before
-- this was written. wrangler tracks 0001 in d1_migrations, so 0001 stays in
-- the repo untouched and this file supersedes it; nobody edits a shipped
-- migration. NEVER run this against a database that has real data.
--
-- Invariants this file encodes:
--   * Quantity changes only through stock_moves, which is append-only
--     (triggers below abort UPDATE and DELETE). lots.qty_on_hand is a cache,
--     written only by the app's single applyMove(), and verified against
--     SUM(delta) by a test and by /api/admin/reconcile.
--   * Money is an integer. Foreign prices are micro-units (USD x 1e6); a lot's
--     cost is micro-IDR (IDR x 1e6), not whole IDR, because a 0.0002 USD part
--     is 3.3 IDR and whole-rupiah rounding would be a 10% error on it.
--   * The FX rate is frozen on the order at import time.
-- --------------------------------------------------------------------------

DROP TRIGGER IF EXISTS parts_audit_update;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS price_cache;
DROP TABLE IF EXISTS stock_checkpoints;
DROP TABLE IF EXISTS stock_events;
DROP TABLE IF EXISTS backups;
DROP TABLE IF EXISTS import_runs;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS parts;
DROP TABLE IF EXISTS meta;

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS locations (
    id        INTEGER PRIMARY KEY,
    code      TEXT NOT NULL UNIQUE,
    name      TEXT NOT NULL DEFAULT '',
    parent_id INTEGER REFERENCES locations(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS suppliers (
    id                 INTEGER PRIMARY KEY,
    name               TEXT NOT NULL UNIQUE,
    kind               TEXT NOT NULL CHECK (kind IN ('distributor', 'marketplace', 'local')),
    currency           TEXT NOT NULL DEFAULT 'USD',
    order_shipping_idr INTEGER NOT NULL DEFAULT 0,
    free_ship_over_idr INTEGER,
    lead_days          INTEGER,
    url                TEXT,
    notes              TEXT
);

-- manufacturer_norm exists because LCSC spells one manufacturer several ways
-- ("DIODES" / "Diodes Incorporated"); the identity of a part is
-- (mpn, manufacturer_norm), produced by one function in src/domain/normalize.ts.
-- needs_review marks rows imported with missing data (description "-").
CREATE TABLE IF NOT EXISTS parts (
    id               INTEGER PRIMARY KEY,
    mpn              TEXT NOT NULL,
    manufacturer     TEXT NOT NULL DEFAULT '',
    manufacturer_norm TEXT NOT NULL DEFAULT '',
    category_id      INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
    description      TEXT NOT NULL DEFAULT '',
    package          TEXT NOT NULL DEFAULT '',
    value            TEXT NOT NULL DEFAULT '',
    lcsc_code        TEXT UNIQUE,
    datasheet_url    TEXT,
    kicad_symbol     TEXT,
    kicad_footprint  TEXT,
    notes            TEXT NOT NULL DEFAULT '',
    needs_review     INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
    rev              INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (mpn COLLATE NOCASE, manufacturer_norm)
);
CREATE INDEX IF NOT EXISTS ix_parts_category ON parts(category_id);

CREATE TABLE IF NOT EXISTS part_aliases (
    id      INTEGER PRIMARY KEY,
    part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
    kind    TEXT NOT NULL CHECK (kind IN ('mpn', 'lcsc', 'manufacturer', 'other')),
    value   TEXT NOT NULL,
    UNIQUE (part_id, kind, value)
);

CREATE TABLE IF NOT EXISTS orders (
    id                 INTEGER PRIMARY KEY,
    supplier_id        INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    order_no           TEXT NOT NULL,
    order_date         TEXT NOT NULL,
    currency           TEXT NOT NULL DEFAULT 'USD',
    fx_to_idr_micro    INTEGER NOT NULL CHECK (fx_to_idr_micro > 0),
    shipping_idr       INTEGER NOT NULL DEFAULT 0,
    duties_idr         INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'received'
                       CHECK (status IN ('ordered', 'received', 'cancelled')),
    source_file_sha256 TEXT,
    UNIQUE (supplier_id, order_no)
);

CREATE TABLE IF NOT EXISTS order_lines (
    id               INTEGER PRIMARY KEY,
    order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    part_id          INTEGER NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
    qty              INTEGER NOT NULL CHECK (qty > 0),
    unit_price_micro INTEGER NOT NULL,
    ext_price_micro  INTEGER NOT NULL,
    raw_json         TEXT NOT NULL,
    UNIQUE (order_id, part_id)
);

CREATE TABLE IF NOT EXISTS donors (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    device      TEXT NOT NULL,
    received_at TEXT,
    condition   TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'stripping' CHECK (status IN ('stripping', 'done', 'parked')),
    notes       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS lots (
    id                  INTEGER PRIMARY KEY,
    part_id             INTEGER NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
    source              TEXT NOT NULL CHECK (source IN ('order', 'salvage', 'manual')),
    order_line_id       INTEGER REFERENCES order_lines(id) ON DELETE RESTRICT,
    donor_id            INTEGER REFERENCES donors(id) ON DELETE RESTRICT,
    condition           TEXT NOT NULL DEFAULT 'new'
                        CHECK (condition IN ('new', 'tested_ok', 'untested', 'faulty')),
    location_id         INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
    unit_cost_idr_micro INTEGER NOT NULL DEFAULT 0,
    date_code           TEXT,
    qty_on_hand         INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
    min_qty             INTEGER,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lots_part     ON lots(part_id);
CREATE INDEX IF NOT EXISTS ix_lots_location ON lots(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_lots_donor    ON lots(donor_id)    WHERE donor_id IS NOT NULL;
-- One lot per order line: this is what makes a re-import unable to double-receive.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lots_order_line ON lots(order_line_id) WHERE order_line_id IS NOT NULL;

-- move_id is client-generated and UNIQUE, so a retried request after a timeout
-- (INSERT OR IGNORE) cannot double-apply. See applyMove().
CREATE TABLE IF NOT EXISTS stock_moves (
    id         INTEGER PRIMARY KEY,
    move_id    TEXT NOT NULL UNIQUE,
    lot_id     INTEGER NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
    delta      INTEGER NOT NULL CHECK (delta <> 0),
    reason     TEXT NOT NULL CHECK (reason IN
                   ('receive', 'consume', 'adjust', 'salvage', 'transfer', 'scrap')),
    project_id INTEGER,
    note       TEXT NOT NULL DEFAULT '',
    at         TEXT NOT NULL,
    CHECK (reason NOT IN ('receive', 'salvage') OR delta > 0),
    CHECK (reason NOT IN ('consume', 'scrap')   OR delta < 0)
);
CREATE INDEX IF NOT EXISTS ix_moves_lot_at ON stock_moves(lot_id, at);

-- Append-only, enforced by the database rather than by good intentions.
CREATE TRIGGER IF NOT EXISTS stock_moves_no_update BEFORE UPDATE ON stock_moves
BEGIN SELECT RAISE(ABORT, 'stock_moves is append-only: append a reversing move instead'); END;
CREATE TRIGGER IF NOT EXISTS stock_moves_no_delete BEFORE DELETE ON stock_moves
BEGIN SELECT RAISE(ABORT, 'stock_moves is append-only: append a reversing move instead'); END;

CREATE TABLE IF NOT EXISTS import_runs (
    id       INTEGER PRIMARY KEY,
    kind     TEXT NOT NULL,
    filename TEXT NOT NULL,
    sha256   TEXT NOT NULL,
    rows_in  INTEGER NOT NULL,
    rows_new INTEGER NOT NULL,
    rows_dup INTEGER NOT NULL,
    at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
    day           TEXT PRIMARY KEY,
    rows_read     INTEGER NOT NULL DEFAULT 0,
    rows_written  INTEGER NOT NULL DEFAULT 0,
    requests      INTEGER NOT NULL DEFAULT 0
);

-- --------------------------------------------------------------------------
-- Seed data
-- --------------------------------------------------------------------------
INSERT OR IGNORE INTO categories(name) VALUES
    ('Resistor'), ('Capacitor'), ('Inductor'), ('Diode'), ('MOSFET'),
    ('Transistor'), ('Op Amp'), ('Audio Amplifier'), ('Regulator'), ('MCU'),
    ('LED'), ('Connector'), ('Switch'), ('Power Management'), ('Other');

INSERT OR IGNORE INTO suppliers(name, kind, currency) VALUES
    ('LCSC', 'distributor', 'USD'), ('Mouser', 'distributor', 'USD'),
    ('Tokopedia', 'marketplace', 'IDR'), ('Shopee', 'marketplace', 'IDR'),
    ('AliExpress', 'marketplace', 'USD'), ('Local Shop', 'local', 'IDR');

-- Placeholder (IDR per USD, x 1e6). Display default only: an order's cost basis
-- is the rate typed on that order at import, never this.
INSERT OR IGNORE INTO settings(key, value) VALUES
    ('fx.usd_idr_micro', '16500000000'),
    ('fx.updated_at',    '2026-10-06T00:00:00Z');
