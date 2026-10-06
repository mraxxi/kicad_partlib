/// <reference types="vite/client" />
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LcscDetail } from '../src/domain/specs';
import { makeApp } from '../src/worker/app';
import type { AppEnv } from '../src/worker/env';
import type { LcscFetcher } from '../src/worker/lcsc';
import { FILES, api, count, importLcsc, reset } from './helpers';

const fixtures = new Map<string, LcscDetail & { status: string }>();
for (const f of Object.values(import.meta.glob<LcscDetail & { status: string }>('./fixtures/lcsc-detail/*.json', { eager: true, import: 'default' }))) fixtures.set(f.productCode, f);

const calls: string[] = [];
const fake: LcscFetcher = async (code) => {
  calls.push(code);
  if (code === 'C1000001') return { status: 'error', message: 'Could not reach LCSC.' };
  const f = fixtures.get(code);
  return !f ? { status: 'not_listed' } : f.status === 'ok' ? { status: 'ok', detail: f } : { status: 'not_listed' };
};
const app = makeApp({ lcscFetch: fake });
async function call(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const res = await app.fetch(new Request(`https://partlib.test${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env as unknown as AppEnv);
  return { status: res.status, json: (await res.json()) as any };
}
const partId = async (mpn: string) => (await env.DB.prepare('SELECT id FROM parts WHERE mpn = ?').bind(mpn).first<{ id: number }>())!.id;
const specsOf = async (mpn: string) => JSON.parse((await env.DB.prepare('SELECT specs FROM parts WHERE mpn = ?').bind(mpn).first<{ specs: string | null }>())!.specs ?? 'null');

beforeEach(async () => {
  await reset();
  calls.length = 0;
  await importLcsc(FILES.a, { apply: true });
  await importLcsc(FILES.b, { apply: true });
});

describe('fetching from LCSC', () => {
  it('stores what LCSC returned, including "not listed", and visits only parts that were not fetched yet', async () => {
    const ids = [await partId('AON7410'), await partId('V106M0603X5R250NKT')];
    const r = await call('/api/enrich/fetch', { partIds: ids });
    expect(Object.fromEntries(r.json.results.map((x: any) => [x.partId, x.status]))).toEqual({ [ids[0]!]: 'ok', [ids[1]!]: 'not_listed' });
    expect(await count('part_enrichment')).toBe(2);
    const unfetched = (await call('/api/enrich/unfetched')).json.parts;
    expect(unfetched).toHaveLength(97);
    expect(unfetched.some((p: any) => p.id === ids[0])).toBe(false);
  });

  it('does not store a transient error, so it can simply be retried', async () => {
    await env.DB.prepare("UPDATE parts SET lcsc_code = 'C1000001' WHERE mpn = 'AON7410'").run();
    const r = await call('/api/enrich/fetch', { partIds: [await partId('AON7410')] });
    expect(r.json.results[0]).toMatchObject({ status: 'error', message: 'Could not reach LCSC.' });
    expect(await count('part_enrichment')).toBe(0);
  });

  it('says so for a part with no C-number instead of guessing', async () => {
    await env.DB.prepare("UPDATE parts SET lcsc_code = NULL WHERE mpn = 'AON7410'").run();
    const r = await call('/api/enrich/fetch', { partIds: [await partId('AON7410')] });
    expect(r.json.results[0].status).toBe('no_c_number');
    expect(calls).toEqual([]);
  });
});

describe('planning writes nothing, applying writes only what was ticked', () => {
  async function fetched(...mpns: string[]) {
    const ids = await Promise.all(mpns.map(partId));
    await call('/api/enrich/fetch', { partIds: ids });
    return ids;
  }

  it('shows what would change without changing anything', async () => {
    const [id] = await fetched('AON7410');
    const before = await env.DB.prepare('SELECT specs, rev FROM parts WHERE id = ?').bind(id).first();
    const plan = (await call('/api/enrich/plan', { partIds: [id] })).json.items[0];
    expect(plan).toMatchObject({ state: 'ready', family: 'mosfet', familyLabel: 'MOSFET' });
    expect(plan.changes.map((c: any) => c.key)).toEqual(expect.arrayContaining(['vds', 'channel', 'id', 'rds_on']));
    expect(plan.changes.every((c: any) => c.action === 'new')).toBe(true);
    expect(await env.DB.prepare('SELECT specs, rev FROM parts WHERE id = ?').bind(id).first()).toEqual(before);
  });

  it('applies only the ticked specs, and a second apply changes nothing', async () => {
    const [id] = await fetched('AON7410');
    const a = await call('/api/enrich/apply', { items: [{ partId: id, keys: ['vds', 'id'] }] });
    expect(a.json).toMatchObject({ ok: true, applied: 1, specsWritten: 2 });
    expect(Object.keys((await specsOf('AON7410')).props).sort()).toEqual(['id', 'vds']);
    const plan = (await call('/api/enrich/plan', { partIds: [id] })).json.items[0];
    expect(plan.changes.filter((c: any) => c.action === 'same').map((c: any) => c.key).sort()).toEqual(['id', 'vds']);
    // applying the same selection again is a no-op
    expect((await call('/api/enrich/apply', { items: [{ partId: id, keys: ['vds', 'id'] }] })).json.applied).toBe(0);
  });

  it('fills passives from their description when LCSC has no record, and prefers LCSC once it does', async () => {
    const id = await partId('CC0603JRNPO0BN331');
    const text = (await call('/api/enrich/plan', { partIds: [id] })).json.items[0];
    expect(text).toMatchObject({ state: 'ready', family: 'capacitor' });
    expect(text.changes.every((c: any) => c.to.src === 'description')).toBe(true);
    await call('/api/enrich/apply', { items: [{ partId: id, keys: text.changes.map((c: any) => c.key) }] });
    expect((await specsOf('CC0603JRNPO0BN331')).props.capacitance.src).toBe('description');
    await fetched('CC0603JRNPO0BN331');
    const upgrade = (await call('/api/enrich/plan', { partIds: [id] })).json.items[0];
    expect(upgrade.changes.find((c: any) => c.key === 'capacitance')).toMatchObject({ action: 'update', to: { src: 'lcsc' } });
  });

  it('offers LCSC\'s category only where the owner has not chosen one, and fills an empty Value', async () => {
    const id = await partId('C50126V-4P0G56');
    await env.DB.prepare("UPDATE parts SET category_id = (SELECT id FROM categories WHERE name = 'Other') WHERE id = ?").bind(id).run();
    await fetched('C50126V-4P0G56');
    const plan = (await call('/api/enrich/plan', { partIds: [id] })).json.items[0];
    expect(plan.category).toEqual({ from: 'Other', to: 'Connector' });
    await call('/api/enrich/apply', { items: [{ partId: id, keys: [], category: true }] });
    expect((await api(`/api/parts/${id}`)).json.part.category).toBe('Connector');
    // the owner's own category is never replaced
    await env.DB.prepare("UPDATE parts SET category_id = (SELECT id FROM categories WHERE name = 'Mechanical') WHERE id = ?").bind(id).run();
    expect((await call('/api/enrich/plan', { partIds: [id] })).json.items[0].category).toBeUndefined();
  });

  it('reports parts LCSC does not list, and parts it has not been asked about', async () => {
    const [ghost] = await fetched('V106M0603X5R250NKT');
    expect((await call('/api/enrich/plan', { partIds: [ghost] })).json.items[0].state).toBe('not_listed');
    const untouched = await partId('TPA3255DDVR');
    expect((await call('/api/enrich/plan', { partIds: [untouched] })).json.items[0].state).toBe('not_fetched');
  });
});

describe('a value you set by hand always wins', () => {
  it('is never overwritten by LCSC, and the plan says why', async () => {
    const id = await partId('AON7410');
    const rev = (await api(`/api/parts/${id}`)).json.part.rev;
    const set = await call(`/api/parts/${id}/specs`, { rev, family: 'mosfet', set: { vds: '25V' } }, 'PATCH');
    expect(set.json.ok).toBe(true);
    await call('/api/enrich/fetch', { partIds: [id] });
    const plan = (await call('/api/enrich/plan', { partIds: [id] })).json.items[0];
    expect(plan.changes.find((c: any) => c.key === 'vds')).toMatchObject({ action: 'kept', reason: 'you set this by hand', from: { n: 25, src: 'manual' }, to: { n: 30 } });
    await call('/api/enrich/apply', { items: [{ partId: id, keys: plan.changes.map((c: any) => c.key) }] });
    const specs = await specsOf('AON7410');
    expect(specs.props.vds).toMatchObject({ n: 25, src: 'manual' });
    expect(specs.props.id.src).toBe('lcsc');
  });

  it('refuses a value in the wrong unit, in a sentence', async () => {
    const id = await partId('AON7410');
    const rev = (await api(`/api/parts/${id}`)).json.part.rev;
    const r = await call(`/api/parts/${id}/specs`, { rev, family: 'mosfet', set: { vds: '30A' } }, 'PATCH');
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('Could not read "30A" as Vds (expected V).');
    expect((await call(`/api/parts/${id}/specs`, { rev, family: 'mosfet', set: { nonsense: '1V' } }, 'PATCH')).json.error).toBe('"nonsense" is not a MOSFET spec.');
  });

  it('can clear a spec, and refuses a stale edit', async () => {
    const id = await partId('AON7410');
    let rev = (await api(`/api/parts/${id}`)).json.part.rev;
    await call(`/api/parts/${id}/specs`, { rev, family: 'mosfet', set: { vds: '25V', id: '40A' } }, 'PATCH');
    rev++;
    await call(`/api/parts/${id}/specs`, { rev, clear: ['id'] }, 'PATCH');
    expect(Object.keys((await specsOf('AON7410')).props)).toEqual(['vds']);
    expect((await call(`/api/parts/${id}/specs`, { rev: 0, set: { vds: '1V' } }, 'PATCH')).status).toBe(409);
  });

  it('asks for a part type when its category has no spec layout', async () => {
    const id = await partId('PMS150C-S08');
    await env.DB.prepare("UPDATE parts SET category_id = (SELECT id FROM categories WHERE name = 'Other') WHERE id = ?").bind(id).run();
    const rev = (await api(`/api/parts/${id}`)).json.part.rev;
    expect((await call(`/api/parts/${id}/specs`, { rev, set: { flash: '2KB' } }, 'PATCH')).status).toBe(422);
    expect((await call(`/api/parts/${id}/specs`, { rev, family: 'mcu', set: { flash: '2KB' } }, 'PATCH')).json.ok).toBe(true);
  });
});

describe('the parts list and layouts', () => {
  it('carries specs in the list and on the part page', async () => {
    const id = await partId('AON7410');
    await call('/api/enrich/fetch', { partIds: [id] });
    await call('/api/enrich/apply', { items: [{ partId: id, keys: ['vds'] }] });
    const list = (await api('/api/parts')).json.parts.find((p: any) => p.id === id);
    expect(list.specs).toMatchObject({ family: 'mosfet', props: { vds: { n: 30 } } });
    expect((await api(`/api/parts/${id}`)).json.part.specs.family).toBe('mosfet');
    expect((await api(`/api/parts/${await partId('TPA3255DDVR')}`)).json.part.specs).toBeNull();
  });

  it('serves the stored LCSC record for the "All specs" view', async () => {
    const id = await partId('AON7410');
    expect((await call(`/api/parts/${id}/enrichment`)).json.snapshot).toBeNull();
    await call('/api/enrich/fetch', { partIds: [id] });
    const snap = (await call(`/api/parts/${id}/enrichment`)).json.snapshot;
    expect(snap.status).toBe('ok');
    expect(snap.detail.params.length).toBe(14);
  });

  it('stores, returns and resets the owner\'s layout, and refuses a key that is not a spec', async () => {
    const put = await call('/api/settings/speclayouts/mosfet', { order: ['rds_on', 'vds'], keyCount: 3, presets: [{ name: 'Mine', chain: [{ key: 'rds_on', dir: 'asc' }, { key: 'col:package', dir: 'asc' }] }] }, 'PUT');
    expect(put.json.ok).toBe(true);
    expect((await call('/api/settings/speclayouts')).json.layouts.mosfet).toMatchObject({ keyCount: 3, order: ['rds_on', 'vds'] });
    expect((await call('/api/settings/speclayouts/mosfet', { order: ['bogus'] }, 'PUT')).status).toBe(422);
    expect((await call('/api/settings/speclayouts/nothing', { keyCount: 2 }, 'PUT')).status).toBe(404);
    await call('/api/settings/speclayouts/mosfet', undefined, 'DELETE');
    expect((await call('/api/settings/speclayouts')).json.layouts.mosfet).toBeUndefined();
  });
});
