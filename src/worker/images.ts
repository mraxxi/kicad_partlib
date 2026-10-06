import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_IMAGE_BYTES, imageCandidates, isAllowedImageUrl, sniffImage } from '../domain/image';
import type { AppEnv, Vars } from './env';
import { fetchLcsc, type LcscFetcher } from './lcsc';
import { validate as zValidator } from './validate';

/**
 * Part images (docs/part-images.md). LCSC publishes each picture at several sizes, so the Worker simply downloads
 * the 900x900 one (about 60 KB) and stores the bytes as they are: nothing is decoded or resized, which keeps
 * a request far under the 10 ms CPU limit.
 *   POST /images/fetch  asks LCSC for each part's FIRST image and stores it (the only write; one row per part, a
 *                       repeat replaces it, so retrying is harmless)
 *   GET  /parts/:id/image serves it with an ETag, so a revisit costs a 304
 *   GET  /images/pending  lists what is still missing (reads only)
 */
const id = z.coerce.number().int().positive();
// Each part costs 2 subrequests (LCSC's record, then the picture); 50 is the limit per request, so 10 parts is 20.
const MAX_PARTS = 10;
const CONCURRENCY = 3;
export type ImageFetcher = (url: string) => Promise<Response>;
const defaultImageFetch: ImageFetcher = (url) => fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (kicad_partlib)' }, signal: AbortSignal.timeout(8000) });

type Outcome = { partId: number; status: 'stored' | 'no_c_number' | 'not_listed' | 'no_image' | 'error'; bytes?: number; message?: string };

export function imageRoutes(deps: { lcscFetch?: LcscFetcher; imageFetch?: ImageFetcher } = {}) {
  const lcscFetch = deps.lcscFetch ?? fetchLcsc;
  const imageFetch = deps.imageFetch ?? defaultImageFetch;
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

  // Parts with a C-number and no image yet, or only a smaller one (96 or 224 px looked blurry; this re-fetches it at 900x900).
  // The part scan is bounded by LIMIT; the image check is a primary-key probe.
  r.get('/images/pending', async (c) => {
    const parts = await c.get('meter').all<{ id: number; lcsc_code: string }>(c.env.DB.prepare(
      `SELECT p.id, p.lcsc_code FROM parts p WHERE p.lcsc_code IS NOT NULL AND p.lcsc_code <> ''
          AND NOT EXISTS (SELECT 1 FROM part_images i WHERE i.part_id = p.id AND i.src_url LIKE '%/900x900/%') ORDER BY p.id LIMIT 500`));
    return c.json({ parts: parts.map((p) => ({ partId: p.id, code: p.lcsc_code })) });
  });

  async function smallestImage(url: string): Promise<{ bytes: Uint8Array; url: string } | string> {
    let why = 'LCSC did not return an image for this part.';
    for (const candidate of imageCandidates(url)) {
      let res: Response;
      try { res = await imageFetch(candidate); } catch { why = 'Could not reach LCSC’s image server.'; continue; }
      const len = Number(res.headers.get('content-length') ?? 0);
      if (!res.ok || len > MAX_IMAGE_BYTES) { await res.body?.cancel(); continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES && sniffImage(bytes)) return { bytes, url: candidate };
    }
    return why;
  }

  r.post('/images/fetch', zValidator('json', z.object({ partIds: z.array(z.number().int().positive()).min(1).max(MAX_PARTS) })), async (c) => {
    const meter = c.get('meter');
    const parts = await meter.all<{ id: number; lcsc_code: string | null }>(
      c.env.DB.prepare('SELECT id, lcsc_code FROM parts WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(c.req.valid('json').partIds)));
    const at = new Date().toISOString();
    const one = async (p: { id: number; lcsc_code: string | null }): Promise<Outcome> => {
      if (!p.lcsc_code) return { partId: p.id, status: 'no_c_number' };
      const rec = await lcscFetch(p.lcsc_code);
      if (rec.status === 'error') return { partId: p.id, status: 'error', message: rec.message };
      if (rec.status === 'not_listed') return { partId: p.id, status: 'not_listed' };
      if (!rec.detail.image || !isAllowedImageUrl(rec.detail.image)) return { partId: p.id, status: 'no_image' };
      const got = await smallestImage(rec.detail.image);
      if (typeof got === 'string') return { partId: p.id, status: 'error', message: got };
      const mime = sniffImage(got.bytes)!;
      meter.add(await c.env.DB.prepare(
        `INSERT INTO part_images(part_id, mime, bytes, src_url, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(part_id) DO UPDATE SET mime = ?2, bytes = ?3, src_url = ?4, fetched_at = ?5`,
      ).bind(p.id, mime, got.bytes, got.url, at).run());
      return { partId: p.id, status: 'stored', bytes: got.bytes.length };
    };
    const results: Outcome[] = [];
    for (let i = 0; i < parts.length; i += CONCURRENCY) results.push(...(await Promise.all(parts.slice(i, i + CONCURRENCY).map(one))));
    return c.json({ results });
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
