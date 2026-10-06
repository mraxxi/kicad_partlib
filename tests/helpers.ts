import { env, exports } from 'cloudflare:workers';
import csv1 from './fixtures/lcsc/LCSC__WM2509100613_20261006045136.csv?raw';
import csv2 from './fixtures/lcsc/LCSC__WM2408250114_20261006045133.csv?raw';

export const FILES = {
  a: { filename: 'LCSC__WM2509100613_20261006045136.csv', csv: csv1 },
  b: { filename: 'LCSC__WM2408250114_20261006045133.csv', csv: csv2 },
};

export async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; json: any }> {
  const res = await exports.default.fetch(
    new Request(`https://partlib.test${path}`, body === undefined ? { method } : {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

export const importLcsc = (f: { filename: string; csv: string }, extra: object = {}) =>
  api('/api/import/lcsc', { ...f, ...extra });

export async function count(table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return r!.n;
}

/**
 * Empty the data tables between tests. stock_moves refuses DELETE by design, so
 * the guard triggers are dropped and re-created from their own stored SQL.
 */
export async function reset(): Promise<void> {
  const triggers = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger'").all<{ sql: string }>();
  await env.DB.exec("DROP TRIGGER IF EXISTS stock_moves_no_update;DROP TRIGGER IF EXISTS stock_moves_no_delete;");
  for (const t of ['part_images', 'part_enrichment', 'bom_lines', 'project_bom', 'needs', 'quotes', 'projects', 'stock_moves', 'lots', 'order_lines', 'orders', 'part_aliases', 'parts', 'donors', 'locations', 'import_runs', 'usage_daily']) {
    await env.DB.exec(`DELETE FROM ${t};`);
  }
  for (const t of triggers.results) await env.DB.exec(t.sql.replace(/\s*\n\s*/g, ' '));
}
