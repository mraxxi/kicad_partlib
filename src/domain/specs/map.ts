import { parseQuantity, type Quantity } from '../quantity';
import { detectFamily, familyById } from './families';
import { SRC_RANK, type Family, type LcscDetail, type PartSpecs, type SpecDef, type SpecValue, type Src } from './types';

// ---------------------------------------------------------------------------------------------------------
// From LCSC's labelled parameters. The label says what a value MEANS ("Quiescent Current"); this code owns the
// numbers. A value in a unit the spec does not expect is refused, never guessed.
// ---------------------------------------------------------------------------------------------------------
function fromQuantity(def: SpecDef, raw: string, alts: Quantity[], src: Src): SpecValue | null {
  const a = alts[0];
  if (!a) return null;
  if (def.kind === 'number') {
    if (a.kind !== 'num' || a.unit !== (def.unit ?? 'none')) return null;
    return { n: a.n, unit: a.unit, raw, ...(a.cond ? { cond: a.cond } : {}), ...(a.count !== undefined ? { count: a.count } : {}), src };
  }
  if (def.kind === 'range') {
    if (a.kind === 'range' && a.unit === (def.unit ?? 'none')) return { min: a.min, max: a.max, unit: a.unit, raw, ...(a.cond ? { cond: a.cond } : {}), src };
    if (a.kind === 'num' && a.unit === (def.unit ?? 'none')) return { min: a.n, max: a.n, unit: a.unit, raw, src };
    return null;
  }
  return null;
}

export function extractFromLcsc(def: SpecDef, d: LcscDetail): SpecValue | null {
  if (def.derive) return def.derive(d);
  for (const label of def.lcsc) {
    const raw = d.params.find((p) => p.name === label)?.value?.trim();
    if (!raw || raw === '-') continue;
    if (def.kind === 'text') return { text: raw, raw, src: 'lcsc' };
    const alts = parseQuantity(raw);
    const v = alts && fromQuantity(def, raw, alts, 'lcsc');
    if (v) return v;
  }
  return null;
}

/** Map a stored LCSC record onto the family's specs. A part in an unmapped family keeps only its LCSC title. */
export function specsFromLcsc(d: LcscDetail, ownerCategory: string | null): PartSpecs {
  const family = detectFamily(d.catalog, d.parentCatalog, ownerCategory);
  const title = (d.intro ?? d.desc ?? '').trim() || undefined;
  const specs: PartSpecs = { v: 1, family: family?.id ?? '', ...(title ? { title } : {}), props: {} };
  if (!family) return specs;
  for (const def of family.props) { const v = extractFromLcsc(def, d); if (v) specs.props[def.key] = v; }
  return specs;
}

// ---------------------------------------------------------------------------------------------------------
// From the description text, for resistors, capacitors and inductors. Offline and deterministic: this fills
// parts that have no LCSC record (no C-number, or LCSC no longer lists them) from text already stored.
// ---------------------------------------------------------------------------------------------------------
const UNIT = String.raw`[pnuµμmkKMG]?`;
const find = (text: string, re: RegExp): string | undefined => re.exec(text)?.[1];

function tryNum(def: SpecDef, token: string | undefined): SpecValue | null {
  if (!token) return null;
  const alts = parseQuantity(token.trim());
  return alts ? fromQuantity(def, token.trim(), alts, 'description') : null;
}

