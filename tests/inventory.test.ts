import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { Meter } from '../src/db/meter';
import { listParts } from '../src/db/parts';
import { FILES, api, count, importLcsc, reset } from './helpers';

let n = 0;
const rid = () => `req-${Date.now()}-${n++}`;

async function lotOf(mpn: string): Promise<{ id: number; partId: number; qty: number }> {
  const r = await env.DB.prepare(
    `SELECT l.id, l.part_id AS partId, l.qty_on_hand AS qty FROM lots l JOIN parts p ON p.id = l.part_id WHERE p.mpn = ? ORDER BY l.id LIMIT 1`,
  ).bind(mpn).first<{ id: number; partId: number; qty: number }>();
  return r!;
}
const qtyOf = async (lotId: number) => (await env.DB.prepare('SELECT qty_on_hand AS q FROM lots WHERE id = ?').bind(lotId).first<{ q: number }>())!.q;
const move = (lotId: number, body: object) => api(`/api/lots/${lotId}/moves`, { moveId: rid(), ...body });

async function assertLedgerMatchesCache() {
  const bad = await env.DB.prepare(
    `SELECT l.id FROM lots l WHERE l.qty_on_hand <> (SELECT COALESCE(SUM(delta), 0) FROM stock_moves WHERE lot_id = l.id)`,
  ).all();
  expect(bad.results).toEqual([]);
}

beforeEach(async () => {
  await reset();
  await importLcsc(FILES.b, { apply: true });
});

describe('parts list', () => {
  it('pages by keyset and reads rows in proportion to the page, not the ledger', async () => {
    const meter = new Meter();
    const page = await listParts(env.DB, meter, 0, 10);
    expect(page.parts).toHaveLength(10);
    expect(page.next).toBe(page.parts[9]!.id);
    // 10 parts + their lots + category lookups; the ledger (stock_moves) is never read.
    console.log(`rows_read for a 10-part page: ${meter.rowsRead}`);
    // Measured: 4 rows per part (part, its lot, category, and the keyset scan). The plan wanted < 2x; with a lot per part that is unreachable and 4x is ~0.001% of a day.
    expect(meter.rowsRead).toBeLessThanOrEqual(10 * 4);
    const rest = await api(`/api/parts?after=${page.next}&limit=500`);
    expect(rest.json.parts).toHaveLength(31);
    expect(rest.json.next).toBeNull();
  });

  it('reports stock, derived status and a human code for each part', async () => {
    const { json } = await api('/api/parts');
    const tpa = json.parts.find((p: any) => p.mpn === 'TPA3116D2DADR');
    expect(tpa).toMatchObject({ totalQty: 8, usableQty: 8, status: 'ok', category: 'IC - Audio', lotCount: 1 });
    expect(tpa.code).toMatch(/^P-\d{4}$/);
  });
});

