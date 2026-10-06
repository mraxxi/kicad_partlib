# Part images

Status: **built, not deployed. Migration `0007` is applied nowhere yet.** Read `AGENTS.md` first.

## What the owner asked for

A picture of the part beside the parts table (the side panel) and on the full part page. LCSC's **first** image only,
as small as it can be while still looking right, and cheap enough that the Workers Free plan survives a much larger
collection.

## The finding that shaped it (verified 2026-10-06 against a real response)

LCSC's part record (`productImages`, the same call enrichment makes) lists the pictures (front, back, ...), and the same file
exists at several sizes, the size being a folder in the URL. For C269266:

| Folder | Size | Format |
|---|---|---|
| `/96x96/` | **2.9 KB** | JPEG, 96x96 |
| `/224x224/` | 9.5 KB | JPEG, 224x224 |
| `/900x900/` (what the record lists) | 63.5 KB | JPEG, 900x900 |

So **nothing has to be resized**. The Worker downloads the 96x96 file and stores the bytes as they are. An earlier draft of this
branch had the browser downscale a larger image; that is gone because it was more code, more requests and a bigger image.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where is it fetched? | The Worker: LCSC's record (1 subrequest), then the 96x96 picture (1 subrequest). Host must be `assets.lcsc.com`. | No CORS problem, no browser round trip, no proxy route. |
| Which size? | 96x96, falling back to 224x224 if 96 is missing; the 900x900 original is never kept (cap 24 KB). | Smallest that still reads as a part. Shown at 96 CSS px in the side panel and on the part page. |
| Resizing? | None. Bytes are checked by magic number (JPEG/PNG/WebP) and stored untouched. | A Worker has 10 ms of CPU and cannot decode an image; it does not need to. |
| Where is it stored? | `part_images` in D1: one row per part, BLOB, `fetched_at` as the ETag, `src_url` for provenance. Not R2. | D1 is the only store (AGENTS.md); R2 needs a payment method. 3 KB x 10,000 parts = 30 MB of D1's 5 GB. |
| Does it slow the parts list? | No. Bytes live in their own table that no list query reads. The table rows do not show thumbnails (one request per visible row). | Keeps the list at 4 rows read per part. |
| Which parts? | Those with a C-number. Others show nothing. | Nothing else identifies LCSC's picture. |

## Cost (Workers Free, per day)

| Action | Worker requests | Subrequests | D1 rows written | D1 rows read |
|---|---|---|---|---|
| Fetch images for up to 10 parts (one call) | 1 | 20 | 10 (no secondary index) | about 11 |
| Backfill 10,000 parts | 1,000 | 20,000 | 10,000 | about 11,000 |
| Open a part with an image | 1 (a 304 on revisit) | 0 | 0 | 1 |
| Open a part with no image | 1 | 0 | 0 | 0 |

The backfill is 1% of the daily request budget and 10% of the write budget, so even 10,000 parts fit in one sitting (the other Workers on the account share these).
Per-request CPU is moving about 30 KB of bytes plus ten single-row writes, well under 10 ms.

## API

* `GET /api/images/pending`: parts with a C-number and no image (at most 500). Reads only.
* `POST /api/images/fetch {partIds}` (at most 10): fetch and store. Per part: `stored`, `no_c_number`, `not_listed`, `no_image`, or `error` with a sentence. Idempotent: one image per part, a repeat replaces it.
* `GET /api/parts/:id/image`: the image with an `ETag` and `no-cache`, so a revisit is a 304.

UI: `PartImage` in `PartDetail.tsx` (so it appears in the side panel and on the part page; a part without an image shows a "Fetch image" button when it has a C-number); "Fetch part images" on the Enrich page.

## Still unverified

1. **Worker egress.** The fetch ran from a plain HTTP client, not from a deployed Worker. Whether Cloudflare's network can call `wmsc.lcsc.com` and
   `assets.lcsc.com` is the same open question as spec enrichment; settle both with one deploy to staging.
2. **Other LCSC categories.** Only C269266 was inspected. A part with no `productImages` answers "LCSC lists this part without an image."

## Deliberately left out

Thumbnails in the table rows (revisit if wanted, via one sprite endpoint), more than one image per part, images for parts without a C-number
(a manual upload would be a small `PUT`), and remembering that LCSC has no image for a part (such parts are retried on each bulk run).
