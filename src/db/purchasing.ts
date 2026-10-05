import { computeBuyList, type BuyList, type Need, type PriceBreak, type Quote, type Risk, type Supplier, type Priority, type NeedStatus } from '../domain/purchasing';
import { Meter } from './meter';
import { refuse, type Outcome } from './result';

const UNIQUE = /UNIQUE constraint failed/i;

// ---- suppliers -------------------------------------------------------------
export interface SupplierRow extends Supplier { kind: string; currency: string; leadDays: number | null; url: string | null; notes: string | null }

export async function listSuppliers(db: D1Database, meter: Meter): Promise<SupplierRow[]> {
  return meter.all<SupplierRow>(db.prepare(
    `SELECT id, name, kind, currency, order_shipping_idr AS orderShippingIdr, free_ship_over_idr AS freeShipOverIdr,
            lead_days AS leadDays, url, notes FROM suppliers ORDER BY id`));
}

export async function updateSupplier(db: D1Database, meter: Meter, id: number,
  s: { orderShippingIdr: number; freeShipOverIdr: number | null; leadDays: number | null; url: string | null; notes: string | null }): Promise<Outcome<object>> {
  const r = await db.prepare('UPDATE suppliers SET order_shipping_idr = ?, free_ship_over_idr = ?, lead_days = ?, url = ?, notes = ? WHERE id = ?')
    .bind(s.orderShippingIdr, s.freeShipOverIdr, s.leadDays, s.url, s.notes, id).run();
  meter.add(r);
  return r.meta.changes === 1 ? { ok: true } : refuse(404, `There is no supplier ${id}.`);
}

// ---- projects --------------------------------------------------------------
export interface ProjectRow { id: number; name: string; status: string; kicadProject: string | null; notes: string; needCount: number; toBuyCount: number }

export async function listProjects(db: D1Database, meter: Meter): Promise<ProjectRow[]> {
  return meter.all<ProjectRow>(db.prepare(
    `SELECT p.id, p.name, p.status, p.kicad_project AS kicadProject, p.notes,
            COUNT(n.id) AS needCount, COALESCE(SUM(n.status = 'to_buy'), 0) AS toBuyCount
       FROM projects p LEFT JOIN needs n ON n.project_id = p.id GROUP BY p.id ORDER BY p.name`));
}

