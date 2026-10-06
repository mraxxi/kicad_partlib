import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import cartCsv from './fixtures/lcsc/export_cart_20261006_140514.csv?raw';
import { cartLabel, fxProblem, orderLabel } from '../src/domain/labels';
import { FILES, api, count, importLcsc, reset } from './helpers';

const CART = { filename: 'export_cart_20261006_140514.csv', csv: cartCsv, newProjectName: 'tester', fxIdrPerUsd: '17893' };
beforeEach(reset);

describe('names are computed from the date; the number stays the key', () => {
  it('names an order by its date, an alias wins, and two orders of one day are told apart', () => {
    expect(orderLabel({ alias: null, orderDate: '2024-08-25' })).toBe('LCSC 25 Aug 2024');
    expect(orderLabel({ alias: null, orderDate: '2024-08-25' }, 2)).toBe('LCSC 25 Aug 2024 (2)');
    expect(orderLabel({ alias: 'Amp parts', orderDate: '2024-08-25' }, 2)).toBe('Amp parts');
  });
  it('names a cart from LCSC\'s file name', () => {
    expect(cartLabel('export_cart_20261006_140514.csv')).toBe('Cart 6 Oct 2026 14:05');
    expect(cartLabel('mine.csv')).toBe('Cart mine.csv');
  });
  it('refuses a rate typed the Indonesian way, with the reason', () => {
    expect(fxProblem('17893')).toBeNull();
    expect(fxProblem('17893.5')).toBeNull();
    expect(fxProblem('17.893')).toMatch(/too low to be right.*17893, not 17\.893/);
    expect(fxProblem('17,893')).toMatch(/dot for decimals/);
    expect(fxProblem('abc')).toMatch(/is not a rate/);
  });
});

describe('order import: name and re-import', () => {
  it('stores the typed name, leaves it empty otherwise, and shows the computed one', async () => {
    const plan = await importLcsc(FILES.b, { apply: false });
    expect(plan.json.order.label).toBe('LCSC 25 Aug 2024');
    await importLcsc(FILES.b, { apply: true, alias: '  Amp parts ' });
    await importLcsc(FILES.a, { apply: true });
    const rows = (await env.DB.prepare('SELECT order_no, alias FROM orders ORDER BY order_no').all<any>()).results;
    expect(rows).toEqual([{ order_no: 'WM2408250114', alias: 'Amp parts' }, { order_no: 'WM2509100613', alias: null }]);
    const list = (await api('/api/imports')).json;
    expect(list.orders.map((o: any) => o.label).sort()).toEqual(['Amp parts', 'LCSC 10 Sep 2025']);
  });
  it('a second import with another name changes nothing and says it is already in', async () => {
    await importLcsc(FILES.b, { apply: true, alias: 'First' });
    const runs = await count('import_runs');
    const again = await importLcsc(FILES.b, { apply: true, alias: 'Second' });
    expect(again.json.rowsWritten).toBe(0);
    expect(await count('import_runs')).toBe(runs);
    expect((await env.DB.prepare('SELECT alias FROM orders').first<any>()).alias).toBe('First');
    const plan = await importLcsc(FILES.b, { apply: false });
    expect(plan.json.order.alreadyImported).toBe(true);
    expect(plan.json.plan.warnings.join(' ')).toMatch(/already imported as "First"/);
  });
  it('refuses a rate of 17.893 and a name that is too long, each with its reason', async () => {
    const r = await importLcsc(FILES.a, { fxIdrPerUsd: '17.893' });
    expect(r.status).toBe(422);
    expect(r.json.errors[0]).toMatch(/too low to be right/);
    const n = await importLcsc(FILES.a, { alias: 'x'.repeat(61) });
    expect(n.json.errors[0]).toMatch(/at most 60 characters/);
    expect(await count('orders')).toBe(0);
  });
  it('shows an order\'s name on its lots', async () => {
    await importLcsc(FILES.b, { apply: true, alias: 'Amp parts' });
    const lot = (await env.DB.prepare('SELECT part_id FROM lots LIMIT 1').first<any>());
    const part = (await api(`/api/parts/${lot.part_id}`)).json;
    expect(part.lots[0]).toMatchObject({ orderNo: 'WM2408250114', orderLabel: 'Amp parts' });
  });
});

describe('renaming', () => {
  it('renames an order with its revision, and refuses a stale one with a sentence', async () => {
    await importLcsc(FILES.b, { apply: true });
    const o = (await api('/api/imports')).json.orders[0];
    const ok = await api(`/api/orders/${o.id}`, { alias: 'Amp parts', rev: o.rev }, 'PATCH');
    expect(ok.json).toMatchObject({ ok: true, rev: 1, alias: 'Amp parts' });
    const stale = await api(`/api/orders/${o.id}`, { alias: 'Other', rev: o.rev }, 'PATCH');
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatch(/renamed somewhere else.*nothing was saved/);
    expect(stale.json.detail.currentAlias).toBe('Amp parts');
    const reset = await api(`/api/orders/${o.id}`, { alias: '  ', rev: 1 }, 'PATCH');
    expect(reset.json.alias).toBeNull();
    expect((await api('/api/orders/9999', { alias: 'x', rev: 0 }, 'PATCH')).json.error).toBe('There is no order 9999.');
  });
  it('renaming never changes how a re-import is detected', async () => {
    await importLcsc(FILES.b, { apply: true });
    const o = (await api('/api/imports')).json.orders[0];
    await api(`/api/orders/${o.id}`, { alias: 'Renamed', rev: o.rev }, 'PATCH');
    const again = await importLcsc(FILES.b, { apply: true });
    expect(again.json.rowsWritten).toBe(0);
    expect(await count('orders')).toBe(1);
  });
});

describe('cart import: no blank error box, names, and re-import', () => {
  it('sends no empty errors list with a preview or an applied result (an empty list drew a blank red box)', async () => {
    const plan = await api('/api/import/lcsc-cart', { ...CART, apply: false });
    expect(plan.status).toBe(200);
    expect('errors' in plan.json).toBe(false);
    const done = await api('/api/import/lcsc-cart', { ...CART, apply: true });
    expect(done.json.mode).toBe('applied');
    expect('errors' in done.json).toBe(false);
  });
  it('names the cart from its file, keeps a typed name, and warns when the same file comes again', async () => {
    expect((await api('/api/import/lcsc-cart', { ...CART, apply: false })).json.alias).toBe('Cart 6 Oct 2026 14:05');
    await api('/api/import/lcsc-cart', { ...CART, apply: true, alias: 'Amp cart' });
    const again = await api('/api/import/lcsc-cart', { ...CART, newProjectName: 'Second project', apply: false });
    expect(again.json.warnings.join(' ')).toMatch(/already imported on .* as "Amp cart"/);
    const list = (await api('/api/imports')).json;
    expect(list.carts).toMatchObject([{ label: 'Amp cart', filename: CART.filename }]);
    const runs = await count('import_runs');
    await api('/api/import/lcsc-cart', { ...CART, apply: true });
    expect(await count('import_runs')).toBe(runs);
  });
  it('refuses a rate of 17.893 with the reason, and writes nothing', async () => {
    const r = await api('/api/import/lcsc-cart', { ...CART, fxIdrPerUsd: '17.893', apply: true });
    expect(r.status).toBe(422);
    expect(r.json.errors[0]).toMatch(/too low to be right/);
    expect(await count('projects')).toBe(0);
  });
  it('names a bad field the way a person does', async () => {
    const r = await api('/api/import/lcsc-cart', { ...CART, priority: 'urgent' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/^The request was not valid: the priority needs/);
  });
});
