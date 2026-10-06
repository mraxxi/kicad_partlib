/**
 * Part images (docs/part-images.md). Pure decisions only: which LCSC image to use, which size, which hosts the Worker
 * may fetch, and whether fetched bytes really are a small image. No I/O.
 *
 * LCSC's detail response carries `productImages`, a list of URLs (front, back, ...); verified 2026-10-06. Other
 * shapes are accepted defensively; anything else returns null rather than a guess.
 */

/** Largest stored image, in bytes. LCSC's own 900x900 JPEG is about 60 KB (224x224 about 10 KB); this only stops a mistake becoming a big row. */
export const MAX_IMAGE_BYTES = 160 * 1024;

const HOSTS = new Set(['assets.lcsc.com']);

/** Only https URLs on LCSC's own image host: the proxy must never become a way to make the Worker fetch anything. */
export function isAllowedImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && HOSTS.has(u.hostname) && u.port === '' && u.username === '' && u.password === '';
  } catch { return false; }
}

const asUrl = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v : v && typeof v === 'object' ? ((v as Record<string, unknown>).url ?? (v as Record<string, unknown>).imageUrl) : null;
  if (typeof s !== 'string') return null;
  const full = s.startsWith('//') ? `https:${s}` : s;
  return isAllowedImageUrl(full) ? full : null;
};

/** LCSC's FIRST product image (the owner asked for the first only). Null when the response carries none we trust. */
export function firstImageUrl(result: unknown): string | null {
  const r = (result ?? {}) as Record<string, unknown>;
  for (const key of ['productImages', 'productImageList', 'productImagesList']) {
    const list = r[key];
    if (Array.isArray(list)) {
      return asUrl(list[0]); // the FIRST image only: if it is not on LCSC's host there is no image, not "the next one"
    }
  }
  for (const key of ['productImageUrl', 'productImage', 'imageUrl']) { const u = asUrl(r[key]); if (u) return u; }
  return null;
}

/**
 * LCSC serves every image at three sizes, the size being a folder in the path: 96x96 (about 3 KB), 224x224 (10 KB) and
 * 900x900 (60 KB), all JPEG; every other folder answers 403 (verified 2026-10-06). The part is small in LCSC's photo
 * (a quarter of the frame, on a ruler grid), so 96 and 224 look blurry at any display size. We therefore store the
 * 900x900 as it is (no resizing anywhere) and let the browser shrink it, which is sharp. 224x224 is the fallback if
 * the 900 is missing or too big to keep.
 */
export function imageCandidates(url: string): string[] {
  const m = /\/(\d{2,4})x\1\//.exec(url);
  if (!m) return [url];
  return ['900x900', '224x224'].map((s) => url.replace(m[0], `/${s}/`));
}

/** What kind of image these bytes are, by their magic numbers (never by the claimed content type). */
export function sniffImage(b: Uint8Array): 'image/webp' | 'image/jpeg' | 'image/png' | null {
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}
