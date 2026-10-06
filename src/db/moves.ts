import type { Condition } from '../domain/stock';
import { Meter } from './meter';
import { refuse, type Outcome } from './result';

export type MoveReason = 'consume' | 'adjust' | 'scrap';

interface LotQty { id: number; qty_on_hand: number }

async function lotQty(db: D1Database, meter: Meter, lotId: number): Promise<LotQty | null> {
  return (await meter.all<LotQty>(db.prepare('SELECT id, qty_on_hand FROM lots WHERE id = ?').bind(lotId)))[0] ?? null;
}

async function moveExists(db: D1Database, meter: Meter, moveId: string): Promise<boolean> {
  return (await meter.all<{ x: number }>(db.prepare('SELECT 1 AS x FROM stock_moves WHERE move_id = ?').bind(moveId))).length > 0;
}

/**
 * The ONLY function that changes a lot's quantity after creation. It appends one
 * move and recomputes lots.qty_on_hand as SUM(delta) for that lot (never
 * `qty + delta`), in one atomic batch. Two properties follow:
 *   - a retried request (same moveId) is a no-op that reports the current
 *     quantity, so a timeout can be retried blindly;
 *   - qty_on_hand can never drift from the ledger through this path.
 * The lots CHECK (qty_on_hand >= 0) is the backstop; the read below exists to
 * turn it into a sentence the owner can act on.
 */
