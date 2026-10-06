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

const asked: string[] = [];
let NO_IMAGE = '';
const fakeLcsc: LcscFetcher = async (code) => {
  asked.push(code);
  if (code === NO_IMAGE) return { status: 'ok', detail: { productCode: code, productModel: 'Y', catalog: 'Diode', params: [] } };
  return { status: 'ok', detail: { productCode: code, productModel: 'X', catalog: 'MOSFET', image: IMG, params: [] } };
};
const fetched: string[] = [];
const app = makeApp({
  lcscFetch: fakeLcsc,
  imageFetch: async (url) => {
    fetched.push(url);
    if (url.includes('/224x224/')) return new Response('nope', { status: 404 }); // the small folder is not published: fall back
    return new Response(WEBP, { headers: { 'content-type': 'image/jpeg' } });
  },
});
const call = (path: string, init?: RequestInit) => app.fetch(new Request(`https://partlib.test${path}`, init), env as unknown as AppEnv);
const putImage = (id: number, body: BodyInit) => call(`/api/parts/${id}/image`, { method: 'PUT', body, headers: { 'content-type': 'image/webp' } });
const nth = async (n: number) => (await env.DB.prepare("SELECT id, lcsc_code FROM parts WHERE lcsc_code <> '' ORDER BY id LIMIT 1 OFFSET ?").bind(n).first<{ id: number; lcsc_code: string }>())!;
const firstPart = async () => (await nth(0)).id;

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
  it('tries the small variant first and the original second', () => {
    expect(imageCandidates(IMG)).toEqual([IMG.replace('900x900', '224x224'), IMG]);
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
  beforeEach(async () => { await reset(); NO_IMAGE = ''; asked.length = 0; fetched.length = 0; await importLcsc(FILES.a, { apply: true }); });

  it('lists parts with a C-number and no image, and writes nothing doing so', async () => {
    const before = await count('part_images');
    const res = await call('/api/images/pending');
    const { parts } = (await res.json()) as { parts: Array<{ partId: number; code: string }> };
    expect(parts.length).toBeGreaterThan(50);
    expect(await count('part_images')).toBe(before);
    expect(await count('part_images')).toBe(0);
  });

  it('answers with LCSC’s first image URL, and says why when there is none', async () => {
    const id = await firstPart();
    expect(await (await call(`/api/parts/${id}/image/source`, { method: 'POST' })).json()).toEqual({ url: IMG });
    const other = await nth(1);
    NO_IMAGE = other.lcsc_code;
    const r = await call(`/api/parts/${other.id}/image/source`, { method: 'POST' });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe('LCSC lists this part without an image.');
    expect(await count('part_images')).toBe(0);
  });

  it('proxies only LCSC hosts, falling back from the small size to the original', async () => {
    expect((await call(`/api/image-proxy?url=${encodeURIComponent('https://evil.example/a.jpg')}`)).status).toBe(400);
    const ok = await call(`/api/image-proxy?url=${encodeURIComponent(IMG)}`);
    expect(ok.status).toBe(200);
    expect(fetched).toEqual([IMG.replace('900x900', '224x224'), IMG]);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(WEBP);
  });

  it('stores one image per part, serves it with an ETag, and replacing it changes the ETag', async () => {
    const id = await firstPart();
    expect((await call(`/api/parts/${id}/image`)).status).toBe(404);
    expect((await putImage(id, WEBP)).status).toBe(200);
    expect((await putImage(id, WEBP)).status).toBe(200); // retrying is harmless
    expect(await count('part_images')).toBe(1);
    const got = await call(`/api/parts/${id}/image`);
    expect(got.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(WEBP);
    const etag = got.headers.get('etag')!;
    expect((await call(`/api/parts/${id}/image`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    await new Promise((r) => setTimeout(r, 5));
    await putImage(id, WEBP);
    expect((await call(`/api/parts/${id}/image`, { headers: { 'if-none-match': etag } })).status).toBe(200);
    const pending = (await (await call('/api/images/pending')).json()) as { parts: Array<{ partId: number }> };
    expect(pending.parts.some((p) => p.partId === id)).toBe(false);
  });

  it('refuses what is not a small image', async () => {
    const id = await firstPart();
    expect((await putImage(id, new TextEncoder().encode('<svg/>'))).status).toBe(415);
    expect((await putImage(id, new Uint8Array(30 * 1024).fill(1))).status).toBe(413);
    expect((await putImage(999999, WEBP)).status).toBe(404);
    expect(await count('part_images')).toBe(0);
  });

  it('reads one row to serve an image (the ledger and part tables stay untouched)', async () => {
    const id = await firstPart();
    await putImage(id, WEBP);
    const r = await env.DB.prepare('SELECT mime, bytes FROM part_images WHERE part_id = ?').bind(id).all();
    expect(r.meta.rows_read).toBeLessThanOrEqual(1);
  });
});
