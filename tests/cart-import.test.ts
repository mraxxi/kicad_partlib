import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import cartCsv from './fixtures/lcsc/export_cart_20261006_140514.csv?raw';
import { FILES, api, count, importLcsc, reset } from './helpers';

const CART = { filename: 'export_cart_20261006_140514.csv', csv: cartCsv };
const run = (extra: object = {}, apply = false) => api('/api/import/lcsc-cart', { ...CART, newProjectName: 'TPA3255 Amp', fxIdrPerUsd: '17893', apply, ...extra });
const snapshot = async () => ({ parts: await count('parts'), needs: await count('needs'), quotes: await count('quotes'), projects: await count('projects'), runs: await count('import_runs') });
const line = (json: any, mpn: string) => json.lines.find((l: any) => l.mpn === mpn);

beforeEach(async () => {
  await reset();
  await importLcsc(FILES.a, { apply: true });
  await importLcsc(FILES.b, { apply: true }); // 99 parts, with real stock
});

describe('LCSC cart import: the plan', () => {
  it('writes nothing while planning, and says what it would do', async () => {
    const before = await snapshot();
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe('plan');
    expect(r.json.summary).toMatchObject({ total: 52, needsToCreate: 52, needsExisting: 0 });
    expect(r.json.summary.newParts + r.json.summary.matchedParts).toBe(52);
    expect(r.json.summary.newParts).toBeGreaterThan(5);
    expect(r.json.project).toEqual({ name: 'TPA3255 Amp', isNew: true });
    expect(await snapshot()).toEqual(before);
  });

  it('knows what is already in stock, so it shows what would actually be bought', async () => {
    const { json } = await run();
    // 8 TPA3116D2DADR and 100 of the 180 ohm resistor are in stock from the real orders
    expect(line(json, 'TPA3116D2DADR')).toMatchObject({ qty: 8, stock: 8, willBuy: 0 });
    expect(line(json, 'AECR0805F180RK9')).toMatchObject({ qty: 100, stock: 100, willBuy: 0 });
    expect(line(json, 'RP2350A')).toMatchObject({ part: 'create_part', stock: 0, willBuy: 20 });
    expect(json.summary.lowStock).toBeGreaterThan(10);
  });

  it('converts the cart\'s USD price into an IDR quote at the typed rate, with the MOQ', async () => {
    const { json } = await run();
    // $0.0167 x 17,893 = 298.8 -> Rp 299; MOQ 50
    expect(line(json, 'XC6206P332MR-MS').quote).toMatchObject({ action: 'create', unitPriceIdr: 299, moq: 50 });
    expect(line(json, 'RP2040').quote).toMatchObject({ unitPriceIdr: Math.round(0.9089 * 17893) });
  });

  it('makes no quote for a part the cart shows no price for, and says so', async () => {
    const { json } = await run();
    expect(line(json, 'PCM5102APWR').quote.action).toBe('skip');
    expect(json.warnings.some((w: string) => /PCM5102APWR\): no price in the cart/.test(w))).toBe(true);
  });

  it('refuses a file that is not a cart export, and a request that names no project or two', async () => {
    expect((await run({ csv: FILES.a.csv })).json.errors[0]).toMatch(/does not look like an LCSC cart export/);
    expect((await api('/api/import/lcsc-cart', { ...CART, apply: false })).json.errors[0]).toMatch(/not both and not neither/);
    expect((await run({ projectId: 1 })).json.errors[0]).toMatch(/not both and not neither/);
    expect((await api('/api/import/lcsc-cart', { ...CART, projectId: 999 })).status).toBe(404);
  });
});

