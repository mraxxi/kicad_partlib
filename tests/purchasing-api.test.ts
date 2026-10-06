import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { FILES, api, count, importLcsc, reset } from './helpers';

const sup: Record<string, number> = {};
async function setup() {
  await reset();
  const rows = await env.DB.prepare('SELECT id, name FROM suppliers').all<{ id: number; name: string }>();
  for (const r of rows.results) sup[r.name] = r.id;
  await api(`/api/suppliers/${sup.LCSC}`, { orderShippingIdr: 160000 }, 'PATCH');
  await api(`/api/suppliers/${sup.Mouser}`, { orderShippingIdr: 350000, freeShipOverIdr: 1500000 }, 'PATCH');
}
const mkPart = async (mpn: string, lcscCode: string | null = null) => (await api('/api/parts', { mpn, lcscCode })).json.id as number;
const project = async (name: string) => (await api('/api/projects', { name })).json.id as number;
const need = async (projectId: number, partId: number, qtyNeeded: number, spares = 0, priority = 'medium') =>
  (await api('/api/needs', { projectId, partId, qtyNeeded, spares, priority })).json.id as number;
const quote = (partId: number, supplier: string, unitPriceIdr: number, moq: number, listingShippingIdr: number, leadDays: number, risk: string) =>
  api(`/api/parts/${partId}/quotes`, { supplierId: sup[supplier], unitPriceIdr, moq, listingShippingIdr, leadDays, risk }, 'PUT');
const buyList = async () => (await api('/api/buylist')).json;

beforeEach(setup);

describe('the sheet\'s numbers, end to end through the API and real stock', () => {
  it('reproduces the recap using stock that came from the real LCSC import', async () => {
    await importLcsc(FILES.a, { apply: true }); // gives TPA3255DDVR x5 and CGA0603X7R104K101JT x100, as in the sheet
    const tpa = (await env.DB.prepare("SELECT id FROM parts WHERE mpn = 'TPA3255DDVR'").first<{ id: number }>())!.id;
    const cap = (await env.DB.prepare("SELECT id FROM parts WHERE mpn = 'CGA0603X7R104K101JT'").first<{ id: number }>())!.id;
    const pcm = await mkPart('PCM5102A'), usbc = await mkPart('TYPE-C-31-M-12'), ind = await mkPart('CDRH127NP-100MC');
    const sc = await project('7.1 USB Sound Card'), amp = await project('TPA3255 Amp'), gen = await project('General Stock');
    await need(sc, pcm, 4, 1, 'high'); await need(sc, usbc, 2, 3, 'high');
    await need(amp, tpa, 2, 0, 'high'); const nInd = await need(amp, ind, 8, 0, 'medium');
    await need(gen, cap, 150, 50, 'low');
    await quote(pcm, 'LCSC', 18000, 1, 0, 10, 'low'); await quote(pcm, 'Tokopedia', 27500, 1, 12000, 3, 'medium'); await quote(pcm, 'AliExpress', 14000, 5, 9000, 18, 'high');
    await quote(usbc, 'LCSC', 1200, 5, 0, 10, 'low'); await quote(usbc, 'Shopee', 3500, 1, 10000, 3, 'medium'); await quote(usbc, 'Tokopedia', 2800, 1, 9000, 2, 'medium');
    await quote(ind, 'LCSC', 7500, 5, 0, 10, 'low'); await quote(ind, 'Mouser', 14000, 1, 0, 7, 'low'); await quote(ind, 'AliExpress', 3000, 10, 15000, 18, 'high');
    await quote(cap, 'LCSC', 68, 100, 0, 10, 'low'); await quote(cap, 'Shopee', 120, 100, 8000, 3, 'medium');
    // Without an override the inductor goes to AliExpress; the sheet overrode it to LCSC.
    expect((await buyList()).buyList.lines.find((l: any) => l.mpn === 'CDRH127NP-100MC').supplierId).toBe(sup.AliExpress);
    expect((await api(`/api/needs/${nInd}`, { rev: 0, overrideSupplierId: sup.LCSC }, 'PATCH')).status).toBe(200);

    const { buyList: bl } = await buyList();
    const r = Object.fromEntries(bl.recap.map((x: any) => [x.name, x]));
    expect(r.LCSC).toMatchObject({ lines: 3, subtotalIdr: 72800, orderShippingIdr: 160000, totalIdr: 232800 });
    expect(r.AliExpress).toMatchObject({ lines: 1, subtotalIdr: 70000, listingShippingIdr: 9000, totalIdr: 79000 });
    const covered = bl.lines.find((l: any) => l.mpn === 'TPA3255DDVR');
    expect(covered).toMatchObject({ state: 'covered', usableInStock: 5, buyQty: 0 });
  });
});