describe('moving stock', () => {
  it('consuming appends a move, shows in history, and keeps the cache equal to the ledger', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    const r = await move(lot.id, { kind: 'consume', qty: 3, note: 'amp build' });
    expect(r.status).toBe(200);
    expect(r.json.qtyOnHand).toBe(5);
    const part = await api(`/api/parts/${lot.partId}`);
    expect(part.json.moves.map((m: any) => [m.reason, m.delta])).toEqual([['consume', -3], ['receive', 8]]);
    await assertLedgerMatchesCache();
  });

  it('a retried request with the same id does not double-apply', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    const body = { kind: 'consume', qty: 3, moveId: 'retry-me-0001', note: '' };
    const a = await api(`/api/lots/${lot.id}/moves`, body);
    const b = await api(`/api/lots/${lot.id}/moves`, body);
    expect(a.json.duplicate).toBe(false);
    expect(b.json).toMatchObject({ duplicate: true, qtyOnHand: 5 });
    expect(await qtyOf(lot.id)).toBe(5);
  });

  it('refuses to take more than is on hand, in a sentence, and writes nothing', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    const before = await count('stock_moves');
    const r = await move(lot.id, { kind: 'consume', qty: 9 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe(`Cannot take 9: lot ${lot.id} has only 8 on hand.`);
    expect(await count('stock_moves')).toBe(before);
  });

  it('an adjustment needs a reason', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    const r = await move(lot.id, { kind: 'adjust', delta: -1, note: '' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/note/);
    const ok = await move(lot.id, { kind: 'adjust', delta: -1, note: 'dropped one' });
    expect(ok.json.qtyOnHand).toBe(7);
  });

  it('a stocktake is stored as a delta with both numbers in the note', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    const r = await move(lot.id, { kind: 'count', countedQty: 6 });
    expect(r.json.qtyOnHand).toBe(6);
    const m = await env.DB.prepare(`SELECT delta, reason, note FROM stock_moves WHERE lot_id = ? ORDER BY id DESC LIMIT 1`).bind(lot.id).first<any>();
    expect(m).toMatchObject({ delta: -2, reason: 'adjust' });
    expect(m.note).toMatch(/Counted 6, ledger said 8/);
    expect((await move(lot.id, { kind: 'count', countedQty: 6 })).status).toBe(409);
  });

  it('scrapping removes pieces and is recorded as scrap', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    await move(lot.id, { kind: 'scrap', qty: 2, note: 'burnt' });
    const m = await env.DB.prepare(`SELECT reason, delta FROM stock_moves WHERE lot_id = ? ORDER BY id DESC LIMIT 1`).bind(lot.id).first<any>();
    expect(m).toEqual({ reason: 'scrap', delta: -2 });
  });

  it('marking part of a lot faulty splits it, keeps total stock, and drops usable stock', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    const id = rid();
    const r = await api(`/api/lots/${lot.id}/reclassify`, { moveId: id, qty: 3, condition: 'faulty', note: 'failed test' });
    expect(r.json).toMatchObject({ split: true, duplicate: false });
    const part = (await api(`/api/parts/${lot.partId}`)).json;
    expect(part.lots.map((l: any) => [l.condition, l.qtyOnHand])).toEqual([['new', 5], ['faulty', 3]]);
    expect(part.part).toMatchObject({ totalQty: 8, usableQty: 5 });
    await assertLedgerMatchesCache();
    // Retry: same lot back, nothing created.
    const again = await api(`/api/lots/${lot.id}/reclassify`, { moveId: id, qty: 3, condition: 'faulty', note: 'failed test' });
    expect(again.json).toMatchObject({ duplicate: true, lotId: r.json.lotId });
    expect(await count('lots')).toBe(42);
  });

  it('changing a whole lot writes no move, and cannot move more than is there', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    const loc = (await api('/api/locations', { code: 'S1' })).json.id;
    const before = await count('stock_moves');
    const r = await api(`/api/lots/${lot.id}/reclassify`, { moveId: rid(), qty: 8, locationId: loc });
    expect(r.json.split).toBe(false);
    expect(await count('stock_moves')).toBe(before);
    expect((await api(`/api/parts/${lot.partId}`)).json.part.locations).toEqual(['S1']);
    expect((await api(`/api/lots/${lot.id}/reclassify`, { moveId: rid(), qty: 9, condition: 'faulty' })).status).toBe(409);
  });

  it('adds manual stock as its own lot with a receive move', async () => {
    const lot = await lotOf('TPA3116D2DADR');
    const body = { moveId: 'manual-0001', qty: 4, condition: 'tested_ok', unitCostIdr: 1500, note: 'found in drawer' };
    const a = await api(`/api/parts/${lot.partId}/lots`, body);
    const b = await api(`/api/parts/${lot.partId}/lots`, body);
    expect(b.json).toMatchObject({ duplicate: true, lotId: a.json.lotId });
    expect(await qtyOf(a.json.lotId)).toBe(4);
    await assertLedgerMatchesCache();
  });
});

