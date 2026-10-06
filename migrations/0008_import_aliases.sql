-- --------------------------------------------------------------------------
-- 0008_import_aliases -- a readable name for an order or an import.
--
-- The real LCSC order number (orders.order_no) stays the key that detects a re-import; `alias` is display only and may
-- be NULL, in which case the app computes a default from the order date (src/domain/labels.ts), so existing orders
-- need no backfill. `rev` is the usual optimistic-concurrency counter for a user-editable row. An import run (a cart
-- file has no number at all) gets the same alias + rev.
-- ALTER TABLE ADD COLUMN is not idempotent; acceptable because wrangler applies a migration once, atomically.
-- --------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN alias TEXT;
ALTER TABLE orders ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_runs ADD COLUMN alias TEXT;
ALTER TABLE import_runs ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
