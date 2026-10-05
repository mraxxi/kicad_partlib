import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CONDITIONS, CONDITION_LABEL, type Condition } from '../domain/stock';
import { api, newId } from './api';
import { idr, num } from './format';
import { useCategories, useDonors, useLocations, useRefreshStock, type Donor } from './hooks';

const STATUS = { stripping: 'Stripping', done: 'Done', parked: 'Parked' } as const;
interface Line { mpn: string; manufacturer: string; qty: string; condition: Condition; est: string; location: string; category: string }
const blank = (): Line => ({ mpn: '', manufacturer: '', qty: '1', condition: 'untested', est: '0', location: '', category: '' });

function Harvest({ donor, onClose }: { donor: Donor; onClose: () => void }) {
  const refresh = useRefreshStock();
  const locs = useLocations().data ?? [];
  const cats = useCategories().data ?? [];
  // One id per form: a retried submit cannot create the lots twice.
  const [harvestId, setHarvestId] = useState(newId);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [done, setDone] = useState<string | null>(null);
  const set = (i: number, k: keyof Line, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const filled = lines.filter((l) => l.mpn.trim());
  const m = useMutation({
    mutationFn: () => api<{ lots: number; newParts: number }>(`/donors/${donor.id}/harvest`, { body: {
      harvestId,
      items: filled.map((l) => ({
        mpn: l.mpn.trim(), manufacturer: l.manufacturer.trim(), qty: Number(l.qty), condition: l.condition,
        estUnitValueIdr: Number(l.est) || 0, locationId: l.location ? Number(l.location) : null, category: l.category || null,
      })) } }),
    onSuccess: (r) => {
      setDone(`Recorded ${r.lots} lot${r.lots === 1 ? '' : 's'} from ${donor.code} (${r.newParts} new part${r.newParts === 1 ? '' : 's'}, to review in Parts).`);
      setLines([blank()]); setHarvestId(newId()); void refresh();
    },
  });
  return (
    <section className="box">
      <div className="row"><h2 style={{ margin: 0 }}>Harvest from {donor.code}</h2><button className="link" onClick={onClose}>Close</button></div>
      <p className="lede">Type each part; press Enter in the last field to add a row. Estimated value is your guess per piece, kept apart from money spent.</p>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div className="scroll"><table className="entry">
          <thead><tr><th>MPN / name</th><th>Maker</th><th>Qty</th><th>Condition</th><th>Est. Rp each</th><th>Location</th><th>Category</th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td><input value={l.mpn} onChange={(e) => set(i, 'mpn', e.target.value)} autoFocus={i === lines.length - 1 && lines.length > 1} /></td>
              <td><input value={l.manufacturer} onChange={(e) => set(i, 'manufacturer', e.target.value)} /></td>
              <td><input className="narrow" type="number" min={1} value={l.qty} onChange={(e) => set(i, 'qty', e.target.value)} /></td>
              <td><select value={l.condition} onChange={(e) => set(i, 'condition', e.target.value)}>{CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}</select></td>
              <td><input className="narrow" type="number" min={0} value={l.est} onChange={(e) => set(i, 'est', e.target.value)} /></td>
              <td><select value={l.location} onChange={(e) => set(i, 'location', e.target.value)}><option value="">–</option>{locs.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></td>
              <td><select value={l.category} onChange={(e) => set(i, 'category', e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && i === lines.length - 1) { e.preventDefault(); setLines([...lines, blank()]); } }}>
                <option value="">Other</option>{cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select></td>
            </tr>))}</tbody>
        </table></div>
        <div className="row">
          <button type="submit" disabled={m.isPending || filled.length === 0}>Record {filled.length || ''} line{filled.length === 1 ? '' : 's'}</button>
          <button type="button" className="secondary" onClick={() => setLines([...lines, blank()])}>Add row</button>
        </div>
        {m.error && <div className="box bad">{(m.error as Error).message}</div>}
        {done && <div className="box ok">{done}</div>}
      </form>
    </section>
  );
}

export function Donors() {
  const { data } = useDonors();
  const refresh = useRefreshStock();
  const [f, setF] = useState({ code: '', device: '', receivedAt: '', condition: '' });
  const [open, setOpen] = useState<number | null>(null);
  const create = useMutation({
    mutationFn: () => api('/donors', { body: { code: f.code, device: f.device, receivedAt: f.receivedAt || null, condition: f.condition } }),
    onSuccess: () => { setF({ code: '', device: '', receivedAt: '', condition: '' }); void refresh(); },
  });
  const setStatus = useMutation({
    mutationFn: (d: Donor & { status: Donor['status'] }) => api(`/donors/${d.id}`, { method: 'PATCH', body: { code: d.code, device: d.device, receivedAt: d.receivedAt, condition: d.condition, status: d.status, notes: d.notes } }),
    onSuccess: () => void refresh(),
  });
  const donor = (data ?? []).find((d) => d.id === open);
  return (
    <>
      <h1>Salvage</h1>
      <p className="lede">Donor boards and what was harvested from each.</p>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label>Board ID<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="LB-003" required /></label>
        <label className="grow">Device<input value={f.device} onChange={(e) => setF({ ...f, device: e.target.value })} placeholder="15.6 in laptop mainboard" required /></label>
        <label>Received<input type="date" value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} /></label>
        <label className="grow">Condition<input value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })} placeholder="No power, shorted VCORE" /></label>
        <button type="submit" disabled={create.isPending}>Add board</button>
      </form>
      {create.error && <div className="box bad">{(create.error as Error).message}</div>}
      <div className="scroll"><table>
        <thead><tr><th>Board</th><th>Device</th><th>Received</th><th>Condition</th><th className="num">Part lines</th><th className="num">Units</th><th className="num">Est. value</th><th>Status</th><th /></tr></thead>
        <tbody>{(data ?? []).map((d) => (
          <tr key={d.id}><td>{d.code}</td><td>{d.device}</td><td>{d.receivedAt ?? ''}</td><td>{d.condition}</td>
            <td className="num">{d.partLines}</td><td className="num">{num(d.unitsHarvested)}</td><td className="num">~{idr(d.estValueIdr)}</td>
            <td><select value={d.status} onChange={(e) => setStatus.mutate({ ...d, status: e.target.value as Donor['status'] })}>
              {Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
            <td><button className="link" onClick={() => setOpen(d.id)}>Harvest</button></td></tr>))}</tbody>
      </table></div>
      {donor && <Harvest key={donor.id} donor={donor} onClose={() => setOpen(null)} />}
    </>
  );
}