describe('LCSC cart import: applying', () => {
  it('creates the project, the missing parts, one need per line and an LCSC quote per priced line', async () => {
    const plan = (await run()).json;
    const a = await run({}, true);
    expect(a.status).toBe(200);
    expect(await count('projects')).toBe(1);
    expect(await count('needs')).toBe(52);
    expect(await count('parts')).toBe(99 + plan.summary.newParts);
    expect(await count('quotes')).toBe(51); // PCM5102APWR has no price
    const need = await env.DB.prepare(`SELECT n.qty_needed AS qty, n.priority FROM needs n JOIN parts p ON p.id = n.part_id WHERE p.mpn = 'RP2350A'`).first<any>();
    expect(need).toEqual({ qty: 20, priority: 'medium' });
    const q = await env.DB.prepare(`SELECT q.unit_price_idr AS price, q.moq, q.notes, q.url FROM quotes q JOIN parts p ON p.id = q.part_id WHERE p.mpn = 'XC6206P332MR-MS'`).first<any>();
    expect(q).toMatchObject({ price: 299, moq: 50, url: 'https://www.lcsc.com/product-detail/C5252899.html' });
    expect(q.notes).toMatch(/sold in multiples of 50/);
  });

  it('is idempotent: importing the same cart again changes nothing', async () => {
    await run({}, true);
    const before = await snapshot();
    const again = await run({ newProjectName: undefined, projectId: (await env.DB.prepare('SELECT id FROM projects').first<{ id: number }>())!.id }, true);
    expect(again.json.summary).toMatchObject({ needsToCreate: 0, needsExisting: 52, newParts: 0 });
    expect(again.json.rowsWritten).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('keeps an existing need\'s quantity, and says the cart disagrees', async () => {
    await run({}, true);
    const pid = (await env.DB.prepare('SELECT id FROM projects').first<{ id: number }>())!.id;
    await env.DB.prepare(`UPDATE needs SET qty_needed = 5 WHERE part_id = (SELECT id FROM parts WHERE mpn = 'RP2350A')`).run();
    const r = await run({ newProjectName: undefined, projectId: pid }, true);
    expect(line(r.json, 'RP2350A').need).toEqual({ action: 'exists', existingQty: 5 });
    expect(r.json.warnings.some((w: string) => /RP2350A\): the project already needs 5; the cart says 20/.test(w))).toBe(true);
    expect((await env.DB.prepare(`SELECT qty_needed AS q FROM needs WHERE part_id = (SELECT id FROM parts WHERE mpn = 'RP2350A')`).first<any>()).q).toBe(5);
  });

  it('updates a quote whose price changed, and leaves one with price breaks alone', async () => {
    await run({}, true);
    const pid = (await env.DB.prepare('SELECT id FROM projects').first<{ id: number }>())!.id;
    await env.DB.prepare(`UPDATE quotes SET price_breaks_json = '[{"qty":100,"priceIdr":200}]' WHERE part_id = (SELECT id FROM parts WHERE mpn = 'XC6206P332MR-MS')`).run();
    const r = await run({ newProjectName: undefined, projectId: pid, fxIdrPerUsd: '18500' }, true);
    expect(line(r.json, 'XC6206P332MR-MS').quote).toMatchObject({ action: 'skip', reason: expect.stringMatching(/price breaks/) });
    expect(line(r.json, 'RP2040').quote.action).toBe('update');
    const kept = await env.DB.prepare(`SELECT unit_price_idr AS p, price_breaks_json AS b FROM quotes WHERE part_id = (SELECT id FROM parts WHERE mpn = 'XC6206P332MR-MS')`).first<any>();
    expect(kept).toEqual({ p: 299, b: '[{"qty":100,"priceIdr":200}]' });
    expect((await env.DB.prepare(`SELECT unit_price_idr AS p FROM quotes WHERE part_id = (SELECT id FROM parts WHERE mpn = 'RP2040')`).first<any>()).p).toBe(Math.round(0.9089 * 18500));
  });

  it('can leave quotes alone', async () => {
    await run({ updateQuotes: false }, true);
    expect(await count('needs')).toBe(52);
    expect(await count('quotes')).toBe(0);
  });

  it('feeds the buy list, and the LCSC cart exported from it matches what was imported', async () => {
    const plan = (await run()).json;
    await run({}, true);
    const bl = (await api('/api/buylist')).json.buyList;
    const buying = bl.lines.filter((l: any) => l.state === 'buy');
    expect(buying.length).toBe(plan.lines.filter((l: any) => l.willBuy > 0 && l.quote.action !== 'skip').length);
    const csv = await (await exports.default.fetch(new Request('https://partlib.test/api/buylist/cart.csv'))).text();
    const rows = csv.trim().split(/\r\n/).slice(1);
    expect(rows.length).toBe(bl.groups.filter((g: any) => g.lcscCode).length);
    // 20 RP2350A, ordered at that quantity (MOQ 1)
    expect(rows).toContain('C42411118,20');
    // a cart line covered by stock is not exported
    expect(rows.some((r) => r.startsWith('C50144,'))).toBe(false);
  });

  it('refuses to put a new project name on top of an existing one', async () => {
    await run({}, true);
    const again = await run({}, true);
    expect(again.status).toBe(422);
    expect(again.json.errors[0]).toMatch(/already exists; choose it from the list/);
  });
});
