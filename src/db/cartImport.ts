import { planCart, type CartLine, type CartPlan, type ExistingQuote } from '../domain/lcscCart';
import type { ExistingPart } from '../domain/lcsc';
import { PART, partStatements } from './lcscImport';
import { Meter } from './meter';

export interface CartTarget {
  /** Exactly one of these names the project; the other is null. */
  projectId: number | null;
  newProjectName: string | null;
}

/** Read-only: gather what the pure planner needs, then plan. Writes nothing. */
export async function buildCartPlan(
  db: D1Database, meter: Meter,
  a: { lines: CartLine[]; target: CartTarget; lcscSupplierId: number; fxIdrPerUsdMicro: number; updateQuotes: boolean },
): Promise<{ plan: CartPlan; projectName: string | null; projectExists: boolean }> {
  const codes = JSON.stringify(a.lines.map((l) => l.lcsc));
  const mpns = JSON.stringify(a.lines.map((l) => l.mpn));
  const project = a.target.projectId !== null
    ? (await meter.all<{ id: number; name: string }>(db.prepare('SELECT id, name FROM projects WHERE id = ?').bind(a.target.projectId)))[0]
    : (await meter.all<{ id: number; name: string }>(db.prepare('SELECT id, name FROM projects WHERE name = ?').bind(a.target.newProjectName)))[0];

  const [partRes] = await db.batch([
    db.prepare(
      `SELECT id, mpn, manufacturer, manufacturer_norm AS manufacturerNorm, lcsc_code AS lcscCode FROM parts
        WHERE lcsc_code IN (SELECT value FROM json_each(?1)) OR mpn COLLATE NOCASE IN (SELECT value FROM json_each(?2))`,
    ).bind(codes, mpns),
  ]);
  meter.add(partRes!);
  const existingParts = partRes!.results as unknown as ExistingPart[];
  const ids = JSON.stringify(existingParts.map((p) => p.id));

  const [needRes, quoteRes, stockRes] = await db.batch([
    db.prepare('SELECT part_id AS partId, qty_needed AS qty FROM needs WHERE project_id = ?1 AND part_id IN (SELECT value FROM json_each(?2))').bind(project?.id ?? -1, ids),
    db.prepare(`SELECT part_id AS partId, unit_price_idr AS price, moq, price_breaks_json IS NOT NULL AS breaks FROM quotes WHERE supplier_id = ?1 AND part_id IN (SELECT value FROM json_each(?2))`).bind(a.lcscSupplierId, ids),
    db.prepare(`SELECT part_id AS partId, SUM(qty_on_hand) AS qty FROM lots WHERE condition <> 'faulty' AND part_id IN (SELECT value FROM json_each(?1)) GROUP BY part_id`).bind(ids),
  ]);
  for (const r of [needRes!, quoteRes!, stockRes!]) meter.add(r);

  const plan = planCart({
    lines: a.lines, existingParts,
    existingNeeds: new Map((needRes!.results as Array<{ partId: number; qty: number }>).map((r) => [r.partId, r.qty])),
    existingQuotes: new Map((quoteRes!.results as Array<{ partId: number; price: number; moq: number; breaks: number }>).map((r): [number, ExistingQuote] => [r.partId, { unitPriceIdr: r.price, moq: r.moq, hasBreaks: r.breaks === 1 }])),
    usable: new Map((stockRes!.results as Array<{ partId: number; qty: number }>).map((r) => [r.partId, r.qty])),
    fxIdrPerUsdMicro: a.fxIdrPerUsdMicro, updateQuotes: a.updateQuotes,
  });
  return { plan, projectName: project?.name ?? a.target.newProjectName, projectExists: !!project };
}

/**
 * Apply a cart plan in ONE atomic batch: the project (if new), any missing parts, one need per line, and an LCSC
 * quote from the cart's price and MOQ. Every statement is OR IGNORE or an upsert, so importing the same cart twice
 * changes nothing; an existing need keeps its quantity; an existing quote with price breaks is never flattened.
 */
export async function applyCartPlan(
  db: D1Database, meter: Meter,
  a: { plan: CartPlan; projectName: string; projectExists: boolean; priority: string; lcscSupplierId: number; file: { name: string; sha256: string; alias: string }; now: string },
): Promise<{ rowsWritten: number }> {
  const { plan } = a;
  if (plan.errors.length) throw new Error('A plan with errors cannot be applied.');
  const before = meter.rowsWritten;
  const live = plan.lines.map((l) => l.part);
  const needsJson = JSON.stringify(plan.lines.filter((l) => l.need.action === 'create').map((l) => ({ part_id: l.part.partId, lcsc: l.line.lcsc, qty: l.line.qty })));
  const quotesJson = JSON.stringify(plan.lines.filter((l) => l.quote.action === 'create' || l.quote.action === 'update').map((l) => ({
    part_id: l.part.partId, lcsc: l.line.lcsc, price: l.quote.unitPriceIdr, moq: l.quote.moq,
    note: `From an LCSC cart export: $${(l.line.unitPriceMicro / 1e6).toFixed(4)} each at ${l.line.qty} pcs${l.line.multiple > 1 ? `, sold in multiples of ${l.line.multiple}` : ''}.`,
    url: `https://www.lcsc.com/product-detail/${l.line.lcsc}.html`,
  })));
  const creates = plan.summary.newParts + plan.summary.needsToCreate + plan.summary.quotesToWrite;
  if (creates === 0 && a.projectExists && !live.some((l) => l.setLcscCode)) return { rowsWritten: 0 };

  const statements: D1PreparedStatement[] = [
    ...(a.projectExists ? [] : [db.prepare(`INSERT OR IGNORE INTO projects(name, status, notes, created_at) VALUES (?1, 'active', 'Created by a cart import.', ?2)`).bind(a.projectName, a.now)]),
    ...partStatements(db, live, a.now),
    db.prepare(
      `INSERT OR IGNORE INTO needs(project_id, part_id, qty_needed, spares, priority, created_at)
       SELECT (SELECT id FROM projects WHERE name = ?1), ${PART}, json_extract(j.value, '$.qty'), 0, ?2, ?3 FROM json_each(?4) j`,
    ).bind(a.projectName, a.priority, a.now, needsJson),
    db.prepare(
      `INSERT INTO quotes(part_id, supplier_id, seller, unit_price_idr, moq, price_breaks_json, listing_shipping_idr, lead_days, risk, url, notes, quoted_at)
       SELECT ${PART}, ?1, '', json_extract(j.value, '$.price'), json_extract(j.value, '$.moq'), NULL, 0, NULL, 'low',
              json_extract(j.value, '$.url'), json_extract(j.value, '$.note'), ?2 FROM json_each(?3) j WHERE true
       ON CONFLICT(part_id, supplier_id) DO UPDATE SET unit_price_idr = excluded.unit_price_idr, moq = excluded.moq,
              notes = excluded.notes, quoted_at = excluded.quoted_at`,
    ).bind(a.lcscSupplierId, a.now, quotesJson),
    db.prepare(`INSERT INTO import_runs(kind, filename, sha256, rows_in, rows_new, rows_dup, at, alias) VALUES ('lcsc-cart', ?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(a.file.name, a.file.sha256, plan.summary.total, plan.summary.needsToCreate, plan.summary.needsExisting, a.now, a.file.alias),
  ];
  await meter.batch(db, statements);
  return { rowsWritten: meter.rowsWritten - before };
}
