import { Hono } from 'hono';
import { z } from 'zod';
import { CsvError } from '../domain/csv';
import { parseLcscCart } from '../domain/lcscCart';
import { MoneyError, parseMicro } from '../domain/money';
import { PRIORITIES } from '../domain/purchasing';
import { applyCartPlan, buildCartPlan } from '../db/cartImport';
import { findSupplierId } from '../db/lcscImport';
import type { AppEnv, Vars } from './env';
import { sha256Hex } from './util';
import { validate as zValidator } from './validate';

const body = z.object({
  filename: z.string().min(1).max(300),
  csv: z.string().min(1).max(2_000_000),
  /** Exactly one of projectId / newProjectName. */
  projectId: z.number().int().positive().optional(),
  newProjectName: z.string().trim().min(1).max(100).optional(),
  priority: z.enum(PRIORITIES).default('medium'),
  /** IDR per 1 USD, as a decimal string: never a float. Converts the cart's USD prices into the IDR quotes. */
  fxIdrPerUsd: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
  updateQuotes: z.boolean().default(true),
  apply: z.boolean().default(false),
});

/**
 * Import an LCSC CART export as buy-list needs for a project, plus an LCSC quote from each line's price and MOQ.
 * Plan first (writes nothing), then apply: the same two-step as the order import.
 */
export function cartRoutes() {
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

  r.post('/import/lcsc-cart', zValidator('json', body), async (c) => {
    const b = c.req.valid('json');
    const meter = c.get('meter');
    const fail = (errors: string[], status: 422 | 500 = 422) => c.json({ errors }, status);

    if ((b.projectId === undefined) === (b.newProjectName === undefined)) return fail(['Choose an existing project or give a new project a name, not both and not neither.']);

    let parsed;
    try { parsed = parseLcscCart(b.csv); } catch (e) { if (e instanceof CsvError) return fail([e.message]); throw e; }
    if (parsed.errors.length) return fail(parsed.errors);
    if (parsed.lines.length === 0) return fail(['The file has a header but no cart lines.']);

    let fx: number;
    try {
      fx = b.fxIdrPerUsd !== undefined ? parseMicro(b.fxIdrPerUsd)
        : Number((await meter.all<{ value: string }>(c.env.DB.prepare("SELECT value FROM settings WHERE key = 'fx.usd_idr_micro'")))[0]?.value);
    } catch (e) { if (e instanceof MoneyError) return fail([e.message]); throw e; }
    if (!Number.isSafeInteger(fx) || fx <= 0) return fail(['The USD to IDR rate must be greater than zero.']);

    const lcscSupplierId = await findSupplierId(c.env.DB, meter, 'LCSC');
    if (lcscSupplierId === null) return fail(['The supplier "LCSC" is missing from the database; the seed data did not apply.'], 500);

    const { plan, projectName, projectExists } = await buildCartPlan(c.env.DB, meter, {
      lines: parsed.lines, target: { projectId: b.projectId ?? null, newProjectName: b.newProjectName ?? null },
      lcscSupplierId, fxIdrPerUsdMicro: fx, updateQuotes: b.updateQuotes,
    });
    if (b.projectId !== undefined && !projectExists) return c.json({ errors: [`There is no project ${b.projectId}.`] }, 404);
    if (b.newProjectName !== undefined && projectExists) return fail([`A project named "${projectName}" already exists; choose it from the list instead.`]);

    const view = {
      project: { name: projectName, isNew: !projectExists },
      fxIdrPerUsd: b.fxIdrPerUsd ?? String(fx / 1e6),
      summary: plan.summary, errors: plan.errors, warnings: plan.warnings,
      lines: plan.lines.map((l) => ({
        row: l.line.row, lcsc: l.line.lcsc, mpn: l.line.mpn, manufacturer: l.line.manufacturer, qty: l.line.qty, moq: l.line.moq,
        unitPriceMicro: l.line.unitPriceMicro, part: l.part.action, partId: l.part.partId, matchedBy: l.part.matchedBy, category: l.part.category,
        needsReview: l.part.needsReview, need: l.need, stock: l.stock, willBuy: l.willBuy, quote: l.quote,
      })),
    };
    if (!b.apply) return c.json({ mode: 'plan', ...view });
    if (plan.errors.length) return c.json({ errors: plan.errors }, 422);

    const res = await applyCartPlan(c.env.DB, meter, {
      plan, projectName: projectName!, projectExists, priority: b.priority, lcscSupplierId,
      file: { name: b.filename, sha256: await sha256Hex(b.csv) }, now: new Date().toISOString(),
    });
    return c.json({ mode: 'applied', ...view, rowsWritten: res.rowsWritten });
  });

  return r;
}