describe('ordering and receiving', () => {
  async function scenario() {
    await importLcsc(FILES.b, { apply: true });
    const ne = (await env.DB.prepare("SELECT id FROM parts WHERE mpn = 'NE5532DR'").first<{ id: number }>())!.id;
    const p = await project('Preamp');
    const n = await need(p, ne, 30, 5, 'high'); // stock is 10 -> buys 20 + 5 = 25
    await quote(ne, 'LCSC', 1000, 1, 0, 10, 'low');
    return { ne, n, p };
  }

  it('previews an order without changing anything, then freezes cost and status on apply', async () => {
    const { n } = await scenario();
    const preview = await api('/api/buylist/order', { supplierId: sup.LCSC });
    expect(preview.json.mode).toBe('plan');
    expect(preview.json.plan).toMatchObject({ partsIdr: 25000, orderShippingIdr: 160000, grandTotalIdr: 185000 });
    expect(preview.json.plan.lines).toEqual([{ needId: n, projectName: 'Preamp', mpn: 'NE5532DR', qty: 25, totalIdr: 25000 }]);
    expect(await env.DB.prepare("SELECT status FROM needs WHERE id = ?").bind(n).first('status')).toBe('to_buy');

    expect((await api('/api/buylist/order', { supplierId: sup.LCSC, apply: true })).json.ordered).toBe(1);
    expect(await env.DB.prepare('SELECT status, ordered_qty AS q, ordered_total_idr AS t, ordered_supplier_id AS s FROM needs WHERE id = ?').bind(n).first())
      .toEqual({ status: 'ordered', q: 25, t: 25000, s: sup.LCSC });
    // A price change after ordering must not move the money already committed.
    const part = (await env.DB.prepare('SELECT part_id AS p FROM needs WHERE id = ?').bind(n).first<{ p: number }>())!.p;
    await quote(part, 'LCSC', 5000, 1, 0, 10, 'low');
    const bl = (await buyList()).buyList;
    expect(bl.recapTotal.orderedInTransitIdr).toBe(25000);
    expect(bl.byProject[0]).toMatchObject({ key: 'Preamp', orderedIdr: 25000 });
    // Applying again changes nothing: the line is no longer to-buy.
    expect((await api('/api/buylist/order', { supplierId: sup.LCSC, apply: true })).status).toBe(409);
  });

  it('a mistaken "ordered" can be undone, which clears the frozen cost', async () => {
    const { n } = await scenario();
    await api('/api/buylist/order', { supplierId: sup.LCSC, apply: true });
    const rev = (await env.DB.prepare('SELECT rev FROM needs WHERE id = ?').bind(n).first<{ rev: number }>())!.rev;
    expect((await api(`/api/needs/${n}`, { rev, status: 'to_buy' }, 'PATCH')).status).toBe(200);
    expect(await env.DB.prepare('SELECT status, ordered_total_idr AS t FROM needs WHERE id = ?').bind(n).first()).toEqual({ status: 'to_buy', t: null });
  });

  it('importing the real LCSC order shows the lines it will close, then closes them and links the order', async () => {
    const { ne, n } = await scenario();
    await api('/api/buylist/order', { supplierId: sup.LCSC, apply: true });
    // The ordered need is for a part already stocked from the earlier import; a second order of it arrives.
    const csv = FILES.b.csv.split(/\r?\n/).filter((l, i) => i === 0 || l.startsWith('C7426,')).join('\n');
    const second = { filename: 'LCSC__WM2510010001_20261010000000.csv', csv };
    const plan = await importLcsc(second);
    expect(plan.json.plan.needsToClose).toEqual([{ needId: n, projectName: 'Preamp', mpn: 'NE5532DR', qty: 25 }]);
    expect(await env.DB.prepare('SELECT status FROM needs WHERE id = ?').bind(n).first('status')).toBe('ordered'); // planning wrote nothing
    const applied = await importLcsc(second, { apply: true });
    expect(applied.json.closedNeeds).toBe(1);
    const row = await env.DB.prepare('SELECT n.status, o.order_no AS orderNo FROM needs n JOIN orders o ON o.id = n.order_id WHERE n.id = ?').bind(n).first<any>();
    expect(row).toEqual({ status: 'received', orderNo: 'WM2510010001' });
    expect(ne).toBeGreaterThan(0);
  });
});

