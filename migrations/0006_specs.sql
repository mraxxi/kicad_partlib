-- --------------------------------------------------------------------------
-- 0006_specs -- per-part specs and the raw LCSC snapshot (docs/spec-enrichment.md).
--
--  * parts.specs: JSON `{v, family, title?, props:{key:{n|min,max|text, unit, raw, cond?, count?, src}}}`.
--    NULL = never enriched. Numbers are SI base units, kept IN the JSON because filtering and sorting happen in
--    the browser (AGENTS.md rule 9, revised): no extra rows to read, nothing to keep in step.
--    `src` is manual | lcsc | description; a manual value is never overwritten.
--  * part_enrichment: the trimmed raw LCSC response for a part, in its own table so list queries never read it
--    and so a new family can be mapped later from stored data without refetching. status is ok | not_listed
--    (LCSC no longer sells it) | error. One row per part; refetching replaces it.
--
-- ALTER TABLE ADD COLUMN is not idempotent; acceptable because wrangler applies a migration once, atomically.
-- --------------------------------------------------------------------------
ALTER TABLE parts ADD COLUMN specs TEXT;

CREATE TABLE IF NOT EXISTS part_enrichment (
    part_id        INTEGER PRIMARY KEY REFERENCES parts(id) ON DELETE RESTRICT,
    source         TEXT NOT NULL DEFAULT 'lcsc',
    status         TEXT NOT NULL CHECK (status IN ('ok', 'not_listed', 'error')),
    schema_version INTEGER NOT NULL DEFAULT 1,
    fetched_at     TEXT NOT NULL,
    raw_json       TEXT
);
