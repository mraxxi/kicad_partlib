import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstImageUrl, imageCandidates, isAllowedImageUrl, sniffImage } from '../src/domain/image';
import { trimLcscResponse } from '../src/domain/specs';
import { makeApp } from '../src/worker/app';
import type { AppEnv } from '../src/worker/env';
import type { LcscFetcher } from '../src/worker/lcsc';
import { FILES, count, importLcsc, reset } from './helpers';

const IMG = 'https://assets.lcsc.com/images/lcsc/900x900/20230101_AON7410_C269266_front.jpg';
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

const asked: string[] = [];
let NO_IMAGE = '';
const fakeLcsc: LcscFetcher = async (code) => {
  asked.push(code);
  if (code === NO_IMAGE) return { status: 'ok', detail: { productCode: code, productModel: 'Y', catalog: 'Diode', params: [] } };
  return { status: 'ok', detail: { productCode: code, productModel: 'X', catalog: 'MOSFET', image: IMG, params: [] } };
};
const fetched: string[] = [];
let smallMissing = false;
const app = makeApp({
  lcscFetch: fakeLcsc,
  imageFetch: async (url) => {
    fetched.push(url);
    if (url.includes('/900x900/') && smallMissing) return new Response('nope', { status: 404 });
    return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
  },
});
const call = (path: string, init?: RequestInit) => app.fetch(new Request(`https://partlib.test${path}`, init), env as unknown as AppEnv);
const post = (partIds: number[]) => call('/api/images/fetch', { method: 'POST', body: JSON.stringify({ partIds }), headers: { 'content-type': 'application/json' } });
const nth = async (n: number) => (await env.DB.prepare("SELECT id, lcsc_code FROM parts WHERE lcsc_code <> '' ORDER BY id LIMIT 1 OFFSET ?").bind(n).first<{ id: number; lcsc_code: string }>())!;

describe('image domain', () => {
  it('takes the first usable LCSC image and nothing else', () => {
    expect(firstImageUrl({ productImages: [IMG, 'https://assets.lcsc.com/other.jpg'] })).toBe(IMG);
    expect(firstImageUrl({ productImages: [{ url: '//assets.lcsc.com/a.jpg' }] })).toBe('https://assets.lcsc.com/a.jpg');
    expect(firstImageUrl({ productImages: ['https://evil.example/a.jpg', IMG] })).toBeNull();
    expect(firstImageUrl({})).toBeNull();
  });
  it('only allows https URLs on the LCSC image host', () => {
    expect(isAllowedImageUrl(IMG)).toBe(true);
    for (const bad of ['http://assets.lcsc.com/a.jpg', 'https://assets.lcsc.com.evil.test/a.jpg', 'https://user@assets.lcsc.com/a.jpg', 'https://assets.lcsc.com:8443/a.jpg', 'nonsense']) expect(isAllowedImageUrl(bad)).toBe(false);
  });
  it('wants LCSC\u2019s 900x900 picture first, then 224x224, and never the 96x96', () => {
    expect(imageCandidates(IMG)).toEqual([IMG, IMG.replace('900x900', '224x224')]);
    expect(imageCandidates('https://assets.lcsc.com/a.jpg')).toEqual(['https://assets.lcsc.com/a.jpg']);
  });
  it('recognises images by their bytes, not their claimed type', () => {
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });
  it('keeps the image URL in the trimmed LCSC record', () => {
    expect(trimLcscResponse({ result: { productCode: 'C1', productImages: [IMG] } })?.image).toBe(IMG);
    expect(trimLcscResponse({ result: { productCode: 'C1' } })?.image).toBeUndefined();
  });
});

describe('part image API', () => {
  beforeEach(async () => { await reset(); NO_IMAGE = ''; smallMissing = false; fetched.length = 0; await importLcsc(FILES.a, { apply: true }); });

  it('lists parts with a C-number and no image, and writes nothing doing so', async () => {
    const { parts } = (await (await call('/api/images/pending')).json()) as { parts: Array<{ partId: number }> };
    expect(parts.length).toBeGreaterThan(50);
    expect(await count('part_images')).toBe(0);
  });

  it('stores LCSC\u2019s 900x900 picture as it is, serves it with an ETag, and a repeat replaces it', async () => {
    const part = await nth(0);
    expect((await call(`/api/parts/${part.id}/image`)).status).toBe(404);
    const r = (await (await post([part.id])).json()) as { results: Array<{ status: string; bytes: number }> };
    expect(r.results).toEqual([{ partId: part.id, status: 'stored', bytes: JPEG.length }]);
    expect(fetched).toEqual([IMG]);
    expect((await post([part.id])).status).toBe(200); // retrying is harmless
    expect(await count('part_images')).toBe(1);
    const got = await call(`/api/parts/${part.id}/image`);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG);
    const etag = got.headers.get('etag')!;
    expect((await call(`/api/parts/${part.id}/image`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    await new Promise((res) => setTimeout(res, 5));
    await post([part.id]);
    expect((await call(`/api/parts/${part.id}/image`, { headers: { 'if-none-match': etag } })).status).toBe(200);
    const pending = (await (await call('/api/images/pending')).json()) as { parts: Array<{ partId: number }> };
    expect(pending.parts.some((p) => p.partId === part.id)).toBe(false);
  });

  it('falls back to 224x224 when the 900x900 is missing', async () => {
    const part = await nth(0);
    smallMissing = true;
    await post([part.id]);
    expect(fetched).toEqual([IMG, IMG.replace('900x900', '224x224')]);
    expect(await count('part_images')).toBe(1);
  });

  it('offers a part again while it only has a smaller picture', async () => {
    const part = await nth(0);
    smallMissing = true;
    await post([part.id]); // stored from the 224x224 fallback
    const ids = async () => ((await (await call('/api/images/pending')).json()) as { parts: Array<{ partId: number }> }).parts.map((p) => p.partId);
    expect(await ids()).toContain(part.id);
    smallMissing = false;
    await post([part.id]);
    expect(await ids()).not.toContain(part.id);
  });

  it('says why a part got no image, and stores nothing for it', async () => {
    const other = await nth(1);
    NO_IMAGE = other.lcsc_code;
    const r = (await (await post([other.id, 999999])).json()) as { results: Array<{ partId: number; status: string }> };
    expect(r.results.map((x) => x.status)).toEqual(['no_image']); // an unknown id is simply not in the answer
    expect(await count('part_images')).toBe(0);
  });

  it('is limited to 10 parts a request, so it stays under the 50-subrequest limit', async () => {
    expect((await post(Array.from({ length: 11 }, (_, i) => i + 1))).status).toBe(400);
  });

  it('reads one row to serve an image', async () => {
    const part = await nth(0);
    await post([part.id]);
    const r = await env.DB.prepare('SELECT mime, bytes FROM part_images WHERE part_id = ?').bind(part.id).all();
    expect(r.meta.rows_read).toBeLessThanOrEqual(1);
  });
});
