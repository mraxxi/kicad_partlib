import { env } from 'cloudflare:workers';
import layoutBom from './fixtures/kicad/designator-layout.csv?raw';
import { beforeEach, describe, expect, it } from 'vitest';
import { bomValueSi, packageFromFootprint, parseKicadBom } from '../src/domain/kicadBom';
import type { LcscDetail } from '../src/domain/specs';
import { makeApp } from '../src/worker/app';
import type { AppEnv } from '../src/worker/env';
import type { LcscFetcher } from '../src/worker/lcsc';
import { FILES, api, count, importLcsc, reset } from './helpers';

// KiCad 9/10's default BOM export, grouped by value + footprint, with the owner's own LCSC / MPN fields.
const BOM = [
  'Refs,Value,Footprint,Qty,DNP,LCSC,MPN,MF',
  '"R1,R2,R3",100R,Resistor_SMD:R_0603_1608Metric,3,,C3017758,,',
  '"C1,C2",100nF,Capacitor_SMD:C_0805_2012Metric,2,,,CGA0805X7R104K101KT,HRE',
  'C3,10uF,Capacitor_SMD:C_0805_2012Metric,1,,,,',
  '"R9,R10",20k,Resistor_SMD:R_0603_1608Metric,2,,,,',
  'TP1,TestPoint,TestPoint:TestPoint_Pad_D1.0mm,1,DNP,,,',
  'J1,USB_C,Connector_USB:USB_C_Receptacle,1,,C2765186,,',
].join('\n');

