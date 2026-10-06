import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CONDITIONS, CONDITION_LABEL, SOURCE_LABEL, STATUS_LABEL, isEstimatedCost, type Condition, type PartSummary } from '../domain/stock';
import { ApiError, api, newId } from './api';
import { idr, num, unitIdr, when } from './format';
import { useCategories, useLocations, useRefreshStock, type Location } from './hooks';
import { Quotes } from './Quotes';
import { partsHref } from './route';

interface Lot {
  id: number; source: 'order' | 'salvage' | 'manual'; condition: Condition; qtyOnHand: number; unitCostIdrMicro: number;
  dateCode: string | null; locationId: number | null; locationCode: string | null; donorCode: string | null; orderNo: string | null;
}
interface Move { id: number; lotId: number; delta: number; reason: string; note: string; at: string }
type Detail = { part: PartSummary & { notes: string; datasheetUrl: string | null; categoryId: number | null }; lots: Lot[]; moves: Move[] };

type Kind = 'consume' | 'adjust' | 'count' | 'scrap' | 'reclassify';
const KIND_LABEL: Record<Kind, string> = { consume: 'Use', adjust: 'Adjust', count: 'Count', scrap: 'Scrap', reclassify: 'Move / mark' };

function LotAction({ lot, kind, locations, onDone, onCancel }: { lot: Lot; kind: Kind; locations: Location[]; onDone: () => void; onCancel: () => void }) {
  // One id per opened form, reused if the request is retried, so a retry cannot apply twice.
  const [moveId] = useState(newId);
  const [qty, setQty] = useState(kind === 'reclassify' ? lot.qtyOnHand : 1);
  const [delta, setDelta] = useState(-1);
  const [counted, setCounted] = useState(lot.qtyOnHand);
  const [note, setNote] = useState('');
  const [cond, setCond] = useState('');
  const [loc, setLoc] = useState('');
  const m = useMutation({
    mutationFn: () => {
      if (kind === 'reclassify') {
        const body: Record<string, unknown> = { moveId, qty, note };
        if (cond) body.condition = cond;
        if (loc) body.locationId = loc === 'none' ? null : Number(loc);
        return api(`/lots/${lot.id}/reclassify`, { body });
      }
      const body = kind === 'adjust' ? { kind, moveId, delta, note }
        : kind === 'count' ? { kind, moveId, countedQty: counted, note } : { kind, moveId, qty, note };
      return api(`/lots/${lot.id}/moves`, { body });
    },
    onSuccess: onDone,
  });
  return (
    <form className="inline action" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <strong>{KIND_LABEL[kind]}</strong>
      {(kind === 'consume' || kind === 'scrap' || kind === 'reclassify') && (
        <label>Quantity<input type="number" min={1} max={lot.qtyOnHand} value={qty} onChange={(e) => setQty(Number(e.target.value))} autoFocus /></label>)}
      {kind === 'adjust' && <label>Change (+/−)<input type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value))} autoFocus /></label>}
      {kind === 'count' && <label>Counted<input type="number" min={0} value={counted} onChange={(e) => setCounted(Number(e.target.value))} autoFocus /></label>}
      {kind === 'reclassify' && (
        <>
          <label>Condition<select value={cond} onChange={(e) => setCond(e.target.value)}><option value="">unchanged</option>
            {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}</select></label>
          <label>Location<select value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">unchanged</option><option value="none">none</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></label>
        </>)}
      <label className="grow">{kind === 'adjust' ? 'Reason (required)' : 'Note'}<input value={note} onChange={(e) => setNote(e.target.value)} required={kind === 'adjust'} /></label>
      <button type="submit" disabled={m.isPending}>Save</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      {m.error && <span className="err">{(m.error as Error).message}</span>}
    </form>
  );
}

