import { bomValueSi, packageFromFootprint, type BomLine } from './kicadBom';
import { mpnKey, type ExistingPart } from './lcsc';
import { normalizeManufacturer, valueToSi } from './normalize';

/**
 * Plan a BOM import: pure, so planning writes nothing and apply recomputes it server-side. Matching reuses the
 * order and cart imports' identity (C-number, then (MPN, manufacturer_norm)), so a part is found the same way
 * wherever it arrives. A BOM often has no manufacturer, so an MPN alone matches only when exactly one part has it.
 * Value + package SUGGEST a part but never link one: a wrong guess would silently buy or skip the wrong thing.
 */
export type LinkRule = 'lcsc' | 'mpn' | 'remembered' | 'manual';
export type LineStatus = 'active' | 'dnp' | 'ignored' | 'removed';

export interface StoredLine { id: number; key: string; partId: number | null; linkRule: LinkRule | null; status: LineStatus; qty: number; refs: string; value: string }
export interface Candidate { id: number; mpn: string; value: string; package: string; lcscCode: string | null; usableQty: number }
/** Candidate parts grouped by package with their value parsed ONCE: suggesting must not re-parse per line x candidate (10 ms CPU). */
export type PreparedCandidates = Map<string, Array<Candidate & { si: number; unit: string }>>;
export function prepareCandidates(candidates: readonly Candidate[]): PreparedCandidates {
  const out: PreparedCandidates = new Map();
  for (const c of candidates) {
    const v = valueToSi(c.value);
    if (!v) continue;
    const list = out.get(c.package) ?? [];
    // Rounded to 12 digits like bomValueSi: "100nF" is 1.0000000000000001e-7 as a float and never equals the BOM's "100n" otherwise
    // (found on a real BOM, where no capacitor was ever suggested).
    list.push({ ...c, si: Number(v.si.toPrecision(12)), unit: v.unit });
    out.set(c.package, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.usableQty - a.usableQty || a.id - b.id);
  return out;
}

export interface Suggestion { partId: number; mpn: string; lcscCode: string | null; value: string; usableQty: number }

export type BomAction = 'new' | 'same' | 'changed' | 'removed';

export interface BomPlanLine {
  line: BomLine | null;
  key: string;
  action: BomAction;
  partId: number | null;
  linkRule: LinkRule | null;
  status: LineStatus;
  /** Per-board quantity before / after, when the line existed. */
  qtyBefore: number | null;
  qtyAfter: number | null;
  suggestions: Suggestion[];
}

/** The need a part already has in this project, as far as the BOM import cares. `owned`: the BOM created it (needs.bom_owned). */
export interface ExistingNeed { qty: number; status: 'to_buy' | 'ordered' | 'received' | 'covered' | 'cancelled'; owned: boolean }

/**
 * What the import would do to a project's needs, one entry per part it touches or disagrees about.
 *  create   no need yet: the BOM makes one (and owns it).
 *  update   a need the BOM owns changes quantity.   reopen  a need the BOM cancelled comes back.   cancel  a BOM-owned to-buy need
 *  has no active line left.   hand  a need you typed or edited has a different quantity: YOURS IS KEPT.   locked  an ordered or
 *  received need differs: frozen, kept.   same  nothing to do.
 */
export type NeedAction = 'create' | 'update' | 'reopen' | 'cancel' | 'hand' | 'locked' | 'same';
export interface NeedChange { partId: number; label: string; action: NeedAction; current: number | null; /** The existing need's status, when there is one. */ status: ExistingNeed['status'] | null; bom: number }

export interface BomPlan {
  needs: NeedChange[];
  lines: BomPlanLine[];
  errors: string[];
  warnings: string[];
  summary: { total: number; linked: number; toIdentify: number; dnp: number; added: number; changed: number; removed: number; unchanged: number; needsCreated: number; needsChanged: number; needsKept: number };
}

export interface BomPlanInput {
  lines: BomLine[];
  existingParts: ExistingPart[];
  /** line key -> part id from any project's earlier manual link ("remembered"). */
  remembered: ReadonlyMap<string, number>;
  stored: readonly StoredLine[];
  candidates: readonly Candidate[];
  boards: number;
  /** partId -> the project's existing need for it. */
  needs: ReadonlyMap<number, ExistingNeed>;
  /** Part ids that exist (a stored link to a deleted part is dropped, never trusted). */
  partIds: ReadonlySet<number>;
}

const MAX_SUGGESTIONS = 3;

export function suggestFor(line: BomLine, candidates: PreparedCandidates): Suggestion[] {
  const pkg = packageFromFootprint(line.footprint);
  const want = bomValueSi(line.value, line.refs);
  if (!pkg || !want) return [];
  return (candidates.get(pkg) ?? [])
    .filter((c) => c.unit === want.unit && c.si === want.si)
    .slice(0, MAX_SUGGESTIONS)
    .map((c) => ({ partId: c.id, mpn: c.mpn, lcscCode: c.lcscCode, value: c.value, usableQty: c.usableQty }));
}

export function planBom(input: BomPlanInput): BomPlan {
  const prepared = prepareCandidates(input.candidates);
  const byLcsc = new Map<string, ExistingPart>();
  const byIdentity = new Map<string, ExistingPart>();
  const byMpn = new Map<string, ExistingPart[]>();
  for (const p of input.existingParts) {
    if (p.lcscCode) byLcsc.set(p.lcscCode.toUpperCase(), p);
    byIdentity.set(mpnKey(p.mpn, p.manufacturerNorm), p);
    const k = p.mpn.toLowerCase();
    byMpn.set(k, [...(byMpn.get(k) ?? []), p]);
  }
  const stored = new Map(input.stored.map((s) => [s.key, s]));
  const warnings: string[] = [];
  const out: BomPlanLine[] = [];
  const seen = new Set<string>();

  for (const line of input.lines) {
    seen.add(line.key);
    const old = stored.get(line.key);
    let partId: number | null = null;
    let rule: LinkRule | null = null;

    if (old?.partId != null && old.linkRule === 'manual' && input.partIds.has(old.partId)) { partId = old.partId; rule = 'manual'; }
    if (partId === null && line.lcsc) { const p = byLcsc.get(line.lcsc); if (p) { partId = p.id; rule = 'lcsc'; } }
    if (partId === null && line.mpn) {
      const exact = line.manufacturer ? byIdentity.get(mpnKey(line.mpn, normalizeManufacturer(line.manufacturer))) : undefined;
      const loose = byMpn.get(line.mpn.toLowerCase());
      const p = exact ?? (!line.manufacturer && loose?.length === 1 ? loose[0] : undefined);
      if (p) { partId = p.id; rule = 'mpn'; }
      else if (!line.manufacturer && loose && loose.length > 1) warnings.push(`Row ${line.row} (${line.refs[0]}): ${line.mpn} matches ${loose.length} parts with different manufacturers, so it was not linked; pick the right one.`);
    }
    if (partId === null && old?.partId != null && old.linkRule && input.partIds.has(old.partId)) { partId = old.partId; rule = old.linkRule; }
    if (partId === null) { const r = input.remembered.get(line.key); if (r !== undefined && input.partIds.has(r)) { partId = r; rule = 'remembered'; } }

    const status: LineStatus = old && old.status !== 'removed' ? old.status : line.dnp ? 'dnp' : 'active';
    let action: BomAction;
    if (!old) action = 'new';
    else if (old.qty !== line.qty || old.status === 'removed' || old.partId !== partId) action = 'changed';
    else action = 'same';
    out.push({
      line, key: line.key, action, partId, linkRule: rule, status,
      qtyBefore: old?.qty ?? null, qtyAfter: line.qty,
      suggestions: partId === null && status === 'active' ? suggestFor(line, prepared) : [],
    });
  }
  for (const s of input.stored) {
    if (seen.has(s.key) || s.status === 'removed') continue;
    out.push({ line: null, key: s.key, action: 'removed', partId: s.partId, linkRule: s.linkRule, status: 'removed', qtyBefore: s.qty, qtyAfter: null, suggestions: [] });
  }

  // ---- needs: what the BOM may change, and where it must leave your numbers alone ----
  const totals = new Map<number, { qty: number; label: string }>();
  for (const l of out) {
    if (!l.line || l.status !== 'active' || l.partId === null) continue;
    const t = totals.get(l.partId) ?? { qty: 0, label: `${l.line.refs.slice(0, 3).join(', ')}${l.line.refs.length > 3 ? '…' : ''} (${l.line.value || l.line.footprint})` };
    t.qty += l.line.qty * input.boards;
    totals.set(l.partId, t);
  }
  const needs: NeedChange[] = [];
  for (const [partId, t] of totals) {
    const cur = input.needs.get(partId);
    let action: NeedAction;
    if (!cur) action = 'create';
    else if (!cur.owned) action = cur.qty === t.qty && cur.status !== 'cancelled' ? 'same' : 'hand';
    else if (cur.status === 'ordered' || cur.status === 'received') action = cur.qty === t.qty ? 'same' : 'locked';
    else if (cur.status === 'cancelled') action = 'reopen';
    else action = cur.qty === t.qty ? 'same' : 'update';
    needs.push({ partId, label: t.label, action, current: cur?.qty ?? null, status: cur?.status ?? null, bom: t.qty });
    if (action === 'hand') warnings.push(cur!.status === 'cancelled'
      ? `${t.label}: you cancelled the need for ${cur!.qty} (set by you) and the BOM says ${t.qty}; it stays cancelled.`
      : `${t.label}: you need ${cur!.qty} (set by you) and the BOM says ${t.qty}; your number is kept.`);
    if (action === 'locked') warnings.push(`${t.label}: already ${cur!.status} for ${cur!.qty} and the BOM now says ${t.qty}; the ${cur!.status} quantity is frozen and not changed.`);
  }
  for (const s of input.stored) {
    if (s.status !== 'active' || s.partId === null || totals.has(s.partId)) continue;
    const cur = input.needs.get(s.partId);
    if (cur?.owned && cur.status === 'to_buy') needs.push({ partId: s.partId, label: `${s.refs.split(/,\s*/).slice(0, 3).join(', ')} (${s.value || s.key})`, action: 'cancel', current: cur.qty, status: cur.status, bom: 0 });
  }

  const live = out.filter((l) => l.action !== 'removed');
  return {
    needs, lines: out, errors: [], warnings,
    summary: {
      total: live.length,
      linked: live.filter((l) => l.partId !== null && l.status === 'active').length,
      toIdentify: live.filter((l) => l.partId === null && l.status === 'active').length,
      dnp: live.filter((l) => l.status === 'dnp').length,
      added: out.filter((l) => l.action === 'new').length,
      changed: out.filter((l) => l.action === 'changed').length,
      removed: out.filter((l) => l.action === 'removed').length,
      unchanged: out.filter((l) => l.action === 'same').length,
      needsCreated: needs.filter((n) => n.action === 'create').length,
      needsChanged: needs.filter((n) => ['update', 'reopen', 'cancel'].includes(n.action)).length,
      needsKept: needs.filter((n) => n.action === 'hand' || n.action === 'locked').length,
    },
  };
}
