import { api } from './api';

/**
 * Ask the server to fetch LCSC's first image for these parts (at most 10 per call; the server stores LCSC's own
 * 96x96 picture as it is). Returns one outcome per part; a refusal is a sentence in `message`.
 */
export interface ImageOutcome { partId: number; status: 'stored' | 'no_c_number' | 'not_listed' | 'no_image' | 'error'; bytes?: number; message?: string }
export const IMAGE_CHUNK = 10;
export const fetchPartImages = (partIds: number[]) => api<{ results: ImageOutcome[] }>('/images/fetch', { body: { partIds } }).then((r) => r.results);

export const IMAGE_STATUS_TEXT: Record<Exclude<ImageOutcome['status'], 'stored' | 'error'>, string> = {
  no_c_number: 'This part has no LCSC part number, so there is no LCSC image to fetch.',
  not_listed: 'LCSC no longer lists this part, so it has no image to fetch.',
  no_image: 'LCSC lists this part without an image.',
};
export const outcomeText = (o: ImageOutcome): string => (o.status === 'error' ? (o.message ?? 'The image could not be fetched.') : o.status === 'stored' ? '' : IMAGE_STATUS_TEXT[o.status]);
