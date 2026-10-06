/**
 * The Parts table's column order: defaults, the saved layout, and moving a column. Pure (no React, no storage
 * access beyond the strings handed in) so it is tested like chain.ts. Ids, never positions, are saved.
 */
export const BASE_ORDER = ['code', 'mpn', 'lcsc', 'value', 'keyspecs', 'package', 'category', 'manufacturer', 'description', 'lots', 'usable', 'total', 'min', 'status', 'locations', 'worth'];
export const PINNED = ['code', 'mpn'];
export const DEFAULT_HIDDEN = ['manufacturer', 'lots', 'total', 'min'];
export const LAYOUT_KEY = 'partlib.layout.parts.v3';
/** v2 put LCSC # after Footprint; it is upgraded once (see upgradeV2) so a saved layout keeps its widths. */
export const LEGACY_LAYOUT_KEY = 'partlib.layout.parts.v2';

export interface Layout { visibility: Record<string, boolean>; order: string[]; sizing: Record<string, number> }

const known = (id: string) => BASE_ORDER.includes(id) || id.startsWith('spec:');
const defaultVisibility = () => Object.fromEntries(DEFAULT_HIDDEN.map((id) => [id, false]));

/** Pinned columns first, unknown ids dropped, base columns added since the layout was saved appended. */
export function normalizeOrder(saved: readonly string[]): string[] {
  const s = saved.filter((id, i) => known(id) && saved.indexOf(id) === i && !PINNED.includes(id));
  return [...PINNED, ...s, ...BASE_ORDER.filter((id) => !s.includes(id) && !PINNED.includes(id))];
}

/** The v2 -> v3 upgrade: LCSC # moves to just after MPN (the owner's request); every other choice is kept. */
export function upgradeV2(v2: Partial<Layout>): Partial<Layout> {
  if (!v2.order?.length) return v2;
  return { ...v2, order: [...PINNED, 'lcsc', ...v2.order.filter((id) => id !== 'lcsc' && !PINNED.includes(id))] };
}

/** Read the saved layout (v3, else an upgraded v2, else defaults). Config fails soft: bad JSON means defaults. */
export function parseLayout(v3: string | null, v2: string | null): Layout {
  let v: Partial<Layout> = {};
  try {
    if (v3) v = JSON.parse(v3) as Partial<Layout>;
    else if (v2) v = upgradeV2(JSON.parse(v2) as Partial<Layout>);
  } catch { v = {}; }
  if (typeof v !== 'object' || v === null) v = {};
  return {
    visibility: { ...defaultVisibility(), ...(v.visibility ?? {}) },
    order: normalizeOrder(Array.isArray(v.order) ? v.order.filter((x): x is string => typeof x === 'string') : []),
    sizing: v.sizing ?? {},
  };
}

export const defaultLayout = (): Layout => ({ visibility: defaultVisibility(), order: [...BASE_ORDER], sizing: {} });

/**
 * Move `id` to just before or after `target` in `ids` (the table's current leaf order). Pinned columns never
 * move and nothing lands in front of them; an unknown id or target leaves the order as it was.
 */
export function moveColumn(ids: readonly string[], id: string, target: string, side: 'before' | 'after'): string[] {
  if (id === target || PINNED.includes(id) || !ids.includes(id) || !ids.includes(target)) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const firstFree = rest.filter((x) => PINNED.includes(x)).length;
  const at = Math.max(firstFree, rest.indexOf(target) + (side === 'after' ? 1 : 0));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** One step left (-1) or right (+1), for the arrow buttons that stay for touch screens and keyboards. */
export function stepColumn(ids: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || PINNED.includes(id) || j < 0 || j >= ids.length || PINNED.includes(ids[j]!)) return [...ids];
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
