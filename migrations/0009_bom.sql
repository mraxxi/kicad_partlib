-- --------------------------------------------------------------------------
-- 0009_bom -- Phase 4: a KiCad BOM stored against a project.
--
--  * project_bom: the BOM currently loaded for a project (one per project) and how many boards it is
--    for. `sha256` makes importing the same file twice change nothing.
--  * bom_lines: one row per BOM line key (LCSC number, else MPN, else value|footprint). `part_id` is NULL
--    while the line is "to identify": a placeholder that is a BOM line, deliberately NOT a fake parts row
--    (a fake part would appear in Parts, Enrich and stock, and turning it into the real part would need a
--    merge, which the app refuses). `link_rule` records how the link was made so a wrong one is visible;
--    'manual' links are never replaced by a re-import. `fields_json` keeps the raw BOM row, nothing lost.
--  * Needs made from a BOM are ordinary needs rows; no change to parts, needs or stock_moves.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_bom (
    project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
    boards      INTEGER NOT NULL DEFAULT 1 CHECK (boards >= 1),
    file_name   TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bom_lines (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    line_key    TEXT NOT NULL,
    refs        TEXT NOT NULL DEFAULT '',
    qty         INTEGER NOT NULL CHECK (qty > 0),
    value       TEXT NOT NULL DEFAULT '',
    footprint   TEXT NOT NULL DEFAULT '',
    fields_json TEXT NOT NULL DEFAULT '{}',
    part_id     INTEGER REFERENCES parts(id) ON DELETE RESTRICT,
    link_rule   TEXT CHECK (link_rule IS NULL OR link_rule IN ('lcsc', 'mpn', 'remembered', 'manual')),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dnp', 'ignored', 'removed')),
    rev         INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, line_key)
);
CREATE INDEX IF NOT EXISTS ix_bom_lines_key  ON bom_lines(line_key) WHERE part_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_bom_lines_part ON bom_lines(part_id) WHERE part_id IS NOT NULL;

INSERT OR IGNORE INTO settings(key, value) VALUES
    ('bom.fields', '{"lcsc":["LCSC","LCSC#","LCSC Part","LCSC Part #","LCSC Part Number","JLCPCB Part","JLCPCB Part #"],"mpn":["MPN","MP","Manufacturer Part Number","Manufacturer_Part_Number","Mfr Part","MFR_PN"],"manufacturer":["Manufacturer","MF","MFR","Mfr","Manufacturer_Name"]}');
