import { normalizeManufacturer } from '../domain/normalize';
import { partCode, stockStatus, type Condition, type PartSummary, type Source } from '../domain/stock';
import { Meter } from './meter';
import { refuse, type Outcome } from './result';

interface AggRow {
  id: number; mpn: string; manufacturer: string; description: string; package: string; value: string;
  lcsc_code: string | null; needs_review: number; min_qty: number | null; rev: number; category: string | null;
  lot_count: number; total_qty: number; usable_qty: number; real_micro: number; est_micro: number;
  untested_salvage_qty: number; sources: string | null; conditions: string | null; locations: string | null;
}

const split = (s: string | null): string[] => (s ? s.split(',') : []);
const microToIdr = (m: number) => Math.round(m / 1_000_000);

function toSummary(r: AggRow): PartSummary {
  return {
    id: r.id, code: partCode(r.id), mpn: r.mpn, manufacturer: r.manufacturer, description: r.description,
    package: r.package, value: r.value, lcscCode: r.lcsc_code, category: r.category,
    needsReview: r.needs_review === 1, minQty: r.min_qty, rev: r.rev, lotCount: r.lot_count,
    totalQty: r.total_qty, usableQty: r.usable_qty,
    valueRealIdr: microToIdr(r.real_micro), valueEstimatedIdr: microToIdr(r.est_micro),
    untestedSalvageQty: r.untested_salvage_qty,
    sources: split(r.sources) as Source[], conditions: split(r.conditions) as Condition[],
    locations: split(r.locations).sort(),
    status: stockStatus(r.usable_qty, r.min_qty),
  };
}

/**
 * One keyset page of parts with their stock aggregated in a single pass over
 * their lots, so rows read stay proportional to the page (parts + their lots),
 * not to the whole ledger. The browser pages through and filters/sorts locally.
 * Faulty lots are not usable and carry no value.
 */
export async function listParts(db: D1Database, meter: Meter, after: number, limit: number): Promise<{ parts: PartSummary[]; next: number | null }> {
  const rows = await meter.all<AggRow>(
    db
      .prepare(
        `SELECT p.id, p.mpn, p.manufacturer, p.description, p.package, p.value, p.lcsc_code,
                p.needs_review, p.min_qty, p.rev, c.name AS category,
                COUNT(l.id) AS lot_count,
                COALESCE(SUM(l.qty_on_hand), 0) AS total_qty,
                COALESCE(SUM(CASE WHEN l.condition <> 'faulty' THEN l.qty_on_hand END), 0) AS usable_qty,
                COALESCE(SUM(CASE WHEN l.condition <> 'faulty' AND l.source <> 'salvage'
                                  THEN l.qty_on_hand * l.unit_cost_idr_micro END), 0) AS real_micro,
                COALESCE(SUM(CASE WHEN l.condition <> 'faulty' AND l.source = 'salvage'
                                  THEN l.qty_on_hand * l.unit_cost_idr_micro END), 0) AS est_micro,
                COALESCE(SUM(CASE WHEN l.source = 'salvage' AND l.condition = 'untested'
                                  THEN l.qty_on_hand END), 0) AS untested_salvage_qty,
                group_concat(DISTINCT l.source) AS sources,
                group_concat(DISTINCT l.condition) AS conditions,
                group_concat(DISTINCT lo.code) AS locations
           FROM (SELECT * FROM parts WHERE id > ?1 ORDER BY id LIMIT ?2) p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN lots l ON l.part_id = p.id
           LEFT JOIN locations lo ON lo.id = l.location_id
          GROUP BY p.id ORDER BY p.id`,
      )
      .bind(after, limit),
  );
  const parts = rows.map(toSummary);
  return { parts, next: parts.length === limit ? parts[parts.length - 1]!.id : null };
}

export async function listAllParts(db: D1Database, meter: Meter): Promise<PartSummary[]> {
  const out: PartSummary[] = [];
  let after = 0;
  for (;;) {
    const page = await listParts(db, meter, after, 500);
    out.push(...page.parts);
    if (page.next === null) return out;
    after = page.next;
  }
}

