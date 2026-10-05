import { Hono, type Context } from 'hono';
import { validate as zValidator } from './validate';
import { z } from 'zod';
import { buildDashboard, CONDITIONS } from '../domain/stock';
import { addManualLot, applyMove, countLot, reclassifyLot } from '../db/moves';
import { getPart, listAllParts, listParts, updatePart } from '../db/parts';
import { createDonor, createLocation, deleteLocation, listDonors, listLocations, updateDonor, updateLocation } from '../db/org';
import { harvest } from '../db/harvest';
import type { Outcome } from '../db/result';
import type { AppEnv, Vars } from './env';

type Ctx = Context<{ Bindings: AppEnv; Variables: Vars }>;

/** One place turns a refusal into HTTP, so every refusal reads the same in every route. */
function respond<T extends object>(c: Ctx, o: Outcome<T>) {
  if (o.ok) return c.json(o);
  return c.json({ error: o.message, detail: o.detail }, o.status);
}

const id = z.coerce.number().int().positive();
// Client-generated, reused on every retry of the same action. No ':' - lot keys are '<id>:<n>'.
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'a request id of 8-64 letters, digits, - or _');
const note = z.string().trim().max(500).default('');
const condition = z.enum(CONDITIONS);

const moveBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('consume'), moveId: requestId, qty: z.number().int().positive(), note }),
  z.object({ kind: z.literal('scrap'), moveId: requestId, qty: z.number().int().positive(), note }),
  z.object({ kind: z.literal('count'), moveId: requestId, countedQty: z.number().int().min(0), note }),
  z.object({
    kind: z.literal('adjust'), moveId: requestId,
    delta: z.number().int().refine((n) => n !== 0, 'a non-zero change'),
    note: z.string().trim().min(3, 'a reason of at least 3 characters').max(500),
  }),
]);

const partEdit = z.object({
  rev: z.number().int().min(0),
  description: z.string().max(500).optional(),
  package: z.string().max(100).optional(),
  value: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  datasheetUrl: z.string().url().max(500).nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  minQty: z.number().int().min(0).nullable().optional(),
});

const donorBody = z.object({
  code: z.string().trim().min(1).max(30),
  device: z.string().trim().min(1).max(200),
  receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  condition: z.string().max(300).default(''),
  status: z.enum(['stripping', 'done', 'parked']).default('stripping'),
  notes: z.string().max(2000).default(''),
});

const locationBody = z.object({ code: z.string().trim().min(1).max(30), name: z.string().trim().max(100).default('') });

const harvestBody = z.object({
  harvestId: requestId,
  items: z.array(z.object({
    mpn: z.string().trim().min(1).max(100),
    manufacturer: z.string().trim().max(100).default(''),
    qty: z.number().int().positive().max(1_000_000),
    condition: condition.default('untested'),
    estUnitValueIdr: z.number().int().min(0).max(100_000_000).default(0),
    locationId: z.number().int().positive().nullable().default(null),
    category: z.string().max(60).nullable().default(null),
    description: z.string().trim().max(300).default(''),
  })).min(1).max(100),
});

export function inventoryRoutes() {
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();
  const now = () => new Date().toISOString();

  r.get('/parts', zValidator('query', z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(500) })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await listParts(c.env.DB, c.get('meter'), q.after, q.limit));
  });

  r.get('/parts/:id', zValidator('param', z.object({ id })), async (c) =>
    respond(c, await getPart(c.env.DB, c.get('meter'), c.req.valid('param').id)));

  r.patch('/parts/:id', zValidator('param', z.object({ id })), zValidator('json', partEdit), async (c) => {
    const { rev, ...edit } = c.req.valid('json');
    return respond(c, await updatePart(c.env.DB, c.get('meter'), c.req.valid('param').id, rev, edit, now()));
  });

  r.post('/parts/:id/lots', zValidator('param', z.object({ id })), zValidator('json', z.object({
    moveId: requestId, qty: z.number().int().positive().max(10_000_000), condition: condition.default('new'),
    locationId: z.number().int().positive().nullable().default(null),
    unitCostIdr: z.number().int().min(0).max(1_000_000_000).default(0), note,
  })), async (c) => {
    const b = c.req.valid('json');
    return respond(c, await addManualLot(c.env.DB, c.get('meter'), { ...b, partId: c.req.valid('param').id, at: now() }));
  });

  r.post('/lots/:id/moves', zValidator('param', z.object({ id })), zValidator('json', moveBody), async (c) => {
    const lotId = c.req.valid('param').id;
    const b = c.req.valid('json');
    const db = c.env.DB, meter = c.get('meter'), at = now();
    if (b.kind === 'count') return respond(c, await countLot(db, meter, { moveId: b.moveId, lotId, countedQty: b.countedQty, note: b.note, at }));
    const delta = b.kind === 'adjust' ? b.delta : -b.qty;
    return respond(c, await applyMove(db, meter, { moveId: b.moveId, lotId, delta, reason: b.kind, note: b.note, at }));
  });

  r.post('/lots/:id/reclassify', zValidator('param', z.object({ id })), zValidator('json', z.object({
    moveId: requestId, qty: z.number().int().positive(), condition: condition.optional(),
    locationId: z.number().int().positive().nullable().optional(), note,
  })), async (c) => {
    const b = c.req.valid('json');
    return respond(c, await reclassifyLot(c.env.DB, c.get('meter'), {
      moveId: b.moveId, lotId: c.req.valid('param').id, qty: b.qty,
      meta: { condition: b.condition, locationId: b.locationId }, note: b.note, at: now(),
    }));
  });

  r.get('/locations', async (c) => c.json({ locations: await listLocations(c.env.DB, c.get('meter')) }));
  r.post('/locations', zValidator('json', locationBody), async (c) => {
    const b = c.req.valid('json');
    return respond(c, await createLocation(c.env.DB, c.get('meter'), b.code, b.name));
  });
  r.patch('/locations/:id', zValidator('param', z.object({ id })), zValidator('json', locationBody), async (c) => {
    const b = c.req.valid('json');
    return respond(c, await updateLocation(c.env.DB, c.get('meter'), c.req.valid('param').id, b.code, b.name));
  });
  r.delete('/locations/:id', zValidator('param', z.object({ id })), async (c) =>
    respond(c, await deleteLocation(c.env.DB, c.get('meter'), c.req.valid('param').id)));

  r.get('/donors', async (c) => c.json({ donors: await listDonors(c.env.DB, c.get('meter')) }));
  r.post('/donors', zValidator('json', donorBody), async (c) => respond(c, await createDonor(c.env.DB, c.get('meter'), c.req.valid('json'))));
  r.patch('/donors/:id', zValidator('param', z.object({ id })), zValidator('json', donorBody), async (c) =>
    respond(c, await updateDonor(c.env.DB, c.get('meter'), c.req.valid('param').id, c.req.valid('json'))));
  r.post('/donors/:id/harvest', zValidator('param', z.object({ id })), zValidator('json', harvestBody), async (c) => {
    const b = c.req.valid('json');
    return respond(c, await harvest(c.env.DB, c.get('meter'), { harvestId: b.harvestId, donorId: c.req.valid('param').id, items: b.items, at: now() }));
  });

  r.get('/categories', async (c) => c.json({
    categories: await c.get('meter').all(c.env.DB.prepare('SELECT id, name FROM categories ORDER BY name')),
  }));

  r.get('/dashboard', async (c) => {
    const parts = await listAllParts(c.env.DB, c.get('meter'));
    return c.json(buildDashboard(parts));
  });

  return r;
}