function LotRow({ lot, locations, refresh }: { lot: Lot; locations: Location[]; refresh: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const est = isEstimatedCost(lot.source);
  return (
    <>
      <tr>
        <td>#{lot.id}</td>
        <td>{SOURCE_LABEL[lot.source]}{lot.orderNo ? ` ${lot.orderNo}` : ''}{lot.donorCode ? ` ${lot.donorCode}` : ''}</td>
        <td><span className={`chip cond-${lot.condition}`}>{CONDITION_LABEL[lot.condition]}</span></td>
        <td>{lot.locationCode ?? '–'}</td>
        <td className="num"><b>{num(lot.qtyOnHand)}</b></td>
        <td className="num">{unitIdr(lot.unitCostIdrMicro)}{est && <span className="est" title="estimated value of a salvaged part, not money spent"> est.</span>}</td>
        <td>{lot.dateCode ?? ''}</td>
        <td className="actions">{(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <button key={k} className="link" disabled={lot.qtyOnHand === 0 && k !== 'adjust' && k !== 'count'} onClick={() => setKind(kind === k ? null : k)}>{KIND_LABEL[k]}</button>))}</td>
      </tr>
      {kind && <tr><td colSpan={8}><LotAction lot={lot} kind={kind} locations={locations} onCancel={() => setKind(null)} onDone={() => { setKind(null); refresh(); }} /></td></tr>}
    </>
  );
}

function AddStock({ partId, locations, onDone }: { partId: number; locations: Location[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [moveId, setMoveId] = useState(newId);
  const [f, setF] = useState({ qty: 1, condition: 'new' as Condition, locationId: '', unitCostIdr: 0, note: '' });
  const m = useMutation({
    mutationFn: () => api(`/parts/${partId}/lots`, { body: { moveId, qty: f.qty, condition: f.condition, locationId: f.locationId ? Number(f.locationId) : null, unitCostIdr: f.unitCostIdr, note: f.note } }),
    onSuccess: () => { setOpen(false); setMoveId(newId()); onDone(); },
  });
  if (!open) return <button className="secondary" onClick={() => setOpen(true)}>Add stock found elsewhere</button>;
  return (
    <form className="inline action" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <label>Quantity<input type="number" min={1} value={f.qty} onChange={(e) => setF({ ...f, qty: Number(e.target.value) })} autoFocus /></label>
      <label>Condition<select value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value as Condition })}>{CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}</select></label>
      <label>Location<select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">none</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></label>
      <label>Unit cost (Rp)<input type="number" min={0} value={f.unitCostIdr} onChange={(e) => setF({ ...f, unitCostIdr: Number(e.target.value) })} /></label>
      <label className="grow">Note<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      <button type="submit" disabled={m.isPending}>Add</button><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      {m.error && <span className="err">{(m.error as Error).message}</span>}
    </form>
  );
}

