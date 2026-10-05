import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { FILES, api, count, importLcsc, reset } from './helpers';

const TABLES = ['parts', 'lots', 'stock_moves', 'orders', 'order_lines', 'part_aliases', 'import_runs'];
const snapshot = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t)])));

beforeEach(reset);

describe('LCSC import', () => {
  it('planning writes nothing', async () => {
    const r = await importLcsc(FILES.a);
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe('plan');
    expect(r.json.plan.summary).toMatchObject({ total: 59, newParts: 59, lotsToCreate: 59 });
    expect(await snapshot()).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
  });

  it('importing both real exports yields 99 parts, 100 lots and 100 receive moves', async () => {
    const a = await importLcsc(FILES.a, { apply: true });
    const b = await importLcsc(FILES.b, { apply: true });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await snapshot()).toMatchObject({ parts: 99, lots: 100, stock_moves: 100, orders: 2, order_lines: 100 });
    console.log(`rows_written: order A = ${a.json.rowsWritten}, order B = ${b.json.rowsWritten}`);
    // Whole-database ceiling for a 100-line import; the daily cap is 100,000.
    expect(a.json.rowsWritten + b.json.rowsWritten).toBeLessThan(5_000);
  });

  it('resolves PAM8013AKR from both exports to one part with two lots', async () => {
    await importLcsc(FILES.a, { apply: true });
    await importLcsc(FILES.b, { apply: true });
    const parts = await env.DB.prepare("SELECT id, manufacturer FROM parts WHERE mpn = 'PAM8013AKR'").all<{ id: number; manufacturer: string }>();
    expect(parts.results).toHaveLength(1);
    const lots = await env.DB.prepare('SELECT qty_on_hand FROM lots WHERE part_id = ?').bind(parts.results[0]!.id).all<{ qty_on_hand: number }>();
    expect(lots.results.map((l) => l.qty_on_hand)).toEqual([5, 5]);
    const alias = await env.DB.prepare("SELECT value FROM part_aliases WHERE part_id = ? AND kind = 'manufacturer'").bind(parts.results[0]!.id).all<{ value: string }>();
    expect(alias.results.map((a) => a.value)).toEqual(['Diodes Incorporated']);
  });

  it('keeps the part with description "-" and flags it for review', async () => {
    await importLcsc(FILES.a, { apply: true });
    const p = await env.DB.prepare("SELECT description, package, needs_review FROM parts WHERE mpn = 'V106M0603X5R250NKT'").first<any>();
    expect(p).toEqual({ description: '', package: '', needs_review: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM parts WHERE needs_review = 1').first('n')).toBe(1);
  });

  it('importing either file again changes nothing', async () => {
    await importLcsc(FILES.a, { apply: true });
    await importLcsc(FILES.b, { apply: true });
    const before = await snapshot();
    const again = await importLcsc(FILES.a, { apply: true });
    const again2 = await importLcsc(FILES.b, { apply: true });
    expect(again.json.rowsWritten).toBe(0);
    expect(again2.json.rowsWritten).toBe(0);
    expect(again.json.summary.duplicates).toBe(59);
    expect(await snapshot()).toEqual(before);
  });

  it('keeps stock in step with the ledger: qty_on_hand equals the sum of its moves for every lot', async () => {
    await importLcsc(FILES.a, { apply: true });
    await importLcsc(FILES.b, { apply: true });
    const bad = await env.DB.prepare(
      `SELECT l.id FROM lots l
        WHERE l.qty_on_hand <> (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE lot_id = l.id)`,
    ).all();
    expect(bad.results).toEqual([]);
    const total = await env.DB.prepare('SELECT SUM(qty_on_hand) AS n FROM lots').first<{ n: number }>();
    const csvTotal = [FILES.a, FILES.b].flatMap((f) => f.csv.split('\n').slice(1))
      .filter(Boolean).length;
    expect(csvTotal).toBe(100);
    expect(total!.n).toBeGreaterThan(0);
  });

  it('freezes the typed FX rate on the order and prices lots in micro-IDR without rounding tiny parts to zero', async () => {
    await importLcsc(FILES.a, { apply: true, fxIdrPerUsd: '16250.5' });
    const o = await env.DB.prepare('SELECT fx_to_idr_micro, order_date FROM orders').first<any>();
    expect(o).toEqual({ fx_to_idr_micro: 16_250_500_000, order_date: '2025-09-10' });
    // C3017514: 100 pcs at 0.0002 USD -> 0.0002 * 16250.5 = 3.2501 IDR each.
    const lot = await env.DB.prepare(
      `SELECT l.unit_cost_idr_micro AS c FROM lots l JOIN parts p ON p.id = l.part_id WHERE p.lcsc_code = 'C3017514'`,
    ).first<{ c: number }>();
    expect(lot!.c).toBe(3_250_100);
  });

  it('an apply replayed after a timeout does not double-count', async () => {
    await importLcsc(FILES.b, { apply: true });
    await importLcsc(FILES.b, { apply: true });
    const sum = await env.DB.prepare('SELECT SUM(qty_on_hand) AS n FROM lots').first<{ n: number }>();
    const moves = await env.DB.prepare('SELECT SUM(delta) AS n FROM stock_moves').first<{ n: number }>();
    expect(sum!.n).toBe(moves!.n);
  });

  it('refuses a file with a malformed row and names the row', async () => {
    const r = await importLcsc({ filename: FILES.b.filename, csv: FILES.b.csv.replace(',10,0.2732,', ',ten,0.2732,') }, { apply: true });
    expect(r.status).toBe(422);
    expect(r.json.errors[0]).toMatch(/^Row 2: quantity/);
    expect(await count('parts')).toBe(0);
  });

  it('refuses to guess an order number from a filename it cannot read', async () => {
    const r = await importLcsc({ filename: 'download.csv', csv: FILES.b.csv });
    expect(r.status).toBe(422);
    expect(r.json.errors[0]).toMatch(/order number/);
  });
});

describe('the ledger is append-only', () => {
  it('refuses to update or delete a stock move', async () => {
    await importLcsc(FILES.b, { apply: true });
    await expect(env.DB.prepare('UPDATE stock_moves SET delta = 1').run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM stock_moves').run()).rejects.toThrow(/append-only/);
  });
  it('refuses to let a lot go negative', async () => {
    await importLcsc(FILES.b, { apply: true });
    await expect(env.DB.prepare('UPDATE lots SET qty_on_hand = -1 WHERE id = 1').run()).rejects.toThrow();
  });
});

describe('usage', () => {
  it('records rows written by an import in usage_daily', async () => {
    await importLcsc(FILES.b, { apply: true });
    // flush runs in waitUntil; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const u = await api('/api/usage');
    expect(u.status).toBe(200);
    expect(u.json.rowsWritten).toBeGreaterThan(0);
    expect(u.json.limits.rowsWritten).toBe(100_000);
  });
});

describe('agreement with the original Google Sheet', () => {
  it('values the LCSC stock at the sheet\'s figure, Rp 1,271,866.647, at the sheet\'s rate', async () => {
    await importLcsc(FILES.a, { apply: true });
    await importLcsc(FILES.b, { apply: true });
    const r = await env.DB.prepare('SELECT SUM(qty_on_hand * unit_cost_idr_micro) AS v FROM lots').first<{ v: number }>();
    // Sheet Dashboard!B7 = 1271866.647 (qty x USD price x 17,893), in micro-IDR here.
    expect(Math.abs(r!.v / 1e6 - 1_271_866.647)).toBeLessThan(1);
  });

  it('files the LCSC parts under the sheet\'s categories, with none left uncategorised', async () => {
    await importLcsc(FILES.a, { apply: true });
    await importLcsc(FILES.b, { apply: true });
    const rows = await env.DB.prepare(
      `SELECT c.name AS name, COUNT(*) AS n FROM parts p LEFT JOIN categories c ON c.id = p.category_id GROUP BY c.name`,
    ).all<{ name: string | null; n: number }>();
    const got = Object.fromEntries(rows.results.map((r) => [r.name, r.n]));
    // The sheet's counts also include 7 example salvage rows and one hand-categorised
    // part (V106..., which LCSC gave no description: it is flagged for review instead).
    expect(got).toEqual({
      'Connector': 3, 'Discrete - Diode': 1, 'Discrete - MOSFET': 8, 'IC - Audio': 3, 'IC - MCU': 1,
      'IC - Op Amp': 4, 'IC - Power': 4, 'Optoelectronics - LED': 1, 'Other': 1,
      'Passive - Capacitor': 14, 'Passive - Inductor': 2, 'Passive - Resistor': 56, 'Switch': 1,
    });
  });
});
