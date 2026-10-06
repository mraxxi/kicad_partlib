import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { guessCategory, CATEGORY_NAMES, type CategoryName } from '../domain/normalize';
import { packageFromFootprint, parseKicadBom } from '../domain/kicadBom';
import { detectFamily } from '../domain/specs';
import { BOM_MAX_LINES, applyBomPlan, buildBomPlan, getBom, loadFieldMap, saveFieldMap, updateBomLine } from '../db/bom';
import { storeSnapshot } from '../db/enrichment';
import { createPart } from '../db/parts';
import { type Outcome } from '../db/result';
import type { AppEnv, Vars } from './env';
import { fetchLcsc, type LcscFetcher } from './lcsc';
import { sha256Hex } from './util';
import { validate as zValidator } from './validate';

type Ctx = Context<{ Bindings: AppEnv; Variables: Vars }>;
function respond<T extends object>(c: Ctx, o: Outcome<T>) {
  if (o.ok) return c.json(o);
  return c.json({ error: o.message, detail: o.detail }, o.status);
}

const id = z.coerce.number().int().positive();
const names = z.array(z.string().trim().min(1).max(60)).min(1).max(20);

/**
 * KiCad BOM import into a project (docs/kicad-bom.md). Plan first (writes nothing), then apply: the same two steps as
 * the order and cart imports, with the same part matching. Editing a single line afterwards is a named-row edit.
 */
