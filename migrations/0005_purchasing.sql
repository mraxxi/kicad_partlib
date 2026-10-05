-- --------------------------------------------------------------------------
-- 0005_purchasing -- Phase 3: projects, what they need, and supplier quotes.
--
-- Money here is whole IDR: quotes are typed in rupiah at quote time (the sheet's
-- model), and a quote carries `quoted_at` so a stale price is visible as stale.
--
--  * needs: one row per (project, part). The sheet allowed repeats of an MPN in
--    a project; a repeat is the same need and is summed, not listed twice.
--  * needs.ordered_*: when a need is marked ORDERED, what it cost is FROZEN here
--    (supplier, quantity, its share of the group total). Quotes keep changing;
--    money already committed must not (same principle as the frozen FX rate).
--  * needs.order_id: set when an LCSC import of the real order closes the need.
--  * quotes: one per (part, supplier), as in the sheet's price matrix. `seller`
--    is a free-text label (the marketplace shop). price_breaks_json is
--    [{"qty":100,"priceIdr":68}, ...]; the base unit_price_idr applies below the
--    first break.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planning', 'active', 'done', 'parked')),
    kicad_project TEXT,
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS needs (
    id                   INTEGER PRIMARY KEY,
    project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    part_id              INTEGER NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
    qty_needed           INTEGER NOT NULL CHECK (qty_needed > 0),
    spares               INTEGER NOT NULL DEFAULT 0 CHECK (spares >= 0),
    priority             TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
    status               TEXT NOT NULL DEFAULT 'to_buy'
                         CHECK (status IN ('to_buy', 'ordered', 'received', 'covered', 'cancelled')),
    override_supplier_id INTEGER REFERENCES suppliers(id) ON DELETE RESTRICT,
    order_id             INTEGER REFERENCES orders(id) ON DELETE RESTRICT,
    ordered_supplier_id  INTEGER REFERENCES suppliers(id) ON DELETE RESTRICT,
    ordered_qty          INTEGER,
    ordered_total_idr    INTEGER,
    ordered_at           TEXT,
    notes                TEXT NOT NULL DEFAULT '',
    rev                  INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    UNIQUE (project_id, part_id),
    CHECK (status <> 'ordered' OR (ordered_supplier_id IS NOT NULL AND ordered_qty IS NOT NULL AND ordered_total_idr IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_needs_project ON needs(project_id, status);
CREATE INDEX IF NOT EXISTS ix_needs_part    ON needs(part_id, status);

CREATE TABLE IF NOT EXISTS quotes (
    id                   INTEGER PRIMARY KEY,
    part_id              INTEGER NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
    supplier_id          INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    seller               TEXT NOT NULL DEFAULT '',
    unit_price_idr       INTEGER NOT NULL CHECK (unit_price_idr >= 0),
    moq                  INTEGER NOT NULL DEFAULT 1 CHECK (moq >= 1),
    price_breaks_json    TEXT,
    listing_shipping_idr INTEGER NOT NULL DEFAULT 0 CHECK (listing_shipping_idr >= 0),
    lead_days            INTEGER,
    risk                 TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
    url                  TEXT NOT NULL DEFAULT '',
    notes                TEXT NOT NULL DEFAULT '',
    quoted_at            TEXT NOT NULL,
    UNIQUE (part_id, supplier_id)
);
