import { describe, expect, it } from 'vitest';
import {
  allocateStock, computeBuyList, lcscCartCsv, orderShipping, priceOrder, rankQuotes, splitTotal, unitPriceAt,
  type Need, type Priority, type Quote, type Risk, type Supplier,
} from '../src/domain/purchasing';

// ---- The owner's Google Sheet, sample rows ported verbatim as the acceptance fixture ----
const LCSC = 1, MOUSER = 2, TOKO = 3, SHOPEE = 4, ALI = 5, LOCAL = 6;
const suppliers: Supplier[] = [
  { id: LCSC, name: 'LCSC', orderShippingIdr: 160000, freeShipOverIdr: null },
  { id: MOUSER, name: 'Mouser', orderShippingIdr: 350000, freeShipOverIdr: 1500000 },
  { id: TOKO, name: 'Tokopedia', orderShippingIdr: 0, freeShipOverIdr: null },
  { id: SHOPEE, name: 'Shopee', orderShippingIdr: 0, freeShipOverIdr: null },
  { id: ALI, name: 'AliExpress', orderShippingIdr: 0, freeShipOverIdr: null },
  { id: LOCAL, name: 'Local Shop', orderShippingIdr: 0, freeShipOverIdr: null },
];
const PART = { pcm: 1, rp: 2, usbc: 3, xtal: 4, tpa: 5, ind: 6, max: 7, cap: 8 };
let qid = 0;
const q = (partId: number, supplierId: number, unitPriceIdr: number, moq: number, listingShippingIdr: number, leadDays: number, risk: Risk, priceBreaks: Quote['priceBreaks'] = []): Quote =>
  ({ id: ++qid, partId, supplierId, seller: '', unitPriceIdr, moq, priceBreaks, listingShippingIdr, leadDays, risk, url: '', quotedAt: '2026-10-06' });
const quotes: Quote[] = [
  q(PART.pcm, LCSC, 18000, 1, 0, 10, 'low'), q(PART.pcm, TOKO, 27500, 1, 12000, 3, 'medium'), q(PART.pcm, ALI, 14000, 5, 9000, 18, 'high'),
  q(PART.usbc, LCSC, 1200, 5, 0, 10, 'low'), q(PART.usbc, SHOPEE, 3500, 1, 10000, 3, 'medium'), q(PART.usbc, TOKO, 2800, 1, 9000, 2, 'medium'),
  q(PART.tpa, LCSC, 69230, 1, 0, 10, 'low'), q(PART.tpa, MOUSER, 112000, 1, 0, 7, 'low'), q(PART.tpa, TOKO, 135000, 1, 12000, 3, 'medium'),
  q(PART.ind, LCSC, 7500, 5, 0, 10, 'low'), q(PART.ind, MOUSER, 14000, 1, 0, 7, 'low'), q(PART.ind, ALI, 3000, 10, 15000, 18, 'high'),
  q(PART.max, LCSC, 48000, 1, 0, 10, 'low'), q(PART.max, MOUSER, 62000, 1, 0, 7, 'low'),
  q(PART.cap, LCSC, 68, 100, 0, 10, 'low'), q(PART.cap, SHOPEE, 120, 100, 8000, 3, 'medium'),
];
let nid = 0;
const need = (o: Partial<Need> & Pick<Need, 'projectName' | 'partId' | 'mpn' | 'qtyNeeded' | 'priority' | 'status'>): Need =>
  ({ id: ++nid, projectId: 1, description: '', lcscCode: null, spares: 0, overrideSupplierId: null, orderedSupplierId: null, orderedQty: null, orderedTotalIdr: null, rev: 0, ...o });
const SC = '7.1 USB Sound Card';
const needs: Need[] = [
  need({ projectName: SC, partId: PART.pcm, mpn: 'PCM5102A', qtyNeeded: 4, spares: 1, priority: 'high', status: 'to_buy' }),
  need({ projectName: SC, partId: PART.rp, mpn: 'RP2350A', qtyNeeded: 1, priority: 'high', status: 'to_buy' }),
  need({ projectName: SC, partId: PART.usbc, mpn: 'TYPE-C-31-M-12', qtyNeeded: 2, spares: 3, priority: 'high', status: 'to_buy' }),
  need({ projectName: SC, partId: PART.xtal, mpn: 'X322512MSB4SI', qtyNeeded: 1, priority: 'medium', status: 'to_buy' }),
  need({ projectName: 'TPA3255 Amp', partId: PART.tpa, mpn: 'TPA3255DDVR', qtyNeeded: 2, priority: 'high', status: 'to_buy' }),
  need({ projectName: 'TPA3255 Amp', partId: PART.ind, mpn: 'CDRH127NP-100MC', qtyNeeded: 8, priority: 'medium', status: 'to_buy', overrideSupplierId: LCSC }),
  need({ projectName: 'Rework Station', partId: PART.max, mpn: 'MAX31855KASA+T', qtyNeeded: 2, priority: 'medium', status: 'ordered', orderedSupplierId: LCSC, orderedQty: 2, orderedTotalIdr: 96000 }),
  need({ projectName: 'General Stock', partId: PART.cap, mpn: 'CGA0603X7R104K101JT', qtyNeeded: 150, spares: 50, priority: 'low', status: 'to_buy' }),
];
const usable = new Map([[PART.tpa, 5], [PART.cap, 100]]);
const bl = computeBuyList({ needs, usableByPart: usable, quotes, suppliers });
const line = (mpn: string) => bl.lines.find((l) => l.mpn === mpn)!;

