import { planHarvest, type HarvestItem, type HarvestLine } from '../domain/harvest';
import { Meter } from './meter';
import { refuse, type Outcome } from './result';

/**
 * Record parts stripped from a donor board: find-or-create each part, one
 * salvaged lot per line, one 'salvage' move per lot, all in ONE atomic batch.
 * Lots are keyed `<harvestId>:<line index>` (lots.create_key, UNIQUE), so a
 * retried request after a timeout cannot create a second set of lots.
 * Cost is the owner's ESTIMATE of value (whole IDR -> micro-IDR); reports keep
 * it apart from money actually spent.
 */
export async function harvest(
  db: D1Database, meter: Meter,
  a: { harvestId: string; donorId: number; items: HarvestItem[]; at: string },
): Promise<Outcome<{ lots: number; newParts: number; duplicate: boolean }>> {
  const donor = await meter.all<{ code: string }>(db.prepare('SELECT code FROM donors WHERE id = ?').bind(a.donorId));
  if (!donor[0]) return refuse(404, `There is no donor board ${a.donorId}.`);
  const already = await meter.all<{ n: number }>(db.prepare(`SELECT COUNT(*) AS n FROM lots WHERE create_key LIKE ? ESCAPE '\\'`).bind(`${a.harvestId}:%`));
  if (already[0]!.n > 0) return { ok: true, lots: already[0]!.n, newParts: 0, duplicate: true };

  const mpns = JSON.stringify(a.items.map((i) => i.mpn));
  const known = await meter.all<{ id: number; mpn: string; manufacturerNorm: string }>(
    db.prepare(`SELECT id, mpn, manufacturer_norm AS manufacturerNorm FROM parts WHERE mpn COLLATE NOCASE IN (SELECT value FROM json_each(?))`).bind(mpns),
  );
  const plan = planHarvest(a.items, known);
  if (plan.errors.length) return refuse(422, plan.errors.join(' '));

  const view = (l: HarvestLine) => ({
    part_id: l.partId, mpn: l.item.mpn, manufacturer: l.item.manufacturer, norm: l.manufacturerNorm,
    category: l.item.category ?? 'Other', description: l.item.description, qty: l.item.qty,
    condition: l.item.condition, location_id: l.item.locationId, cost: l.item.estUnitValueIdr * 1_000_000,
  });
  const created = plan.lines.filter((l) => l.action === 'create_part');
  // Same new part on two lines of one harvest: the second INSERT OR IGNORE is a no-op and both lots resolve to the one row.
  const partsJson = JSON.stringify(created.map(view));
  const linesJson = JSON.stringify(plan.lines.map(view));
  const PART = `COALESCE(json_extract(j.value,'$.part_id'),
                 (SELECT id FROM parts WHERE mpn = json_extract(j.value,'$.mpn') COLLATE NOCASE
                                         AND manufacturer_norm = json_extract(j.value,'$.norm')))`;
  const keys = `SELECT ?1 || ':' || key FROM json_each(?2)`;

  await meter.batch(db, [
    db.prepare(
      `INSERT OR IGNORE INTO parts(mpn, manufacturer, manufacturer_norm, category_id, description, needs_review, created_at, updated_at)
       SELECT json_extract(j.value,'$.mpn'), json_extract(j.value,'$.manufacturer'), json_extract(j.value,'$.norm'),
              (SELECT id FROM categories WHERE name = json_extract(j.value,'$.category')),
              json_extract(j.value,'$.description'), 1, ?2, ?2
         FROM json_each(?1) j`,
    ).bind(partsJson, a.at),
    db.prepare(
      `INSERT OR IGNORE INTO lots(part_id, source, donor_id, condition, location_id, unit_cost_idr_micro, qty_on_hand, created_at, create_key)
       SELECT ${PART}, 'salvage', ?3, json_extract(j.value,'$.condition'), json_extract(j.value,'$.location_id'),
              json_extract(j.value,'$.cost'), 0, ?4, ?1 || ':' || j.key
         FROM json_each(?2) j`,
    ).bind(a.harvestId, linesJson, a.donorId, a.at),
    db.prepare(
      `INSERT OR IGNORE INTO stock_moves(move_id, lot_id, delta, reason, note, at)
       SELECT l.create_key, l.id, json_extract(j.value,'$.qty'), 'salvage', ?3, ?4
         FROM json_each(?2) j JOIN lots l ON l.create_key = ?1 || ':' || j.key`,
    ).bind(a.harvestId, linesJson, `Salvaged from ${donor[0].code}`, a.at),
    db.prepare(
      `UPDATE lots SET qty_on_hand = (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE lot_id = lots.id)
        WHERE create_key IN (${keys})`,
    ).bind(a.harvestId, linesJson),
  ]);
  return { ok: true, lots: plan.lines.length, newParts: created.length, duplicate: false };
}
