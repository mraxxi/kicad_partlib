import { normalizeManufacturer } from './normalize';
import type { Condition } from './stock';

export interface HarvestItem {
  mpn: string;
  manufacturer: string;
  qty: number;
  condition: Condition;
  /** Whole IDR per piece; an ESTIMATE of what the salvaged part is worth. */
  estUnitValueIdr: number;
  locationId: number | null;
  category: string | null;
  description: string;
}

export interface KnownPart {
  id: number;
  mpn: string;
  manufacturerNorm: string;
}

export interface HarvestLine {
  index: number;
  item: HarvestItem;
  action: 'create_part' | 'match_part';
  partId: number | null;
  manufacturerNorm: string;
}

/**
 * Decide, for each salvaged line, whether it is a part already in the library.
 * Exact (mpn, manufacturer) first; with no manufacturer typed, a UNIQUE mpn match
 * wins -- when you strip a board you rarely know or care who made the AMS1117,
 * and splitting its stock across a blank-maker twin is the failure to avoid.
 * An mpn shared by several makers with none typed is ambiguous, so it creates
 * nothing and says so rather than guessing.
 */
export function planHarvest(items: readonly HarvestItem[], known: readonly KnownPart[]): { lines: HarvestLine[]; errors: string[] } {
  const exact = new Map<string, KnownPart>();
  const byMpn = new Map<string, KnownPart[]>();
  for (const k of known) {
    const m = k.mpn.toLowerCase();
    exact.set(`${m}\u0000${k.manufacturerNorm}`, k);
    byMpn.set(m, [...(byMpn.get(m) ?? []), k]);
  }
  const errors: string[] = [];
  const lines = items.map((item, index): HarvestLine => {
    const norm = normalizeManufacturer(item.manufacturer);
    const m = item.mpn.toLowerCase();
    let hit = exact.get(`${m}\u0000${norm}`);
    if (!hit && norm === '') {
      const same = byMpn.get(m) ?? [];
      if (same.length === 1) hit = same[0];
      else if (same.length > 1) errors.push(`Line ${index + 1}: "${item.mpn}" exists from several manufacturers; type which one.`);
    }
    return { index, item, action: hit ? 'match_part' : 'create_part', partId: hit?.id ?? null, manufacturerNorm: norm };
  });
  return { lines, errors };
}
