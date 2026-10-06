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

export interface StoredLine { id: number; key: string; partId: number | null; linkRule: LinkRule | null; status: LineStatus; qty: number }
export interface Candidate { id: number; mpn: string; value: string; package: string; lcscCode: string | null; usableQty: number }
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

export interface BomPlan {
  lines: BomPlanLine[];
  errors: string[];
  warnings: string[];
  summary: { total: number; linked: number; toIdentify: number; dnp: number; added: number; changed: number; removed: number; unchanged: number };
}

export interface BomPlanInput {
  lines: BomLine[];
  existingParts: ExistingPart[];
  /** line key -> part id from any project's earlier manual link ("remembered"). */
  remembered: ReadonlyMap<string, number>;
  stored: readonly StoredLine[];
  candidates: readonly Candidate[];
  /** Part ids that exist (a stored link to a deleted part is dropped, never trusted). */
  partIds: ReadonlySet<number>;
}

const MAX_SUGGESTIONS = 3;

export function suggestFor(line: BomLine, candidates: readonly Candidate[]): Suggestion[] {
  const pkg = packageFromFootprint(line.footprint);
  const want = bomValueSi(line.value, line.refs);
  if (!pkg || !want) return [];
  return candidates
    .filter((c) => c.package === pkg)
    .filter((c) => { const v = valueToSi(c.value); return !!v && v.unit === want.unit && v.si === want.si; })
    .sort((a, b) => b.usableQty - a.usableQty || a.id - b.id)
    .slice(0, MAX_SUGGESTIONS)
    .map((c) => ({ partId: c.id, mpn: c.mpn, lcscCode: c.lcscCode, value: c.value, usableQty: c.usableQty }));
}

export function planBom(input: BomPlanInput): BomPlan {
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
      suggestions: partId === null && status === 'active' ? suggestFor(line, input.candidates) : [],
    });
  }
  for (const s of input.stored) {
    if (seen.has(s.key) || s.status === 'removed') continue;
    out.push({ line: null, key: s.key, action: 'removed', partId: s.partId, linkRule: s.linkRule, status: 'removed', qtyBefore: s.qty, qtyAfter: null, suggestions: [] });
  }

  const live = out.filter((l) => l.action !== 'removed');
  return {
    lines: out, errors: [], warnings,
    summary: {
      total: live.length,
      linked: live.filter((l) => l.partId !== null && l.status === 'active').length,
      toIdentify: live.filter((l) => l.partId === null && l.status === 'active').length,
      dnp: live.filter((l) => l.status === 'dnp').length,
      added: out.filter((l) => l.action === 'new').length,
      changed: out.filter((l) => l.action === 'changed').length,
      removed: out.filter((l) => l.action === 'removed').length,
      unchanged: out.filter((l) => l.action === 'same').length,
    },
  };
}
