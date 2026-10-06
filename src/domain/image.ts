/**
 * Part images (docs/part-images.md). Pure decisions only: which LCSC image to use, which hosts the Worker may
 * fetch for the browser, and whether uploaded bytes really are a small image. No I/O.
 *
 * LCSC's detail response field names for images are NOT yet verified from a Worker (egress to wmsc.lcsc.com is
 * unverified, docs/spec-enrichment.md section 11), so `firstImageUrl` accepts the shapes seen in the wild and
 * returns null for anything else rather than guessing.
 */

/** Largest stored image, in bytes. A 128 px WebP is 3-6 KB; this ceiling only stops a mistake becoming a big row. */
export const MAX_IMAGE_BYTES = 24 * 1024;
/** Longest side of the stored image, in pixels. The browser downscales to this before uploading. */
export const IMAGE_MAX_SIDE = 128;

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
 * LCSC image paths carry the size as a folder (`/900x900/`). Try the small variant first and the original second,
 * so a size LCSC does not publish costs one extra request instead of a missing image. The first candidate is the
 * cheapest to transfer; the browser downscales either way.
 */
export function imageCandidates(url: string): string[] {
  const small = url.replace(/\/(\d{2,4})x\1\//, '/224x224/');
  return small === url ? [url] : [small, url];
}

/** What kind of image these bytes are, by their magic numbers (never by the claimed content type). */
export function sniffImage(b: Uint8Array): 'image/webp' | 'image/jpeg' | 'image/png' | null {
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}
