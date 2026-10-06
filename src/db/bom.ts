import { DEFAULT_FIELD_MAP, packageFromFootprint, type BomLine, type FieldMap } from '../domain/kicadBom';
import { planBom, prepareCandidates, suggestFor, type BomPlan, type Candidate, type ExistingNeed, type LineStatus, type LinkRule, type StoredLine, type Suggestion } from '../domain/bomPlan';
import type { ExistingPart } from '../domain/lcsc';
import { Meter } from './meter';
import { refuse, type Outcome } from './result';

export const BOM_MAX_LINES = 400;
const CHUNK = 50;

/** Config fails soft: a missing or malformed `bom.fields` setting falls back to the defaults rather than blocking an import. */
export async function loadFieldMap(db: D1Database, meter: Meter): Promise<FieldMap> {
  const row = (await meter.all<{ value: string }>(db.prepare("SELECT value FROM settings WHERE key = 'bom.fields'")))[0];
  try {
    const v = JSON.parse(row?.value ?? '{}') as Partial<FieldMap>;
    const list = (x: unknown, d: string[]) => (Array.isArray(x) && x.every((s) => typeof s === 'string') && x.length ? (x as string[]) : d);
    return { lcsc: list(v.lcsc, DEFAULT_FIELD_MAP.lcsc), mpn: list(v.mpn, DEFAULT_FIELD_MAP.mpn), manufacturer: list(v.manufacturer, DEFAULT_FIELD_MAP.manufacturer) };
  } catch { return DEFAULT_FIELD_MAP; }
}

