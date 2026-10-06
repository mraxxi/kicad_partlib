-- --------------------------------------------------------------------------
-- 0007_part_images -- one small thumbnail per part (docs/part-images.md).
--
-- Its own table, keyed by the part, so no list query ever reads image bytes (a parts page reads parts, lots and
-- categories only). The bytes are a ~3-6 KB WebP the BROWSER downscaled; the Worker never decodes an image (10 ms CPU).
-- INTEGER PRIMARY KEY is the rowid, so there is no secondary index: one insert writes one row.
-- fetched_at doubles as the ETag. src_url records where it came from (LCSC's first image).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS part_images (
    part_id    INTEGER PRIMARY KEY REFERENCES parts(id) ON DELETE CASCADE,
    mime       TEXT NOT NULL CHECK (mime IN ('image/webp', 'image/jpeg', 'image/png')),
    bytes      BLOB NOT NULL,
    src_url    TEXT,
    fetched_at TEXT NOT NULL
);
