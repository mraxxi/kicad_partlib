import { parseCsv } from './csv';
import { parseMicro, MoneyError } from './money';
import { guessCategory, guessValue, normalizeManufacturer, type CategoryName } from './normalize';

/** The columns exactly as LCSC exports them. */
const REQUIRED = [
  'LCSC Part Number', 'Manufacture Part Number', 'Manufacturer', 'Package', 'Description',
  'Quantity', 'Unit Price($)', 'Ext.Price($)',
] as const;

export interface LcscLine {
  /** 1-based CSV record number, header excluded. Shown in every message about a row. */
  row: number;
  lcsc: string;
  mpn: string;
  manufacturer: string;
  package: string;
  description: string;
  rohs: string;
  qty: number;
  unitPriceMicro: number;
  extPriceMicro: number;
  dateCode: string;
  raw: Record<string, string>;
}

export interface ParsedLcsc {
  lines: LcscLine[];
  errors: string[];
}

/** "LCSC__WM2509100613_20261006045136.csv" -> order WM2509100613. */
export function parseLcscFilename(name: string): { orderNo: string; exportedAt: string } | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = /^LCSC__([A-Za-z0-9]+)_(\d{4})(\d{2})(\d{2})(\d{6})(?:\s*\(\d+\))?\.csv$/i.exec(base);
  if (!m) return null;
  return { orderNo: m[1]!.toUpperCase(), exportedAt: `${m[2]}-${m[3]}-${m[4]}` };
}

/**
 * LCSC order numbers embed the order date: WM2509100613 is 2025-09-10. The
 * export timestamp in the filename is when the CSV was downloaded, which is a
 * different (and later) date, so it is only a fallback.
 */
export function orderDateFromOrderNo(orderNo: string): string | null {
  const m = /^[A-Za-z]{2}(\d{2})(\d{2})(\d{2})/.exec(orderNo);
  if (!m) return null;
  const [yy, mm, dd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `20${m[1]}-${m[2]}-${m[3]}`;
}

export function parseLcscCsv(text: string): ParsedLcsc {
  const rows = parseCsv(text);
  const errors: string[] = [];
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    return { lines: [], errors: [`This does not look like an LCSC order export; missing column(s): ${missing.join(', ')}.`] };
  }
  const col = new Map(header.map((h, i) => [h, i]));
  const get = (r: string[], name: string) => (r[col.get(name) ?? -1] ?? '').trim();

  const lines: LcscLine[] = [];
  rows.slice(1).forEach((r, idx) => {
    const row = idx + 1;
    try {
      const qty = Number(get(r, 'Quantity'));
      if (!Number.isInteger(qty) || qty <= 0) throw new MoneyError(`quantity "${get(r, 'Quantity')}" is not a positive whole number.`);
      const lcsc = get(r, 'LCSC Part Number').toUpperCase();
      if (!/^C\d+$/.test(lcsc)) throw new MoneyError(`"${lcsc}" is not an LCSC part number (expected C followed by digits).`);
      const mpn = get(r, 'Manufacture Part Number');
      if (!mpn) throw new MoneyError('manufacturer part number is empty.');
      const raw: Record<string, string> = {};
      header.forEach((h, i) => (raw[h] = r[i] ?? ''));
      lines.push({
        row, lcsc, mpn,
        manufacturer: get(r, 'Manufacturer'),
        package: get(r, 'Package'),
        description: get(r, 'Description'),
        rohs: get(r, 'RoHS'),
        qty,
        unitPriceMicro: parseMicro(get(r, 'Unit Price($)')),
        extPriceMicro: parseMicro(get(r, 'Ext.Price($)')),
        dateCode: get(r, 'Date Code / Lot No.'),
        raw,
      });
    } catch (e) {
      errors.push(`Row ${row}: ${(e as Error).message}`);
    }
  });
  return { lines, errors };
}

// ---------------------------------------------------------------------------
// Planning. Pure: nothing here reads or writes the database, so building a plan
// can never mutate anything (docs: plan-then-apply).
// ---------------------------------------------------------------------------

export interface ExistingPart {
  id: number;
  mpn: string;
  manufacturer: string;
  manufacturerNorm: string;
  lcscCode: string | null;
}

export type LineAction = 'create_part' | 'match_part' | 'skip_duplicate';

