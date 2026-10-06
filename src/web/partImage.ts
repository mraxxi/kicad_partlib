import { IMAGE_MAX_SIDE } from '../domain/image';
import { ApiError, api } from './api';

/**
 * Fetch LCSC's first image for a part, shrink it HERE (the Worker has 10 ms of CPU and never decodes images), and
 * store the result. Returns the stored size in bytes. Throws ApiError with a sentence the UI can show as-is.
 */
export async function fetchPartImage(partId: number): Promise<number> {
  const { url } = await api<{ url: string }>(`/parts/${partId}/image/source`, { method: 'POST' });
  const res = await fetch(`/api/image-proxy?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new ApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The server answered ${res.status}.`, res.status);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(await res.blob()); } catch { throw new ApiError('The image LCSC sent could not be read.', 0); }
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // LCSC photos are on white; flatten any transparency onto it
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  // WebP where the browser can encode it (about 3-6 KB at this size), JPEG otherwise.
  let out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.6 });
  if (out.type !== 'image/webp') out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
  const put = await fetch(`/api/parts/${partId}/image?src=${encodeURIComponent(url)}`, { method: 'PUT', body: out });
  const json = (await put.json().catch(() => ({}))) as { error?: string; bytes?: number };
  if (!put.ok) throw new ApiError(json.error ?? `The server answered ${put.status}.`, put.status);
  return json.bytes ?? out.size;
}
