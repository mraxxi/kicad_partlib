import { costIdrMicro } from '../domain/money';
import { planLcscImport, type ExistingPart, type LcscLine, type Plan, type PlanLine } from '../domain/lcsc';
import { Meter } from './meter';

export interface OrderMeta {
  supplierId: number;
  orderNo: string;
  orderDate: string;
  fxIdrPerUsdMicro: number;
  shippingIdr: number;
  dutiesIdr: number;
}

export async function findSupplierId(db: D1Database, meter: Meter, name: string): Promise<number | null> {
  const rows = await meter.all<{ id: number }>(db.prepare('SELECT id FROM suppliers WHERE name = ?').bind(name));
  return rows[0]?.id ?? null;
}

/**
 * Read-only: gather what the pure planner needs. Set-based via json_each, which
 * keeps it to one subrequest and under D1's 100-bound-parameter ceiling.
 */
/** A buy-list line this import will close, shown in the plan because the owner did not name it. */
export interface NeedToClose { needId: number; projectName: string; mpn: string; qty: number }
export type ImportPlan = Plan & { needsToClose: NeedToClose[] };

export async function buildPlan(
  db: D1Database,
  meter: Meter,
  meta: Pick<OrderMeta, 'supplierId' | 'orderNo'>,
  lines: LcscLine[],
): Promise<ImportPlan> {
  const codes = JSON.stringify(lines.map((l) => l.lcsc));
  const mpns = JSON.stringify(lines.map((l) => l.mpn));
  const [partRes, orderRes] = await db.batch([
    db
      .prepare(
        `SELECT id, mpn, manufacturer, manufacturer_norm AS manufacturerNorm, lcsc_code AS lcscCode
           FROM parts
          WHERE lcsc_code IN (SELECT value FROM json_each(?1))
             OR mpn COLLATE NOCASE IN (SELECT value FROM json_each(?2))`,
      )
      .bind(codes, mpns),
    db
      .prepare(
        `SELECT ol.part_id AS partId FROM order_lines ol
           JOIN orders o ON o.id = ol.order_id
          WHERE o.supplier_id = ?1 AND o.order_no = ?2`,
      )
      .bind(meta.supplierId, meta.orderNo),
  ]);
  meter.add(partRes!);
  meter.add(orderRes!);
  const plan = planLcscImport({
    lines,
    existingParts: partRes!.results as unknown as ExistingPart[],
    existingOrderPartIds: new Set((orderRes!.results as Array<{ partId: number }>).map((r) => r.partId)),
  });
  // Needs marked ORDERED from this supplier for a part on this order: importing the real order closes them.
  const partIds = JSON.stringify(plan.lines.map((l) => l.partId).filter((id): id is number => id !== null));
  const needs = await meter.all<NeedToClose>(
    db.prepare(
      `SELECT n.id AS needId, pr.name AS projectName, pa.mpn, n.ordered_qty AS qty
         FROM needs n JOIN projects pr ON pr.id = n.project_id JOIN parts pa ON pa.id = n.part_id
        WHERE n.status = 'ordered' AND n.ordered_supplier_id = ?1 AND n.part_id IN (SELECT value FROM json_each(?2))`,
    ).bind(meta.supplierId, partIds),
  );
  return { ...plan, needsToClose: needs };
}

// Resolves a line's part: the id when it matched an existing part, otherwise the
// C-number of the part this same batch just created.
export const PART = `COALESCE(json_extract(j.value, '$.part_id'),
                       (SELECT id FROM parts WHERE lcsc_code = json_extract(j.value, '$.lcsc')))`;
const ORDER_ID = `(SELECT id FROM orders WHERE supplier_id = ?2 AND order_no = ?3)`;

/**
 * The statements that make sure every planned line has a part: create the missing ones, set a C-number on a part
 * that matched by MPN and had none, and remember a manufacturer's other spelling as an alias. Shared by the order
 * import and the cart import so a part is created and matched identically either way. All are INSERT OR IGNORE /
 * conditional, so replaying them is harmless.
 */
export function partStatements(db: D1Database, live: PlanLine[], now: string): D1PreparedStatement[] {
  const created = live.filter((l) => l.action === 'create_part');
  const partsJson = JSON.stringify(
    created.map((l) => ({
      mpn: l.line.mpn, manufacturer: l.line.manufacturer, norm: l.manufacturerNorm,
      category: l.category, description: l.line.description === '-' ? '' : l.line.description,
      package: l.line.package === '-' ? '' : l.line.package, value: l.value,
      lcsc: l.line.lcsc, review: l.needsReview ? 1 : 0,
    })),
  );
  const codeJson = JSON.stringify(
    live.filter((l) => l.setLcscCode && l.partId !== null).map((l) => ({ part_id: l.partId, lcsc: l.line.lcsc })),
  );
  const aliasJson = JSON.stringify(
    live.filter((l) => l.manufacturerVariant && l.partId !== null).map((l) => ({ part_id: l.partId, mfr: l.line.manufacturer })),
  );
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO parts(mpn, manufacturer, manufacturer_norm, category_id, description,
                                     package, value, lcsc_code, needs_review, created_at, updated_at)
         SELECT json_extract(j.value,'$.mpn'), json_extract(j.value,'$.manufacturer'), json_extract(j.value,'$.norm'),
                (SELECT id FROM categories WHERE name = json_extract(j.value,'$.category')),
                json_extract(j.value,'$.description'), json_extract(j.value,'$.package'),
                json_extract(j.value,'$.value'), json_extract(j.value,'$.lcsc'),
                json_extract(j.value,'$.review'), ?2, ?2
           FROM json_each(?1) j`,
      )
      .bind(partsJson, now),
    db
      .prepare(
        `UPDATE parts SET lcsc_code = (SELECT json_extract(j.value,'$.lcsc') FROM json_each(?1) j
                                        WHERE json_extract(j.value,'$.part_id') = parts.id),
                          rev = rev + 1, updated_at = ?2
          WHERE lcsc_code IS NULL AND id IN (SELECT json_extract(value,'$.part_id') FROM json_each(?1))`,
      )
      .bind(codeJson, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO part_aliases(part_id, kind, value)
         SELECT json_extract(j.value,'$.part_id'), 'manufacturer', json_extract(j.value,'$.mfr') FROM json_each(?1) j`,
      )
      .bind(aliasJson),
  ];
}