describe('the owner\'s sheet, ported as a fixture', () => {
  it('buys shortfall plus spares, and nothing when stock covers the need', () => {
    expect(line('PCM5102A')).toMatchObject({ shortfall: 4, buyQty: 5 });
    expect(line('TYPE-C-31-M-12')).toMatchObject({ shortfall: 2, buyQty: 5 });
    expect(line('TPA3255DDVR')).toMatchObject({ shortfall: 0, buyQty: 0, state: 'covered' });
    expect(line('CGA0603X7R104K101JT')).toMatchObject({ shortfall: 50, buyQty: 100 });
  });

  it('picks the best supplier by landed cost, and honours an override', () => {
    expect(line('PCM5102A')).toMatchObject({ bestSupplierId: ALI, supplierId: ALI, unitPriceIdr: 14000, orderQty: 5, lineTotalIdr: 79000 });
    expect(line('TYPE-C-31-M-12')).toMatchObject({ supplierId: LCSC, lineTotalIdr: 6000 });
    // Overridden from AliExpress (cheaper) to LCSC; ordered at MOQ-or-need, whichever is more.
    expect(line('CDRH127NP-100MC')).toMatchObject({ bestSupplierId: ALI, supplierId: LCSC, orderQty: 8, lineTotalIdr: 60000 });
    expect(line('CGA0603X7R104K101JT')).toMatchObject({ supplierId: LCSC, lineTotalIdr: 6800 });
  });

  it('flags a line with no quotes instead of inventing a price', () => {
    expect(line('RP2350A')).toMatchObject({ state: 'no_quote', buyQty: 1, supplierId: null, lineTotalIdr: 0 });
  });

  it('reproduces the sheet\'s Purchase Recap by supplier, to the rupiah', () => {
    const r = Object.fromEntries(bl.recap.map((x) => [x.name, x]));
    expect(r['LCSC']).toMatchObject({ lines: 3, subtotalIdr: 72800, listingShippingIdr: 0, orderShippingIdr: 160000, totalIdr: 232800, orderedInTransitIdr: 96000 });
    expect(r['AliExpress']).toMatchObject({ lines: 1, subtotalIdr: 70000, listingShippingIdr: 9000, orderShippingIdr: 0, totalIdr: 79000 });
    expect(r['Mouser']).toMatchObject({ lines: 0, totalIdr: 0, orderShippingIdr: 0 });
    expect(bl.recapTotal).toEqual({ lines: 4, subtotalIdr: 142800, listingShippingIdr: 9000, orderShippingIdr: 160000, totalIdr: 311800, orderedInTransitIdr: 96000 });
  });

  it('reproduces the spend by project and by priority', () => {
    const p = Object.fromEntries(bl.byProject.map((s) => [s.key, s]));
    expect(p[SC]).toMatchObject({ lines: 4, toBuyIdr: 85000, orderedIdr: 0 });
    expect(p['TPA3255 Amp']).toMatchObject({ lines: 1, toBuyIdr: 60000 });
    expect(p['Rework Station']).toMatchObject({ lines: 0, orderedIdr: 96000 });
    expect(p['General Stock']).toMatchObject({ lines: 1, toBuyIdr: 6800 });
    const pr = Object.fromEntries(bl.byPriority.map((s) => [s.key, s]));
    expect(pr['high']).toMatchObject({ lines: 3, toBuyIdr: 85000 });
    expect(pr['medium']).toMatchObject({ lines: 2, toBuyIdr: 60000, orderedIdr: 96000 });
    expect(pr['low']).toMatchObject({ lines: 1, toBuyIdr: 6800 });
  });

  it('reproduces the landed-cost-per-unit price matrix', () => {
    const m = Object.fromEntries(bl.matrix.map((r) => [r.mpn, r.bySupplier]));
    const per = (mpn: string) => Object.fromEntries(Object.entries(m[mpn]!).map(([s, v]) => [Number(s), v.landedPerUnitIdr]));
    expect(per('PCM5102A')).toEqual({ [LCSC]: 18000, [TOKO]: 29900, [ALI]: 15800 });
    expect(per('TYPE-C-31-M-12')).toEqual({ [LCSC]: 1200, [TOKO]: 4600, [SHOPEE]: 5500 });
    expect(per('TPA3255DDVR')).toEqual({ [LCSC]: 69230, [MOUSER]: 112000, [TOKO]: 147000 });
    expect(per('CDRH127NP-100MC')).toEqual({ [LCSC]: 7500, [MOUSER]: 14000, [ALI]: 5625 });
    expect(per('MAX31855KASA+T')).toEqual({ [LCSC]: 48000, [MOUSER]: 62000 });
    expect(per('CGA0603X7R104K101JT')).toEqual({ [LCSC]: 68, [SHOPEE]: 200 });
    expect(m['PCM5102A']![ALI]!.best).toBe(true);
  });
});

