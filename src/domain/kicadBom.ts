import { CsvError, parseCsv } from './csv';

/**
 * KiCad's BOM CSV (Schematic Editor > File > Export > BOM, or `kicad-cli sch export bom`). The default columns
 * are `Refs`/`Reference`, `Value`, `Footprint`, `Qty`, `DNP` (older exports add `Datasheet`); every other column
 * is a symbol field the owner added (LCSC, MPN, MF ...). Field names are a map, not code: `FieldMap` comes from
 * the `bom.fields` setting so the owner's spellings are adjusted without a release.
 *
 * Reading a BOM is a read: nothing here touches a KiCad file, and nothing is guessed silently. A line the file
 * cannot identify stays a line with its value and footprint; matching and linking are bomPlan.ts.
 */
export interface FieldMap { lcsc: string[]; mpn: string[]; manufacturer: string[] }

export const DEFAULT_FIELD_MAP: FieldMap = {
  lcsc: ['LCSC', 'LCSC#', 'LCSC Part', 'LCSC Part #', 'LCSC Part Number', 'JLCPCB Part', 'JLCPCB Part #'],
  mpn: ['MPN', 'MP', 'Manufacturer Part Number', 'Manufacturer_Part_Number', 'Mfr Part', 'MFR_PN'],
  manufacturer: ['Manufacturer', 'MF', 'MFR', 'Mfr', 'Manufacturer_Name'],
};

const REFS = ['refs', 'reference', 'references', 'designator', 'designators'];
const QTY = ['qty', 'quantity'];
const norm = (s: string) => s.trim().toLowerCase();

export interface BomLine {
  /** First row of the file this line came from (1 = first data row). */
  row: number;
  key: string;
  refs: string[];
  /** Pieces per board. */
  qty: number;
  value: string;
  footprint: string;
  lcsc: string;
  mpn: string;
  manufacturer: string;
  dnp: boolean;
  raw: Record<string, string>;
}

export interface ParsedBom { lines: BomLine[]; errors: string[]; warnings: string[] }

const truthy = (s: string) => ['1', 'yes', 'y', 'true', 'x', 'dnp'].includes(norm(s));

export function bomLineKey(l: Pick<BomLine, 'lcsc' | 'mpn' | 'value' | 'footprint'>): string {
  if (/^C\d+$/.test(l.lcsc)) return `lcsc:${l.lcsc}`;
  if (l.mpn) return `mpn:${l.mpn.toLowerCase()}`;
  return `vf:${l.value.toLowerCase()}|${l.footprint.toLowerCase()}`;
}

/** "Resistor_SMD:R_0603_1608Metric" -> "0603". The package a chip passive's footprint names, or null. */
export function packageFromFootprint(footprint: string): string | null {
  const m = /(?:^|[_:\-\s])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?:[_\-\s]|$)/.exec(footprint);
  return m ? m[1]! : null;
}

function pickDelimiter(text: string): string {
  const first = (text.split(/\r?\n/, 1)[0] ?? '');
  const count = (c: string) => first.split(c).length - 1;
  return count(',') >= count(';') && count(',') >= count('\t') ? ',' : count(';') >= count('\t') ? ';' : '\t';
}