export interface PlanLine {
  line: LcscLine;
  action: LineAction;
  partId: number | null;
  matchedBy: 'lcsc' | 'mpn' | null;
  /** Matched an existing part that had no C-number; the apply will set it. */
  setLcscCode: boolean;
  /** Matched, but LCSC spells the manufacturer differently; recorded as an alias. */
  manufacturerVariant: boolean;
  manufacturerNorm: string;
  category: CategoryName;
  value: string;
  needsReview: boolean;
  reviewReasons: string[];
}

export interface Plan {
  lines: PlanLine[];
  /** Any error blocks apply. */
  errors: string[];
  warnings: string[];
  summary: {
    total: number;
    newParts: number;
    matchedParts: number;
    duplicates: number;
    lotsToCreate: number;
    piecesToReceive: number;
    totalUsdMicro: number;
  };
}

export interface PlanInput {
  lines: LcscLine[];
  existingParts: ExistingPart[];
  /** Part ids that already have a line on this order (empty if the order is new). */
  existingOrderPartIds: ReadonlySet<number>;
}

export const mpnKey = (mpn: string, norm: string) => `${mpn.toLowerCase()}\u0000${norm}`;
const dash = (s: string) => (s === '-' ? '' : s);

export function planLcscImport(input: PlanInput): Plan {
  const byLcsc = new Map<string, ExistingPart>();
  const byMpn = new Map<string, ExistingPart>();
  for (const p of input.existingParts) {
    if (p.lcscCode) byLcsc.set(p.lcscCode.toUpperCase(), p);
    byMpn.set(mpnKey(p.mpn, p.manufacturerNorm), p);
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const pendingLcsc = new Map<string, number>(); // C-number -> first row creating it
  const pendingMpn = new Map<string, number>();
  const out: PlanLine[] = [];

  for (const line of input.lines) {
    const norm = normalizeManufacturer(line.manufacturer);
    const description = dash(line.description);
    const category = guessCategory(description);
    const reasons: string[] = [];
    if (!description) reasons.push('LCSC gave no description');
    if (!line.manufacturer) reasons.push('no manufacturer');

    const expectedExt = line.qty * line.unitPriceMicro;
    if (Math.abs(expectedExt - line.extPriceMicro) > 10_000) {
      warnings.push(`Row ${line.row} (${line.lcsc}): ${line.qty} x unit price differs from the extended price by more than one cent.`);
    }

    let matched = byLcsc.get(line.lcsc);
    let matchedBy: PlanLine['matchedBy'] = matched ? 'lcsc' : null;
    if (!matched) {
      matched = byMpn.get(mpnKey(line.mpn, norm));
      if (matched) matchedBy = 'mpn';
    }

    const key = mpnKey(line.mpn, norm);
    const firstSeen = pendingLcsc.get(line.lcsc) ?? pendingMpn.get(key);
    if (!matched && firstSeen !== undefined) {
      errors.push(`Row ${line.row} repeats the part from row ${firstSeen} (${line.lcsc} / ${line.mpn}); one order line per part is expected.`);
    }

    let action: LineAction;
    if (matched) {
      action = input.existingOrderPartIds.has(matched.id) ? 'skip_duplicate' : 'match_part';
      if (matched.lcscCode && matched.lcscCode.toUpperCase() !== line.lcsc) {
        warnings.push(`Row ${line.row}: ${line.mpn} already has C-number ${matched.lcscCode}; keeping it and ignoring ${line.lcsc}.`);
      }
    } else {
      action = 'create_part';
      pendingLcsc.set(line.lcsc, line.row);
      pendingMpn.set(key, line.row);
    }

    out.push({
      line,
      action,
      partId: matched?.id ?? null,
      matchedBy,
      setLcscCode: !!matched && matched.lcscCode === null,
      manufacturerVariant: !!matched && !!line.manufacturer && matched.manufacturer !== line.manufacturer,
      manufacturerNorm: norm,
      category,
      value: guessValue(description, category),
      needsReview: reasons.length > 0,
      reviewReasons: reasons,
    });
  }

  const live = out.filter((l) => l.action !== 'skip_duplicate');
  return {
    lines: out,
    errors,
    warnings,
    summary: {
      total: out.length,
      newParts: out.filter((l) => l.action === 'create_part').length,
      matchedParts: out.filter((l) => l.action === 'match_part').length,
      duplicates: out.filter((l) => l.action === 'skip_duplicate').length,
      lotsToCreate: live.length,
      piecesToReceive: live.reduce((n, l) => n + l.line.qty, 0),
      totalUsdMicro: live.reduce((n, l) => n + l.line.extPriceMicro, 0),
    },
  };
}
