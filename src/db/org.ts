import { Meter } from './meter';
import { refuse, type Outcome } from './result';

export interface LocationRow { id: number; code: string; name: string; lotCount: number; units: number }

export async function listLocations(db: D1Database, meter: Meter): Promise<LocationRow[]> {
  return meter.all<LocationRow>(
    db.prepare(
      `SELECT lo.id, lo.code, lo.name, COUNT(l.id) AS lotCount, COALESCE(SUM(l.qty_on_hand), 0) AS units
         FROM locations lo LEFT JOIN lots l ON l.location_id = lo.id GROUP BY lo.id ORDER BY lo.code`,
    ),
  );
}

const UNIQUE = /UNIQUE constraint failed/i;

export async function createLocation(db: D1Database, meter: Meter, code: string, name: string): Promise<Outcome<{ id: number }>> {
  try {
    const r = await db.prepare('INSERT INTO locations(code, name) VALUES (?, ?)').bind(code, name).run();
    meter.add(r);
    return { ok: true, id: r.meta.last_row_id };
  } catch (e) {
    if (UNIQUE.test(String(e))) return refuse(409, `A location with the code "${code}" already exists.`);
    throw e;
  }
}

export async function updateLocation(db: D1Database, meter: Meter, id: number, code: string, name: string): Promise<Outcome<object>> {
  try {
    const r = await db.prepare('UPDATE locations SET code = ?, name = ? WHERE id = ?').bind(code, name, id).run();
    meter.add(r);
    return r.meta.changes === 1 ? { ok: true } : refuse(404, `There is no location ${id}.`);
  } catch (e) {
    if (UNIQUE.test(String(e))) return refuse(409, `A location with the code "${code}" already exists.`);
    throw e;
  }
}

/** Refuses while any lot is stored there: deleting would silently orphan stock. */
export async function deleteLocation(db: D1Database, meter: Meter, id: number): Promise<Outcome<object>> {
  const used = (await meter.all<{ n: number }>(db.prepare('SELECT COUNT(*) AS n FROM lots WHERE location_id = ?').bind(id)))[0]!.n;
  if (used > 0) return refuse(409, `This location still holds ${used} lot${used === 1 ? '' : 's'}; move them elsewhere before deleting it.`);
  const r = await db.prepare('DELETE FROM locations WHERE id = ?').bind(id).run();
  meter.add(r);
  return r.meta.changes === 1 ? { ok: true } : refuse(404, `There is no location ${id}.`);
}

export interface DonorRow {
  id: number; code: string; device: string; receivedAt: string | null; condition: string;
  status: 'stripping' | 'done' | 'parked'; notes: string; partLines: number; unitsHarvested: number; estValueIdr: number;
}

export async function listDonors(db: D1Database, meter: Meter): Promise<DonorRow[]> {
  const rows = await meter.all<Omit<DonorRow, 'estValueIdr'> & { estMicro: number }>(
    db.prepare(
      `SELECT d.id, d.code, d.device, d.received_at AS receivedAt, d.condition, d.status, d.notes,
              COUNT(l.id) AS partLines, COALESCE(SUM(l.qty_on_hand), 0) AS unitsHarvested,
              COALESCE(SUM(CASE WHEN l.condition <> 'faulty' THEN l.qty_on_hand * l.unit_cost_idr_micro END), 0) AS estMicro
         FROM donors d LEFT JOIN lots l ON l.donor_id = d.id GROUP BY d.id ORDER BY d.code`,
    ),
  );
  return rows.map(({ estMicro, ...r }) => ({ ...r, estValueIdr: Math.round(estMicro / 1_000_000) }));
}

export interface DonorInput { code: string; device: string; receivedAt: string | null; condition: string; status: DonorRow['status']; notes: string }

export async function createDonor(db: D1Database, meter: Meter, d: DonorInput): Promise<Outcome<{ id: number }>> {
  try {
    const r = await db
      .prepare('INSERT INTO donors(code, device, received_at, condition, status, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(d.code, d.device, d.receivedAt, d.condition, d.status, d.notes)
      .run();
    meter.add(r);
    return { ok: true, id: r.meta.last_row_id };
  } catch (e) {
    if (UNIQUE.test(String(e))) return refuse(409, `A donor board with the code "${d.code}" already exists.`);
    throw e;
  }
}

export async function updateDonor(db: D1Database, meter: Meter, id: number, d: DonorInput): Promise<Outcome<object>> {
  try {
    const r = await db
      .prepare('UPDATE donors SET code = ?, device = ?, received_at = ?, condition = ?, status = ?, notes = ? WHERE id = ?')
      .bind(d.code, d.device, d.receivedAt, d.condition, d.status, d.notes, id)
      .run();
    meter.add(r);
    return r.meta.changes === 1 ? { ok: true } : refuse(404, `There is no donor board ${id}.`);
  } catch (e) {
    if (UNIQUE.test(String(e))) return refuse(409, `A donor board with the code "${d.code}" already exists.`);
    throw e;
  }
}