interface Conflict { kind: 'conflict'; currentRev: number; fields: Record<string, { yours: unknown; current: unknown }> }
interface Confirm { kind: 'confirm_identity'; changes: Record<string, { from: string | null; to: string | null }>; impact: { lots: number; needs: number; quotes: number; orderLines: number } }
interface Collision { kind: 'collision'; partId?: number }
const FIELD_LABEL: Record<string, string> = { mpn: 'MPN', manufacturer: 'Manufacturer', lcscCode: 'LCSC #' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function Edit({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const cats = useCategories().data ?? [];
  const p = d.part;
  const [f, setF] = useState({
    description: p.description, package: p.package, value: p.value, categoryId: p.categoryId ? String(p.categoryId) : '',
    minQty: p.minQty === null ? '' : String(p.minQty), notes: p.notes, datasheetUrl: p.datasheetUrl ?? '', needsReview: p.needsReview,
    mpn: p.mpn, manufacturer: p.manufacturer, lcsc: p.lcscCode ?? '',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [rev, setRev] = useState(p.rev);
  useEffect(() => { setRev(p.rev); }, [p.rev]);
  const [problem, setProblem] = useState<Conflict | Confirm | Collision | null>(null);
  const identityChanged = f.mpn !== p.mpn || f.manufacturer !== p.manufacturer || (f.lcsc || null) !== p.lcscCode;
  const m = useMutation({
    mutationFn: (o: { rev: number; confirm: boolean }) => api(`/parts/${p.id}`, { method: 'PATCH', body: {
      rev: o.rev, confirmIdentity: o.confirm, description: f.description, package: f.package, value: f.value,
      categoryId: f.categoryId ? Number(f.categoryId) : null, minQty: f.minQty === '' ? null : Number(f.minQty),
      notes: f.notes, datasheetUrl: f.datasheetUrl || null, needsReview: f.needsReview,
      mpn: f.mpn, manufacturer: f.manufacturer, lcscCode: f.lcsc.trim() || null } }),
    onSuccess: () => { setProblem(null); onSaved(); },
    onError: (e) => { setProblem(e instanceof ApiError && e.detail ? (e.detail as Conflict | Confirm | Collision) : null); },
  });
  const plainError = m.error && (!problem || problem.kind === 'collision') ? (m.error as Error).message : null;
  return (
    <form className="grid" onSubmit={(e) => { e.preventDefault(); m.mutate({ rev, confirm: false }); }}>
      <label>Value<input value={f.value} onChange={(e) => set('value', e.target.value)} placeholder="10uF, 4.7kΩ, 100nH…" /></label>
      <label>Footprint<input value={f.package} onChange={(e) => set('package', e.target.value)} placeholder="0603, SOP-8…" /></label>
      <label className="wide">Description
        <input value={f.description} onChange={(e) => { set('description', e.target.value); if (e.target.value.trim() && p.description === '' && f.needsReview) set('needsReview', false); }} /></label>
      <label>Category<select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}><option value="">none</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Minimum usable stock<input type="number" min={0} value={f.minQty} onChange={(e) => set('minQty', e.target.value)} placeholder="not tracked" /></label>
      <label className="wide">Datasheet URL<input value={f.datasheetUrl} onChange={(e) => set('datasheetUrl', e.target.value)} /></label>
      <label className="wide">Notes<input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      <label className="check wide"><input type="checkbox" checked={f.needsReview} onChange={(e) => set('needsReview', e.target.checked)} /> Still needs review (shows on the dashboard until you clear it)</label>

      <details className="wide identity" open={identityChanged}>
        <summary>Identity: MPN, manufacturer, C-number</summary>
        <p className="lede">These decide how imports and the buy list recognise this part. You will be shown what is linked to it before a change is applied. Past orders keep their original text.</p>
        <div className="grid">
          <label>MPN<input value={f.mpn} onChange={(e) => set('mpn', e.target.value)} required /></label>
          <label>Manufacturer<input value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></label>
          <label>LCSC #<input value={f.lcsc} onChange={(e) => set('lcsc', e.target.value)} placeholder="C12345" /></label>
        </div>
      </details>

      <div className="row wide"><button type="submit" disabled={m.isPending}>Save details</button>{plainError && <span className="err">{plainError}</span>}
        {problem?.kind === 'collision' && problem.partId && <a href={`#/parts/${problem.partId}`}>Open the other part</a>}</div>

      {problem?.kind === 'confirm_identity' && (
        <div className="box warn wide">
          <b>Confirm the identity change. Nothing has been saved yet.</b>
          <ul>{Object.entries(problem.changes).map(([k, v]) => <li key={k}>{FIELD_LABEL[k] ?? k}: <b>{v.from || '(empty)'}</b> → <b>{v.to || '(empty)'}</b></li>)}</ul>
          <p>This part is linked to {plural(problem.impact.lots, 'lot')}, {plural(problem.impact.needs, 'project need')}, {plural(problem.impact.quotes, 'quote')} and {plural(problem.impact.orderLines, 'order line')}.
            They stay attached. Future imports and buy-list lines will recognise the part by the new values.</p>
          <div className="row">
            <button type="button" onClick={() => m.mutate({ rev, confirm: true })} disabled={m.isPending}>Apply change</button>
            <button type="button" className="secondary" onClick={() => setProblem(null)}>Not now</button>
          </div>
        </div>)}

      {problem?.kind === 'conflict' && (
        <div className="box warn wide">
          <b>This part was changed somewhere else; nothing was saved.</b>
          <table><thead><tr><th>Field</th><th>Yours</th><th>Current</th></tr></thead>
            <tbody>{Object.entries(problem.fields).map(([k, v]) => <tr key={k}><td>{FIELD_LABEL[k] ?? k}</td><td>{String(v.yours ?? '–')}</td><td>{String(v.current ?? '–')}</td></tr>)}</tbody></table>
          <div className="row">
            <button type="button" onClick={() => m.mutate({ rev: problem.currentRev, confirm: false })}>Keep mine</button>
            <button type="button" className="secondary" onClick={() => { setProblem(null); onSaved(); }}>Keep theirs</button>
          </div>
        </div>)}
    </form>
  );
}

export function PartDetail({ id, embedded = false }: { id: number; embedded?: boolean }) {
  const refreshStock = useRefreshStock();
  const locations = useLocations().data ?? [];
  const { data, error, refetch } = useQuery({ queryKey: ['part', id], queryFn: () => api<Detail>(`/parts/${id}`) });
  const refresh = () => { void refreshStock(); void refetch(); };
  if (error) return <div className="box bad">{(error as Error).message} <a href={partsHref()}>Back to parts</a></div>;
  if (!data) return <p className="lede">Loading…</p>;
  const { part: p, lots, moves } = data;
  return (
    <>
      {!embedded && <p className="lede"><a href={partsHref()}>← All parts</a></p>}
      {embedded ? <h2 style={{ marginTop: 0 }}>{p.mpn} <span className="lede">{p.code}</span></h2> : <h1>{p.mpn} <span className="lede">{p.code}</span></h1>}
      <p className="lede">{[p.manufacturer, p.package, p.value, p.category].filter(Boolean).join(' · ')}{p.lcscCode && <> · <a href={`https://www.lcsc.com/product-detail/${p.lcscCode}.html`} target="_blank" rel="noreferrer">{p.lcscCode}</a></>}</p>
      {p.needsReview && <div className="box warn">This part was created with missing details; fill them in below.</div>}
      <div className="box stats">
        <div><b>{num(p.usableQty)}</b><span>usable</span></div>
        <div><b>{num(p.totalQty)}</b><span>total on hand</span></div>
        <div><b><span className={`chip st-${p.status}`}>{STATUS_LABEL[p.status]}</span></b><span>stock status</span></div>
        <div><b>{idr(p.valueRealIdr)}</b><span>value (paid for)</span></div>
        {p.valueEstimatedIdr > 0 && <div><b>~{idr(p.valueEstimatedIdr)}</b><span>salvaged, estimated</span></div>}
      </div>
      <h2>Details</h2>
      <Edit key={p.rev} d={data} onSaved={refresh} />
      <h2>Lots</h2>
      <div className="scroll"><table>
        <thead><tr><th>Lot</th><th>Source</th><th>Condition</th><th>Where</th><th className="num">Qty</th><th className="num">Unit cost</th><th>Date code</th><th /></tr></thead>
        <tbody>{lots.map((l) => <LotRow key={l.id} lot={l} locations={locations} refresh={refresh} />)}</tbody>
      </table></div>
      <AddStock partId={p.id} locations={locations} onDone={refresh} />
      <Quotes partId={p.id} />
      <h2>History</h2>
      <div className="scroll"><table>
        <thead><tr><th>When</th><th>Lot</th><th>Reason</th><th className="num">Change</th><th>Note</th></tr></thead>
        <tbody>{moves.map((m) => (
          <tr key={m.id}><td>{when(m.at)}</td><td>#{m.lotId}</td><td>{m.reason}</td>
            <td className={`num ${m.delta < 0 ? 'neg' : 'pos'}`}>{m.delta > 0 ? '+' : ''}{m.delta}</td><td>{m.note}</td></tr>))}</tbody>
      </table></div>
    </>
  );
}
