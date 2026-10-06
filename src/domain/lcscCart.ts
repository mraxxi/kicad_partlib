import { parseCsv } from './csv';
import { costIdrMicro, parseMicro, MoneyError } from './money';
import { planLcscImport, type ExistingPart, type LcscLine, type PlanLine } from './lcsc';

/**
 * LCSC's CART export (a different file from the order export): Index, LCSC#, MPN, Manufacturer, Package,
 * Customer #, Description, RoHS, Quantity, MOQ, Multiple, Unit Price($), Extended Price($), Product Link.
 * A cart says what the owner INTENDS to buy, so it feeds the buy list (needs and an LCSC quote), not stock.
 */
const REQUIRED = ['LCSC#', 'MPN', 'Quantity', 'Unit Price($)'] as const;

export interface CartLine {
  row: number; lcsc: string; mpn: string; manufacturer: string; package: string; description: string;
  qty: number; moq: number; multiple: number;
  /** micro-USD; 0 when LCSC showed no price (an unavailable part). */
  unitPriceMicro: number;
  raw: Record<string, string>;
}

export function parseLcscCart(text: string): { lines: CartLine[]; errors: string[] } {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return { lines: [], errors: [`This does not look like an LCSC cart export; missing column(s): ${missing.join(', ')}.`] };
  const idx = new Map(header.map((h, i) => [h, i]));
  const get = (r: string[], n: string) => (r[idx.get(n) ?? -1] ?? '').trim();
  const lines: CartLine[] = [];
  const errors: string[] = [];
  rows.slice(1).forEach((r, i) => {
    const row = i + 1;
    try {
      const lcsc = get(r, 'LCSC#').toUpperCase();
      if (!/^C\d+$/.test(lcsc)) throw new MoneyError(`"${lcsc}" is not an LCSC part number (expected C followed by digits).`);
      const qty = Number(get(r, 'Quantity'));
      if (!Number.isInteger(qty) || qty <= 0) throw new MoneyError(`quantity "${get(r, 'Quantity')}" is not a positive whole number.`);
      const mpn = get(r, 'MPN');
      if (!mpn) throw new MoneyError('manufacturer part number is empty.');
      const int = (n: string, d: number) => { const v = Number(get(r, n)); return Number.isInteger(v) && v > 0 ? v : d; };
      const raw: Record<string, string> = {};
      header.forEach((h, k) => (raw[h] = r[k] ?? ''));
      lines.push({
        row, lcsc, mpn, manufacturer: get(r, 'Manufacturer'), package: get(r, 'Package'), description: get(r, 'Description'),
        qty, moq: int('MOQ', 1), multiple: int('Multiple', 1), unitPriceMicro: parseMicro(get(r, 'Unit Price($)') || '0'), raw,
      });
    } catch (e) { errors.push(`Row ${row}: ${(e as Error).message}`); }
  });
  return { lines, errors };
}

/** The shape the part-matching planner already understands, so cart lines match parts exactly as order lines do. */
export const cartLineAsLcscLine = (l: CartLine): LcscLine => ({
  row: l.row, lcsc: l.lcsc, mpn: l.mpn, manufacturer: l.manufacturer, package: l.package, description: l.description,
  rohs: l.raw['RoHS'] ?? '', qty: l.qty, unitPriceMicro: l.unitPriceMicro, extPriceMicro: l.unitPriceMicro * l.qty, dateCode: '', raw: l.raw,
});

// ---------------------------------------------------------------------------------------------------------
// The plan. Pure: nothing here reads or writes the database (AGENTS.md rule 10), so planning cannot change anything.
// ---------------------------------------------------------------------------------------------------------
export interface ExistingQuote { unitPriceIdr: number; moq: number; hasBreaks: boolean }

export interface CartPlanLine {
  line: CartLine;
  part: PlanLine;
  need: { action: 'create' | 'exists'; existingQty?: number };
  /** Usable stock right now (0 for a part the library does not have yet). */
  stock: number;
  /** What the buy list will actually buy: the need less stock. */
  willBuy: number;
  quote: { action: 'create' | 'update' | 'same' | 'skip'; unitPriceIdr: number; moq: number; reason?: string; existing?: ExistingQuote };
}