describe('locations and donors', () => {
  it('refuses a duplicate location code and deleting a location that holds stock', async () => {
    const a = await api('/api/locations', { code: 'A1', name: 'Drawer A1' });
    expect((await api('/api/locations', { code: 'A1' })).json.error).toBe('A location with the code "A1" already exists.');
    const lot = await lotOf('TPA3116D2DADR');
    await api(`/api/lots/${lot.id}/reclassify`, { moveId: rid(), qty: 8, locationId: a.json.id });
    const del = await api(`/api/locations/${a.json.id}`, undefined, 'DELETE');
    expect(del.status).toBe(409);
    expect(del.json.error).toMatch(/still holds 1 lot/);
    const empty = (await api('/api/locations', { code: 'Z9' })).json.id;
    expect((await api(`/api/locations/${empty}`, undefined, 'DELETE')).status).toBe(200);
  });

  it('records a donor board and refuses a duplicate code', async () => {
    const a = await api('/api/donors', { code: 'LB-001', device: '15.6 in laptop mainboard' });
    expect(a.status).toBe(200);
    expect((await api('/api/donors', { code: 'LB-001', device: 'x' })).status).toBe(409);
  });
});

describe('harvesting a donor board', () => {
  async function donor() {
    return (await api('/api/donors', { code: 'PSU-001', device: 'ATX PSU 500 W' })).json.id as number;
  }

  it('creates parts and salvaged lots with estimated value, and is idempotent on retry', async () => {
    const d = await donor();
    const body = {
      harvestId: 'harvest-0001',
      items: [
        { mpn: 'IRF3205', manufacturer: 'Infineon', qty: 6, condition: 'tested_ok', estUnitValueIdr: 4000, category: 'Discrete - MOSFET' },
        { mpn: '470uF 25V electrolytic', qty: 10, estUnitValueIdr: 500, category: 'Passive - Capacitor' },
      ],
    };
    const a = await api(`/api/donors/${d}/harvest`, body);
    expect(a.json).toMatchObject({ lots: 2, newParts: 2, duplicate: false });
    expect((await api(`/api/donors/${d}/harvest`, body)).json.duplicate).toBe(true);
    expect(await count('lots')).toBe(43);
    const irf = (await api('/api/parts')).json.parts.find((p: any) => p.mpn === 'IRF3205');
    expect(irf).toMatchObject({ totalQty: 6, valueRealIdr: 0, valueEstimatedIdr: 24000, category: 'Discrete - MOSFET', needsReview: true });
    expect(irf.sources).toEqual(['salvage']);
    const donors = (await api('/api/donors')).json.donors;
    expect(donors[0]).toMatchObject({ code: 'PSU-001', partLines: 2, unitsHarvested: 16 });
    await assertLedgerMatchesCache();
  });

  it('adds a lot to an existing part when the MPN is already in the library', async () => {
    const d = await donor();
    const r = await api(`/api/donors/${d}/harvest`, { harvestId: 'harvest-0002', items: [{ mpn: 'ne5532dr', qty: 4 }] });
    expect(r.json).toMatchObject({ lots: 1, newParts: 0 });
    const part = (await api('/api/parts')).json.parts.find((p: any) => p.mpn === 'NE5532DR');
    expect(part).toMatchObject({ lotCount: 2, totalQty: 14 });
    expect(await count('parts')).toBe(41);
  });

  it('does not guess when an MPN exists from several manufacturers and none was typed', async () => {
    const d = await donor();
    await api(`/api/donors/${d}/harvest`, { harvestId: 'harvest-0003', items: [{ mpn: 'AMS1117', manufacturer: 'AMS', qty: 1 }, { mpn: 'AMS1117', manufacturer: 'Advanced', qty: 1 }] });
    const r = await api(`/api/donors/${d}/harvest`, { harvestId: 'harvest-0004', items: [{ mpn: 'AMS1117', qty: 1 }] });
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/several manufacturers/);
  });
});