export function specsFromDescription(familyId: string, description: string): PartSpecs | null {
  const family = familyById(familyId);
  if (!family || !['resistor', 'capacitor', 'inductor'].includes(family.id)) return null;
  const text = description.replace(/Ω/g, 'Ω');
  const get = (key: string) => family.props.find((p) => p.key === key)!;
  const props: Record<string, SpecValue | null> = {};
  const tol = find(text, /(±\s?\d+(?:\.\d+)?%)/);
  const volts = find(text, /(?:^|[\s,])(\d+(?:\.\d+)?V)(?=\s|$|,)/);
  if (family.id === 'resistor') {
    props.resistance = tryNum(get('resistance'), find(text, new RegExp(String.raw`(?:^|\s)(\d+(?:\.\d+)?${UNIT}Ω)(?=\s|$)`)));
    props.power = tryNum(get('power'), find(text, new RegExp(String.raw`(?:^|\s)(\d+(?:\.\d+)?m?W)(?=\s|$)`)));
    props.tolerance = tryNum(get('tolerance'), tol);
    props.voltage = tryNum(get('voltage'), volts);
    props.tempco = tryNum(get('tempco'), find(text, /(±\s?\d+ppm\/℃)/)?.replace(/\s/g, ''));
    const tech = find(text, /(Thick Film|Thin Film|Carbon Film|Metal Film|Metal Oxide|Wirewound)/i);
    props.technology = tech ? { text: `${tech} Resistor`, raw: tech, src: 'description' } : null;
  } else if (family.id === 'capacitor') {
    props.capacitance = tryNum(get('capacitance'), find(text, new RegExp(String.raw`(?:^|\s)(\d+(?:\.\d+)?${UNIT}F)(?=\s|$)`)));
    props.voltage = tryNum(get('voltage'), volts);
    props.tolerance = tryNum(get('tolerance'), tol);
    const die = find(text, /\b(X7R|X5R|X6S|X7S|X8R|C0G|COG|NP0|Y5V|Z5U)\b/i);
    props.dielectric = die ? { text: die.toUpperCase().replace('COG', 'C0G'), raw: die, src: 'description' } : null;
  } else {
    props.inductance = tryNum(get('inductance'), find(text, new RegExp(String.raw`(?:^|\s)(\d+(?:\.\d+)?${UNIT}H)(?=\s|$)`)));
    const amps = [...text.matchAll(/(?:^|\s)(\d+(?:\.\d+)?m?A)(?=\s|$)/g)].map((m) => m[1]!);
    props.current = tryNum(get('current'), amps[0]);     // first current in an LCSC inductor line is the rated current
    props.isat = tryNum(get('isat'), amps[1]);           // the second, when present, is the saturation current
    props.dcr = tryNum(get('dcr'), find(text, new RegExp(String.raw`(?:^|\s)(\d+(?:\.\d+)?${UNIT}Ω)(?=\s|$)`)));
    props.tolerance = tryNum(get('tolerance'), tol);
  }
  const out: Record<string, SpecValue> = {};
  for (const [k, v] of Object.entries(props)) if (v) out[k] = v;
  return Object.keys(out).length ? { v: 1, family: family.id, props: out } : null;
}

// ---------------------------------------------------------------------------------------------------------
// Merging. Precedence: manual > lcsc > description. A manual value is never overwritten.
// ---------------------------------------------------------------------------------------------------------
export interface SpecChange {
  key: string;
  action: 'new' | 'update' | 'same' | 'kept';
  from?: SpecValue;
  to: SpecValue;
  /** Why an incoming value was not applied ("kept"): it is lower-ranked than, and differs from, what is there. */
  reason?: string;
}

const sameValue = (a: SpecValue, b: SpecValue): boolean =>
  a.n === b.n && a.min === b.min && a.max === b.max && a.text === b.text && a.cond === b.cond && a.count === b.count && a.unit === b.unit;

export function mergeSpecs(existing: PartSpecs | null, incoming: PartSpecs): { next: PartSpecs; changes: SpecChange[] } {
  const props: Record<string, SpecValue> = { ...(existing?.props ?? {}) };
  const changes: SpecChange[] = [];
  for (const [key, to] of Object.entries(incoming.props)) {
    const from = existing?.props[key];
    if (!from) { props[key] = to; changes.push({ key, action: 'new', to }); continue; }
    if (sameValue(from, to)) { changes.push({ key, action: 'same', from, to }); continue; }
    if (SRC_RANK[to.src] >= SRC_RANK[from.src] && from.src !== 'manual') { props[key] = to; changes.push({ key, action: 'update', from, to }); continue; }
    changes.push({ key, action: 'kept', from, to, reason: from.src === 'manual' ? 'you set this by hand' : `${from.src} data outranks ${to.src}` });
  }
  const title = incoming.title ?? existing?.title;
  return { next: { v: 1, family: incoming.family || existing?.family || '', ...(title ? { title } : {}), props }, changes };
}

/** A family's props that this part has values for, in importance order. */
export function availableKeys(family: Family, specs: PartSpecs | null, order: readonly string[] = family.order): string[] {
  return order.filter((k) => specs?.props[k]);
}
