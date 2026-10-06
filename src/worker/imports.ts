import { Hono } from 'hono';
import { z } from 'zod';
import { cartLabel, cleanAlias, orderLabel } from '../domain/labels';
import type { AppEnv, Vars } from './env';

const id = z.coerce.number().int().positive();
const rename = z.object({ alias: z.string().max(200), rev: z.number().int().min(0) });

/**
 * What has been imported, by readable name, and renaming it. The name is display only: re-import detection keeps using
 * the order number (orders) and the file's SHA-256 (carts), so a rename can never cause or hide a duplicate.
 */
export function importRoutes() {
  const r = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

  r.get('/imports', async (c) => {
    const meter = c.get('meter');
    const orders = await meter.all<{ id: number; orderNo: string; orderDate: string; alias: string | null; rev: number; lines: number }>(
      c.env.DB.prepare(
        `SELECT o.id, o.order_no AS orderNo, o.order_date AS orderDate, o.alias, o.rev,
                (SELECT COUNT(*) FROM order_lines ol WHERE ol.order_id = o.id) AS lines
           FROM orders o ORDER BY o.order_date DESC, o.id DESC LIMIT 200`));
    const carts = await meter.all<{ id: number; filename: string; alias: string | null; rev: number; at: string; rowsIn: number }>(
      c.env.DB.prepare(`SELECT id, filename, alias, rev, at, rows_in AS rowsIn FROM import_runs WHERE kind = 'lcsc-cart' ORDER BY id DESC LIMIT 100`));
    // "(2)" tells apart two orders of one date; oldest id first so a name never changes when a later order arrives.
    const seen = new Map<string, number>();
    const nth = new Map<number, number>();
    for (const o of [...orders].sort((a, b) => a.id - b.id)) { const n = (seen.get(o.orderDate) ?? 0) + 1; seen.set(o.orderDate, n); nth.set(o.id, n); }
    return c.json({
      orders: orders.map((o) => ({ ...o, label: orderLabel(o, nth.get(o.id)) })),
      carts: carts.map((k) => ({ ...k, label: k.alias ?? cartLabel(k.filename) })),
    });
  });

  // One handler for both tables; the table name is a constant, never user input.
  const renameRoute = (table: 'orders' | 'import_runs', what: string) =>
    async (c: import('hono').Context<{ Bindings: AppEnv; Variables: Vars }>) => {
      const rowId = id.safeParse(c.req.param('id'));
      const body = rename.safeParse(await c.req.json().catch(() => null));
      if (!rowId.success || !body.success) return c.json({ error: 'The request was not valid: it needs a name and the revision shown in the list.' }, 400);
      const b = body.data;
      const named = cleanAlias(b.alias);
      if (!named.ok) return c.json({ error: named.message }, 422);
      const meter = c.get('meter');
      const kind = table === 'import_runs' ? " AND kind = 'lcsc-cart'" : '';
      const cur = (await meter.all<{ alias: string | null; rev: number }>(c.env.DB.prepare(`SELECT alias, rev FROM ${table} WHERE id = ?${kind}`).bind(rowId.data)))[0];
      if (!cur) return c.json({ error: `There is no ${what} ${rowId.data}.` }, 404);
      if (cur.rev !== b.rev) return c.json({ error: `This ${what} was renamed somewhere else since you opened the list; nothing was saved. Reload and try again.`, detail: { kind: 'conflict', currentRev: cur.rev, currentAlias: cur.alias } }, 409);
      const res = await c.env.DB.prepare(`UPDATE ${table} SET alias = ?1, rev = rev + 1 WHERE id = ?2 AND rev = ?3`).bind(named.alias, rowId.data, b.rev).run();
      meter.add(res);
      if (!res.meta.changes) return c.json({ error: `This ${what} was renamed somewhere else since you opened the list; nothing was saved. Reload and try again.` }, 409);
      return c.json({ ok: true, rev: b.rev + 1, alias: named.alias });
    };

  r.patch('/orders/:id', renameRoute('orders', 'order'));
  r.patch('/imports/:id', renameRoute('import_runs', 'import'));
  return r;
}