export async function createProject(db: D1Database, meter: Meter, p: { name: string; status: string; kicadProject: string | null; notes: string }, now: string): Promise<Outcome<{ id: number }>> {
  try {
    const r = await db.prepare('INSERT INTO projects(name, status, kicad_project, notes, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(p.name, p.status, p.kicadProject, p.notes, now).run();
    meter.add(r);
    return { ok: true, id: r.meta.last_row_id };
  } catch (e) {
    if (UNIQUE.test(String(e))) return refuse(409, `A project named "${p.name}" already exists.`);
    throw e;
  }
}

export async function updateProject(db: D1Database, meter: Meter, id: number, p: { name: string; status: string; kicadProject: string | null; notes: string }): Promise<Outcome<object>> {
  try {
    const r = await db.prepare('UPDATE projects SET name = ?, status = ?, kicad_project = ?, notes = ? WHERE id = ?')
      .bind(p.name, p.status, p.kicadProject, p.notes, id).run();
    meter.add(r);
    return r.meta.changes === 1 ? { ok: true } : refuse(404, `There is no project ${id}.`);
  } catch (e) {
    if (UNIQUE.test(String(e))) return refuse(409, `A project named "${p.name}" already exists.`);
    throw e;
  }
}

// ---- needs -----------------------------------------------------------------
export async function addNeed(db: D1Database, meter: Meter, n: { projectId: number; partId: number; qtyNeeded: number; spares: number; priority: Priority }, now: string): Promise<Outcome<{ id: number }>> {
  const proj = await meter.all<{ id: number }>(db.prepare('SELECT id FROM projects WHERE id = ?').bind(n.projectId));
  if (!proj[0]) return refuse(404, `There is no project ${n.projectId}.`);
  const part = await meter.all<{ id: number }>(db.prepare('SELECT id FROM parts WHERE id = ?').bind(n.partId));
  if (!part[0]) return refuse(404, `There is no part ${n.partId}.`);
  try {
    const r = await db.prepare('INSERT INTO needs(project_id, part_id, qty_needed, spares, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(n.projectId, n.partId, n.qtyNeeded, n.spares, n.priority, now).run();
    meter.add(r);
    return { ok: true, id: r.meta.last_row_id };
  } catch (e) {
    if (UNIQUE.test(String(e))) return refuse(409, 'This project already needs that part; edit the existing line instead of adding it twice.');
    throw e;
  }
}

export interface NeedEdit { qtyNeeded?: number; spares?: number; priority?: Priority; overrideSupplierId?: number | null; notes?: string; status?: 'to_buy' | 'received' | 'cancelled' }

/**
 * Edit a need. `status` may only move between the states a person decides:
 * cancel, reopen (which also un-orders, clearing the frozen cost, so a mistaken
 * "ordered" can be undone), or close as received by hand. 'ordered' is reached
 * only through the order action, which freezes the cost.
 */
export async function updateNeed(db: D1Database, meter: Meter, id: number, rev: number, e: NeedEdit): Promise<Outcome<{ rev: number }>> {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  const col: Array<[keyof NeedEdit, string]> = [['qtyNeeded', 'qty_needed'], ['spares', 'spares'], ['priority', 'priority'], ['overrideSupplierId', 'override_supplier_id'], ['notes', 'notes']];
  for (const [k, c] of col) if (e[k] !== undefined) { sets.push(`${c} = ?`); vals.push(e[k] as string | number | null); }
  if (e.status !== undefined) {
    sets.push('status = ?'); vals.push(e.status);
    if (e.status === 'to_buy') sets.push('ordered_supplier_id = NULL', 'ordered_qty = NULL', 'ordered_total_idr = NULL', 'ordered_at = NULL');
  }
  if (sets.length === 0) return refuse(422, 'Nothing to change: no fields were given.');
  const r = await db.prepare(`UPDATE needs SET ${sets.join(', ')}, rev = rev + 1 WHERE id = ? AND rev = ?`).bind(...vals, id, rev).run();
  meter.add(r);
  if (r.meta.changes === 1) return { ok: true, rev: rev + 1 };
  const cur = await meter.all<{ rev: number }>(db.prepare('SELECT rev FROM needs WHERE id = ?').bind(id));
  if (!cur[0]) return refuse(404, `There is no need ${id}.`);
  return refuse(409, 'This line was changed somewhere else since you loaded it; nothing was saved. Reload and try again.', { currentRev: cur[0].rev });
}

// ---- quotes ----------------------------------------------------------------
export interface QuoteRow extends Quote { supplierName: string; notes: string }
interface QuoteDb { id: number; partId: number; supplierId: number; supplierName: string; seller: string; unitPriceIdr: number; moq: number; breaks: string | null; listingShippingIdr: number; leadDays: number | null; risk: Risk; url: string; notes: string; quotedAt: string }

const QUOTE_SELECT = `SELECT q.id, q.part_id AS partId, q.supplier_id AS supplierId, s.name AS supplierName, q.seller, q.unit_price_idr AS unitPriceIdr,
       q.moq, q.price_breaks_json AS breaks, q.listing_shipping_idr AS listingShippingIdr, q.lead_days AS leadDays,
       q.risk, q.url, q.notes, q.quoted_at AS quotedAt FROM quotes q JOIN suppliers s ON s.id = q.supplier_id`;

/** Malformed stored breaks are ignored, not fatal: a quote with bad JSON still prices at its base price. */
function parseBreaks(json: string | null): PriceBreak[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((b): b is PriceBreak => typeof b?.qty === 'number' && typeof b?.priceIdr === 'number') : [];
  } catch { return []; }
}
const toQuote = ({ breaks, ...q }: QuoteDb): QuoteRow => ({ ...q, priceBreaks: parseBreaks(breaks) });

export async function listQuotes(db: D1Database, meter: Meter, partId: number): Promise<QuoteRow[]> {
  return (await meter.all<QuoteDb>(db.prepare(`${QUOTE_SELECT} WHERE q.part_id = ? ORDER BY q.unit_price_idr`).bind(partId))).map(toQuote);
}

export interface QuoteInput { supplierId: number; seller: string; unitPriceIdr: number; moq: number; priceBreaks: PriceBreak[]; listingShippingIdr: number; leadDays: number | null; risk: Risk; url: string; notes: string }

/** One quote per (part, supplier), as in the sheet's matrix: saving again updates it and restamps `quoted_at`. */
export async function upsertQuote(db: D1Database, meter: Meter, partId: number, q: QuoteInput, now: string): Promise<Outcome<object>> {
  const part = await meter.all<{ id: number }>(db.prepare('SELECT id FROM parts WHERE id = ?').bind(partId));
  if (!part[0]) return refuse(404, `There is no part ${partId}.`);
  const r = await db.prepare(
    `INSERT INTO quotes(part_id, supplier_id, seller, unit_price_idr, moq, price_breaks_json, listing_shipping_idr, lead_days, risk, url, notes, quoted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(part_id, supplier_id) DO UPDATE SET seller = ?3, unit_price_idr = ?4, moq = ?5, price_breaks_json = ?6,
       listing_shipping_idr = ?7, lead_days = ?8, risk = ?9, url = ?10, notes = ?11, quoted_at = ?12`,
  ).bind(partId, q.supplierId, q.seller, q.unitPriceIdr, q.moq, q.priceBreaks.length ? JSON.stringify(q.priceBreaks) : null,
    q.listingShippingIdr, q.leadDays, q.risk, q.url, q.notes, now).run();
  meter.add(r);
  return { ok: true };
}

export async function deleteQuote(db: D1Database, meter: Meter, id: number): Promise<Outcome<object>> {
  const r = await db.prepare('DELETE FROM quotes WHERE id = ?').bind(id).run();
  meter.add(r);
  return r.meta.changes === 1 ? { ok: true } : refuse(404, `There is no quote ${id}.`);
}

// ---- the buy list ----------------------------------------------------------
export interface BuyListData { buyList: BuyList; suppliers: SupplierRow[] }

export async function loadBuyList(db: D1Database, meter: Meter): Promise<BuyListData> {
  const open = `('to_buy', 'ordered', 'covered')`;
  const [needRes, stockRes, quoteRes, supRes] = await db.batch([
    db.prepare(
      `SELECT n.id, n.project_id AS projectId, pr.name AS projectName, n.part_id AS partId, pa.mpn, pa.description, pa.lcsc_code AS lcscCode,
              n.qty_needed AS qtyNeeded, n.spares, n.priority, n.status, n.override_supplier_id AS overrideSupplierId,
              n.ordered_supplier_id AS orderedSupplierId, n.ordered_qty AS orderedQty, n.ordered_total_idr AS orderedTotalIdr, n.rev
         FROM needs n JOIN projects pr ON pr.id = n.project_id JOIN parts pa ON pa.id = n.part_id
        WHERE n.status IN ${open} ORDER BY n.id`),
    db.prepare(
      `SELECT part_id AS partId, SUM(qty_on_hand) AS qty FROM lots
        WHERE condition <> 'faulty' AND part_id IN (SELECT part_id FROM needs WHERE status IN ${open}) GROUP BY part_id`),
    db.prepare(`${QUOTE_SELECT} WHERE q.part_id IN (SELECT part_id FROM needs WHERE status IN ${open})`),
    db.prepare(
      `SELECT id, name, kind, currency, order_shipping_idr AS orderShippingIdr, free_ship_over_idr AS freeShipOverIdr,
              lead_days AS leadDays, url, notes FROM suppliers ORDER BY id`),
  ]);
  for (const r of [needRes!, stockRes!, quoteRes!, supRes!]) meter.add(r);
  const needs = needRes!.results as unknown as Need[];
  const usable = new Map((stockRes!.results as unknown as Array<{ partId: number; qty: number }>).map((r) => [r.partId, r.qty]));
  const quotes = (quoteRes!.results as unknown as QuoteDb[]).map(toQuote);
  const suppliers = supRes!.results as unknown as SupplierRow[];
  return { buyList: computeBuyList({ needs, usableByPart: usable, quotes, suppliers }), suppliers };
}

export interface OrderPlan {
  supplierId: number; supplierName: string;
  lines: Array<{ needId: number; projectName: string; mpn: string; qty: number; totalIdr: number }>;
  groups: Array<{ mpn: string; orderQty: number; unitPriceIdr: number; totalIdr: number }>;
  partsIdr: number; orderShippingIdr: number; grandTotalIdr: number;
}

/** What marking this supplier's lines as ordered would freeze. Pure of side effects: it only reads. */
export function planOrder(data: BuyListData, supplierId: number): OrderPlan | null {
  const sup = data.suppliers.find((s) => s.id === supplierId);
  if (!sup) return null;
  const recap = data.buyList.recap.find((r) => r.supplierId === supplierId)!;
  return {
    supplierId, supplierName: sup.name,
    lines: data.buyList.lines.filter((l) => l.state === 'buy' && l.supplierId === supplierId)
      .map((l) => ({ needId: l.needId, projectName: l.projectName, mpn: l.mpn, qty: l.buyQty, totalIdr: l.lineTotalIdr })),
    groups: data.buyList.groups.filter((g) => g.supplierId === supplierId)
      .map((g) => ({ mpn: g.mpn, orderQty: g.orderQty, unitPriceIdr: g.unitPriceIdr, totalIdr: g.totalIdr })),
    partsIdr: recap.subtotalIdr + recap.listingShippingIdr, orderShippingIdr: recap.orderShippingIdr, grandTotalIdr: recap.totalIdr,
  };
}

/**
 * Freeze these needs as ORDERED with what they cost now. Applied in one
 * statement and only to rows still 'to_buy', so a stale or repeated request
 * cannot re-freeze a line at a newer price.
 */
export async function applyOrder(db: D1Database, meter: Meter, plan: OrderPlan, now: string): Promise<{ ordered: number }> {
  if (plan.lines.length === 0) return { ordered: 0 };
  const json = JSON.stringify(plan.lines.map((l) => ({ id: l.needId, qty: l.qty, total: l.totalIdr })));
  const r = await db.prepare(
    `UPDATE needs SET status = 'ordered', ordered_supplier_id = ?1, ordered_at = ?2,
            ordered_qty = (SELECT json_extract(j.value, '$.qty') FROM json_each(?3) j WHERE json_extract(j.value, '$.id') = needs.id),
            ordered_total_idr = (SELECT json_extract(j.value, '$.total') FROM json_each(?3) j WHERE json_extract(j.value, '$.id') = needs.id),
            rev = rev + 1
      WHERE status = 'to_buy' AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?3))`,
  ).bind(plan.supplierId, now, json).run();
  meter.add(r);
  return { ordered: r.meta.changes };
}