export function bomRoutes(deps: { lcscFetch?: LcscFetcher } = {}) {
  const lcscFetch = deps.lcscFetch ?? fetchLcsc;
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();
  const now = () => new Date().toISOString();

  r.post('/projects/:id/bom', zValidator('param', z.object({ id })), zValidator('json', z.object({
    filename: z.string().min(1).max(300),
    csv: z.string().min(1).max(2_000_000),
    boards: z.number().int().min(1).max(10_000).default(1),
    apply: z.boolean().default(false),
  })), async (c) => {
    const { id: projectId } = c.req.valid('param');
    const b = c.req.valid('json');
    const meter = c.get('meter');

    const parsed = parseKicadBom(b.csv, await loadFieldMap(c.env.DB, meter));
    if (parsed.errors.length) return c.json({ errors: parsed.errors }, 422);
    if (parsed.lines.length > BOM_MAX_LINES) return c.json({ error: `This BOM has ${parsed.lines.length} lines and the limit is ${BOM_MAX_LINES}; split it by sheet or board.` }, 422);

    const loaded = await buildBomPlan(c.env.DB, meter, projectId, parsed.lines);
    if (!loaded.projectExists) return c.json({ error: `There is no project ${projectId}.` }, 404);
    const plan = loaded.plan;
    plan.warnings.unshift(...parsed.warnings);

    const view = {
      boards: b.boards, previousBoards: loaded.boards, summary: plan.summary, warnings: plan.warnings,
      sameFile: loaded.sha256 === await sha256Hex(b.csv) && loaded.boards === b.boards,
      lines: plan.lines.map((l) => ({
        key: l.key, row: l.line?.row ?? null, refs: l.line?.refs.join(', ') ?? '', value: l.line?.value ?? '', footprint: l.line?.footprint ?? '',
        qty: l.qtyAfter, qtyBefore: l.qtyBefore, action: l.action, partId: l.partId, linkRule: l.linkRule, status: l.status, suggestions: l.suggestions,
      })),
    };
    if (!b.apply) return c.json({ mode: 'plan', ...view });

    const res = await applyBomPlan(c.env.DB, meter, {
      projectId, plan, boards: b.boards, file: { name: b.filename, sha256: await sha256Hex(b.csv) },
      previous: { boards: loaded.boards, sha256: loaded.sha256 }, now: now(),
    });
    return c.json({ mode: 'applied', ...view, ...res });
  });

  r.get('/projects/:id/bom', zValidator('param', z.object({ id })), async (c) =>
    c.json({ bom: await getBom(c.env.DB, c.get('meter'), c.req.valid('param').id) }));

  r.patch('/bom-lines/:id', zValidator('param', z.object({ id })), zValidator('json', z.object({
    rev: z.number().int().min(0),
    partId: z.number().int().positive().nullable().optional(),
    status: z.enum(['active', 'dnp', 'ignored']).optional(),
  })), async (c) => {
    const { rev, ...edit } = c.req.valid('json');
    return respond(c, await updateBomLine(c.env.DB, c.get('meter'), c.req.valid('param').id, rev, edit, now()));
  });

  // Create a real part for a BOM line (from a C-number LCSC lists, or typed MPN) and link the line to it.
  r.post('/bom-lines/:id/create-part', zValidator('param', z.object({ id })), zValidator('json', z.object({
    rev: z.number().int().min(0),
    lcscCode: z.string().trim().toUpperCase().regex(/^C\d+$/, 'an LCSC number like C12345').nullable().default(null),
    mpn: z.string().trim().max(100).default(''),
    manufacturer: z.string().trim().max(100).default(''),
    category: z.enum(CATEGORY_NAMES).nullable().default(null),
  })), async (c) => {
    const b = c.req.valid('json');
    const meter = c.get('meter');
    const line = (await meter.all<{ id: number; value: string; footprint: string; project_id: number }>(
      c.env.DB.prepare('SELECT id, value, footprint, project_id FROM bom_lines WHERE id = ?').bind(c.req.valid('param').id)))[0];
    if (!line) return c.json({ error: `There is no BOM line ${c.req.valid('param').id}.` }, 404);

    let { mpn, manufacturer } = b;
    let description = '';
    let pkg = packageFromFootprint(line.footprint) ?? '';
    let category: CategoryName | null = b.category;
    let detail = null;
    if (b.lcscCode && !mpn) {
      const got = await lcscFetch(b.lcscCode);
      if (got.status === 'not_listed') return c.json({ error: `LCSC does not list ${b.lcscCode}; type the MPN yourself.` }, 422);
      if (got.status === 'error') return c.json({ error: `${got.message} Type the MPN yourself, or try again.` }, 502);
      detail = got.detail;
      mpn = got.detail.productModel;
      manufacturer = manufacturer || got.detail.brand || '';
      description = (got.detail.intro ?? got.detail.desc ?? '').trim();
      pkg = got.detail.package || pkg;
      category = category ?? (detectFamily(got.detail.catalog, got.detail.parentCatalog, null)?.category as CategoryName | undefined) ?? guessCategory(description);
    }
    if (!mpn) return c.json({ error: 'Give the part an MPN, or an LCSC number that LCSC lists, so it has a name.' }, 422);

    const made = await createPart(c.env.DB, meter, {
      mpn, manufacturer, description, package: pkg, value: line.value, category: category ?? 'Other', lcscCode: b.lcscCode,
    }, now());
    if (!made.ok) return respond(c, made);
    // Hand-made from a BOM line: flag it for review, and keep LCSC's raw record so Enrich needs no second fetch.
    await meter.batch(c.env.DB, [c.env.DB.prepare('UPDATE parts SET needs_review = 1 WHERE id = ?').bind(made.id)]);
    if (detail) await storeSnapshot(c.env.DB, meter, made.id, 'ok', detail, now());
    const linked = await updateBomLine(c.env.DB, meter, line.id, b.rev, { partId: made.id }, now());
    if (!linked.ok) return c.json({ error: `${linked.message} The part ${made.code} was created; link the line to it by hand.`, detail: linked.detail }, linked.status);
    return c.json({ ok: true, partId: made.id, code: made.code, rev: linked.rev });
  });

  r.get('/settings/bom-fields', async (c) => c.json({ fields: await loadFieldMap(c.env.DB, c.get('meter')) }));
  r.put('/settings/bom-fields', zValidator('json', z.object({ lcsc: names, mpn: names, manufacturer: names })), async (c) => {
    await saveFieldMap(c.env.DB, c.get('meter'), c.req.valid('json'));
    return c.json({ ok: true });
  });

  return r;
}
