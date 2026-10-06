import { trimLcscResponse, type LcscDetail } from '../domain/specs';

export type LcscResult = { status: 'ok'; detail: LcscDetail } | { status: 'not_listed' } | { status: 'error'; message: string };
export type LcscFetcher = (code: string) => Promise<LcscResult>;

const DETAIL = 'https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=';

/**
 * Ask LCSC for one part. An undocumented endpoint (docs/spec-enrichment.md), so every failure is a value, never a
 * throw: a part LCSC no longer lists is `not_listed`, anything else wrong is `error` with a short reason that
 * never contains a URL or response body. Timeout 8 s; one attempt (the caller decides whether to retry).
 */
export const fetchLcsc: LcscFetcher = async (code) => {
  if (!/^C\d+$/.test(code)) return { status: 'error', message: `"${code}" is not an LCSC part number.` };
  try {
    const res = await fetch(DETAIL + code, { headers: { 'user-agent': 'Mozilla/5.0 (kicad_partlib)' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { status: 'error', message: `LCSC answered HTTP ${res.status}.` };
    const detail = trimLcscResponse(await res.json());
    return detail ? { status: 'ok', detail } : { status: 'not_listed' };
  } catch (e) {
    return { status: 'error', message: e instanceof Error && e.name === 'TimeoutError' ? 'LCSC did not answer in time.' : 'Could not reach LCSC.' };
  }
};