describe('where the app deliberately differs from the sheet', () => {
  const mk = (id: number, project: string, qty: number, prio: Priority): Need =>
    need({ id, projectName: project, partId: 9, mpn: 'X', qtyNeeded: qty, priority: prio, status: 'to_buy' });

  it('shares stock across needs instead of counting it once per project', () => {
    const a = allocateStock([mk(1, 'A', 6, 'low'), mk(2, 'B', 6, 'high')], new Map([[9, 8]]));
    // The high-priority need takes 6 of the 8; the low one finds only 2.
    expect(a.get(2)).toMatchObject({ stockAllotted: 6, shortfall: 0, buyQty: 0 });
    expect(a.get(1)).toMatchObject({ stockAllotted: 2, shortfall: 4, buyQty: 4 });
  });

  it('orders the same part from the same supplier once: one MOQ, one listing shipping', () => {
    const two = computeBuyList({
      needs: [mk(1, 'A', 30, 'high'), mk(2, 'B', 30, 'high')], usableByPart: new Map(),
      quotes: [q(9, TOKO, 100, 50, 5000, 3, 'low')], suppliers,
    });
    // Per-line (the sheet): 2 x (50 x 100 + 5000) = 20,000. Together: 60 pcs, one shipping.
    expect(two.groups).toHaveLength(1);
    expect(two.groups[0]).toMatchObject({ buyQty: 60, orderQty: 60, subtotalIdr: 6000, shippingIdr: 5000, totalIdr: 11000 });
    expect(two.lines.map((l) => l.lineTotalIdr)).toEqual([5500, 5500]);
  });
});

describe('pricing', () => {
  const base = q(1, LCSC, 100, 10, 0, 5, 'low', [{ qty: 100, priceIdr: 80 }, { qty: 1000, priceIdr: 60 }]);
  it('uses the price break for the quantity actually ordered, MOQ included', () => {
    expect(unitPriceAt(base, 50)).toBe(100);
    expect(unitPriceAt(base, 100)).toBe(80);
    expect(unitPriceAt(base, 999)).toBe(80);
    expect(unitPriceAt(base, 5000)).toBe(60);
    expect(priceOrder(base, 3)).toMatchObject({ orderQty: 10, unitPriceIdr: 100, subtotalIdr: 1000 });
  });
  it('ranks ties as shared and breaks them by lead time for the pick', () => {
    const a = q(1, TOKO, 100, 1, 0, 9, 'low'), b = q(1, SHOPEE, 100, 1, 0, 2, 'low');
    const r = rankQuotes([a, b], 10);
    expect(r.map((x) => x.rank)).toEqual([1, 1]);
    expect(r[0]!.quote.supplierId).toBe(SHOPEE);
  });
  it('waives order shipping at the threshold, and charges none when nothing is bought', () => {
    const m = suppliers[1]!;
    expect(orderShipping(m, 0)).toBe(0);
    expect(orderShipping(m, 1_499_999)).toBe(350000);
    expect(orderShipping(m, 1_500_000)).toBe(0);
  });
  it('splits a total so the parts add up exactly', () => {
    expect(splitTotal(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitTotal(7, [5, 0, 2]).reduce((a, b) => a + b, 0)).toBe(7);
    expect(splitTotal(0, [0, 0])).toEqual([0, 0]);
  });
});

describe('LCSC cart export', () => {
  it('lists only LCSC groups, at the quantity to order, and names parts it cannot export', () => {
    const groups = [
      { partId: 1, mpn: 'A', lcscCode: 'C1', supplierId: LCSC, quoteId: 1, buyQty: 5, orderQty: 10, unitPriceIdr: 1, subtotalIdr: 10, shippingIdr: 0, totalIdr: 10, needIds: [1] },
      { partId: 2, mpn: 'B', lcscCode: null, supplierId: LCSC, quoteId: 2, buyQty: 5, orderQty: 5, unitPriceIdr: 1, subtotalIdr: 5, shippingIdr: 0, totalIdr: 5, needIds: [2] },
      { partId: 3, mpn: 'C', lcscCode: 'C3', supplierId: ALI, quoteId: 3, buyQty: 5, orderQty: 5, unitPriceIdr: 1, subtotalIdr: 5, shippingIdr: 0, totalIdr: 5, needIds: [3] },
    ];
    const out = lcscCartCsv(groups, LCSC);
    expect(out.csv).toBe('LCSC Part Number,Quantity\r\nC1,10\r\n');
    expect(out.skipped).toEqual(['B']);
  });
});
