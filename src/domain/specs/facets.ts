import { formatSpec, sortNumber } from './format';
import type { Family, PartSpecs } from './types';

/**
 * Faceted filtering for the Parts table: "which footprints do I have a 10uF in?" / "which capacitances do I have
 * in 0805?". Pure, no I/O. A facet is one filterable field; the owner ticks values (any-of within a facet,
 * all-of across facets). Each facet's list counts the rows that match every OTHER facet's selection, so the lists
 * answer the question instead of showing everything that exists.
 */
export const NONE_KEY = '-';
const PKG_ID = 'pkg';
/** URL parameter for a facet: footprint is `pkg`, a spec is `sp.<key>`. */
export const facetParam = (id: string): string => (id === PKG_ID ? PKG_ID : `sp.${id}`);

export interface FacetValue { key: string; label: string; sort?: number | string }
export interface FacetSource<T> { id: string; label: string; of(item: T): FacetValue | null }
export type Selection = Record<string, readonly string[]>;
export interface FacetOption { key: string; label: string; count: number }

/** 4 significant figures: the precision formatSpec prints, so "10uF" from a description and "10µF" from LCSC agree. */
const round = (x: number): string => String(Number(x.toPrecision(4)));

/** One spec as a facet. A condition (Rds(on) @10V vs @4.5V) is part of the key: those numbers are not comparable. */
export function specSource(family: Family, key: string): FacetSource<{ specs: PartSpecs | null }> | null {
  const def = family.props.find((p) => p.key === key);
  if (!def) return null;
  return {
    id: key, label: def.label,
    of: ({ specs }) => {
      const v = specs?.props[key];
      if (!v) return null;
      const label = formatSpec(def, v);
      const cond = v.cond ? `@${v.cond.toLowerCase()}` : '';
      if (v.text !== undefined) return { key: `${v.text.trim().toLowerCase()}${cond}`, label, sort: label.toLowerCase() };
      if (def.kind === 'range' && v.min !== undefined && v.max !== undefined) return { key: `${round(v.min)}~${round(v.max)}${cond}`, label, sort: sortNumber(def, v) };
      const n = sortNumber(def, v);
      return n === undefined ? null : { key: `${round(n)}${cond}`, label, sort: n };
    },
  };
}

/** Footprint is not a spec: it is the part's own package text, offered in every view. */
export function packageSource<T extends { package: string }>(): FacetSource<T> {
  return { id: PKG_ID, label: 'Footprint', of: (p) => { const t = p.package.trim(); return t ? { key: t.toLowerCase(), label: t, sort: t } : null; } };
}

const keyOf = <T>(src: FacetSource<T>, item: T): string => src.of(item)?.key ?? NONE_KEY;

/** Does the item pass every facet's selection (except `except`, used to count a facet against the others)? */
export function matchesFacets<T>(item: T, sources: readonly FacetSource<T>[], sel: Selection, except?: string): boolean {
  return sources.every((s) => {
    const picked = sel[s.id];
    return s.id === except || !picked || picked.length === 0 || picked.includes(keyOf(s, item));
  });
}

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const order = (a: FacetValue | undefined, b: FacetValue | undefined): number => {
  const x = a?.sort, y = b?.sort;
  if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
  return typeof x === 'number' && typeof y === 'number' ? x - y : natural.compare(String(x), String(y));
};

/**
 * The checklist for one facet: every value present among rows that pass the other facets, with its count, in spec
 * order (100nF before 10µF before 22µF). A selected value with no rows left stays listed at 0 so it can be unticked.
 * "(none)" collects rows with no value, so un-enriched parts are visible instead of silently hidden.
 */
export function facetOptions<T>(items: readonly T[], src: FacetSource<T>, sources: readonly FacetSource<T>[], sel: Selection): FacetOption[] {
  const seen = new Map<string, FacetValue>(); // label per key, from every row, so a zero-count selection keeps its name
  const counts = new Map<string, number>();
  for (const item of items) {
    const v = src.of(item);
    const key = v?.key ?? NONE_KEY;
    if (v && !seen.has(key)) seen.set(key, v);
    if (matchesFacets(item, sources, sel, src.id)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = new Set([...counts.keys(), ...(sel[src.id] ?? [])]);
  const out: FacetOption[] = [];
  for (const key of keys) out.push({ key, label: key === NONE_KEY ? '(none)' : seen.get(key)?.label ?? key, count: counts.get(key) ?? 0 });
  return out.sort((a, b) => (a.key === NONE_KEY ? 1 : b.key === NONE_KEY ? -1 : order(seen.get(a.key), seen.get(b.key))));
}
