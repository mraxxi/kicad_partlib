import { bomValueSi, packageFromFootprint, type BomLine } from './kicadBom';

/**
 * Suggest library parts for a BOM line whose Value is a PART NAME ("TPA3255DDV", "NE5532AD", "2N7002") because the
 * schematic has no LCSC number or MPN. Suggestions only, like value+footprint ones: nothing links by itself.
 *
 * Matching is a normalised PREFIX match, nothing fuzzy: case and punctuation are dropped, and the part's MPN may carry a
 * suffix the schematic leaves off (TPA3255DDV -> TPA3255DDVR, NE5532AD -> NE5532ADR, packaging and revision letters). The
 * footprint only orders ties. A Value is treated as a name only when it is long enough, has a digit and a letter, is not an
 * electrical value (100nF, 3R3, 10uH) and does not start like a connector or switch symbol name; otherwise "SW", "OUT", "~",
 * "balR" or "Conn_01x04_Socket" would match half the library.
 */
export interface NamePart { id: number; mpn: string; package: string; lcscCode: string | null; value: string; usableQty: number }
export interface PreparedName extends NamePart { norm: string; pkg: string }
export interface NameSuggestion { partId: number; mpn: string; lcscCode: string | null; value: string; usableQty: number }

export const NAME_MIN_LENGTH = 5;
const SYMBOL_PREFIX = /^(conn|connector|jack|audiojack|header|terminal|screw|socket|switch|usb|testpoint|mounting)/;

export const normName = (s: string): string => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The normalised Value if it looks like a part name, else null. */
export function nameKey(value: string, refs: readonly string[]): string | null {
  const n = normName(value);
  if (n.length < NAME_MIN_LENGTH || !/\d/.test(n) || !/[a-z]/.test(n) || SYMBOL_PREFIX.test(n)) return null;
  return bomValueSi(value, refs) === null ? n : null;
}

/** A line the schematic could not identify by number: no LCSC, no MPN. */
export const isNameCandidate = (line: Pick<BomLine, 'lcsc' | 'mpn'>): boolean => line.lcsc === '' && line.mpn === '';

/** Normalise every part's MPN once per request, not per line x part (10 ms CPU). */
export function prepareNames(parts: readonly NamePart[]): PreparedName[] {
  return parts.map((p) => ({ ...p, norm: normName(p.mpn), pkg: normName(p.package) }));
}

/** Ids of the parts any of these lines would be suggested; lets the caller fetch stock for just those. */
export function matchedPartIds(lines: ReadonlyArray<Pick<BomLine, 'value' | 'refs' | 'lcsc' | 'mpn'>>, parts: readonly PreparedName[]): Set<number> {
  const ids = new Set<number>();
  for (const l of lines) {
    const key = isNameCandidate(l) ? nameKey(l.value, l.refs) : null;
    if (key) for (const p of parts) if (p.norm.startsWith(key)) ids.add(p.id);
  }
  return ids;
}

const MAX = 3;

export function suggestByName(line: Pick<BomLine, 'value' | 'refs' | 'footprint' | 'lcsc' | 'mpn'>, parts: readonly PreparedName[]): NameSuggestion[] {
  const key = isNameCandidate(line) ? nameKey(line.value, line.refs) : null;
  if (!key) return [];
  const foot = normName(line.footprint);
  const pkgOfFootprint = packageFromFootprint(line.footprint);
  const fits = (p: PreparedName) => p.pkg.length >= 3 && (foot.includes(p.pkg) || p.pkg.includes(foot) || p.package === pkgOfFootprint);
  return parts
    .filter((p) => p.norm.startsWith(key))
    .sort((a, b) =>
      Number(b.norm === key) - Number(a.norm === key)            // an exact name first
      || Number(fits(b)) - Number(fits(a))                       // the footprint only breaks ties
      || b.usableQty - a.usableQty || a.norm.length - b.norm.length || a.id - b.id)
    .slice(0, MAX)
    .map((p) => ({ partId: p.id, mpn: p.mpn, lcscCode: p.lcscCode, value: p.value, usableQty: p.usableQty }));
}
