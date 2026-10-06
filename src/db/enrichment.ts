import {
  detectFamily, familyById, formatSpec, mergeSpecs, specsFromDescription, specsFromLcsc, valueFromText,
  type LayoutOverride, type LcscDetail, type PartSpecs, type SpecChange,
} from '../domain/specs';
import { Meter } from './meter';
import { refuse, type Outcome } from './result';

// ---- the raw LCSC snapshot (a cache: refetching replaces it) ----------------------------------------------
export async function storeSnapshot(db: D1Database, meter: Meter, partId: number, status: 'ok' | 'not_listed' | 'error', detail: LcscDetail | null, now: string): Promise<void> {
  const r = await db.prepare(
    `INSERT INTO part_enrichment(part_id, source, status, schema_version, fetched_at, raw_json) VALUES (?1, 'lcsc', ?2, 1, ?3, ?4)
     ON CONFLICT(part_id) DO UPDATE SET status = ?2, schema_version = 1, fetched_at = ?3, raw_json = ?4`,
  ).bind(partId, status, now, detail ? JSON.stringify(detail) : null).run();
  meter.add(r);
}

export async function getSnapshot(db: D1Database, meter: Meter, partId: number): Promise<{ status: string; fetchedAt: string; detail: LcscDetail | null } | null> {
  const row = (await meter.all<{ status: string; fetched_at: string; raw_json: string | null }>(
    db.prepare('SELECT status, fetched_at, raw_json FROM part_enrichment WHERE part_id = ?').bind(partId)))[0];
  if (!row) return null;
  let detail: LcscDetail | null = null;
  try { detail = row.raw_json ? (JSON.parse(row.raw_json) as LcscDetail) : null; } catch { detail = null; }
  return { status: row.status, fetchedAt: row.fetched_at, detail };
}

// ---- a plan: what enrichment WOULD change. Reads only; writes nothing (AGENTS.md rule 10) -------------------
interface PartRow {
  id: number; mpn: string; lcsc_code: string | null; description: string; value: string; rev: number;
  category: string | null; specs: string | null; snap_status: string | null; raw_json: string | null;
}

export interface PlanItem {
  partId: number; mpn: string; lcscCode: string | null; family: string; familyLabel: string;
  /** 'ready' has something to apply; 'unchanged' nothing new; 'not_listed' LCSC lacks it; 'not_fetched' no LCSC record yet; 'no_family' nothing mappable. */
  state: 'ready' | 'unchanged' | 'not_listed' | 'not_fetched' | 'no_family';
  changes: SpecChange[];
  category?: { from: string | null; to: string };
  valueText?: string;
  title?: string;
}

const parseSpecs = (s: string | null): PartSpecs | null => { try { return s ? (JSON.parse(s) as PartSpecs) : null; } catch { return null; } };

function planOne(row: PartRow): PlanItem {
  const existing = parseSpecs(row.specs);
  let detail: LcscDetail | null = null;
  try { detail = row.raw_json ? (JSON.parse(row.raw_json) as LcscDetail) : null; } catch { detail = null; }

  let incoming: PartSpecs | null = null;
  if (detail) incoming = specsFromLcsc(detail, row.category);
  else {
    const fam = existing?.family || detectFamily(undefined, undefined, row.category)?.id;
    if (fam) incoming = specsFromDescription(fam, row.description);
  }
  const base = { partId: row.id, mpn: row.mpn, lcscCode: row.lcsc_code };
  if (!incoming) {
    const state = row.snap_status === 'not_listed' ? 'not_listed' : row.lcsc_code && !row.snap_status ? 'not_fetched' : 'no_family';
    return { ...base, family: existing?.family ?? '', familyLabel: '', state, changes: [] };
  }
  const family = familyById(incoming.family);
  const { changes } = mergeSpecs(existing, incoming);
  const actionable = changes.filter((c) => c.action === 'new' || c.action === 'update');

  // Category: LCSC knows a finer category than "Other"; offer it only where the owner has not chosen one.
  const category = family && (row.category === null || row.category === 'Other') && family.category !== row.category
    ? { from: row.category, to: family.category } : undefined;
  // The plain-text Value column is only filled when empty (it predates specs).
  let valueText: string | undefined;
  if (family && row.value === '' && ['resistor', 'capacitor', 'inductor'].includes(family.id)) {
    const first = family.order.map((k) => ({ k, v: (changes.find((c) => c.key === k)?.to ?? existing?.props[k]) })).find((x) => x.v);
    const def = first && family.props.find((p) => p.key === first.k);
    if (first?.v && def) valueText = formatSpec(def, first.v);
  }
  const ready = actionable.length > 0 || category !== undefined || valueText !== undefined;
  return {
    ...base, family: incoming.family, familyLabel: family?.label ?? '', state: ready ? 'ready' : 'unchanged', changes,
    ...(category ? { category } : {}), ...(valueText ? { valueText } : {}), ...(incoming.title ? { title: incoming.title } : {}),
  };
}

