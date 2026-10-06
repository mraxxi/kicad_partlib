import { Hono } from 'hono';
import { z } from 'zod';
import { FAMILIES, familyById, type LayoutOverride } from '../domain/specs';
import {
  applyEnrichment, getLayouts, getSnapshot, planEnrichment, putLayout, resetLayout, setManualSpecs, storeSnapshot, unfetchedParts,
} from '../db/enrichment';
import type { AppEnv, Vars } from './env';
import { fetchLcsc, type LcscFetcher } from './lcsc';
import { validate as zValidator } from './validate';

/**
 * Routes for spec enrichment (docs/spec-enrichment.md). Four steps, each its own request, so each can be small
 * (a Worker request has a 10 ms CPU budget and 50 subrequests) and so PLANNING WRITES NOTHING:
 *   fetch  -> stores LCSC's raw record (a cache)        plan -> reads, returns what would change
 *   apply  -> writes only what was ticked               manual -> the owner's own value, which always wins
 */
const id = z.coerce.number().int().positive();
const ids = (max: number) => z.array(z.number().int().positive()).min(1).max(max);
const CONCURRENCY = 4;

export function enrichmentRoutes(deps: { lcscFetch?: LcscFetcher } = {}) {
  const lcscFetch = deps.lcscFetch ?? fetchLcsc;
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();
  const now = () => new Date().toISOString();

  // Read-only diagnostic: can this Worker reach LCSC at all?
  r.get('/enrich/lcsc-check', async (c) => {
    const results = [];
    for (const code of ['C269266', 'C468240', 'C5240381']) {
      const t0 = Date.now();
      const res = await lcscFetch(code);
      results.push({ code, status: res.status, ms: Date.now() - t0, ...(res.status === 'ok' ? { model: res.detail.productModel, params: res.detail.params.length } : {}), ...(res.status === 'error' ? { message: res.message } : {}) });
    }
    return c.json({ reachable: results.some((x) => x.status === 'ok'), results });
  });

  // Parts with a C-number and no LCSC record yet: what "fetch" should visit.
  r.get('/enrich/unfetched', async (c) => c.json({ parts: await unfetchedParts(c.env.DB, c.get('meter')) }));

  r.post('/enrich/fetch', zValidator('json', z.object({ partIds: ids(20) })), async (c) => {
    const meter = c.get('meter');
    const parts = await meter.all<{ id: number; lcsc_code: string | null }>(
      c.env.DB.prepare('SELECT id, lcsc_code FROM parts WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(c.req.valid('json').partIds)));
    const results: Array<{ partId: number; code: string | null; status: string; message?: string }> = [];
    const todo = parts.filter((p) => p.lcsc_code);
    for (const p of parts.filter((x) => !x.lcsc_code)) results.push({ partId: p.id, code: null, status: 'no_c_number' });
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const batch = todo.slice(i, i + CONCURRENCY);
      const got = await Promise.all(batch.map((p) => lcscFetch(p.lcsc_code!)));
      for (let k = 0; k < batch.length; k++) {
        const p = batch[k]!, res = got[k]!;
        // A transient error is not stored: only "ok" and "not_listed" are answers worth caching.
        if (res.status === 'ok') await storeSnapshot(c.env.DB, meter, p.id, 'ok', res.detail, now());
        else if (res.status === 'not_listed') await storeSnapshot(c.env.DB, meter, p.id, 'not_listed', null, now());
        results.push({ partId: p.id, code: p.lcsc_code, status: res.status, ...(res.status === 'error' ? { message: res.message } : {}) });
      }
    }
    return c.json({ results });
  });

  r.post('/enrich/plan', zValidator('json', z.object({ partIds: ids(50) })), async (c) =>
    c.json({ items: await planEnrichment(c.env.DB, c.get('meter'), c.req.valid('json').partIds) }));

  r.post('/enrich/apply', zValidator('json', z.object({
    items: z.array(z.object({ partId: z.number().int().positive(), keys: z.array(z.string().max(40)).max(40), category: z.boolean().default(false), valueText: z.boolean().default(false) })).min(1).max(50),
  })), async (c) => c.json({ ok: true, ...(await applyEnrichment(c.env.DB, c.get('meter'), c.req.valid('json').items, now())) }));

  r.get('/parts/:id/enrichment', zValidator('param', z.object({ id })), async (c) => {
    const snap = await getSnapshot(c.env.DB, c.get('meter'), c.req.valid('param').id);
    return c.json({ snapshot: snap });
  });

  r.patch('/parts/:id/specs', zValidator('param', z.object({ id })), zValidator('json', z.object({
    rev: z.number().int().min(0), family: z.string().max(30).optional(),
    set: z.record(z.string().max(40), z.string().max(120)).default({}), clear: z.array(z.string().max(40)).default([]),
  })), async (c) => {
    const { rev, ...edit } = c.req.valid('json');
    const o = await setManualSpecs(c.env.DB, c.get('meter'), c.req.valid('param').id, rev, edit, now());
    return o.ok ? c.json(o) : c.json({ error: o.message, detail: o.detail }, o.status);
  });

  // The owner's key-spec order and sort presets, stored in D1 so every machine sees the same ones.
  r.get('/settings/speclayouts', async (c) => c.json({ layouts: await getLayouts(c.env.DB, c.get('meter')) }));

  const presetSchema = z.object({ name: z.string().trim().min(1).max(60), chain: z.array(z.object({ key: z.string().max(40), dir: z.enum(['asc', 'desc']) })).min(1).max(6) });
  r.put('/settings/speclayouts/:family', zValidator('param', z.object({ family: z.string().max(30) })), zValidator('json', z.object({
    order: z.array(z.string().max(40)).max(20).optional(), keyCount: z.number().int().min(1).max(8).optional(), presets: z.array(presetSchema).max(12).optional(),
  })), async (c) => {
    const fam = familyById(c.req.valid('param').family);
    if (!fam) return c.json({ error: `There is no spec family "${c.req.valid('param').family}". Known: ${FAMILIES.map((f) => f.id).join(', ')}.` }, 404);
    const layout: LayoutOverride = c.req.valid('json');
    const known = new Set([...fam.props.map((p) => p.key)]);
    const bad = [...(layout.order ?? []), ...(layout.presets ?? []).flatMap((p) => p.chain.map((x) => x.key))].find((k) => !known.has(k) && !k.startsWith('col:'));
    if (bad) return c.json({ error: `"${bad}" is not a ${fam.label} spec.` }, 422);
    await putLayout(c.env.DB, c.get('meter'), fam.id, layout);
    return c.json({ ok: true });
  });
  r.delete('/settings/speclayouts/:family', zValidator('param', z.object({ family: z.string().max(30) })), async (c) => {
    await resetLayout(c.env.DB, c.get('meter'), c.req.valid('param').family);
    return c.json({ ok: true });
  });

  return r;
}