export async function saveFieldMap(db: D1Database, meter: Meter, map: FieldMap): Promise<void> {
  meter.add(await db.prepare("INSERT INTO settings(key, value) VALUES ('bom.fields', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(JSON.stringify(map)).run());
}

interface Loaded { projectExists: boolean; boards: number | null; sha256: string | null; stored: StoredLine[]; plan: BomPlan }

async function candidatesFor(db: D1Database, meter: Meter, footprints: string[]): Promise<Candidate[]> {
  const pkgs = [...new Set(footprints.map(packageFromFootprint).filter((p): p is string => !!p))];
  if (pkgs.length === 0) return [];
  return meter.all<Candidate>(db.prepare(
    `SELECT p.id, p.mpn, p.value, p.package, p.lcsc_code AS lcscCode,
            COALESCE((SELECT SUM(qty_on_hand) FROM lots l WHERE l.part_id = p.id AND l.condition <> 'faulty'), 0) AS usableQty
       FROM parts p WHERE p.package IN (SELECT value FROM json_each(?)) AND p.value <> '' LIMIT 3000`).bind(JSON.stringify(pkgs)));
}

/** Read-only: gather what the pure planner needs, then plan. Writes nothing. */
export async function buildBomPlan(db: D1Database, meter: Meter, projectId: number, lines: BomLine[], boards: number): Promise<Loaded> {
  const codes = JSON.stringify(lines.map((l) => l.lcsc).filter(Boolean));
  const mpns = JSON.stringify(lines.map((l) => l.mpn).filter(Boolean));
  const keys = JSON.stringify(lines.map((l) => l.key));
  const [projRes, bomRes, partRes, storedRes, remRes, needRes] = await db.batch([
    db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId),
    db.prepare('SELECT boards, sha256 FROM project_bom WHERE project_id = ?').bind(projectId),
    db.prepare(
      `SELECT id, mpn, manufacturer, manufacturer_norm AS manufacturerNorm, lcsc_code AS lcscCode FROM parts
        WHERE lcsc_code IN (SELECT value FROM json_each(?1)) OR mpn COLLATE NOCASE IN (SELECT value FROM json_each(?2))`).bind(codes, mpns),
    db.prepare('SELECT id, line_key AS key, part_id AS partId, link_rule AS linkRule, status, qty, refs, value FROM bom_lines WHERE project_id = ?').bind(projectId),
    db.prepare(
      `SELECT line_key AS key, part_id AS partId, MAX(id) FROM bom_lines
        WHERE link_rule = 'manual' AND part_id IS NOT NULL AND project_id <> ?1 AND line_key IN (SELECT value FROM json_each(?2)) GROUP BY line_key`).bind(projectId, keys),
    db.prepare('SELECT part_id AS partId, qty_needed AS qty, status, bom_owned AS owned FROM needs WHERE project_id = ?').bind(projectId),
  ]);
  for (const r of [projRes!, bomRes!, partRes!, storedRes!, remRes!, needRes!]) meter.add(r);
  const needs = new Map((needRes!.results as unknown as Array<{ partId: number; qty: number; status: ExistingNeed['status']; owned: number }>)
    .map((r): [number, ExistingNeed] => [r.partId, { qty: r.qty, status: r.status, owned: r.owned === 1 }]));
  const stored = storedRes!.results as unknown as StoredLine[];
  const remembered = new Map((remRes!.results as unknown as Array<{ key: string; partId: number }>).map((r) => [r.key, r.partId]));
  const linkedIds = [...new Set([...stored.map((s) => s.partId), ...remembered.values()].filter((x): x is number => x !== null))];
  const idRows = linkedIds.length ? await meter.all<{ id: number }>(db.prepare('SELECT id FROM parts WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(linkedIds))) : [];
  const candidates = await candidatesFor(db, meter, lines.map((l) => l.footprint));
  const bom = (bomRes!.results as unknown as Array<{ boards: number; sha256: string }>)[0];
  return {
    projectExists: (projRes!.results as unknown[]).length === 1, boards: bom?.boards ?? null, sha256: bom?.sha256 ?? null, stored,
    plan: planBom({ lines, existingParts: partRes!.results as unknown as ExistingPart[], remembered, stored, candidates, boards, needs, partIds: new Set(idRows.map((r) => r.id)) }),
  };
}

/**
 * Make the needs the BOM OWNS agree with its lines, for the given parts only: need = pieces per board x boards, summed over
 * active lines. Ownership (`needs.bom_owned`) is what keeps this honest:
 *  - a part with no need yet gets one, owned by the BOM;
 *  - an owned to_buy / covered need follows the BOM's quantity; an owned need the BOM cancelled comes back when its line does;
 *  - an owned to_buy need whose part has no active line left is CANCELLED (reopenable), never deleted;
 *  - a need the owner typed or edited (bom_owned = 0), and any ordered or received need (frozen cost), is never touched.
 * `guard` makes a single-line edit's sync conditional on THIS request's UPDATE having succeeded (it writes a one-off token
 * the guard looks for), so a refused (stale) edit changes nothing here either, in the same atomic batch.
 */
export function syncNeedStatements(db: D1Database, projectId: number, now: string, partIds: number[], guard: { lineId: number; token: string } | null = null): D1PreparedStatement[] {
  const ids = JSON.stringify([...new Set(partIds)]);
  const g = guard ? `AND EXISTS (SELECT 1 FROM bom_lines WHERE id = ?4 AND edit_token = ?5)` : '';
  const gb = guard ? [guard.lineId, guard.token] : [];
  return [
    db.prepare(
      `INSERT INTO needs(project_id, part_id, qty_needed, spares, priority, bom_owned, created_at)
       SELECT ?1, t.part_id, t.total, 0, 'medium', 1, ?2 FROM (
         SELECT b.part_id AS part_id, SUM(b.qty) * (SELECT boards FROM project_bom WHERE project_id = ?1) AS total
           FROM bom_lines b WHERE b.project_id = ?1 AND b.status = 'active' AND b.part_id IN (SELECT value FROM json_each(?3)) GROUP BY b.part_id) t
        WHERE t.total > 0 ${g}
       ON CONFLICT(project_id, part_id) DO UPDATE SET qty_needed = excluded.qty_needed, rev = needs.rev + 1,
              status = CASE WHEN needs.status = 'cancelled' THEN 'to_buy' ELSE needs.status END
        WHERE needs.bom_owned = 1 AND needs.status IN ('to_buy', 'covered', 'cancelled') AND (needs.qty_needed <> excluded.qty_needed OR needs.status = 'cancelled')`,
    ).bind(projectId, now, ids, ...gb),
    db.prepare(
      `UPDATE needs SET status = 'cancelled', rev = rev + 1
        WHERE project_id = ?1 AND bom_owned = 1 AND status = 'to_buy' AND part_id IN (SELECT value FROM json_each(?2))
          AND part_id NOT IN (SELECT part_id FROM bom_lines WHERE project_id = ?1 AND status = 'active' AND part_id IS NOT NULL)
          ${guard ? 'AND EXISTS (SELECT 1 FROM bom_lines WHERE id = ?3 AND edit_token = ?4)' : ''}`,
    ).bind(projectId, ids, ...gb),
  ];
}

/**
 * Apply a BOM plan in ONE atomic batch: the project's BOM record, every line (an upsert keyed on the line key, so a
 * revised BOM keeps the owner's links), lines that vanished marked removed, then the needs recomputed from the lines.
 * The same file with the same board count is a no-op that writes nothing, not even a row saying so.
 */
export async function applyBomPlan(
  db: D1Database, meter: Meter,
  a: { projectId: number; plan: BomPlan; boards: number; file: { name: string; sha256: string }; previous: { boards: number | null; sha256: string | null }; storedPartIds: number[]; now: string },
): Promise<{ rowsWritten: number; unchanged: boolean }> {
  if (a.plan.errors.length) throw new Error('A plan with errors cannot be applied.');
  if (a.previous.sha256 === a.file.sha256 && a.previous.boards === a.boards) return { rowsWritten: 0, unchanged: true };
  const before = meter.rowsWritten;
  const live = a.plan.lines.filter((l) => l.line !== null);
  const rows = live.map((l) => ({
    key: l.key, refs: l.line!.refs.join(', '), qty: l.line!.qty, value: l.line!.value, footprint: l.line!.footprint,
    fields: JSON.stringify(l.line!.raw), part_id: l.partId, rule: l.linkRule, status: l.status,
  }));
  const upsert = db.prepare(
    `INSERT INTO bom_lines(project_id, line_key, refs, qty, value, footprint, fields_json, part_id, link_rule, status)
     SELECT ?1, json_extract(j.value, '$.key'), json_extract(j.value, '$.refs'), json_extract(j.value, '$.qty'), json_extract(j.value, '$.value'),
            json_extract(j.value, '$.footprint'), json_extract(j.value, '$.fields'), json_extract(j.value, '$.part_id'),
            json_extract(j.value, '$.rule'), json_extract(j.value, '$.status') FROM json_each(?2) j WHERE true
     ON CONFLICT(project_id, line_key) DO UPDATE SET refs = excluded.refs, qty = excluded.qty, value = excluded.value, footprint = excluded.footprint,
            fields_json = excluded.fields_json, part_id = excluded.part_id, link_rule = excluded.link_rule, status = excluded.status, rev = bom_lines.rev + 1`);
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO project_bom(project_id, boards, file_name, sha256, imported_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(project_id) DO UPDATE SET boards = ?2, file_name = ?3, sha256 = ?4, imported_at = ?5`,
    ).bind(a.projectId, a.boards, a.file.name, a.file.sha256, a.now),
  ];
  for (let i = 0; i < rows.length; i += CHUNK) statements.push(upsert.bind(a.projectId, JSON.stringify(rows.slice(i, i + CHUNK))));
  statements.push(
    db.prepare(`UPDATE bom_lines SET status = 'removed', rev = rev + 1 WHERE project_id = ?1 AND status <> 'removed' AND line_key NOT IN (SELECT value FROM json_each(?2))`)
      .bind(a.projectId, JSON.stringify(live.map((l) => l.key))),
    // New links AND the parts the stored lines were linked to: a line that moved from part X to part Y must release X's need.
    ...syncNeedStatements(db, a.projectId, a.now, [...a.plan.lines.map((l) => l.partId), ...a.storedPartIds].filter((x): x is number => x !== null)),
  );
  await meter.batch(db, statements);
  return { rowsWritten: meter.rowsWritten - before, unchanged: false };
}

// ---- the stored BOM, for the project page ---------------------------------------------------------------
export interface BomLineView {
  id: number; rev: number; key: string; refs: string; qty: number; value: string; footprint: string; status: LineStatus;
  partId: number | null; linkRule: LinkRule | null; mpn: string | null; lcscCode: string | null; description: string | null; onHand: number;
  suggestions: Suggestion[];
}
export interface BomView { boards: number; fileName: string; importedAt: string; lines: BomLineView[] }

export async function getBom(db: D1Database, meter: Meter, projectId: number): Promise<BomView | null> {
  const [bomRes, lineRes] = await db.batch([
    db.prepare('SELECT boards, file_name AS fileName, imported_at AS importedAt FROM project_bom WHERE project_id = ?').bind(projectId),
    db.prepare(
      `SELECT b.id, b.rev, b.line_key AS key, b.refs, b.qty, b.value, b.footprint, b.status, b.part_id AS partId, b.link_rule AS linkRule,
              p.mpn, p.lcsc_code AS lcscCode, p.description,
              COALESCE((SELECT SUM(l.qty_on_hand) FROM lots l WHERE l.part_id = b.part_id AND l.condition <> 'faulty'), 0) AS onHand
         FROM bom_lines b LEFT JOIN parts p ON p.id = b.part_id WHERE b.project_id = ? AND b.status <> 'removed' ORDER BY b.id`).bind(projectId),
  ]);
  meter.add(bomRes!); meter.add(lineRes!);
  const bom = (bomRes!.results as unknown as Array<{ boards: number; fileName: string; importedAt: string }>)[0];
  if (!bom) return null;
  const rows = lineRes!.results as unknown as Array<Omit<BomLineView, 'suggestions'>>;
  const open = rows.filter((r) => r.partId === null && r.status === 'active');
  const cands = prepareCandidates(open.length ? await candidatesFor(db, meter, open.map((r) => r.footprint)) : []);
  const lines = rows.map((r): BomLineView => ({
    ...r,
    suggestions: r.partId === null && r.status === 'active'
      ? suggestFor({ row: 0, key: r.key, refs: r.refs.split(/,\s*/), qty: r.qty, value: r.value, footprint: r.footprint, lcsc: '', mpn: '', manufacturer: '', dnp: false, raw: {} }, cands) : [],
  }));
  return { ...bom, lines };
}

export interface LineEdit { partId?: number | null; status?: 'active' | 'dnp' | 'ignored' }

/**
 * Edit one line: link it to a part, unlink it, or set DNP / ignored. A named-row edit, so no plan step; `rev` guards a
 * stale save. The needs are recomputed in the same batch, so a link is never visible without its need.
 */
export async function updateBomLine(db: D1Database, meter: Meter, id: number, rev: number, e: LineEdit, now: string): Promise<Outcome<{ rev: number }>> {
  const cur = (await meter.all<{ project_id: number; part_id: number | null; rev: number }>(db.prepare('SELECT project_id, part_id, rev FROM bom_lines WHERE id = ?').bind(id)))[0];
  if (!cur) return refuse(404, `There is no BOM line ${id}.`);
  if (e.partId === undefined && e.status === undefined) return refuse(422, 'Nothing to change: no fields were given.');
  if (e.partId != null) {
    const p = await meter.all<{ id: number }>(db.prepare('SELECT id FROM parts WHERE id = ?').bind(e.partId));
    if (!p[0]) return refuse(404, `There is no part ${e.partId}.`);
  }
  const token = crypto.randomUUID();
  const sets: string[] = ['rev = rev + 1', 'edit_token = ?'];
  const vals: Array<string | number | null> = [token];
  if (e.partId !== undefined) { sets.push('part_id = ?', 'link_rule = ?'); vals.push(e.partId, e.partId === null ? null : 'manual'); }
  if (e.status !== undefined) { sets.push('status = ?'); vals.push(e.status); }
  const results = await meter.batch(db, [
    db.prepare(`UPDATE bom_lines SET ${sets.join(', ')} WHERE id = ? AND rev = ?`).bind(...vals, id, rev),
    // Only the parts this line touches (its old and new link), and only if the revision check passed.
    ...syncNeedStatements(db, cur.project_id, now, [cur.part_id, e.partId].filter((x): x is number => typeof x === 'number'), { lineId: id, token }),
  ]);
  if (results[0]!.meta.changes === 1) return { ok: true, rev: rev + 1 };
  return refuse(409, 'This BOM line was changed somewhere else since you loaded it; nothing was saved. Reload and try again.', { currentRev: cur.rev });
}