export interface LotRow {
  id: number; source: Source; condition: Condition; qtyOnHand: number; unitCostIdrMicro: number;
  dateCode: string | null; locationId: number | null; locationCode: string | null;
  donorCode: string | null; orderNo: string | null; createdAt: string;
}
export interface MoveRow {
  id: number; moveId: string; lotId: number; delta: number; reason: string; note: string; at: string;
}

export async function getPart(db: D1Database, meter: Meter, id: number): Promise<Outcome<{ part: PartSummary & { notes: string; datasheetUrl: string | null; categoryId: number | null }; lots: LotRow[]; moves: MoveRow[] }>> {
  const [partRes, lotRes, moveRes] = await db.batch([
    db.prepare(
      `SELECT p.id, p.mpn, p.manufacturer, p.description, p.package, p.value, p.lcsc_code, p.needs_review,
              p.min_qty, p.rev, p.notes, p.datasheet_url, p.category_id, c.name AS category
         FROM parts p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
    ).bind(id),
    db.prepare(
      `SELECT l.id, l.source, l.condition, l.qty_on_hand AS qtyOnHand, l.unit_cost_idr_micro AS unitCostIdrMicro,
              l.date_code AS dateCode, l.location_id AS locationId, lo.code AS locationCode,
              d.code AS donorCode, o.order_no AS orderNo, l.created_at AS createdAt
         FROM lots l
         LEFT JOIN locations lo ON lo.id = l.location_id
         LEFT JOIN donors d ON d.id = l.donor_id
         LEFT JOIN order_lines ol ON ol.id = l.order_line_id
         LEFT JOIN orders o ON o.id = ol.order_id
        WHERE l.part_id = ? ORDER BY l.id`,
    ).bind(id),
    db.prepare(
      `SELECT m.id, m.move_id AS moveId, m.lot_id AS lotId, m.delta, m.reason, m.note, m.at
         FROM stock_moves m WHERE m.lot_id IN (SELECT id FROM lots WHERE part_id = ?)
        ORDER BY m.at DESC, m.id DESC LIMIT 200`,
    ).bind(id),
  ]);
  meter.add(partRes!); meter.add(lotRes!); meter.add(moveRes!);
  const p = (partRes!.results as unknown as Array<AggRow & { notes: string; datasheet_url: string | null; category_id: number | null }>)[0];
  if (!p) return refuse(404, `There is no part with id ${id}.`);
  const lots = lotRes!.results as unknown as LotRow[];
  const usable = lots.filter((l) => l.condition !== 'faulty');
  const real = usable.filter((l) => l.source !== 'salvage').reduce((n, l) => n + l.qtyOnHand * l.unitCostIdrMicro, 0);
  const est = usable.filter((l) => l.source === 'salvage').reduce((n, l) => n + l.qtyOnHand * l.unitCostIdrMicro, 0);
  const summary = toSummary({
    ...p, lot_count: lots.length, total_qty: lots.reduce((n, l) => n + l.qtyOnHand, 0),
    usable_qty: usable.reduce((n, l) => n + l.qtyOnHand, 0), real_micro: real, est_micro: est,
    untested_salvage_qty: lots.filter((l) => l.source === 'salvage' && l.condition === 'untested').reduce((n, l) => n + l.qtyOnHand, 0),
    sources: [...new Set(lots.map((l) => l.source))].join(','), conditions: [...new Set(lots.map((l) => l.condition))].join(','),
    locations: [...new Set(lots.map((l) => l.locationCode).filter(Boolean))].join(','),
  });
  return { ok: true, part: { ...summary, notes: p.notes, datasheetUrl: p.datasheet_url, categoryId: p.category_id }, lots, moves: moveRes!.results as unknown as MoveRow[] };
}

export interface PartEdit {
  description?: string; package?: string; value?: string; notes?: string;
  datasheetUrl?: string | null; categoryId?: number | null; minQty?: number | null; needsReview?: boolean;
  /** Identity: changing these changes how imports and the buy list recognise the part, so they need confirmation. */
  mpn?: string; manufacturer?: string; lcscCode?: string | null;
}

const COLUMN: Record<keyof PartEdit, string> = {
  description: 'description', package: 'package', value: 'value', notes: 'notes',
  datasheetUrl: 'datasheet_url', categoryId: 'category_id', minQty: 'min_qty', needsReview: 'needs_review',
  mpn: 'mpn', manufacturer: 'manufacturer', lcscCode: 'lcsc_code',
};
const IDENTITY = ['mpn', 'manufacturer', 'lcscCode'] as const;

interface IdentityRow { mpn: string; manufacturer: string; lcsc_code: string | null; rev: number }

/**
 * Edit a part, with two guards.
 *
 * 1. Optimistic concurrency (AGENTS.md rule 3): the UPDATE only lands if `rev` is
 *    still what the editor saw; on a mismatch we refuse and return the CURRENT
 *    values of exactly the fields being edited, so the UI can show a field-level
 *    diff instead of re-sending over another machine's edit.
 * 2. Identity (mpn, manufacturer, C-number) is plan-then-apply (rule 10). Changing
 *    it decides how every future import and buy-list line recognises this part,
 *    and it can collide with another part. Without `confirmIdentity` the call
 *    changes NOTHING and answers with what would change and what is linked to the
 *    part; a collision with an existing part is always refused.
 *
 * Imports never overwrite an existing part's fields (they only ever match it), so
 * an edit made here to fix a broken import survives re-importing the same order.
 * Column names come from the COLUMN constant, never from the request.
 */
export async function updatePart(
  db: D1Database, meter: Meter, id: number, rev: number, edit: PartEdit, now: string, confirmIdentity = false,
): Promise<Outcome<{ rev: number }>> {
  const cur = (await meter.all<IdentityRow>(db.prepare('SELECT mpn, manufacturer, lcsc_code, rev FROM parts WHERE id = ?').bind(id)))[0];
  if (!cur) return refuse(404, `There is no part with id ${id}.`);
  const was: Record<(typeof IDENTITY)[number], string | null> = { mpn: cur.mpn, manufacturer: cur.manufacturer, lcscCode: cur.lcsc_code };

  // An identity field sent back unchanged is not a change.
  const e: PartEdit = { ...edit };
  for (const k of IDENTITY) if (e[k] !== undefined && e[k] === was[k]) delete e[k];
  const changed = IDENTITY.filter((k) => e[k] !== undefined);

  if (changed.length > 0) {
    const mpn = e.mpn ?? cur.mpn;
    const norm = normalizeManufacturer(e.manufacturer ?? cur.manufacturer);
    const lcsc = e.lcscCode !== undefined ? e.lcscCode : cur.lcsc_code;
    const clash = (await meter.all<{ id: number }>(
      db.prepare(`SELECT id FROM parts WHERE id <> ?1 AND ((mpn = ?2 COLLATE NOCASE AND manufacturer_norm = ?3) OR (?4 IS NOT NULL AND lcsc_code = ?4)) LIMIT 1`)
        .bind(id, mpn, norm, lcsc),
    ))[0];
    if (clash) {
      return refuse(409, `That would make this part identical to ${partCode(clash.id)}, which already has that MPN and manufacturer or that C-number. Nothing was changed; edit or remove ${partCode(clash.id)} instead.`,
        { kind: 'collision', partId: clash.id });
    }
    if (!confirmIdentity) {
      const [lots, needs, quotes, lines] = await db.batch([
        db.prepare('SELECT COUNT(*) AS n FROM lots WHERE part_id = ?').bind(id),
        db.prepare('SELECT COUNT(*) AS n FROM needs WHERE part_id = ?').bind(id),
        db.prepare('SELECT COUNT(*) AS n FROM quotes WHERE part_id = ?').bind(id),
        db.prepare('SELECT COUNT(*) AS n FROM order_lines WHERE part_id = ?').bind(id),
      ]);
      for (const r of [lots!, needs!, quotes!, lines!]) meter.add(r);
      const n = (r: D1Result<unknown>) => (r.results[0] as { n: number }).n;
      return refuse(409, 'Changing the MPN, manufacturer or C-number changes how imports and your buy list recognise this part. Nothing was changed yet; confirm to apply.', {
        kind: 'confirm_identity',
        changes: Object.fromEntries(changed.map((k) => [k, { from: was[k], to: e[k] ?? null }])),
        impact: { lots: n(lots!), needs: n(needs!), quotes: n(quotes!), orderLines: n(lines!) },
      });
    }
  }

  const keys = (Object.keys(e) as Array<keyof PartEdit>).filter((k) => e[k] !== undefined);
  if (keys.length === 0) return changed.length === 0 && Object.keys(edit).length > 0 ? { ok: true, rev: cur.rev } : refuse(422, 'Nothing to change: no fields were given.');
  const sets = keys.map((k) => `${COLUMN[k]} = ?`);
  const vals = keys.map((k) => (k === 'needsReview' ? (e.needsReview ? 1 : 0) : (e[k] as string | number | null)));
  if (e.manufacturer !== undefined) { sets.push('manufacturer_norm = ?'); vals.push(normalizeManufacturer(e.manufacturer)); }
  let res: D1Result<unknown>;
  try {
    res = await db.prepare(`UPDATE parts SET ${sets.join(', ')}, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`).bind(...vals, now, id, rev).run();
  } catch (err) {
    // The database's own UNIQUE constraints are the backstop for a race with another machine.
    if (/UNIQUE constraint failed/i.test(String(err))) return refuse(409, 'Another part already has that MPN and manufacturer or that C-number; nothing was changed.', { kind: 'collision' });
    throw err;
  }
  meter.add(res);
  if (res.meta.changes === 1) return { ok: true, rev: rev + 1 };
  const latest = await getPart(db, meter, id);
  if (!latest.ok) return latest;
  const p = latest.part;
  const now_: Record<keyof PartEdit, unknown> = {
    description: p.description, package: p.package, value: p.value, notes: p.notes, datasheetUrl: p.datasheetUrl,
    categoryId: p.categoryId, minQty: p.minQty, needsReview: p.needsReview, mpn: p.mpn, manufacturer: p.manufacturer, lcscCode: p.lcscCode,
  };
  return refuse(409, 'This part was changed somewhere else since you opened it; nothing was saved. Review the current values and save again.', {
    kind: 'conflict', currentRev: p.rev,
    fields: Object.fromEntries(keys.map((k) => [k, { yours: e[k], current: now_[k] }])),
  });
}

export interface NewPart { mpn: string; manufacturer: string; description: string; package: string; value: string; category: string | null; lcscCode: string | null }

/**
 * A part you want to buy but do not own yet (a buy list needs somewhere to point).
 * Identity is (mpn, manufacturer) and, when given, the C-number; creating a part
 * that already exists is refused with its code, not silently duplicated.
 */
export async function createPart(db: D1Database, meter: Meter, p: NewPart, now: string): Promise<Outcome<{ id: number; code: string }>> {
  const norm = normalizeManufacturer(p.manufacturer);
  const dup = await meter.all<{ id: number }>(
    db.prepare(`SELECT id FROM parts WHERE (mpn = ?1 COLLATE NOCASE AND manufacturer_norm = ?2) OR (?3 IS NOT NULL AND lcsc_code = ?3) LIMIT 1`)
      .bind(p.mpn, norm, p.lcscCode),
  );
  if (dup[0]) return refuse(409, `That part already exists as ${partCode(dup[0].id)}.`);
  const r = await db.prepare(
    `INSERT INTO parts(mpn, manufacturer, manufacturer_norm, category_id, description, package, value, lcsc_code, created_at, updated_at)
     VALUES (?1, ?2, ?3, (SELECT id FROM categories WHERE name = ?4), ?5, ?6, ?7, ?8, ?9, ?9)`,
  ).bind(p.mpn, p.manufacturer, norm, p.category, p.description, p.package, p.value, p.lcscCode, now).run();
  meter.add(r);
  return { ok: true, id: r.meta.last_row_id, code: partCode(r.meta.last_row_id) };
}
