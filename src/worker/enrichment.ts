import { Hono } from 'hono';
import type { AppEnv, Vars } from './env';

/**
 * Routes for spec enrichment (docs/spec-enrichment.md). The first one is a read-only diagnostic: it asks LCSC
 * for three known parts and reports what came back, so "can this Worker reach LCSC at all?" is answered by
 * the deployed Worker rather than assumed. It writes nothing.
 */
const LCSC_DETAIL = 'https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=';

export function enrichmentRoutes() {
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

  r.get('/enrich/lcsc-check', async (c) => {
    const results = [];
    for (const code of ['C269266', 'C468240', 'C5240381']) {
      const t0 = Date.now();
      try {
        const res = await fetch(LCSC_DETAIL + code, { headers: { 'user-agent': 'Mozilla/5.0 (kicad_partlib)' }, signal: AbortSignal.timeout(8000) });
        const text = await res.text();
        let model: string | null = null;
        let params: number | null = null;
        try {
          const j = JSON.parse(text) as { result?: { productModel?: string; paramVOList?: unknown[] } | null };
          model = j.result?.productModel ?? null;
          params = j.result?.paramVOList?.length ?? null;
        } catch { /* not JSON: report the status and size below */ }
        results.push({ code, status: res.status, ms: Date.now() - t0, bytes: text.length, model, params, ...(res.ok ? {} : { head: text.slice(0, 100) }) });
      } catch (e) {
        results.push({ code, error: e instanceof Error ? e.name : 'error', ms: Date.now() - t0 });
      }
    }
    return c.json({ reachable: results.some((x) => 'status' in x && x.status === 200), results });
  });

  return r;
}
