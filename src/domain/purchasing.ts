/**
 * Purchasing, as pure functions: what to buy, from whom, and what it costs.
 * Ported from the owner's Google Sheet (Buy List / Price Compare / Purchase
 * Recap), whose sample rows are the acceptance fixtures in tests/purchasing.
 *
 * Money is whole IDR throughout and every comparison is between integers: for
 * one part the landed cost per unit of two quotes shares a denominator, so
 * ranking by landed TOTAL ranks by landed per-unit cost with no division.
 *
 * Deliberate departures from the sheet, each fixing a real error in it:
 *   1. Stock is ALLOCATED across a part's open needs (priority, then id). The
 *      sheet subtracted the full stock from every line, so two projects needing
 *      the same part each "found" the same pieces.
 *   2. Lines for the same part and supplier are ORDERED TOGETHER: one MOQ, one
 *      listing shipping. The sheet charged both per line.
 *   3. Ranking uses the part's demand from still-to-buy needs only; an already
 *      ordered line no longer pulls on the price.
 */
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const NEED_STATUSES = ['to_buy', 'ordered', 'received', 'covered', 'cancelled'] as const;
export type NeedStatus = (typeof NEED_STATUSES)[number];
export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export interface PriceBreak { qty: number; priceIdr: number }
export interface Quote {
  id: number; partId: number; supplierId: number; seller: string; unitPriceIdr: number; moq: number;
  priceBreaks: PriceBreak[]; listingShippingIdr: number; leadDays: number | null; risk: Risk; url: string; quotedAt: string;
}
export interface Supplier { id: number; name: string; orderShippingIdr: number; freeShipOverIdr: number | null }
export interface Need {
  id: number; projectId: number; projectName: string; partId: number; mpn: string; description: string; lcscCode: string | null;
  qtyNeeded: number; spares: number; priority: Priority; status: NeedStatus; overrideSupplierId: number | null;
  orderedSupplierId: number | null; orderedQty: number | null; orderedTotalIdr: number | null; rev: number;
}

/** Unit price at an order quantity: the highest break not above it, else the base price. */
export function unitPriceAt(q: Pick<Quote, 'unitPriceIdr' | 'priceBreaks'>, orderQty: number): number {
  let price = q.unitPriceIdr;
  let bestQty = 0;
  for (const b of q.priceBreaks) if (b.qty <= orderQty && b.qty >= bestQty) { price = b.priceIdr; bestQty = b.qty; }
  return price;
}

export interface Priced { orderQty: number; unitPriceIdr: number; subtotalIdr: number; shippingIdr: number; totalIdr: number }

/** What it costs to buy `buyQty` on this quote: at least the MOQ, priced at the break for the quantity actually ordered. */
export function priceOrder(q: Quote, buyQty: number): Priced {
  const orderQty = Math.max(buyQty, q.moq);
  const unitPriceIdr = unitPriceAt(q, orderQty);
  const subtotalIdr = orderQty * unitPriceIdr;
  return { orderQty, unitPriceIdr, subtotalIdr, shippingIdr: q.listingShippingIdr, totalIdr: subtotalIdr + q.listingShippingIdr };
}

/** Landed cost per unit actually needed, rounded for display. The ranking never uses it. */
export const landedPerUnit = (totalIdr: number, demand: number): number => Math.round(totalIdr / Math.max(demand, 1));

export interface RankedQuote { quote: Quote; priced: Priced; rank: number; best: boolean; landedPerUnitIdr: number }

/** Rank a part's quotes by landed total for `demand` pieces. Ties share a rank (as the sheet's COUNTIFS did). */
export function rankQuotes(quotes: readonly Quote[], demand: number): RankedQuote[] {
  const priced = quotes.map((quote) => ({ quote, priced: priceOrder(quote, demand) }));
  const ranked = priced.map((p) => ({
    ...p,
    rank: priced.filter((o) => o.priced.totalIdr < p.priced.totalIdr).length + 1,
    landedPerUnitIdr: landedPerUnit(p.priced.totalIdr, demand),
  }));
  return ranked
    .map((r) => ({ ...r, best: r.rank === 1 }))
    .sort((a, b) => a.rank - b.rank || (a.quote.leadDays ?? 1e9) - (b.quote.leadDays ?? 1e9)
      || RISK_RANK[a.quote.risk] - RISK_RANK[b.quote.risk] || a.quote.supplierId - b.quote.supplierId);
}

