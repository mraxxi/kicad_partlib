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
  datasheetUrl?: string | null; categoryId?: number | null; minQty?: number | null;
}

const COLUMN: Record<keyof PartEdit, string> = {
  description: 'description', package: 'package', value: 'value', notes: 'notes',
  datasheetUrl: 'datasheet_url', categoryId: 'category_id', minQty: 'min_qty',
};

/**
 * Optimistic concurrency (AGENTS.md rule 3): the UPDATE only lands if `rev` is
 * still what the editor saw. On a mismatch we refuse and return the CURRENT
 * values of exactly the fields being edited, so the UI can show a field-level
 * diff instead of silently re-sending over the other machine's edit. The
 * column names come from the COLUMN constant, never from the request.
 */
export async function updatePart(db: D1Database, meter: Meter, id: number, rev: number, edit: PartEdit, now: string): Promise<Outcome<{ rev: number }>> {
  const keys = (Object.keys(edit) as Array<keyof PartEdit>).filter((k) => edit[k] !== undefined);
  if (keys.length === 0) return refuse(422, 'Nothing to change: no fields were given.');
  const sets = keys.map((k) => `${COLUMN[k]} = ?`).join(', ');
  const res = await db
    .prepare(`UPDATE parts SET ${sets}, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
    .bind(...keys.map((k) => edit[k] as string | number | null), now, id, rev)
    .run();
  meter.add(res);
  if (res.meta.changes === 1) return { ok: true, rev: rev + 1 };
  const cur = await getPart(db, meter, id);
  if (!cur.ok) return cur;
  const p = cur.part;
  const now_: Record<keyof PartEdit, unknown> = {
    description: p.description, package: p.package, value: p.value, notes: p.notes,
    datasheetUrl: p.datasheetUrl, categoryId: p.categoryId, minQty: p.minQty,
  };
  return refuse(409, 'This part was changed somewhere else since you opened it; nothing was saved. Review the current values and save again.', {
    currentRev: p.rev,
    fields: Object.fromEntries(keys.map((k) => [k, { yours: edit[k], current: now_[k] }])),
  });
}