export interface CartPlan {
  lines: CartPlanLine[];
  errors: string[];
  warnings: string[];
  summary: { total: number; newParts: number; matchedParts: number; needsToCreate: number; needsExisting: number; quotesToWrite: number; lowStock: number };
}

/** Whole rupiah, rounded half up. Quotes are whole IDR; a 0.0002 USD part is therefore approximate (documented limitation). */
export const usdMicroToIdr = (micro: number, fxIdrPerUsdMicro: number): number => Math.round(costIdrMicro(micro, fxIdrPerUsdMicro) / 1_000_000);

export function planCart(input: {
  lines: CartLine[];
  existingParts: ExistingPart[];
  /** part id -> qty already needed by the chosen project */
  existingNeeds: ReadonlyMap<number, number>;
  /** part id -> its current LCSC quote */
  existingQuotes: ReadonlyMap<number, ExistingQuote>;
  /** part id -> usable stock */
  usable: ReadonlyMap<number, number>;
  fxIdrPerUsdMicro: number;
  updateQuotes: boolean;
}): CartPlan {
  const base = planLcscImport({ lines: input.lines.map(cartLineAsLcscLine), existingParts: input.existingParts, existingOrderPartIds: new Set() });
  const warnings = [...base.warnings.filter((w) => !/extended price/.test(w))]; // a cart has no meaningful extended-price check
  const lines: CartPlanLine[] = base.lines.map((part, i): CartPlanLine => {
    const line = input.lines[i]!;
    const pid = part.partId;
    const existingQty = pid !== null ? input.existingNeeds.get(pid) : undefined;
    const stock = pid !== null ? input.usable.get(pid) ?? 0 : 0;
    const need = existingQty !== undefined ? { action: 'exists' as const, existingQty } : { action: 'create' as const };
    const qty = existingQty ?? line.qty;
    if (existingQty !== undefined && existingQty !== line.qty) warnings.push(`Row ${line.row} (${line.mpn}): the project already needs ${existingQty}; the cart says ${line.qty}. The project's number is kept.`);
    if (line.qty % line.multiple !== 0) warnings.push(`Row ${line.row} (${line.mpn}): quantity ${line.qty} is not a multiple of ${line.multiple}, which LCSC requires.`);

    const price = usdMicroToIdr(line.unitPriceMicro, input.fxIdrPerUsdMicro);
    const ex = pid !== null ? input.existingQuotes.get(pid) : undefined;
    let quote: CartPlanLine['quote'];
    if (line.unitPriceMicro === 0) { quote = { action: 'skip', unitPriceIdr: 0, moq: line.moq, reason: 'the cart shows no price for this part (LCSC may not be selling it)' }; warnings.push(`Row ${line.row} (${line.mpn}): no price in the cart, so no quote was made.`); }
    else if (!input.updateQuotes) quote = { action: 'skip', unitPriceIdr: price, moq: line.moq, reason: 'quotes are switched off for this import' };
    else if (ex?.hasBreaks) quote = { action: 'skip', unitPriceIdr: price, moq: line.moq, reason: 'the existing LCSC quote has price breaks, which a single cart price would flatten', existing: ex };
    else if (ex && ex.unitPriceIdr === price && ex.moq === line.moq) quote = { action: 'same', unitPriceIdr: price, moq: line.moq, existing: ex };
    else quote = { action: ex ? 'update' : 'create', unitPriceIdr: price, moq: line.moq, ...(ex ? { existing: ex } : {}) };
    return { line, part, need, stock, willBuy: Math.max(0, qty - stock), quote };
  });
  return {
    lines, errors: base.errors, warnings,
    summary: {
      total: lines.length,
      newParts: lines.filter((l) => l.part.action === 'create_part').length,
      matchedParts: lines.filter((l) => l.part.action !== 'create_part').length,
      needsToCreate: lines.filter((l) => l.need.action === 'create').length,
      needsExisting: lines.filter((l) => l.need.action === 'exists').length,
      quotesToWrite: lines.filter((l) => l.quote.action === 'create' || l.quote.action === 'update').length,
      lowStock: lines.filter((l) => l.stock > 0 && l.willBuy === 0).length,
    },
  };
}