export interface Allocation { stockAllotted: number; shortfall: number; buyQty: number }

/**
 * Allocate each part's usable stock across its to-buy needs, highest priority
 * first, then oldest. A need fully covered buys nothing; otherwise it buys its
 * shortfall plus its spares (spares are only worth buying if buying anyway).
 */
export function allocateStock(needs: readonly Need[], usableByPart: ReadonlyMap<number, number>): Map<number, Allocation> {
  const out = new Map<number, Allocation>();
  const byPart = new Map<number, Need[]>();
  for (const n of needs) if (n.status === 'to_buy') byPart.set(n.partId, [...(byPart.get(n.partId) ?? []), n]);
  for (const [partId, list] of byPart) {
    let left = usableByPart.get(partId) ?? 0;
    list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id);
    for (const n of list) {
      const allot = Math.min(left, n.qtyNeeded);
      left -= allot;
      const shortfall = n.qtyNeeded - allot;
      out.set(n.id, { stockAllotted: allot, shortfall, buyQty: shortfall === 0 ? 0 : shortfall + n.spares });
    }
  }
  return out;
}

/** Split a whole-IDR total over weights so the parts add up exactly (the remainder goes to the largest weights first). */
export function splitTotal(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - shares.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => i).sort((a, b) => weights[b]! - weights[a]! || a - b);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) shares[order[k]!]!++;
  return shares;
}

export type LineState = 'buy' | 'covered' | 'no_quote' | 'ordered' | 'received' | 'cancelled';
export interface BuyLine {
  needId: number; rev: number; projectId: number; projectName: string; partId: number; mpn: string; description: string; lcscCode: string | null;
  priority: Priority; status: NeedStatus; state: LineState;
  qtyNeeded: number; usableInStock: number; stockAllotted: number; shortfall: number; spares: number; buyQty: number;
  bestSupplierId: number | null; overrideSupplierId: number | null; supplierId: number | null;
  unitPriceIdr: number | null; moq: number | null; orderQty: number | null; listingShippingIdr: number | null;
  lineTotalIdr: number; orderedTotalIdr: number;
}
export interface OrderGroup {
  partId: number; mpn: string; lcscCode: string | null; supplierId: number; quoteId: number;
  buyQty: number; orderQty: number; unitPriceIdr: number; subtotalIdr: number; shippingIdr: number; totalIdr: number; needIds: number[];
}
export interface SupplierRecap {
  supplierId: number; name: string; lines: number; subtotalIdr: number; listingShippingIdr: number;
  orderShippingIdr: number; totalIdr: number; orderedInTransitIdr: number;
}
export interface Slice { key: string; lines: number; toBuyIdr: number; orderedIdr: number }
export interface MatrixRow {
  partId: number; mpn: string; demand: number;
  bySupplier: Record<number, { landedPerUnitIdr: number; totalIdr: number; rank: number; best: boolean }>;
}
export interface BuyList {
  lines: BuyLine[]; groups: OrderGroup[]; recap: SupplierRecap[]; recapTotal: Omit<SupplierRecap, 'supplierId' | 'name'>;
  byProject: Slice[]; byPriority: Slice[]; matrix: MatrixRow[];
}

/** The sheet's order-shipping rule: once per supplier, nothing if nothing is bought, waived at or above the free-shipping threshold. */
export function orderShipping(s: Pick<Supplier, 'orderShippingIdr' | 'freeShipOverIdr'>, spendIdr: number): number {
  if (spendIdr === 0) return 0;
  if (s.freeShipOverIdr !== null && s.freeShipOverIdr > 0 && spendIdr >= s.freeShipOverIdr) return 0;
  return s.orderShippingIdr;
}