const PLAN_SQL = `SELECT p.id, p.mpn, p.lcsc_code, p.description, p.value, p.rev, c.name AS category, p.specs,
                         e.status AS snap_status, e.raw_json
                    FROM parts p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN part_enrichment e ON e.part_id = p.id
                   WHERE p.id IN (SELECT value FROM json_each(?))`;

async function loadRows(db: D1Database, meter: Meter, partIds: number[]): Promise<PartRow[]> {
  const rows = await meter.all<PartRow>(db.prepare(PLAN_SQL).bind(JSON.stringify(partIds)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return partIds.map((id) => byId.get(id)).filter((r): r is PartRow => !!r);
}

export async function planEnrichment(db: D1Database, meter: Meter, partIds: number[]): Promise<PlanItem[]> {
  return (await loadRows(db, meter, partIds)).map(planOne);
}

export interface Selection { partId: number; keys: string[]; category?: boolean; valueText?: boolean }

/**
 * Apply the SELECTED parts of a fresh plan. The plan is recomputed here from stored data (a client-sent plan is
 * never trusted) and only new/update changes the owner ticked are written; a manual value can never be among them.
 */
export async function applyEnrichment(db: D1Database, meter: Meter, selections: Selection[], now: string): Promise<{ applied: number; specsWritten: number }> {
  const rows = await loadRows(db, meter, selections.map((s) => s.partId));
  const plans = rows.map(planOne);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const statements: D1PreparedStatement[] = [];
  let specsWritten = 0;
  for (const plan of plans) {
    const sel = selections.find((s) => s.partId === plan.partId)!;
    const row = rowById.get(plan.partId)!;
    const existing = parseSpecs(row.specs);
    const chosen = plan.changes.filter((c) => (c.action === 'new' || c.action === 'update') && sel.keys.includes(c.key));
    const wantCategory = !!(sel.category && plan.category);
    const wantValue = !!(sel.valueText && plan.valueText);
    if (chosen.length === 0 && !wantCategory && !wantValue) continue;
    const next: PartSpecs = { v: 1, family: plan.family || existing?.family || '', props: { ...(existing?.props ?? {}) }, ...(plan.title ?? existing?.title ? { title: plan.title ?? existing?.title } : {}) };
    for (const c of chosen) next.props[c.key] = c.to;
    specsWritten += chosen.length;
    statements.push(
      db.prepare(
        `UPDATE parts SET specs = ?1,
                category_id = CASE WHEN ?2 = 1 THEN (SELECT id FROM categories WHERE name = ?3) ELSE category_id END,
                value = CASE WHEN ?4 = 1 THEN ?5 ELSE value END, rev = rev + 1, updated_at = ?6 WHERE id = ?7`,
      ).bind(JSON.stringify(next), wantCategory ? 1 : 0, plan.category?.to ?? null, wantValue ? 1 : 0, plan.valueText ?? null, now, plan.partId),
    );
  }
  for (let i = 0; i < statements.length; i += 50) await meter.batch(db, statements.slice(i, i + 50));
  return { applied: statements.length, specsWritten };
}

// ---- manual edits: the owner's value always wins -----------------------------------------------------------
export async function setManualSpecs(
  db: D1Database, meter: Meter, partId: number, rev: number, edit: { family?: string; set: Record<string, string>; clear: string[] }, now: string,
): Promise<Outcome<{ rev: number }>> {
  const row = (await meter.all<{ rev: number; specs: string | null; category: string | null }>(
    db.prepare('SELECT p.rev, p.specs, c.name AS category FROM parts p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?').bind(partId)))[0];
  if (!row) return refuse(404, `There is no part with id ${partId}.`);
  const existing = parseSpecs(row.specs);
  const familyId = edit.family ?? existing?.family ?? detectFamily(undefined, undefined, row.category)?.id;
  const family = familyId ? familyById(familyId) : undefined;
  if (!family) return refuse(422, 'Choose what kind of part this is before entering specs; its category has no spec layout yet.');
  const props = existing && existing.family === family.id ? { ...existing.props } : { ...(existing?.props ?? {}) };
  for (const [key, text] of Object.entries(edit.set)) {
    const def = family.props.find((p) => p.key === key);
    if (!def) return refuse(422, `"${key}" is not a ${family.label} spec.`);
    const v = valueFromText(def, text, 'manual');
    if (!v) return refuse(422, `Could not read "${text}" as ${def.label}${def.kind === 'text' ? '' : ` (expected ${def.unit === 'none' ? 'a number' : def.unit})`}.`);
    props[key] = v;
  }
  for (const key of edit.clear) delete props[key];
  const next: PartSpecs = { v: 1, family: family.id, ...(existing?.title ? { title: existing.title } : {}), props };
  const res = await db.prepare('UPDATE parts SET specs = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?').bind(JSON.stringify(next), now, partId, rev).run();
  meter.add(res);
  if (res.meta.changes === 1) return { ok: true, rev: rev + 1 };
  return refuse(409, 'This part was changed somewhere else since you opened it; nothing was saved. Reload and try again.', { kind: 'conflict', currentRev: row.rev });
}

// ---- the owner's layouts and presets, shared across machines (D1 settings) ------------------------------------
const KEY = (family: string) => `speclayout.${family}`;

export async function getLayouts(db: D1Database, meter: Meter): Promise<Record<string, LayoutOverride>> {
  const rows = await meter.all<{ key: string; value: string }>(db.prepare("SELECT key, value FROM settings WHERE key LIKE 'speclayout.%'"));
  const out: Record<string, LayoutOverride> = {};
  for (const r of rows) { try { out[r.key.slice('speclayout.'.length)] = JSON.parse(r.value) as LayoutOverride; } catch { /* a corrupt layout falls back to the built-in one */ } }
  return out;
}

export async function putLayout(db: D1Database, meter: Meter, family: string, layout: LayoutOverride): Promise<void> {
  meter.add(await db.prepare('INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(KEY(family), JSON.stringify(layout)).run());
}

export async function resetLayout(db: D1Database, meter: Meter, family: string): Promise<void> {
  meter.add(await db.prepare('DELETE FROM settings WHERE key = ?').bind(KEY(family)).run());
}

/** Parts that have a C-number but no LCSC snapshot yet: what "fetch from LCSC" should visit. */
export async function unfetchedParts(db: D1Database, meter: Meter): Promise<Array<{ id: number; lcscCode: string }>> {
  return meter.all<{ id: number; lcscCode: string }>(db.prepare(
    `SELECT p.id, p.lcsc_code AS lcscCode FROM parts p LEFT JOIN part_enrichment e ON e.part_id = p.id
      WHERE p.lcsc_code IS NOT NULL AND e.part_id IS NULL ORDER BY p.id`));
}