const fixtures = new Map<string, LcscDetail & { status: string }>();
for (const f of Object.values(import.meta.glob<LcscDetail & { status: string }>('./fixtures/lcsc-detail/*.json', { eager: true, import: 'default' }))) fixtures.set(f.productCode, f);
const fake: LcscFetcher = async (code) => {
  if (code === 'C9999999') return { status: 'ok', detail: { productCode: 'C9999999', productModel: 'TEST-AMP-1', brand: 'Acme Semiconductor', catalog: 'Audio Amplifiers', package: 'QFN-9', intro: 'Class D audio amplifier QFN-9', params: [] } };
  const f = fixtures.get(code);
  return !f ? { status: 'not_listed' } : { status: 'ok', detail: f };
};
const app = makeApp({ lcscFetch: fake });
async function call(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const res = await app.fetch(new Request(`https://partlib.test${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env as unknown as AppEnv);
  return { status: res.status, json: (await res.json()) as any };
}

const FILE = { filename: 'amp.csv', csv: BOM };
let pid = 0;
const run = (extra: object = {}, apply = false) => call(`/api/projects/${pid}/bom`, { ...FILE, apply, ...extra });
const bom = async () => (await call(`/api/projects/${pid}/bom`)).json.bom;
const lineOf = (b: any, key: string) => b.lines.find((l: any) => l.key === key);
const needs = async () => (await env.DB.prepare('SELECT n.qty_needed AS qty, n.status, p.mpn FROM needs n JOIN parts p ON p.id = n.part_id ORDER BY n.id').all<{ qty: number; status: string; mpn: string }>()).results;
const partId = async (mpn: string) => (await env.DB.prepare('SELECT id FROM parts WHERE mpn = ?').bind(mpn).first<{ id: number }>())!.id;
const snapshot = async () => ({ lines: await count('bom_lines'), needs: await count('needs'), parts: await count('parts'), bom: await count('project_bom') });

beforeEach(async () => {
  await reset();
  await importLcsc(FILES.a, { apply: true });
  await importLcsc(FILES.b, { apply: true });
  pid = (await api('/api/projects', { name: 'TPA3255 Amp' })).json.id;
});

describe('reading a KiCad BOM', () => {
  it('reads the default columns and the owner\'s own fields', () => {
    const p = parseKicadBom(BOM);
    expect(p.errors).toEqual([]);
    expect(p.lines).toHaveLength(6);
    expect(p.lines[0]).toMatchObject({ key: 'lcsc:C3017758', refs: ['R1', 'R2', 'R3'], qty: 3, lcsc: 'C3017758' });
    expect(p.lines[1]).toMatchObject({ key: 'mpn:cga0805x7r104k101kt', manufacturer: 'HRE' });
    expect(p.lines[2]!.key).toBe('vf:10uf|capacitor_smd:c_0805_2012metric');
    expect(p.lines[4]!.dnp).toBe(true);
  });

  it('copes with the older Reference/Datasheet layout and a semicolon file', () => {
    const p = parseKicadBom('Reference;Value;Datasheet;Footprint;Qty\nC1, C2;100n;~;Capacitor_SMD:C_0603_1608Metric;2');
    expect(p.errors).toEqual([]);
    expect(p.lines[0]).toMatchObject({ refs: ['C1', 'C2'], qty: 2, value: '100n' });
  });

  it('says why a file is refused, naming the row and the reason', () => {
    expect(parseKicadBom('Name,Colour\nx,y').errors[0]).toMatch(/does not look like a KiCad BOM export/);
    expect(parseKicadBom('Refs,Value,Qty\n"R1",10k,two').errors[0]).toMatch(/Row 1 \(R1\): quantity "two" is not a positive whole number/);
    expect(parseKicadBom('Refs,Value,Qty\n,10k,1').errors[0]).toMatch(/Row 1: the Refs cell is empty/);
    expect(parseKicadBom('Refs,Value,Qty\n').errors[0]).toMatch(/header but no BOM lines/);
  });

  it('adds the same part appearing twice, and warns when Qty and the references disagree', () => {
    const p = parseKicadBom('Refs,Value,Footprint,Qty\n"R1,R2",10k,R_0603,3\nR3,10k,R_0603,1');
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]!.qty).toBe(4);
    expect(p.warnings.join(' ')).toMatch(/Qty column says 3 but 2 reference/);
  });

  it('turns KiCad values and footprints into something comparable', () => {
    expect(bomValueSi('4k7', ['R1'])).toEqual({ si: 4700, unit: 'ohm' });
    expect(bomValueSi('100n', ['C1'])).toEqual({ si: 1e-7, unit: 'farad' });
    expect(bomValueSi('10uF', ['C1'])).toEqual({ si: 1e-5, unit: 'farad' });
    expect(bomValueSi('10k', ['U1'])).toBeNull();
    expect(bomValueSi('TPA3255', ['U1'])).toBeNull();
    expect(packageFromFootprint('Capacitor_SMD:C_0805_2012Metric')).toBe('0805');
    expect(packageFromFootprint('Package_QFP:LQFP-48_7x7mm')).toBeNull();
  });
});

describe('importing a BOM into a project', () => {
  it('writes nothing while planning, and says what each line matched and why', async () => {
    const before = await snapshot();
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe('plan');
    expect(await snapshot()).toEqual(before);
    const byKey = (k: string) => r.json.lines.find((l: any) => l.key === k);
    expect(byKey('lcsc:C3017758')).toMatchObject({ linkRule: 'lcsc', action: 'new' });
    expect(byKey('mpn:cga0805x7r104k101kt')).toMatchObject({ linkRule: 'mpn' });
    expect(byKey('lcsc:C2765186')).toMatchObject({ partId: null, linkRule: null });
    expect(r.json.summary).toMatchObject({ total: 6, linked: 2, dnp: 1, toIdentify: 3 });
  });

  it('suggests a part by value and package but never links it', async () => {
    const r = await run();
    const twenty = r.json.lines.find((l: any) => l.value === '20k');
    expect(twenty.partId).toBeNull();
    expect(twenty.suggestions.map((s: any) => s.mpn)).toContain('FRC0603F2002TS');
  });

  it('creates the lines and an ordinary need for each linked part', async () => {
    const r = await run({}, true);
    expect(r.json.mode).toBe('applied');
    expect(await needs()).toEqual([{ qty: 2, status: 'to_buy', mpn: 'CGA0805X7R104K101KT' }, { qty: 3, status: 'to_buy', mpn: 'SCR0603J100R' }]);
    const b = await bom();
    expect(b.lines).toHaveLength(6);
    expect(lineOf(b, 'lcsc:C3017758')).toMatchObject({ onHand: 100, linkRule: 'lcsc' });
    expect(lineOf(b, 'vf:tp1|x')).toBeUndefined();
  });

  it('does nothing the second time, not even a row', async () => {
    await run({}, true);
    const before = await snapshot();
    const again = await run({}, true);
    expect(again.json).toMatchObject({ unchanged: true, rowsWritten: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('multiplies by the number of boards, and a DNP line asks for nothing', async () => {
    await run({ boards: 5 }, true);
    expect((await needs()).map((n) => n.qty)).toEqual([10, 15]);
    expect(await count('project_bom')).toBe(1);
  });

  it('refuses a missing project and a bad file in one sentence each', async () => {
    expect((await call('/api/projects/9999/bom', { ...FILE })).json.error).toMatch(/There is no project 9999/);
    const bad = await run({ csv: 'a,b\n1,2' });
    expect(bad.status).toBe(422);
    expect(bad.json.errors[0]).toMatch(/does not look like a KiCad BOM export/);
  });
});

describe('editing BOM lines', () => {
  it('links a line to a part: the need appears, and the choice is remembered in the next project', async () => {
    await run({}, true);
    const b = await bom();
    const line = lineOf(b, 'vf:10uf|capacitor_smd:c_0805_2012metric');
    const part = await partId('TCC0805X7R474M101FT');
    const r = await call(`/api/bom-lines/${line.id}`, { rev: line.rev, partId: part }, 'PATCH');
    expect(r.status).toBe(200);
    expect((await needs()).find((n) => n.mpn === 'TCC0805X7R474M101FT')).toMatchObject({ qty: 1 });
    expect(lineOf(await bom(), line.key)).toMatchObject({ partId: part, linkRule: 'manual' });

    const other = (await api('/api/projects', { name: 'Second board' })).json.id;
    const plan = await call(`/api/projects/${other}/bom`, { ...FILE });
    expect(plan.json.lines.find((l: any) => l.key === line.key)).toMatchObject({ partId: part, linkRule: 'remembered' });
  });

  it('refuses a stale save with a sentence, and changes nothing', async () => {
    await run({}, true);
    const line = lineOf(await bom(), 'lcsc:C3017758');
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'ignored' }, 'PATCH');
    const stale = await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'dnp' }, 'PATCH');
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatch(/changed somewhere else/);
    expect(lineOf(await bom(), line.key).status).toBe('ignored');
  });

  it('cancels the need when a line is ignored or unlinked, and reopens it when linked again', async () => {
    await run({}, true);
    let line = lineOf(await bom(), 'lcsc:C3017758');
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'ignored' }, 'PATCH');
    expect((await needs()).find((n) => n.mpn === 'SCR0603J100R')!.status).toBe('cancelled');
    line = lineOf(await bom(), 'lcsc:C3017758');
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'active' }, 'PATCH');
    expect((await needs()).find((n) => n.mpn === 'SCR0603J100R')).toMatchObject({ status: 'to_buy', qty: 3 });
    line = lineOf(await bom(), 'lcsc:C3017758');
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, partId: null }, 'PATCH');
    expect((await needs()).find((n) => n.mpn === 'SCR0603J100R')!.status).toBe('cancelled');
  });

  it('creates a part from a C-number LCSC lists, flags it for review and links the line', async () => {
    await run({}, true);
    const line = lineOf(await bom(), 'lcsc:C2765186');
    const parts = await count('parts');
    const none = await call(`/api/bom-lines/${line.id}/create-part`, { rev: line.rev, lcscCode: 'C2765186' });
    expect(none.status).toBe(422);
    expect(none.json.error).toMatch(/does not list C2765186/);
    expect(await count('parts')).toBe(parts);

    const ok = await call(`/api/bom-lines/${line.id}/create-part`, { rev: line.rev, lcscCode: 'C9999999' });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare('SELECT mpn, manufacturer, lcsc_code, package, needs_review FROM parts WHERE id = ?').bind(ok.json.partId).first<any>();
    expect(row).toMatchObject({ mpn: 'TEST-AMP-1', manufacturer: 'Acme Semiconductor', lcsc_code: 'C9999999', package: 'QFN-9', needs_review: 1 });
    expect(await count('part_enrichment')).toBe(1);
    expect(lineOf(await bom(), line.key)).toMatchObject({ partId: ok.json.partId, linkRule: 'manual' });
    expect((await needs()).find((n) => n.mpn === 'TEST-AMP-1')).toMatchObject({ qty: 1, status: 'to_buy' });
  });

  it('creates a part from a typed MPN with the line\'s value and package, and refuses a duplicate', async () => {
    await run({}, true);
    const line = lineOf(await bom(), 'vf:10uf|capacitor_smd:c_0805_2012metric');
    const r = await call(`/api/bom-lines/${line.id}/create-part`, { rev: line.rev, mpn: 'CL21A106KAYNNNE', manufacturer: 'Samsung', category: 'Passive - Capacitor' });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare('SELECT value, package, needs_review FROM parts WHERE id = ?').bind(r.json.partId).first<any>();
    expect(row).toMatchObject({ value: '10uF', package: '0805', needs_review: 1 });
    expect(lineOf(await bom(), line.key)).toMatchObject({ partId: r.json.partId, linkRule: 'manual' });
    const dup = await call(`/api/bom-lines/${line.id}/create-part`, { rev: r.json.rev, mpn: 'CL21A106KAYNNNE', manufacturer: 'Samsung' });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatch(/already exists as P-/);
    expect((await call(`/api/bom-lines/${line.id}/create-part`, { rev: r.json.rev })).json.error).toMatch(/Give the part an MPN/);
  });
});

describe('re-importing a revised BOM', () => {
  it('keeps manual links, changes quantities, and cancels what disappeared', async () => {
    await run({}, true);
    const line = lineOf(await bom(), 'vf:10uf|capacitor_smd:c_0805_2012metric');
    const part = await partId('TCC0805X7R474M101FT');
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, partId: part }, 'PATCH');

    const revised = BOM.replace('"R1,R2,R3",100R,Resistor_SMD:R_0603_1608Metric,3', '"R1,R2,R3,R4,R5,R6",100R,Resistor_SMD:R_0603_1608Metric,6')
      .replace(/\n"C1,C2",100nF.*HRE/, '');
    const plan = await run({ csv: revised });
    expect(plan.json.summary).toMatchObject({ changed: 1, removed: 1 });
    expect(plan.json.lines.find((l: any) => l.key === 'lcsc:C3017758')).toMatchObject({ qtyBefore: 3, qty: 6, action: 'changed' });
    expect((await needs()).find((n) => n.mpn === 'SCR0603J100R')!.qty).toBe(3); // planning wrote nothing

    await run({ csv: revised }, true);
    const n = await needs();
    expect(n.find((x) => x.mpn === 'SCR0603J100R')).toMatchObject({ qty: 6, status: 'to_buy' });
    expect(n.find((x) => x.mpn === 'CGA0805X7R104K101KT')!.status).toBe('cancelled');
    expect(n.find((x) => x.mpn === 'TCC0805X7R474M101FT')).toMatchObject({ qty: 1 });
    expect(lineOf(await bom(), line.key)).toMatchObject({ partId: part, linkRule: 'manual' });
  });

  it('never touches a need that is already ordered', async () => {
    await run({}, true);
    const sup = (await env.DB.prepare("SELECT id FROM suppliers WHERE name = 'LCSC'").first<{ id: number }>())!.id;
    await env.DB.prepare("UPDATE needs SET status = 'ordered', ordered_supplier_id = ?, ordered_qty = 3, ordered_total_idr = 900 WHERE qty_needed = 3").bind(sup).run();
    await run({ csv: BOM.replace('"R1,R2,R3",100R,Resistor_SMD:R_0603_1608Metric,3', '"R1,R2,R3,R4",100R,Resistor_SMD:R_0603_1608Metric,4') }, true);
    expect((await needs()).find((n) => n.mpn === 'SCR0603J100R')).toMatchObject({ status: 'ordered', qty: 3 });
  });

  it('shows up in the buy list like any other need, with stock allocated', async () => {
    await run({ boards: 40 }, true); // 40 x 3 = 120 resistors, 100 in stock
    const line = (await call('/api/buylist')).json.buyList.lines.find((l: any) => l.mpn === 'SCR0603J100R');
    expect(line).toMatchObject({ qtyNeeded: 120, stockAllotted: 100, shortfall: 20 });
  });
});

describe('the field map', () => {
  it('can be changed without a release, and falls back when the setting is broken', async () => {
    const csv = 'Refs,Value,Footprint,Qty,Supplier Code\nR1,100R,R_0603,1,C3017758';
    expect((await run({ csv })).json.lines[0].key).toBe('vf:100r|r_0603');
    const cur = (await call('/api/settings/bom-fields')).json.fields;
    expect((await call('/api/settings/bom-fields', { ...cur, lcsc: [...cur.lcsc, 'Supplier Code'] }, 'PUT')).status).toBe(200);
    expect((await run({ csv })).json.lines[0]).toMatchObject({ key: 'lcsc:C3017758', linkRule: 'lcsc' });
    await env.DB.prepare("UPDATE settings SET value = 'not json' WHERE key = 'bom.fields'").run();
    expect((await run({ csv: BOM })).status).toBe(200);
  });
});

describe('needs you typed by hand are never the BOM\'s to change', () => {
  const R100 = 'lcsc:C3017758';
  const revised = BOM.replace('"R1,R2,R3",100R,Resistor_SMD:R_0603_1608Metric,3', '"R1,R2,R3,R4,R5,R6",100R,Resistor_SMD:R_0603_1608Metric,6');
  const handNeed = async (qty: number) => { await api('/api/needs', { projectId: pid, partId: await partId('SCR0603J100R'), qtyNeeded: qty }); };
  const r100 = async () => (await needs()).find((n) => n.mpn === 'SCR0603J100R')!;

  it('survives the import, a re-import and a line edit, and the preview says where it disagrees', async () => {
    await handNeed(50);
    const plan = await run();
    expect(plan.json.needs.find((n: any) => n.action === 'hand')).toMatchObject({ current: 50, bom: 3 });
    expect(plan.json.warnings.join(' ')).toMatch(/you need 50 \(set by you\) and the BOM says 3; your number is kept/);
    expect(plan.json.summary.needsKept).toBe(1);
    await run({}, true);
    expect(await r100()).toMatchObject({ qty: 50, status: 'to_buy' });
    await run({ csv: revised }, true);
    expect(await r100()).toMatchObject({ qty: 50, status: 'to_buy' });
    const line = lineOf(await bom(), R100);
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'ignored' }, 'PATCH');
    expect(await r100()).toMatchObject({ qty: 50, status: 'to_buy' }); // not cancelled either
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev + 1, partId: null }, 'PATCH');
    expect(await r100()).toMatchObject({ qty: 50, status: 'to_buy' });
  });

  it('a need the owner cancelled stays cancelled, and one whose quantity they edited is theirs from then on', async () => {
    await run({}, true);
    const cap = await partId('CGA0805X7R104K101KT');
    const nid = (id: number) => env.DB.prepare('SELECT id, rev FROM needs WHERE part_id = ?').bind(id).first<{ id: number; rev: number }>();
    const a = (await nid(await partId('SCR0603J100R')))!, c = (await nid(cap))!;
    expect((await api(`/api/needs/${a.id}`, { rev: a.rev, status: 'cancelled' }, 'PATCH')).status).toBe(200);
    expect((await api(`/api/needs/${c.id}`, { rev: c.rev, qtyNeeded: 9 }, 'PATCH')).status).toBe(200);
    const plan = await run({ csv: revised });
    expect(plan.json.needs.find((n: any) => n.partId === cap)).toMatchObject({ action: 'hand', current: 9 });
    await run({ csv: revised }, true);
    expect(await r100()).toMatchObject({ qty: 3, status: 'cancelled' });
    expect((await needs()).find((n) => n.mpn === 'CGA0805X7R104K101KT')).toMatchObject({ qty: 9 });
  });

  it('a BOM-made need the BOM cancelled does come back when its line does', async () => {
    await run({}, true);
    const line = lineOf(await bom(), R100);
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'ignored' }, 'PATCH');
    expect(await r100()).toMatchObject({ status: 'cancelled' });
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev + 1, status: 'active' }, 'PATCH');
    expect(await r100()).toMatchObject({ status: 'to_buy', qty: 3 });
  });

  it('lists every need change in the preview before anything is written', async () => {
    const first = await run();
    expect(first.json.summary).toMatchObject({ needsCreated: 2, needsChanged: 0, needsKept: 0 });
    expect(first.json.needs.map((n: any) => n.action)).toEqual(['create', 'create']);
    await run({}, true);
    const second = await run({ csv: revised.replace(/\n"C1,C2",100nF.*HRE/, '') });
    expect(second.json.needs.filter((n: any) => n.action !== 'same').map((n: any) => [n.action, n.current, n.bom]).sort()).toEqual([['cancel', 2, 0], ['update', 3, 6]]);
    expect((await needs()).map((n) => [n.qty, n.status])).toEqual([[2, 'to_buy'], [3, 'to_buy']]); // preview wrote nothing
  });

  it('a line edit syncs only the parts it touches, and a stale edit changes no need at all', async () => {
    await run({}, true);
    // Drift an unrelated BOM-owned need on purpose: a whole-project re-sync would "repair" it, a scoped one must not.
    await env.DB.prepare("UPDATE needs SET qty_needed = 77 WHERE part_id = ?").bind(await partId('CGA0805X7R104K101KT')).run();
    const line = lineOf(await bom(), R100);
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'dnp' }, 'PATCH');
    expect((await needs()).find((n) => n.mpn === 'CGA0805X7R104K101KT')!.qty).toBe(77);
    expect((await r100()).status).toBe('cancelled');
    const revBefore = (await env.DB.prepare('SELECT rev FROM needs WHERE part_id = ?').bind(await partId('SCR0603J100R')).first<{ rev: number }>())!.rev;
    const stale = await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'active' }, 'PATCH');
    expect(stale.status).toBe(409);
    expect((await env.DB.prepare('SELECT rev, status FROM needs WHERE part_id = ?').bind(await partId('SCR0603J100R')).first<any>())).toMatchObject({ rev: revBefore, status: 'cancelled' });
  });

  it('says so when the need you cancelled is the one the BOM disagrees with', async () => {
    await run({}, true);
    const a = (await env.DB.prepare('SELECT id, rev FROM needs WHERE part_id = ?').bind(await partId('SCR0603J100R')).first<{ id: number; rev: number }>())!;
    await api(`/api/needs/${a.id}`, { rev: a.rev, status: 'cancelled' }, 'PATCH');
    const plan = await run({ csv: revised });
    expect(plan.json.warnings.join(' ')).toMatch(/you cancelled the need for 3 \(set by you\) and the BOM says 6; it stays cancelled/);
  });

  it('a stale edit that is exactly one revision behind changes no need either', async () => {
    await run({}, true);
    const line = lineOf(await bom(), R100);
    await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'dnp' }, 'PATCH'); // line is now one revision ahead
    // The need was cancelled by that edit; reopen it by hand in the database so a wrongly-run sync would visibly cancel it again.
    await env.DB.prepare("UPDATE needs SET status = 'to_buy', qty_needed = 77 WHERE part_id = ?").bind(await partId('SCR0603J100R')).run();
    const stale = await call(`/api/bom-lines/${line.id}`, { rev: line.rev, status: 'ignored' }, 'PATCH');
    expect(stale.status).toBe(409);
    expect(await r100()).toMatchObject({ status: 'to_buy', qty: 77 });
  });
});

describe('a line that moves to another part releases the first part\'s need', () => {
  it('cancels the old part\'s BOM-owned need and creates the new one', async () => {
    const bomText = 'Refs,Value,Footprint,Qty,MPN,MF\nC1,100n,Capacitor_SMD:C_0805_2012Metric,2,CGA0805X7R104K101KT,';
    await run({ csv: bomText }, true);
    const x = await partId('CGA0805X7R104K101KT');
    expect((await needs()).map((n) => [n.mpn, n.status])).toEqual([['CGA0805X7R104K101KT', 'to_buy']]);
    const made = await api('/api/parts', { mpn: 'CGA0805X7R104K101KT', manufacturer: 'Other Maker' });
    expect(made.status).toBe(200);
    const moved = bomText.replace('2,CGA0805X7R104K101KT,', '2,CGA0805X7R104K101KT,Other Maker');
    const plan = await run({ csv: moved });
    expect(plan.json.needs.map((n: any) => n.action).sort()).toEqual(['cancel', 'create']);
    await run({ csv: moved }, true);
    const rows = (await env.DB.prepare('SELECT part_id, status, qty_needed FROM needs ORDER BY part_id').all<any>()).results;
    expect(rows).toEqual([{ part_id: x, status: 'cancelled', qty_needed: 2 }, { part_id: made.json.id, status: 'to_buy', qty_needed: 2 }]);
  });
});

describe('a BOM in the Designator / Footprint / Quantity / Value / LCSC Part # layout (no MPN column)', () => {
  const REAL = { filename: 'bom.csv', csv: layoutBom };

  it('parses without errors or warnings: its column names need no configuration', () => {
    const p = parseKicadBom(layoutBom);
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.lines).toHaveLength(12);
    expect(p.lines.reduce((n, l) => n + l.qty, 0)).toBe(28); // the Quantity column summed, and also the number of references
    expect(p.lines[0]).toMatchObject({ qty: 9, value: '100n', footprint: '0603', lcsc: '', mpn: '' });
    expect(p.lines[0]!.refs).toHaveLength(9);
    expect(p.lines[0]!.refs[7]).toBe('C7_2'); // KiCad's sub-unit references are kept as written
    expect(p.lines.every((l) => l.key.startsWith('vf:'))).toBe(true); // every LCSC cell is empty and there is no MPN column
  });

  it('reads bare footprints and the values it uses: 100n, 10u, 330p, 3R3, 2.7k, 10uH, and ~ means nothing', () => {
    const by = (v: string, f: string) => parseKicadBom(layoutBom).lines.find((l) => l.value === v && l.footprint === f)!;
    expect(packageFromFootprint('0603')).toBe('0603');
    expect(packageFromFootprint('SOT-23')).toBeNull();
    expect(packageFromFootprint('C_Rect_L13.0mm_W6.5mm_P7.50mm_P10.00mm')).toBeNull();
    expect(bomValueSi('3R3', by('3R3', '1210').refs)).toEqual({ si: 3.3, unit: 'ohm' });
    expect(bomValueSi('~', ['U4', 'U5'])).toBeNull();
    expect(bomValueSi('10uH', ['L2'])).toEqual({ si: 1e-5, unit: 'henry' });
  });

  it('suggests library parts for the passives, including capacitors, and links nothing by itself', async () => {
    const plan = await run(REAL);
    expect(plan.status).toBe(200);
    expect(plan.json.summary).toMatchObject({ total: 12, linked: 0, toIdentify: 12 });
    expect(plan.json.lines.every((l: any) => l.partId === null)).toBe(true);
    const sug = (v: string, f: string) => plan.json.lines.find((l: any) => l.value === v && l.footprint === f).suggestions.map((s: any) => s.mpn);
    expect(sug('3R3', '1210')).toContain('CL1210FN3R3P');            // a resistor, 3.3 ohm
    expect(sug('100n', '0603')).toContain('CGA0603X7R104K101JT');     // a capacitor: used to be missed (float rounding)
    expect(sug('330p', '0603')).toContain('CC0603JRNPO0BN331');
    expect(sug('100n', '0805')).toContain('CGA0805X7R104K101KT');
  });

  it('applies, and the same file again changes nothing', async () => {
    const first = await run(REAL, true);
    expect(first.json.mode).toBe('applied');
    expect((await bom()).lines).toHaveLength(12);
    expect(await count('needs')).toBe(0); // nothing linked yet, so nothing is needed
    const before = await snapshot();
    expect((await run(REAL, true)).json).toMatchObject({ unchanged: true, rowsWritten: 0 });
    expect(await snapshot()).toEqual(before);
  });
});