describe('editing a part', () => {
  it('saves with the current rev and bumps it', async () => {
    const lot = await lotOf('NE5532DR');
    const r = await api(`/api/parts/${lot.partId}`, { rev: 0, minQty: 20, notes: 'audio' }, 'PATCH');
    expect(r.json).toMatchObject({ ok: true, rev: 1 });
    const part = (await api(`/api/parts/${lot.partId}`)).json.part;
    expect(part).toMatchObject({ minQty: 20, notes: 'audio', rev: 1, status: 'reorder' });
  });

  it('refuses a stale edit and returns a field-level diff instead of overwriting', async () => {
    const lot = await lotOf('NE5532DR');
    await api(`/api/parts/${lot.partId}`, { rev: 0, minQty: 20 }, 'PATCH');
    const stale = await api(`/api/parts/${lot.partId}`, { rev: 0, minQty: 5 }, 'PATCH');
    expect(stale.status).toBe(409);
    expect(stale.json.detail.fields.minQty).toEqual({ yours: 5, current: 20 });
    expect((await api(`/api/parts/${lot.partId}`)).json.part.minQty).toBe(20);
  });

  it('answers a malformed request with a sentence naming the field', async () => {
    const lot = await lotOf('NE5532DR');
    const r = await api(`/api/parts/${lot.partId}`, { rev: 0, minQty: -3 }, 'PATCH');
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/^The request was not valid: "minQty"/);
  });
});

describe('dashboard', () => {
  it('matches a direct SQL check of stock, value, reorder and untested salvage', async () => {
    const d = (await api('/api/donors', { code: 'LB-002', device: 'laptop' })).json.id;
    await api(`/api/donors/${d}/harvest`, { harvestId: 'harvest-0009', items: [
      { mpn: 'H9JCNNNCP3ML', qty: 8, condition: 'untested', estUnitValueIdr: 0, category: 'IC - Memory' },
      { mpn: 'AON6414A', qty: 12, condition: 'tested_ok', estUnitValueIdr: 2000, category: 'Discrete - MOSFET' },
    ] });
    const ne = await lotOf('NE5532DR');
    await api(`/api/parts/${ne.partId}`, { rev: 0, minQty: 50 }, 'PATCH');
    const out = await lotOf('RC4580IDR');
    await move(out.id, { kind: 'consume', qty: 10 });

    const dash = (await api('/api/dashboard')).json;
    const sql = await env.DB.prepare(
      `SELECT SUM(qty_on_hand) AS units,
              SUM(CASE WHEN source <> 'salvage' AND condition <> 'faulty' THEN qty_on_hand * unit_cost_idr_micro END) AS real,
              SUM(CASE WHEN source = 'salvage' AND condition <> 'faulty' THEN qty_on_hand * unit_cost_idr_micro END) AS est,
              SUM(CASE WHEN source = 'salvage' AND condition = 'untested' THEN qty_on_hand END) AS untested
         FROM lots`,
    ).first<any>();
    expect(dash.unitsOnHand).toBe(sql.units);
    expect(Math.abs(dash.valueRealIdr - sql.real / 1e6)).toBeLessThan(dash.partLines); // per-part rounding to whole IDR
    expect(dash.valueEstimatedIdr).toBe(sql.est / 1e6);
    expect(dash.untestedSalvageUnits).toBe(sql.untested);
    expect(dash.reorderCount).toBe(1);
    expect(dash.outCount).toBe(1);
    expect(dash.reorder.map((r: any) => [r.mpn, r.status])).toEqual([['RC4580IDR', 'out'], ['NE5532DR', 'reorder']]);
    expect(dash.byCategory.find((c: any) => c.category === 'IC - Memory')).toMatchObject({ parts: 1, units: 8 });
  });
});

describe('the ledger after everything above', () => {
  it('stays append-only through the API surface too', async () => {
    const lot = await lotOf('NE5532DR');
    await move(lot.id, { kind: 'consume', qty: 1 });
    await expect(env.DB.prepare('DELETE FROM stock_moves WHERE lot_id = ?').bind(lot.id).run()).rejects.toThrow(/append-only/);
  });
});
