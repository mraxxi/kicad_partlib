import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { familyById, formatSpec, type SpecChange } from '../domain/specs';
import { api } from './api';
import { useParts } from './hooks';
import { fetchPartImage } from './partImage';

interface PlanItem {
  partId: number; mpn: string; lcscCode: string | null; family: string; familyLabel: string;
  state: 'ready' | 'unchanged' | 'not_listed' | 'not_fetched' | 'no_family'; changes: SpecChange[];
  category?: { from: string | null; to: string }; valueText?: string;
}
const CHUNK_FETCH = 20, CHUNK_PLAN = 50;
const STATE_LABEL: Record<PlanItem['state'], string> = {
  ready: 'ready to apply', unchanged: 'already up to date', not_listed: 'no longer listed by LCSC', not_fetched: 'not fetched from LCSC yet', no_family: 'no spec layout for this kind of part yet',
};

/**
 * Bulk enrichment, as a plan you review (AGENTS.md rule 10): 1) fetch LCSC's record for parts that have a C-number,
 * 2) see what would change, 3) apply only what is ticked. A value you entered by hand is never in the list.
 */
export function Enrich() {
  const { data: parts } = useParts();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const stop = useRef(false);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true); setErr(null); setMsg(null); stop.current = false;
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); setProgress(null); void label; }
  }

  const fetchAll = () => run('fetch', async () => {
    const { parts: todo } = await api<{ parts: Array<{ id: number }> }>('/enrich/unfetched');
    if (todo.length === 0) { setMsg('Every part with a C-number has already been fetched.'); return; }
    const tally: Record<string, number> = {};
    for (let i = 0; i < todo.length && !stop.current; i += CHUNK_FETCH) {
      setProgress(`Asking LCSC… ${Math.min(i + CHUNK_FETCH, todo.length)} of ${todo.length}`);
      const r = await api<{ results: Array<{ status: string }> }>('/enrich/fetch', { body: { partIds: todo.slice(i, i + CHUNK_FETCH).map((p) => p.id) } });
      for (const x of r.results) tally[x.status] = (tally[x.status] ?? 0) + 1;
    }
    setMsg(`${stop.current ? 'Stopped. ' : ''}Fetched ${tally.ok ?? 0}; ${tally.not_listed ?? 0} no longer listed${tally.error ? `; ${tally.error} failed and will be retried next time` : ''}.`);
  });

  // One part at a time: each needs two LCSC requests from the Worker and a resize in this browser, so there is
  // nothing to gain from parallelism and a small pause keeps us polite to LCSC.
  const fetchImages = () => run('images', async () => {
    const { parts: todo } = await api<{ parts: Array<{ partId: number }> }>('/images/pending');
    if (todo.length === 0) { setMsg('Every part with a C-number already has an image.'); return; }
    let done = 0, bytes = 0; const failed: Record<string, number> = {};
    for (let i = 0; i < todo.length && !stop.current; i++) {
      setProgress(`Fetching images… ${i + 1} of ${todo.length}`);
      try { bytes += await fetchPartImage(todo[i]!.partId); done++; } catch (e) { const m = (e as Error).message; failed[m] = (failed[m] ?? 0) + 1; }
      await new Promise((r) => setTimeout(r, 150));
    }
    const why = Object.entries(failed).map(([m, n]) => `${n} \u00d7 ${m}`).join(' ');
    setMsg(`${stop.current ? 'Stopped. ' : ''}Stored ${done} images (${Math.round(bytes / 1024)} KB in total).${why ? ` Not stored: ${why}` : ''}`);
  });

  const review = () => run('plan', async () => {
    const ids = (parts ?? []).map((p) => p.id);
    const all: PlanItem[] = [];
    for (let i = 0; i < ids.length && !stop.current; i += CHUNK_PLAN) {
      setProgress(`Reading plans… ${Math.min(i + CHUNK_PLAN, ids.length)} of ${ids.length}`);
      all.push(...(await api<{ items: PlanItem[] }>('/enrich/plan', { body: { partIds: ids.slice(i, i + CHUNK_PLAN) } })).items);
    }
    setItems(all);
    setPicked(Object.fromEntries(all.filter((x) => x.state === 'ready').map((x) => [x.partId, true])));
  });

  const applySelected = () => run('apply', async () => {
    const chosen = (items ?? []).filter((x) => x.state === 'ready' && picked[x.partId]);
    let applied = 0, specs = 0;
    for (let i = 0; i < chosen.length; i += CHUNK_PLAN) {
      setProgress(`Applying… ${Math.min(i + CHUNK_PLAN, chosen.length)} of ${chosen.length}`);
      const r = await api<{ applied: number; specsWritten: number }>('/enrich/apply', { body: { items: chosen.slice(i, i + CHUNK_PLAN).map((x) => ({
        partId: x.partId, keys: x.changes.filter((c) => c.action === 'new' || c.action === 'update').map((c) => c.key), category: !!x.category, valueText: !!x.valueText })) } });
      applied += r.applied; specs += r.specsWritten;
    }
    setMsg(`Applied ${specs} specs to ${applied} parts.`);
    setItems(null);
    await qc.invalidateQueries({ queryKey: ['parts'] });
    await qc.invalidateQueries({ queryKey: ['dashboard'] });
  });

  const counts = (items ?? []).reduce<Record<string, number>>((m, x) => ({ ...m, [x.state]: (m[x.state] ?? 0) + 1 }), {});
  const ready = (items ?? []).filter((x) => x.state === 'ready');
  const nSelected = ready.filter((x) => picked[x.partId]).length;

  return (
    <>
      <h1>Enrich specs</h1>
      <p className="lede">Fill each part&rsquo;s specs (voltage, current, Rds(on), tolerance&hellip;) from LCSC, and from the description text for passives. You see what would change first; values you entered by hand are never touched.</p>

      <div className="box">
        <h2 style={{ marginTop: 0 }}>1. Fetch from LCSC</h2>
        <p className="lede">Asks LCSC about each part that has a C-number and has not been asked yet, a few at a time, and keeps its answer. Nothing about your parts changes in this step.</p>
        <div className="row"><button onClick={fetchAll} disabled={busy}>Fetch from LCSC</button>{busy && <button className="secondary" onClick={() => { stop.current = true; }}>Stop</button>}</div>
      </div>

      <div className="box">
        <h2 style={{ marginTop: 0 }}>Part images</h2>
        <p className="lede">Fetches LCSC&rsquo;s first picture for each part that has a C-number and no picture yet, shrinks it to a small thumbnail in your browser (about 4 KB) and keeps it. Parts you already have a picture for are skipped.</p>
        <div className="row"><button onClick={fetchImages} disabled={busy}>Fetch part images</button>{busy && <button className="secondary" onClick={() => { stop.current = true; }}>Stop</button>}</div>
      </div>

      <div className="box">
        <h2 style={{ marginTop: 0 }}>2. Review what would change</h2>
        <div className="row"><button onClick={review} disabled={busy || !parts}>Review {parts ? parts.length : ''} parts</button></div>
      </div>

      {progress && <div className="box">{progress}</div>}
      {err && <div className="box bad">{err}</div>}
      {msg && <div className="box ok">{msg}</div>}

      {items && (
        <>
          <div className="box stats">
            {(Object.keys(STATE_LABEL) as Array<PlanItem['state']>).map((s) => counts[s] ? <div key={s}><b>{counts[s]}</b><span>{STATE_LABEL[s]}</span></div> : null)}
          </div>
          {ready.length > 0 && (
            <>
              <div className="row">
                <button onClick={applySelected} disabled={busy || nSelected === 0}>Apply to {nSelected} part{nSelected === 1 ? '' : 's'}</button>
                <button className="secondary" onClick={() => setPicked(Object.fromEntries(ready.map((x) => [x.partId, true])))}>Select all</button>
                <button className="secondary" onClick={() => setPicked({})}>Select none</button>
              </div>
              <div className="scroll"><table>
                <thead><tr><th /><th>Part</th><th>MPN</th><th>Kind</th><th>What changes</th></tr></thead>
                <tbody>{ready.map((x) => {
                  const fam = familyById(x.family);
                  const acts = x.changes.filter((c) => c.action === 'new' || c.action === 'update');
                  return (
                    <tr key={x.partId}>
                      <td><input type="checkbox" checked={!!picked[x.partId]} onChange={(e) => setPicked({ ...picked, [x.partId]: e.target.checked })} /></td>
                      <td><a href={`#/parts/${x.partId}`}>P-{String(x.partId).padStart(4, '0')}</a></td>
                      <td>{x.mpn}</td><td>{x.familyLabel}</td>
                      <td>{acts.map((c) => { const def = fam?.props.find((p) => p.key === c.key); return def ? `${def.label} ${formatSpec(def, c.to)}` : c.key; }).join(' · ')}
                        {x.category && <span className="est"> · category {'→'} {x.category.to}</span>}
                        {x.valueText && <span className="est"> · value {x.valueText}</span>}</td>
                    </tr>);
                })}</tbody></table></div>
            </>)}
        </>)}
    </>
  );
}