export function computeBuyList(input: {
  needs: readonly Need[]; usableByPart: ReadonlyMap<number, number>; quotes: readonly Quote[]; suppliers: readonly Supplier[];
}): BuyList {
  const { needs, usableByPart, quotes, suppliers } = input;
  const alloc = allocateStock(needs, usableByPart);
  const quotesByPart = new Map<number, Quote[]>();
  for (const q of quotes) quotesByPart.set(q.partId, [...(quotesByPart.get(q.partId) ?? []), q]);

  const demand = new Map<number, number>();
  for (const n of needs) demand.set(n.partId, (demand.get(n.partId) ?? 0) + (alloc.get(n.id)?.buyQty ?? 0));
  const bestByPart = new Map<number, RankedQuote | undefined>();
  for (const [partId, qs] of quotesByPart) bestByPart.set(partId, rankQuotes(qs, demand.get(partId) ?? 0)[0]);

  // Pass 1: which supplier and quote each buying need uses; group needs per (part, supplier).
  interface Draft { n: Need; a: Allocation; supplierId: number | null; quote: Quote | null }
  const drafts: Draft[] = needs.map((n) => {
    const a = alloc.get(n.id) ?? { stockAllotted: 0, shortfall: 0, buyQty: 0 };
    let supplierId: number | null = null;
    let quote: Quote | null = null;
    if (n.status === 'to_buy' && a.buyQty > 0) {
      supplierId = n.overrideSupplierId ?? bestByPart.get(n.partId)?.quote.supplierId ?? null;
      quote = supplierId === null ? null : (quotesByPart.get(n.partId) ?? []).find((q) => q.supplierId === supplierId) ?? null;
    }
    return { n, a, supplierId, quote };
  });
  const groups = new Map<string, OrderGroup>();
  for (const d of drafts) {
    if (!d.quote) continue;
    const key = `${d.n.partId}|${d.quote.supplierId}`;
    const g = groups.get(key) ?? { partId: d.n.partId, mpn: d.n.mpn, lcscCode: d.n.lcscCode, supplierId: d.quote.supplierId, quoteId: d.quote.id,
      buyQty: 0, orderQty: 0, unitPriceIdr: 0, subtotalIdr: 0, shippingIdr: 0, totalIdr: 0, needIds: [] };
    g.buyQty += d.a.buyQty;
    g.needIds.push(d.n.id);
    groups.set(key, g);
  }
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  for (const g of groups.values()) Object.assign(g, priceOrder(quoteById.get(g.quoteId)!, g.buyQty));

  // Pass 2: lines. A group's total is shared over its needs in proportion to what each buys.
  const share = new Map<number, number>();
  for (const g of groups.values()) {
    const parts = splitTotal(g.totalIdr, g.needIds.map((id) => alloc.get(id)!.buyQty));
    g.needIds.forEach((id, i) => share.set(id, parts[i]!));
  }
  const lines: BuyLine[] = drafts.map(({ n, a, supplierId, quote }) => {
    const g = quote ? groups.get(`${n.partId}|${quote.supplierId}`)! : null;
    const state: LineState = n.status === 'to_buy'
      ? (a.buyQty === 0 ? 'covered' : quote ? 'buy' : 'no_quote')
      : n.status === 'covered' ? 'covered' : n.status;
    return {
      needId: n.id, rev: n.rev, projectId: n.projectId, projectName: n.projectName, partId: n.partId, mpn: n.mpn, description: n.description,
      lcscCode: n.lcscCode, priority: n.priority, status: n.status, state,
      qtyNeeded: n.qtyNeeded, usableInStock: usableByPart.get(n.partId) ?? 0, stockAllotted: a.stockAllotted, shortfall: a.shortfall,
      spares: n.spares, buyQty: a.buyQty,
      bestSupplierId: n.status === 'to_buy' && a.buyQty > 0 ? bestByPart.get(n.partId)?.quote.supplierId ?? null : null,
      overrideSupplierId: n.overrideSupplierId, supplierId,
      unitPriceIdr: g?.unitPriceIdr ?? null, moq: quote?.moq ?? null, orderQty: g?.orderQty ?? null, listingShippingIdr: g?.shippingIdr ?? null,
      lineTotalIdr: share.get(n.id) ?? 0, orderedTotalIdr: n.status === 'ordered' ? n.orderedTotalIdr ?? 0 : 0,
    };
  });

  const recap: SupplierRecap[] = suppliers.map((s) => {
    const mine = [...groups.values()].filter((g) => g.supplierId === s.id);
    const subtotalIdr = mine.reduce((t, g) => t + g.subtotalIdr, 0);
    const listingShippingIdr = mine.reduce((t, g) => t + g.shippingIdr, 0);
    const ship = orderShipping(s, subtotalIdr + listingShippingIdr);
    return {
      supplierId: s.id, name: s.name, lines: lines.filter((l) => l.state === 'buy' && l.supplierId === s.id).length,
      subtotalIdr, listingShippingIdr, orderShippingIdr: ship, totalIdr: subtotalIdr + listingShippingIdr + ship,
      orderedInTransitIdr: needs.filter((n) => n.status === 'ordered' && n.orderedSupplierId === s.id).reduce((t, n) => t + (n.orderedTotalIdr ?? 0), 0),
    };
  });
  const recapTotal = recap.reduce((t, r) => ({
    lines: t.lines + r.lines, subtotalIdr: t.subtotalIdr + r.subtotalIdr, listingShippingIdr: t.listingShippingIdr + r.listingShippingIdr,
    orderShippingIdr: t.orderShippingIdr + r.orderShippingIdr, totalIdr: t.totalIdr + r.totalIdr, orderedInTransitIdr: t.orderedInTransitIdr + r.orderedInTransitIdr,
  }), { lines: 0, subtotalIdr: 0, listingShippingIdr: 0, orderShippingIdr: 0, totalIdr: 0, orderedInTransitIdr: 0 });

  // "Lines to buy" counts every still-to-buy line that buys something, quoted or not (the sheet did).
  const slice = (keyOf: (l: BuyLine) => string): Slice[] => {
    const m = new Map<string, Slice>();
    for (const l of lines) {
      const buying = l.state === 'buy' || l.state === 'no_quote';
      if (!buying && l.state !== 'ordered') continue;
      const s = m.get(keyOf(l)) ?? { key: keyOf(l), lines: 0, toBuyIdr: 0, orderedIdr: 0 };
      if (buying) { s.lines++; s.toBuyIdr += l.lineTotalIdr; }
      s.orderedIdr += l.orderedTotalIdr;
      m.set(s.key, s);
    }
    return [...m.values()];
  };
  const matrix: MatrixRow[] = [...quotesByPart].map(([partId, qs]) => {
    const need = needs.find((n) => n.partId === partId);
    const d = demand.get(partId) ?? 0;
    const row: MatrixRow = { partId, mpn: need?.mpn ?? '', demand: d, bySupplier: {} };
    for (const r of rankQuotes(qs, d)) row.bySupplier[r.quote.supplierId] = { landedPerUnitIdr: r.landedPerUnitIdr, totalIdr: r.priced.totalIdr, rank: r.rank, best: r.best };
    return row;
  }).filter((r) => r.mpn !== '');

  return {
    lines, groups: [...groups.values()], recap, recapTotal,
    byProject: slice((l) => l.projectName), byPriority: slice((l) => l.priority), matrix,
  };
}

/**
 * LCSC's BOM tool (lcsc.com/bom) maps columns itself on upload and accepts CSV up
 * to 4 MB and 800 lines; it needs a Quantity column plus a part identifier. This
 * is the ONE place the cart format lives (verified 2026-10-06), so a change on
 * their side is a one-function change here.
 */
export const LCSC_CART_MAX_LINES = 800;
export function lcscCartCsv(groups: readonly OrderGroup[], lcscSupplierId: number): { csv: string; lines: number; skipped: string[] } {
  const mine = groups.filter((g) => g.supplierId === lcscSupplierId);
  const skipped = mine.filter((g) => !g.lcscCode).map((g) => g.mpn);
  const rows = mine.filter((g) => g.lcscCode).map((g) => `${g.lcscCode},${g.orderQty}`);
  return { csv: ['LCSC Part Number,Quantity', ...rows].join('\r\n') + '\r\n', lines: rows.length, skipped };
}
