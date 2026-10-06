import { familyById } from './families';
import { formatSpec, sortNumber } from './format';
import type { ChainItem, Family, PartSpecs, Preset } from './types';

/** What the owner may change per family; stored in D1 `settings` as `speclayout.<family>`. */
export interface LayoutOverride { order?: string[]; keyCount?: number; presets?: Preset[] }
export interface ResolvedLayout { order: string[]; keyCount: number; presets: Preset[] }

/** Merge the built-in layout with the owner's overrides. Unknown keys are dropped; specs added later are appended. */
export function resolveLayout(family: Family, override?: LayoutOverride | null): ResolvedLayout {
  const known = new Set(family.props.map((p) => p.key));
  const saved = (override?.order ?? []).filter((k) => known.has(k));
  const order = [...saved, ...family.order.filter((k) => !saved.includes(k))];
  const presets = (override?.presets ?? family.presets).map((p) => ({ name: p.name, chain: p.chain.filter((c) => known.has(c.key) || c.key.startsWith('col:')) })).filter((p) => p.chain.length > 0);
  return { order, keyCount: override?.keyCount ?? family.keyCount, presets };
}

export interface Segment { key: string; label: string; text: string }
export interface Summary {
  /** Spec #0: the first available spec in importance order. Never empty if the part has any spec or a title. */
  value: Segment | null;
  /** The next few, ranked; the cell is cut by column width. */
  keys: Segment[];
  /** Every available spec in order, for the tooltip. */
  all: Segment[];
}

export function summarize(specs: PartSpecs | null, layout?: ResolvedLayout | null): Summary {
  const family = specs?.family ? familyById(specs.family) : undefined;
  if (!specs || !family) {
    return { value: specs?.title ? { key: 'title', label: 'LCSC', text: specs.title } : null, keys: [], all: [] };
  }
  const l = layout ?? resolveLayout(family);
  const all: Segment[] = [];
  for (const key of l.order) {
    const def = family.props.find((p) => p.key === key);
    const v = specs.props[key];
    if (def && v) all.push({ key, label: def.label, text: formatSpec(def, v) });
  }
  if (all.length === 0) return { value: specs.title ? { key: 'title', label: 'LCSC', text: specs.title } : null, keys: [], all: [] };
  return { value: all[0]!, keys: all.slice(1, 1 + l.keyCount), all };
}

/**
 * What a spec sorts by: a number, text, or undefined (sorts last). `sortVia` lets colour sort by wavelength.
 * Text specs sort alphabetically.
 */
export function specSortValue(family: Family, specs: PartSpecs | null, key: string): number | string | undefined {
  let def = family.props.find((p) => p.key === key);
  if (!def) return undefined;
  if (def.sortVia) { const via = family.props.find((p) => p.key === def!.sortVia); if (via && specs?.props[via.key]) def = via; }
  const v = specs?.props[def.key];
  if (!v) return undefined;
  return def.kind === 'text' ? v.text : sortNumber(def, v);
}

export type { ChainItem };
