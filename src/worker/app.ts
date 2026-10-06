import { Hono } from 'hono';
import { validate as zValidator } from './validate';
import { z } from 'zod';
import type { JWTVerifyGetKey } from 'jose';
import { Meter } from '../db/meter';
import { applyLcscImport, buildPlan, findSupplierId, type ImportPlan } from '../db/lcscImport';
import { orderDateFromOrderNo, parseLcscCsv, parseLcscFilename } from '../domain/lcsc';
import { MoneyError, parseMicro } from '../domain/money';
import { CsvError } from '../domain/csv';
import { accessMiddleware } from './access';
import { cartRoutes } from './cart';
import { sha256Hex } from './util';
import { inventoryRoutes } from './inventory';
import { purchasingRoutes } from './purchasing';
import { enrichmentRoutes } from './enrichment';
import type { LcscFetcher } from './lcsc';
import type { AppEnv, Vars } from './env';

const FREE_LIMITS = { rowsRead: 5_000_000, rowsWritten: 100_000, requests: 100_000 } as const;

const importBody = z.object({
  filename: z.string().min(1).max(300),
  csv: z.string().min(1).max(2_000_000),
  orderNo: z.string().regex(/^[A-Za-z0-9]{4,32}$/).optional(),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** IDR per 1 USD, as a decimal string ("16250.5"): never a float. */
  fxIdrPerUsd: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
  shippingIdr: z.number().int().min(0).default(0),
  dutiesIdr: z.number().int().min(0).default(0),
  apply: z.boolean().default(false),
});

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function planView(plan: ImportPlan) {
  return {
    summary: plan.summary,
    needsToClose: plan.needsToClose,
    errors: plan.errors,
    warnings: plan.warnings,
    lines: plan.lines.map((l) => ({
      row: l.line.row, lcsc: l.line.lcsc, mpn: l.line.mpn, manufacturer: l.line.manufacturer,
      qty: l.line.qty, unitPriceMicro: l.line.unitPriceMicro, action: l.action, matchedBy: l.matchedBy,
      partId: l.partId, category: l.category, value: l.value,
      needsReview: l.needsReview, reviewReasons: l.reviewReasons,
      setLcscCode: l.setLcscCode, manufacturerVariant: l.manufacturerVariant,
    })),
  };
}

export function makeApp(deps: { jwks?: JWTVerifyGetKey; lcscFetch?: LcscFetcher } = {}) {
  const app = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

  app.use('/api/*', accessMiddleware(deps));
  app.use('/api/*', async (c, next) => {
    const meter = new Meter();
    c.set('meter', meter);
    await next();
    try {
      c.executionCtx.waitUntil(meter.flush(c.env.DB).catch(() => undefined));
    } catch {
      // No ExecutionContext (a bare unit call): usage is simply not recorded.
    }
  });

  app.onError((err, c) => {
    // Never echo err.message: it can carry SQL. The log has it; the client gets a sentence.
    console.error('unhandled', err);
    return c.json({ error: 'Something went wrong on the server; nothing was reported to the browser.' }, 500);
  });

  app.route('/api', inventoryRoutes());
  app.route('/api', purchasingRoutes());
  app.route('/api', enrichmentRoutes({ lcscFetch: deps.lcscFetch }));
  app.route('/api', cartRoutes());

  app.get('/api/health', (c) => c.json({ ok: true, identity: c.get('identity') }));

  app.get('/api/usage', async (c) => {
    const day = new Date().toISOString().slice(0, 10);
    const row = (
      await c.get('meter').all<{ rows_read: number; rows_written: number; requests: number }>(
        c.env.DB.prepare('SELECT rows_read, rows_written, requests FROM usage_daily WHERE day = ?').bind(day),
      )
    )[0] ?? { rows_read: 0, rows_written: 0, requests: 0 };
    return c.json({
      day,
      rowsRead: row.rows_read, rowsWritten: row.rows_written, requests: row.requests,
      limits: FREE_LIMITS,
      note: 'Counts only what this app recorded; other Workers on the account share the same daily quota.',
    });
  });

  app.post('/api/import/lcsc', zValidator('json', importBody), async (c) => {
    const body = c.req.valid('json');
    const meter = c.get('meter');
    const fail = (errors: string[]) => c.json({ errors }, 422);

    let parsed;
    try {
      parsed = parseLcscCsv(body.csv);
    } catch (e) {
      if (e instanceof CsvError) return fail([e.message]);
      throw e;
    }
    if (parsed.errors.length) return fail(parsed.errors);
    if (parsed.lines.length === 0) return fail(['The file has a header but no order lines.']);

    const fromName = parseLcscFilename(body.filename);
    const orderNo = body.orderNo?.toUpperCase() ?? fromName?.orderNo;
    if (!orderNo) return fail([`Could not read an order number from the filename "${body.filename}"; enter it by hand.`]);
    const orderDate = body.orderDate ?? orderDateFromOrderNo(orderNo) ?? fromName?.exportedAt;
    if (!orderDate || !isRealDate(orderDate)) return fail(['Enter the order date as YYYY-MM-DD.']);

    let fxIdrPerUsdMicro: number;
    try {
      if (body.fxIdrPerUsd !== undefined) {
        fxIdrPerUsdMicro = parseMicro(body.fxIdrPerUsd);
      } else {
        const rows = await meter.all<{ value: string }>(
          c.env.DB.prepare("SELECT value FROM settings WHERE key = 'fx.usd_idr_micro'"),
        );
        fxIdrPerUsdMicro = Number(rows[0]?.value);
      }
    } catch (e) {
      if (e instanceof MoneyError) return fail([e.message]);
      throw e;
    }
    if (!Number.isSafeInteger(fxIdrPerUsdMicro) || fxIdrPerUsdMicro <= 0) return fail(['The USD to IDR rate must be greater than zero.']);

    const supplierId = await findSupplierId(c.env.DB, meter, 'LCSC');
    if (supplierId === null) return c.json({ errors: ['The supplier "LCSC" is missing from the database; the seed data did not apply.'] }, 500);

    const plan = await buildPlan(c.env.DB, meter, { supplierId, orderNo }, parsed.lines);
    const order = { orderNo, orderDate, fxIdrPerUsd: body.fxIdrPerUsd ?? String(fxIdrPerUsdMicro / 1e6), shippingIdr: body.shippingIdr, dutiesIdr: body.dutiesIdr };

    if (!body.apply) return c.json({ mode: 'plan', order, plan: planView(plan) });
    if (plan.errors.length) return c.json({ errors: plan.errors }, 422);

    const sha256 = await sha256Hex(body.csv);
    const result = await applyLcscImport(
      c.env.DB, meter,
      { supplierId, orderNo, orderDate, fxIdrPerUsdMicro, shippingIdr: body.shippingIdr, dutiesIdr: body.dutiesIdr },
      plan, { name: body.filename, sha256 }, new Date().toISOString(),
    );
    return c.json({ mode: 'applied', order, summary: plan.summary, closedNeeds: plan.needsToClose.length, rowsWritten: result.rowsWritten, rowsRead: result.rowsRead });
  });

  return app;
}
