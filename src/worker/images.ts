import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_IMAGE_BYTES, imageCandidates, isAllowedImageUrl, sniffImage } from '../domain/image';
import type { AppEnv, Vars } from './env';
import { fetchLcsc, type LcscFetcher } from './lcsc';
import { validate as zValidator } from './validate';

/**
 * Part images (docs/part-images.md). The Worker only ferries bytes; it never decodes or resizes an image (10 ms CPU).
 *   source  -> asks LCSC for the part's first image URL      (writes nothing)
 *   proxy   -> streams LCSC's image to the browser            (LCSC's image host sends no CORS headers, so the
 *                                                              browser cannot read it directly to downscale it)
 *   PUT     -> stores the small image the browser made        (the only write; idempotent: a part has one image)
 *   GET     -> serves it with an ETag, so a revisit costs a 304
 */
const id = z.coerce.number().int().positive();
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export type ImageFetcher = (url: string) => Promise<Response>;
const defaultImageFetch: ImageFetcher = (url) => fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (kicad_partlib)' }, signal: AbortSignal.timeout(8000) });

export function imageRoutes(deps: { lcscFetch?: LcscFetcher; imageFetch?: ImageFetcher } = {}) {
  const lcscFetch = deps.lcscFetch ?? fetchLcsc;
  const imageFetch = deps.imageFetch ?? defaultImageFetch;
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

  // Parts that have a C-number and no image yet: what "fetch images" should visit. Index-backed: the part table scan
  // is bounded by LIMIT and the image lookup is a primary-key probe.
  r.get('/images/pending', async (c) => {
    const parts = await c.get('meter').all<{ id: number; lcsc_code: string }>(c.env.DB.prepare(
      `SELECT p.id, p.lcsc_code FROM parts p WHERE p.lcsc_code IS NOT NULL AND p.lcsc_code <> ''
          AND NOT EXISTS (SELECT 1 FROM part_images i WHERE i.part_id = p.id) ORDER BY p.id LIMIT 500`));
    return c.json({ parts: parts.map((p) => ({ partId: p.id, code: p.lcsc_code })) });
  });

  r.post('/parts/:id/image/source', zValidator('param', z.object({ id })), async (c) => {
    const row = (await c.get('meter').all<{ lcsc_code: string | null }>(c.env.DB.prepare('SELECT lcsc_code FROM parts WHERE id = ?').bind(c.req.valid('param').id)))[0];
    if (!row) return c.json({ error: 'That part does not exist.' }, 404);
    if (!row.lcsc_code) return c.json({ error: 'This part has no LCSC part number, so there is no LCSC image to fetch.' }, 422);
    const res = await lcscFetch(row.lcsc_code);
    if (res.status === 'error') return c.json({ error: res.message }, 502);
    if (res.status === 'not_listed') return c.json({ error: 'LCSC no longer lists this part, so it has no image to fetch.' }, 404);
    if (!res.detail.image) return c.json({ error: 'LCSC lists this part without an image.' }, 404);
    return c.json({ url: res.detail.image });
  });

  r.get('/image-proxy', zValidator('query', z.object({ url: z.string().max(500) })), async (c) => {
    const url = c.req.valid('query').url;
    if (!isAllowedImageUrl(url)) return c.json({ error: 'Only images on LCSC’s own image host can be fetched.' }, 400);
    for (const candidate of imageCandidates(url)) {
      let res: Response;
      try { res = await imageFetch(candidate); } catch { continue; }
      const type = res.headers.get('content-type') ?? '';
      const len = Number(res.headers.get('content-length') ?? 0);
      if (!res.ok || !type.startsWith('image/') || len > MAX_SOURCE_BYTES) { await res.body?.cancel(); continue; }
      return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' } });
    }
    return c.json({ error: 'LCSC did not return an image for this part.' }, 502);
  });

  r.put('/parts/:id/image', zValidator('param', z.object({ id })), zValidator('query', z.object({ src: z.string().max(500).optional() })), async (c) => {
    const partId = c.req.valid('param').id;
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return c.json({ error: `A part image must be between 1 byte and ${MAX_IMAGE_BYTES / 1024} KB; downscale it first.` }, 413);
    const mime = sniffImage(bytes);
    if (!mime) return c.json({ error: 'That is not a WebP, JPEG or PNG image.' }, 415);
    const src = c.req.valid('query').src;
    const meter = c.get('meter');
    const exists = (await meter.all<{ id: number }>(c.env.DB.prepare('SELECT id FROM parts WHERE id = ?').bind(partId)))[0];
    if (!exists) return c.json({ error: 'That part does not exist.' }, 404);
    const at = new Date().toISOString();
    const w = await c.env.DB.prepare(
      `INSERT INTO part_images(part_id, mime, bytes, src_url, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(part_id) DO UPDATE SET mime = ?2, bytes = ?3, src_url = ?4, fetched_at = ?5`,
    ).bind(partId, mime, bytes, src && isAllowedImageUrl(src) ? src : null, at).run();
    meter.add(w);
    return c.json({ ok: true, bytes: bytes.length, version: at });
  });

  r.get('/parts/:id/image', zValidator('param', z.object({ id })), async (c) => {
    const row = (await c.get('meter').all<{ mime: string; bytes: ArrayBuffer; fetched_at: string }>(
      c.env.DB.prepare('SELECT mime, bytes, fetched_at FROM part_images WHERE part_id = ?').bind(c.req.valid('param').id)))[0];
    if (!row) return c.json({ error: 'This part has no image yet.' }, 404);
    const etag = `"${row.fetched_at}"`;
    const headers = { etag, 'cache-control': 'private, no-cache' };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(row.bytes as ArrayBuffer), { headers: { ...headers, 'content-type': row.mime } });
  });

  return r;
}