export interface ApplyResult {
  rowsWritten: number;
  rowsRead: number;
}

/**
 * Apply a plan in ONE atomic db.batch(). Idempotent twice over: the order is
 * keyed on (supplier, order_no), a lot on its order line, and a receive move on
 * 'rcv:<order_line_id>', so replaying the same batch after a timeout, or
 * importing the same CSV again, changes nothing. lots.qty_on_hand is recomputed
 * from the ledger rather than incremented, so a replay cannot double-count.
 */
export async function applyLcscImport(
  db: D1Database,
  meter: Meter,
  meta: OrderMeta,
  plan: ImportPlan,
  file: { name: string; sha256: string },
  now: string,
): Promise<ApplyResult> {
  if (plan.errors.length) throw new Error('A plan with errors cannot be applied.');
  const live = plan.lines.filter((l) => l.action !== 'skip_duplicate');
  // Re-importing a file that is already fully in changes nothing, including no log row.
  if (live.length === 0 && plan.needsToClose.length === 0) return { rowsRead: 0, rowsWritten: 0 };
  const before = { r: meter.rowsRead, w: meter.rowsWritten };

  const linesJson = JSON.stringify(
    live.map((l) => ({
      part_id: l.partId, lcsc: l.line.lcsc, qty: l.line.qty,
      unit: l.line.unitPriceMicro, ext: l.line.extPriceMicro, raw: l.line.raw,
      cost: costIdrMicro(l.line.unitPriceMicro, meta.fxIdrPerUsdMicro), date_code: l.line.dateCode || null,
    })),
  );
  const keyed = (sql: string) => db.prepare(sql).bind(linesJson, meta.supplierId, meta.orderNo);

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO orders(supplier_id, order_no, order_date, currency, fx_to_idr_micro,
                                      shipping_idr, duties_idr, status, source_file_sha256)
         VALUES (?1, ?2, ?3, 'USD', ?4, ?5, ?6, 'received', ?7)`,
      )
      .bind(meta.supplierId, meta.orderNo, meta.orderDate, meta.fxIdrPerUsdMicro, meta.shippingIdr, meta.dutiesIdr, file.sha256),
    ...partStatements(db, live, now),
    keyed(
      `INSERT OR IGNORE INTO order_lines(order_id, part_id, qty, unit_price_micro, ext_price_micro, raw_json)
       SELECT ${ORDER_ID}, ${PART}, json_extract(j.value,'$.qty'), json_extract(j.value,'$.unit'),
              json_extract(j.value,'$.ext'), json_extract(j.value,'$.raw')
         FROM json_each(?1) j`,
    ),
    db
      .prepare(
        `INSERT OR IGNORE INTO lots(part_id, source, order_line_id, condition, unit_cost_idr_micro,
                                    date_code, qty_on_hand, created_at)
         SELECT ol.part_id, 'order', ol.id, 'new', json_extract(j.value,'$.cost'),
                json_extract(j.value,'$.date_code'), 0, ?4
           FROM json_each(?1) j
           JOIN order_lines ol ON ol.order_id = ${ORDER_ID} AND ol.part_id = ${PART}`,
      )
      .bind(linesJson, meta.supplierId, meta.orderNo, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO stock_moves(move_id, lot_id, delta, reason, note, at)
         SELECT 'rcv:' || l.order_line_id, l.id, ol.qty, 'receive', ?3, ?4
           FROM lots l JOIN order_lines ol ON ol.id = l.order_line_id
          WHERE ol.order_id = (SELECT id FROM orders WHERE supplier_id = ?1 AND order_no = ?2)`,
      )
      .bind(meta.supplierId, meta.orderNo, `LCSC order ${meta.orderNo}`, now),
    db
      .prepare(
        `UPDATE lots SET qty_on_hand = (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE lot_id = lots.id)
          WHERE order_line_id IN (SELECT id FROM order_lines
                                   WHERE order_id = (SELECT id FROM orders WHERE supplier_id = ?1 AND order_no = ?2))`,
      )
      .bind(meta.supplierId, meta.orderNo),
    db
      .prepare(
        `UPDATE needs SET status = 'received', order_id = (SELECT id FROM orders WHERE supplier_id = ?1 AND order_no = ?2), rev = rev + 1
          WHERE status = 'ordered' AND ordered_supplier_id = ?1
            AND part_id IN (SELECT part_id FROM order_lines WHERE order_id = (SELECT id FROM orders WHERE supplier_id = ?1 AND order_no = ?2))`,
      )
      .bind(meta.supplierId, meta.orderNo),
    db
      .prepare(
        `INSERT INTO import_runs(kind, filename, sha256, rows_in, rows_new, rows_dup, at)
         VALUES ('lcsc', ?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(file.name, file.sha256, plan.summary.total, plan.summary.lotsToCreate, plan.summary.duplicates, now),
  ];

  await meter.batch(db, statements);
  return { rowsRead: meter.rowsRead - before.r, rowsWritten: meter.rowsWritten - before.w };
}
