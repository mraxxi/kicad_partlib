# Part images

Status: **built, not deployed. Migration `0007` is applied nowhere yet.** Read `AGENTS.md` first.

## What the owner asked for

A picture of the part beside the parts table (the side panel) and on the full part page. LCSC's **first** image only,
as small as it can be while still looking right, and cheap enough that the Workers Free plan survives a much larger
collection.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where is the image fetched? | The Worker asks LCSC for the part's record (the call enrichment already makes) to learn the first image URL, then streams that image to the browser through `/api/image-proxy`. | LCSC's image host sends no CORS headers, so the browser cannot read it directly. Streaming bytes costs the Worker almost no CPU. |
| Who downscales? | **The browser** (`createImageBitmap` + `OffscreenCanvas`) to at most 128 px on the long side, WebP at quality 0.6 (JPEG where WebP encoding is missing). About 3-6 KB. | A Worker has 10 ms of CPU and cannot decode an image. Cloudflare Images/Resizing is not part of the free plan. |
| Which size is downloaded? | The `224x224` variant of LCSC's URL first, the original second. | Less to transfer; the original is the fallback if LCSC does not publish that folder. |
| Where is it stored? | `part_images` in D1: one row per part, bytes as a BLOB, `fetched_at` as the ETag. Not R2. | D1 is the only store (AGENTS.md); R2 needs a payment method on file. 5 KB x 10,000 parts = 50 MB of D1's 5 GB. |
| Does it slow the parts list? | No. Image bytes live in their own table and are never read by a list query. The table does not show thumbnails (that would be one request per visible row); the side panel and part page do. | Keeps the list at 4 rows read per part. |
| Which part gets one? | Parts with a C-number. Others show nothing. A part can be re-fetched from its page. | Nothing else identifies LCSC's picture. |

## Cost (Workers Free, per day)

| Action | Worker requests | Subrequests | D1 rows written | D1 rows read |
|---|---|---|---|---|
| Fetch one image (once per part) | 3 (source, proxy, store) | 2-3 | 1 (no secondary index) | 1-2 |
| Fetch 500 images (one button press) | 1,500 | 1,500 total, never more than 3 in one request | 500 | about 1,500 |
| Open a part with an image | 1 (a 304 on revisit) | 0 | 0 | 1 |
| Open a part with no image | 1 | 0 | 0 | 0 |

At 10,000 parts the one-off backfill is about 30,000 Worker requests and 10,000 rows written, so do it in a few
sittings (30% of the request budget and 10% of the write budget in one day, shared with the other Workers on the account). Storage stays about
1% of D1's limit. Per-request CPU is the streaming of a few KB and a single-row query, well under 10 ms.

## API

* `GET /api/images/pending`: parts with a C-number and no image (at most 500). Reads only.
* `POST /api/parts/:id/image/source`: LCSC's first image URL. Writes nothing.
* `GET /api/image-proxy?url=`: streams one image, only for `https://assets.lcsc.com/...`, at most 2 MB.
* `PUT /api/parts/:id/image`: stores the downscaled bytes (at most 24 KB, WebP/JPEG/PNG by magic number, never by claimed type). Idempotent: one image per part, a repeat replaces it.
* `GET /api/parts/:id/image`: the image with an `ETag` and `no-cache`, so a revisit is a 304.

The browser side is `src/web/partImage.ts`; the bulk button is on the Enrich page; a single-part button appears on a part
with no image.

## Not verified yet (read before deploying)

1. **LCSC's image field name.** I could not call `wmsc.lcsc.com` from the build environment (egress blocked). `firstImageUrl`
   accepts `productImages` (list of strings or `{url}`), `productImageList`, `productImagesList` and a single
   `productImageUrl`/`productImage`/`imageUrl`, and returns nothing for anything else. If the real field differs, the UI says
   "LCSC lists this part without an image." Check one real response and adjust the one function.
2. **The `224x224` folder.** A guess from LCSC's `/900x900/` URL layout; if it 404s the proxy falls back to the original.
3. **Worker egress to LCSC** (already open in `docs/spec-enrichment.md`) and to `assets.lcsc.com`.
4. **Browser WebP encoding.** Chrome and Firefox encode WebP; Safari falls back to JPEG, which is larger (maybe 5-8 KB).

Safest first step after deploy: open one part, press "Fetch image", and look at the response size.

## Deliberately left out

Thumbnails in the table rows (one request per visible row; revisit if the owner wants it, using a combined sprite endpoint),
more than one image per part, images for parts without a C-number (a manual upload would reuse `PUT`), and remembering that
LCSC has no image for a part (such parts are retried on each bulk run, two subrequests each).
