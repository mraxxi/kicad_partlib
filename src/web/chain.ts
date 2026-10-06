import type { SortingState } from '@tanstack/react-table';
import { CORE_SORT_KEYS, type ChainItem, type Family } from '../domain/specs';

/** Sort-chain keys are spec keys or `col:<name>`; table column ids are `spec:<family>:<key>` or the column's own id. */
export const specColumnId = (family: string, key: string): string => `spec:${family}:${key}`;
const CORE_TO_COLUMN: Record<string, string> = { 'col:value': 'value', 'col:package': 'package', 'col:mpn': 'mpn', 'col:usable': 'usable' };
const COLUMN_TO_CORE = Object.fromEntries(Object.entries(CORE_TO_COLUMN).map(([k, v]) => [v, k]));

export function chainToSorting(family: Family, chain: ChainItem[]): SortingState {
  return chain.map((c) => ({ id: CORE_TO_COLUMN[c.key] ?? specColumnId(family.id, c.key), desc: c.dir === 'desc' }));
}

/** The part of the current sorting a chain can describe (spec columns and the core columns it knows). */
export function sortingToChain(family: Family, sorting: SortingState): ChainItem[] {
  const prefix = `spec:${family.id}:`;
  const out: ChainItem[] = [];
  for (const s of sorting) {
    if (s.id.startsWith(prefix)) out.push({ key: s.id.slice(prefix.length), dir: s.desc ? 'desc' : 'asc' });
    else if (COLUMN_TO_CORE[s.id]) out.push({ key: COLUMN_TO_CORE[s.id]!, dir: s.desc ? 'desc' : 'asc' });
  }
  return out;
}

export function chainLabel(family: Family, key: string): string {
  return family.props.find((p) => p.key === key)?.label ?? CORE_SORT_KEYS.find((c) => c.key === key)?.label ?? key;
}
