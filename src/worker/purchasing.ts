import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { CATEGORY_NAMES } from '../domain/normalize';
import { LCSC_CART_MAX_LINES, PRIORITIES, RISKS, lcscCartCsv } from '../domain/purchasing';
import { createPart } from '../db/parts';
import {
  addNeed, applyOrder, createProject, deleteQuote, listProjects, listQuotes, listSuppliers, loadBuyList, planOrder,
  updateNeed, updateProject, updateSupplier, upsertQuote,
} from '../db/purchasing';
import type { Outcome } from '../db/result';
import type { AppEnv, Vars } from './env';
import { validate as zValidator } from './validate';

type Ctx = Context<{ Bindings: AppEnv; Variables: Vars }>;
function respond<T extends object>(c: Ctx, o: Outcome<T>) {
  if (o.ok) return c.json(o);
  return c.json({ error: o.message, detail: o.detail }, o.status);
}

const id = z.coerce.number().int().positive();
const idr = z.number().int().min(0).max(10_000_000_000);

const projectBody = z.object({
  name: z.string().trim().min(1).max(100),
  status: z.enum(['planning', 'active', 'done', 'parked']).default('active'),
  kicadProject: z.string().trim().max(300).nullable().default(null),
  notes: z.string().max(2000).default(''),
});

const quoteBody = z.object({
  supplierId: z.number().int().positive(),
  seller: z.string().trim().max(200).default(''),
  unitPriceIdr: idr,
  moq: z.number().int().min(1).max(10_000_000).default(1),
  priceBreaks: z.array(z.object({ qty: z.number().int().min(2).max(10_000_000), priceIdr: idr })).max(10).default([]),
  listingShippingIdr: idr.default(0),
  leadDays: z.number().int().min(0).max(365).nullable().default(null),
  risk: z.enum(RISKS).default('low'),
  url: z.string().trim().max(500).default(''),
  notes: z.string().max(500).default(''),
});

export function purchasingRoutes() {
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();
  const now = () => new Date().toISOString();

  r.post('/parts', zValidator('json', z.object({
    mpn: z.string().trim().min(1).max(100), manufacturer: z.string().trim().max(100).default(''),
    description: z.string().trim().max(300).default(''), package: z.string().trim().max(100).default(''), value: z.string().trim().max(100).default(''),
    category: z.enum(CATEGORY_NAMES).nullable().default(null),
    lcscCode: z.string().trim().toUpperCase().regex(/^C\d+$/, 'an LCSC number like C12345').nullable().default(null),
  })), async (c) => respond(c, await createPart(c.env.DB, c.get('meter'), c.req.valid('json'), now())));

  r.get('/suppliers', async (c) => c.json({ suppliers: await listSuppliers(c.env.DB, c.get('meter')) }));
  r.patch('/suppliers/:id', zValidator('param', z.object({ id })), zValidator('json', z.object({
    orderShippingIdr: idr, freeShipOverIdr: idr.nullable().default(null), leadDays: z.number().int().min(0).max(365).nullable().default(null),
    url: z.string().trim().max(300).nullable().default(null), notes: z.string().max(500).nullable().default(null),
  })), async (c) => respond(c, await updateSupplier(c.env.DB, c.get('meter'), c.req.valid('param').id, c.req.valid('json'))));

  r.get('/projects', async (c) => c.json({ projects: await listProjects(c.env.DB, c.get('meter')) }));
  r.post('/projects', zValidator('json', projectBody), async (c) => respond(c, await createProject(c.env.DB, c.get('meter'), c.req.valid('json'), now())));
  r.patch('/projects/:id', zValidator('param', z.object({ id })), zValidator('json', projectBody), async (c) =>
    respond(c, await updateProject(c.env.DB, c.get('meter'), c.req.valid('param').id, c.req.valid('json'))));

  r.post('/needs', zValidator('json', z.object({
    projectId: z.number().int().positive(), partId: z.number().int().positive(),
    qtyNeeded: z.number().int().min(1).max(10_000_000), spares: z.number().int().min(0).max(10_000_000).default(0),
    priority: z.enum(PRIORITIES).default('medium'),
  })), async (c) => respond(c, await addNeed(c.env.DB, c.get('meter'), c.req.valid('json'), now())));
  r.patch('/needs/:id', zValidator('param', z.object({ id })), zValidator('json', z.object({
    rev: z.number().int().min(0),
    qtyNeeded: z.number().int().min(1).max(10_000_000).optional(), spares: z.number().int().min(0).max(10_000_000).optional(),
    priority: z.enum(PRIORITIES).optional(), overrideSupplierId: z.number().int().positive().nullable().optional(),
    notes: z.string().max(500).optional(), status: z.enum(['to_buy', 'received', 'cancelled']).optional(),
  })), async (c) => {
    const { rev, ...edit } = c.req.valid('json');
    return respond(c, await updateNeed(c.env.DB, c.get('meter'), c.req.valid('param').id, rev, edit));
  });

  r.get('/parts/:id/quotes', zValidator('param', z.object({ id })), async (c) =>
    c.json({ quotes: await listQuotes(c.env.DB, c.get('meter'), c.req.valid('param').id) }));
  r.put('/parts/:id/quotes', zValidator('param', z.object({ id })), zValidator('json', quoteBody), async (c) =>
    respond(c, await upsertQuote(c.env.DB, c.get('meter'), c.req.valid('param').id, c.req.valid('json'), now())));
  r.delete('/quotes/:id', zValidator('param', z.object({ id })), async (c) => respond(c, await deleteQuote(c.env.DB, c.get('meter'), c.req.valid('param').id)));

  r.get('/buylist', async (c) => c.json(await loadBuyList(c.env.DB, c.get('meter'))));

  // Plan-then-apply: marking a supplier's lines ordered touches every to-buy line it covers, not just one the owner named.
  r.post('/buylist/order', zValidator('json', z.object({ supplierId: z.number().int().positive(), apply: z.boolean().default(false) })), async (c) => {
    const b = c.req.valid('json');
    const data = await loadBuyList(c.env.DB, c.get('meter'));
    const plan = planOrder(data, b.supplierId);
    if (!plan) return c.json({ error: `There is no supplier ${b.supplierId}.` }, 404);
    if (plan.lines.length === 0) return c.json({ error: `Nothing to order from ${plan.supplierName}: no still-to-buy line is quoted there.` }, 409);
    if (!b.apply) return c.json({ mode: 'plan', plan });
    const done = await applyOrder(c.env.DB, c.get('meter'), plan, now());
    return c.json({ mode: 'applied', plan, ordered: done.ordered });
  });

  r.get('/buylist/cart.csv', async (c) => {
    const data = await loadBuyList(c.env.DB, c.get('meter'));
    const lcsc = data.suppliers.find((s) => s.name === 'LCSC');
    if (!lcsc) return c.json({ error: 'The supplier "LCSC" is missing from the database.' }, 500);
    const out = lcscCartCsv(data.buyList.groups, lcsc.id);
    if (out.lines === 0) return c.json({ error: 'No still-to-buy line is quoted at LCSC with an LCSC part number, so there is no cart to export.' }, 409);
    if (out.lines > LCSC_CART_MAX_LINES) return c.json({ error: `LCSC's BOM tool takes at most ${LCSC_CART_MAX_LINES} lines and this cart has ${out.lines}; order in batches.` }, 409);
    return new Response(out.csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="lcsc-cart.csv"',
        'x-skipped-parts': out.skipped.join(', '),
      },
    });
  });

  return r;
}
