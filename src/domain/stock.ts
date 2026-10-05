/**
 * Pure stock vocabulary and derivations. Nothing here touches the database, and
 * nothing here is ever stored: stock status, part codes and dashboard figures
 * are all derived from lots, so they cannot disagree with the ledger.
 */
export const CONDITIONS = ['new', 'tested_ok', 'untested', 'faulty'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABEL: Record<Condition, string> = {
  new: 'New', tested_ok: 'Tested OK', untested: 'Untested', faulty: 'Faulty',
};

export const SOURCES = ['order', 'salvage', 'manual'] as const;
export type Source = (typeof SOURCES)[number];
export const SOURCE_LABEL: Record<Source, string> = { order: 'LCSC order', salvage: 'Salvaged', manual: 'Manual' };

export type StockStatus = 'ok' | 'reorder' | 'out';
export const STATUS_LABEL: Record<StockStatus, string> = { ok: 'OK', reorder: 'Reorder', out: 'Out' };

/**
 * The sheet's rule: Out when nothing usable is left, Reorder when below the
 * part's minimum, otherwise OK. Faulty lots are not usable stock.
 */
export function stockStatus(usableQty: number, minQty: number | null): StockStatus {
  if (usableQty <= 0) return 'out';
  if (minQty !== null && usableQty < minQty) return 'reorder';
  return 'ok';
}

/** Human id for labels and conversation ("P-0042"). Derived from the row id: no counter to keep in step. */
export function partCode(id: number): string {
  return `P-${String(id).padStart(4, '0')}`;
}
export function parsePartCode(text: string): number | null {
  const m = /^P-(\d{1,9})$/i.exec(text.trim());
  return m ? Number(m[1]) : null;
}

/** A salvaged lot's cost is an ESTIMATED value, not money spent; reports keep the two apart. */
export const isEstimatedCost = (source: Source): boolean => source === 'salvage';

export interface PartSummary {
  id: number;
  code: string;
  mpn: string;
  manufacturer: string;
  description: string;
  package: string;
  value: string;
  lcscCode: string | null;
  category: string | null;
  needsReview: boolean;
  minQty: number | null;
  rev: number;
  lotCount: number;
  totalQty: number;
  usableQty: number;
  /** Whole IDR, over usable (non-faulty) lots, purchases and manual stock. */
  valueRealIdr: number;
  /** Whole IDR, over usable salvaged lots: an estimate. */
  valueEstimatedIdr: number;
  untestedSalvageQty: number;
  sources: Source[];
  conditions: Condition[];
  locations: string[];
  status: StockStatus;
}

export interface Dashboard {
  partLines: number;
  unitsOnHand: number;
  valueRealIdr: number;
  valueEstimatedIdr: number;
  reorderCount: number;
  outCount: number;
  untestedSalvageUnits: number;
  needsReviewCount: number;
  byCategory: Array<{ category: string; parts: number; units: number; valueRealIdr: number; valueEstimatedIdr: number }>;
  reorder: Array<{ id: number; code: string; mpn: string; usableQty: number; minQty: number | null; status: StockStatus }>;
}

export function buildDashboard(parts: readonly PartSummary[]): Dashboard {
  const cats = new Map<string, Dashboard['byCategory'][number]>();
  let units = 0, real = 0, est = 0, untested = 0, review = 0;
  for (const p of parts) {
    units += p.totalQty;
    real += p.valueRealIdr;
    est += p.valueEstimatedIdr;
    untested += p.untestedSalvageQty;
    if (p.needsReview) review++;
    const name = p.category ?? 'Uncategorised';
    const c = cats.get(name) ?? { category: name, parts: 0, units: 0, valueRealIdr: 0, valueEstimatedIdr: 0 };
    c.parts++;
    c.units += p.totalQty;
    c.valueRealIdr += p.valueRealIdr;
    c.valueEstimatedIdr += p.valueEstimatedIdr;
    cats.set(name, c);
  }
  const flagged = parts.filter((p) => p.status !== 'ok');
  return {
    partLines: parts.length,
    unitsOnHand: units,
    valueRealIdr: real,
    valueEstimatedIdr: est,
    reorderCount: flagged.filter((p) => p.status === 'reorder').length,
    outCount: flagged.filter((p) => p.status === 'out').length,
    untestedSalvageUnits: untested,
    needsReviewCount: review,
    byCategory: [...cats.values()].sort((a, b) => b.valueRealIdr + b.valueEstimatedIdr - (a.valueRealIdr + a.valueEstimatedIdr)),
    reorder: flagged
      .sort((a, b) => Number(b.status === 'out') - Number(a.status === 'out') || a.usableQty - b.usableQty)
      .slice(0, 25)
      .map((p) => ({ id: p.id, code: p.code, mpn: p.mpn, usableQty: p.usableQty, minQty: p.minQty, status: p.status })),
  };
}
