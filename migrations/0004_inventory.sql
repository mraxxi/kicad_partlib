-- --------------------------------------------------------------------------
-- 0004_inventory -- what Phase 2 (inventory UI) needs beyond 0002.
--
--  * parts.min_qty: the reorder threshold is a property of the PART (the sheet's
--    "Min Qty"), compared against usable stock summed over its lots.
--  * lots.create_key: a client-generated idempotency key for a lot created by a
--    request the browser may retry (split, harvest, manual add). UNIQUE, and
--    inserted with INSERT OR IGNORE, so a retry after a timeout cannot create a
--    second lot. Import lots leave it NULL (their key is the order line).
--  * ix_parts_min: reorder queries must read only the parts that HAVE a
--    threshold, not scan every part.
--
-- ALTER TABLE ADD COLUMN is not idempotent. That is acceptable here only because
-- wrangler applies a migration atomically and records it in d1_migrations, so it
-- cannot run twice or half-way.
-- --------------------------------------------------------------------------
ALTER TABLE parts ADD COLUMN min_qty INTEGER CHECK (min_qty IS NULL OR min_qty >= 0);
ALTER TABLE lots  ADD COLUMN create_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_lots_create_key ON lots(create_key) WHERE create_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_parts_min ON parts(min_qty) WHERE min_qty IS NOT NULL;