export function parseKicadBom(text: string, map: FieldMap = DEFAULT_FIELD_MAP): ParsedBom {
  let rows: string[][];
  try { rows = parseCsv(text, pickDelimiter(text)); } catch (e) {
    if (e instanceof CsvError) return { lines: [], errors: [e.message], warnings: [] };
    throw e;
  }
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const lower = header.map(norm);
  const find = (names: string[]) => { for (const n of names) { const i = lower.indexOf(norm(n)); if (i >= 0) return i; } return -1; };
  const iRefs = find(REFS), iQty = find(QTY), iValue = find(['value']), iFoot = find(['footprint']), iDnp = find(['dnp', 'do not populate']);
  const iLcsc = find(map.lcsc), iMpn = find(map.mpn), iMf = find(map.manufacturer);

  if (iRefs < 0 || (iValue < 0 && iMpn < 0 && iLcsc < 0)) {
    return {
      lines: [], warnings: [],
      errors: [`This does not look like a KiCad BOM export: it needs a Refs (or Reference) column and a Value column, and the first row has ${header.length ? `"${header.slice(0, 8).join('", "')}"` : 'no columns'}.`],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const byKey = new Map<string, BomLine>();
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  rows.slice(1).forEach((r, k) => {
    const row = k + 1;
    const refs = get(r, iRefs).split(/[\s,;]+/).filter(Boolean);
    if (refs.length === 0) { errors.push(`Row ${row}: the Refs cell is empty, so there is nothing to place on the board.`); return; }
    let qty = refs.length;
    if (iQty >= 0 && get(r, iQty) !== '') {
      const q = Number(get(r, iQty));
      if (!Number.isInteger(q) || q <= 0) { errors.push(`Row ${row} (${refs[0]}): quantity "${get(r, iQty)}" is not a positive whole number.`); return; }
      if (q !== refs.length) warnings.push(`Row ${row} (${refs[0]}): the Qty column says ${q} but ${refs.length} reference(s) are listed; using ${q}.`);
      qty = q;
    }
    const lcsc = get(r, iLcsc).toUpperCase();
    if (lcsc && !/^C\d+$/.test(lcsc)) warnings.push(`Row ${row} (${refs[0]}): "${get(r, iLcsc)}" is not an LCSC number (C followed by digits), so it is ignored for matching.`);
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { if (h) raw[h] = r[i] ?? ''; });
    const line: BomLine = {
      row, key: '', refs, qty, value: get(r, iValue), footprint: get(r, iFoot), lcsc: /^C\d+$/.test(lcsc) ? lcsc : '',
      mpn: get(r, iMpn), manufacturer: get(r, iMf), dnp: iDnp >= 0 && truthy(get(r, iDnp)), raw,
    };
    line.key = bomLineKey(line);
    if (line.key === 'vf:|') { errors.push(`Row ${row} (${refs[0]}): the line has no LCSC number, MPN, value or footprint, so it cannot be told apart from other lines.`); return; }
    const prev = byKey.get(line.key);
    if (prev) {
      // The same part twice in one file (KiCad grouped by something finer, e.g. a different field): one line, summed.
      prev.refs.push(...refs);
      prev.qty += qty;
      prev.dnp = prev.dnp && line.dnp;
      warnings.push(`Row ${row} (${refs[0]}) is the same part as row ${prev.row}; their quantities are added together.`);
    } else byKey.set(line.key, line);
  });
  if (byKey.size === 0 && errors.length === 0) errors.push('The file has a header but no BOM lines.');
  return { lines: [...byKey.values()], errors, warnings };
}

// ---- value text -> a number, for suggestions -------------------------------------------------------------
const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
export type PassiveUnit = 'ohm' | 'farad' | 'henry';

/**
 * What a KiCad value like "10u", "100n", "4k7", "10k" or "2.2uF" means, so it can be compared with a part's "10uF".
 * The unit is optional in KiCad values and comes from the reference letter (R, C, L) then. Anything that is not a
 * plain resistance, capacitance or inductance returns null: a suggestion is only made where the match is exact.
 */
export function bomValueSi(value: string, refs: readonly string[]): { si: number; unit: PassiveUnit } | null {
  const letter = (refs[0] ?? '').replace(/[^A-Za-z].*$/, '').toUpperCase();
  const unitOf = (c: string | undefined): PassiveUnit | null => (c === 'R' ? 'ohm' : c === 'C' ? 'farad' : c === 'L' ? 'henry' : null);
  const v = value.trim().replace(/Ω/g, 'Ω');
  // 4k7 / 4R7 / 2u2
  let m = /^(\d+)([pnuµμmkKMGR])(\d+)\s*([FHΩ])?$/.exec(v);
  if (m) {
    const si = Number(`${m[1]}.${m[3]}`) * (m[2] === 'R' ? 1 : PREFIX[m[2]!]!);
    const unit = m[4] === 'F' ? 'farad' : m[4] === 'H' ? 'henry' : m[4] ? 'ohm' : unitOf(letter);
    return unit ? { si: Number(si.toPrecision(12)), unit } : null;
  }
  m = /^(\d+(?:\.\d+)?)\s*([pnuµμmkKMG]?)\s*([FHΩ]|ohm|Ohm|R)?$/.exec(v);
  if (!m) return null;
  const unit = m[3] === 'F' ? 'farad' : m[3] === 'H' ? 'henry' : m[3] ? 'ohm' : unitOf(letter);
  if (!unit) return null;
  return { si: Number((Number(m[1]) * (m[2] ? PREFIX[m[2]]! : 1)).toPrecision(12)), unit };
}