export async function applyMove(
  db: D1Database, meter: Meter,
  m: { moveId: string; lotId: number; delta: number; reason: MoveReason; note: string; at: string },
): Promise<Outcome<{ qtyOnHand: number; duplicate: boolean }>> {
  const lot = await lotQty(db, meter, m.lotId);
  if (!lot) return refuse(404, `There is no lot ${m.lotId}.`);
  if (await moveExists(db, meter, m.moveId)) return { ok: true, qtyOnHand: lot.qty_on_hand, duplicate: true };
  if (lot.qty_on_hand + m.delta < 0) {
    return refuse(409, `Cannot take ${-m.delta}: lot ${m.lotId} has only ${lot.qty_on_hand} on hand.`);
  }
  const [, , after] = await meter.batch(db, [
    db.prepare(`INSERT OR IGNORE INTO stock_moves(move_id, lot_id, delta, reason, note, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(m.moveId, m.lotId, m.delta, m.reason, m.note, m.at),
    db.prepare(`UPDATE lots SET qty_on_hand = (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE lot_id = ?1) WHERE id = ?1`)
      .bind(m.lotId),
    db.prepare('SELECT qty_on_hand FROM lots WHERE id = ?').bind(m.lotId),
  ]);
  return { ok: true, qtyOnHand: (after!.results[0] as { qty_on_hand: number }).qty_on_hand, duplicate: false };
}

/**
 * A stocktake: "I counted N". Stored as the DELTA to the ledger's number at the
 * moment of counting (AGENTS.md rule 2 history: an absolute count made replay
 * order-dependent), with both numbers kept in the note so shrinkage is reportable.
 */
export async function countLot(
  db: D1Database, meter: Meter, a: { moveId: string; lotId: number; countedQty: number; note: string; at: string },
): Promise<Outcome<{ qtyOnHand: number; duplicate: boolean }>> {
  const lot = await lotQty(db, meter, a.lotId);
  if (!lot) return refuse(404, `There is no lot ${a.lotId}.`);
  if (await moveExists(db, meter, a.moveId)) return { ok: true, qtyOnHand: lot.qty_on_hand, duplicate: true };
  const delta = a.countedQty - lot.qty_on_hand;
  if (delta === 0) return refuse(409, `Lot ${a.lotId} already has ${lot.qty_on_hand} on hand; there is nothing to adjust.`);
  const note = `Counted ${a.countedQty}, ledger said ${lot.qty_on_hand}.${a.note ? ' ' + a.note : ''}`;
  return applyMove(db, meter, { moveId: a.moveId, lotId: a.lotId, delta, reason: 'adjust', note, at: a.at });
}

export interface LotMeta { condition?: Condition; locationId?: number | null }

/**
 * Change where a lot is, or what state it is in. For the WHOLE lot that is not a
 * quantity change, so it writes no move. For PART of a lot (3 of the 10 turned
 * out faulty; 5 of them went to another drawer) the lot is split: a new lot is
 * created and the pieces move across as a matched pair of 'transfer' moves, so
 * quantity history stays complete and the two lots stay homogeneous.
 */
export async function reclassifyLot(
  db: D1Database, meter: Meter,
  a: { moveId: string; lotId: number; qty: number; meta: LotMeta; note: string; at: string },
): Promise<Outcome<{ lotId: number; split: boolean; duplicate: boolean }>> {
  const dup = await meter.all<{ id: number }>(db.prepare('SELECT id FROM lots WHERE create_key = ?').bind(a.moveId));
  if (dup[0]) return { ok: true, lotId: dup[0].id, split: true, duplicate: true };
  const lot = await lotQty(db, meter, a.lotId);
  if (!lot) return refuse(404, `There is no lot ${a.lotId}.`);
  if (a.meta.condition === undefined && a.meta.locationId === undefined) return refuse(422, 'Say what to change: a condition, a location, or both.');
  if (a.qty > lot.qty_on_hand) return refuse(409, `Cannot move ${a.qty}: lot ${a.lotId} has only ${lot.qty_on_hand} on hand.`);

  const setLoc = a.meta.locationId !== undefined;
  if (a.qty === lot.qty_on_hand) {
    const res = await db
      .prepare(`UPDATE lots SET condition = COALESCE(?1, condition),
                                location_id = CASE WHEN ?2 = 1 THEN ?3 ELSE location_id END WHERE id = ?4`)
      .bind(a.meta.condition ?? null, setLoc ? 1 : 0, a.meta.locationId ?? null, a.lotId)
      .run();
    meter.add(res);
    return { ok: true, lotId: a.lotId, split: false, duplicate: false };
  }

  const newLot = `(SELECT id FROM lots WHERE create_key = ?1)`;
  await meter.batch(db, [
    db.prepare(
      `INSERT OR IGNORE INTO lots(part_id, source, order_line_id, donor_id, condition, location_id,
                                  unit_cost_idr_micro, date_code, qty_on_hand, created_at, create_key)
       SELECT part_id, source, NULL, donor_id, COALESCE(?3, condition),
              CASE WHEN ?4 = 1 THEN ?5 ELSE location_id END, unit_cost_idr_micro, date_code, 0, ?6, ?1
         FROM lots WHERE id = ?2`,
    ).bind(a.moveId, a.lotId, a.meta.condition ?? null, setLoc ? 1 : 0, a.meta.locationId ?? null, a.at),
    db.prepare(`INSERT OR IGNORE INTO stock_moves(move_id, lot_id, delta, reason, note, at) VALUES (?1 || ':out', ?2, ?3, 'transfer', ?4, ?5)`)
      .bind(a.moveId, a.lotId, -a.qty, a.note, a.at),
    db.prepare(`INSERT OR IGNORE INTO stock_moves(move_id, lot_id, delta, reason, note, at) SELECT ?1 || ':in', ${newLot}, ?2, 'transfer', ?3, ?4`)
      .bind(a.moveId, a.qty, a.note, a.at),
    db.prepare(`UPDATE lots SET qty_on_hand = (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE lot_id = lots.id)
                 WHERE id = ?2 OR id = ${newLot}`).bind(a.moveId, a.lotId),
  ]);
  const created = (await meter.all<{ id: number }>(db.prepare('SELECT id FROM lots WHERE create_key = ?').bind(a.moveId)))[0];
  return { ok: true, lotId: created!.id, split: true, duplicate: false };
}

/** Stock that exists but did not come from an order or a donor: found in a drawer, a gift, a recount of unknown parts. */
export async function addManualLot(
  db: D1Database, meter: Meter,
  a: { moveId: string; partId: number; qty: number; condition: Condition; locationId: number | null; unitCostIdr: number; note: string; at: string },
): Promise<Outcome<{ lotId: number; duplicate: boolean }>> {
  const dup = await meter.all<{ id: number }>(db.prepare('SELECT id FROM lots WHERE create_key = ?').bind(a.moveId));
  if (dup[0]) return { ok: true, lotId: dup[0].id, duplicate: true };
  const part = await meter.all<{ id: number }>(db.prepare('SELECT id FROM parts WHERE id = ?').bind(a.partId));
  if (!part[0]) return refuse(404, `There is no part ${a.partId}.`);
  await meter.batch(db, [
    db.prepare(
      `INSERT OR IGNORE INTO lots(part_id, source, condition, location_id, unit_cost_idr_micro, qty_on_hand, created_at, create_key)
       VALUES (?2, 'manual', ?3, ?4, ?5, 0, ?6, ?1)`,
    ).bind(a.moveId, a.partId, a.condition, a.locationId, a.unitCostIdr * 1_000_000, a.at),
    db.prepare(`INSERT OR IGNORE INTO stock_moves(move_id, lot_id, delta, reason, note, at)
                SELECT ?1, id, ?2, 'receive', ?3, ?4 FROM lots WHERE create_key = ?1`).bind(a.moveId, a.qty, a.note, a.at),
    db.prepare(`UPDATE lots SET qty_on_hand = (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE lot_id = lots.id)
                 WHERE create_key = ?1`).bind(a.moveId),
  ]);
  const lot = (await meter.all<{ id: number }>(db.prepare('SELECT id FROM lots WHERE create_key = ?').bind(a.moveId)))[0];
  return { ok: true, lotId: lot!.id, duplicate: false };
}