describe('guards', () => {
  it('refuses a duplicate part, a repeated need and a stale edit, each in a sentence', async () => {
    const pcm = await mkPart('PCM5102A', 'C12345');
    expect((await api('/api/parts', { mpn: 'pcm5102a' })).json.error).toMatch(/^That part already exists as P-\d{4}\.$/);
    expect((await api('/api/parts', { mpn: 'OTHER', lcscCode: 'C12345' })).status).toBe(409);
    const p = await project('X');
    const n = await need(p, pcm, 4);
    expect((await api('/api/needs', { projectId: p, partId: pcm, qtyNeeded: 1 })).json.error).toMatch(/already needs that part/);
    await api(`/api/needs/${n}`, { rev: 0, qtyNeeded: 6 }, 'PATCH');
    const stale = await api(`/api/needs/${n}`, { rev: 0, qtyNeeded: 9 }, 'PATCH');
    expect(stale.status).toBe(409);
    expect(stale.json.detail.currentRev).toBe(1);
  });

  it('keeps one quote per part and supplier, and restamps it when saved again', async () => {
    const pcm = await mkPart('PCM5102A');
    await quote(pcm, 'LCSC', 18000, 1, 0, 10, 'low');
    await quote(pcm, 'LCSC', 17000, 1, 0, 10, 'low');
    const q = (await api(`/api/parts/${pcm}/quotes`)).json.quotes;
    expect(q).toHaveLength(1);
    expect(q[0].unitPriceIdr).toBe(17000);
    expect((await api(`/api/quotes/${q[0].id}`, undefined, 'DELETE')).status).toBe(200);
    expect(await count('quotes')).toBe(0);
  });

  it('applies price breaks from a saved quote when pricing a large order', async () => {
    const pcm = await mkPart('PCM5102A');
    const p = await project('Y');
    await need(p, pcm, 1000);
    await api(`/api/parts/${pcm}/quotes`, { supplierId: sup.LCSC, unitPriceIdr: 100, priceBreaks: [{ qty: 100, priceIdr: 80 }, { qty: 1000, priceIdr: 60 }] }, 'PUT');
    expect((await buyList()).buyList.lines[0]).toMatchObject({ unitPriceIdr: 60, lineTotalIdr: 60000 });
  });

  it('exports an LCSC cart of the quantities to order, and refuses to export nothing', async () => {
    expect((await exportCart()).status).toBe(409);
    await importLcsc(FILES.b, { apply: true });
    const ne = (await env.DB.prepare("SELECT id FROM parts WHERE mpn = 'NE5532DR'").first<{ id: number }>())!.id;
    const p = await project('Preamp');
    await need(p, ne, 30, 5);
    await quote(ne, 'LCSC', 1000, 1, 0, 10, 'low');
    const res = await exportCart();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('LCSC Part Number,Quantity\r\nC7426,25\r\n');
  });
});

import { exports } from 'cloudflare:workers';
const exportCart = () => exports.default.fetch(new Request('https://partlib.test/api/buylist/cart.csv'));
