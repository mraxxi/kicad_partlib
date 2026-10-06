import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PRIORITIES } from '../domain/purchasing';
import { api } from './api';
import { LinesTable } from './BuyList';
import { ProjectBom } from './ProjectBom';
import { useBuyList, useCategories, useParts, useProjects, useRefreshBuying } from './hooks';

const STATUSES = ['planning', 'active', 'done', 'parked'] as const;

function AddNeed({ projectId, onDone }: { projectId: number; onDone: () => void }) {
  const { data: parts = [] } = useParts();
  const cats = useCategories().data ?? [];
  const [q, setQ] = useState('');
  const [partId, setPartId] = useState<number | null>(null);
  const [f, setF] = useState({ qty: '1', spares: '0', priority: 'medium' });
  const [creating, setCreating] = useState(false);
  const [np, setNp] = useState({ mpn: '', manufacturer: '', lcscCode: '', category: '' });
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? parts.filter((p) => `${p.mpn} ${p.description} ${p.code} ${p.lcscCode ?? ''}`.toLowerCase().includes(t)).slice(0, 8) : [];
  }, [q, parts]);
  const chosen = parts.find((p) => p.id === partId);
  const newPart = useMutation({
    mutationFn: () => api<{ id: number }>('/parts', { body: { mpn: np.mpn, manufacturer: np.manufacturer, lcscCode: np.lcscCode || null, category: np.category || null } }),
    onSuccess: (r) => { setPartId(r.id); setCreating(false); setQ(np.mpn); onDone(); },
  });
  const add = useMutation({
    mutationFn: () => api('/needs', { body: { projectId, partId, qtyNeeded: Number(f.qty), spares: Number(f.spares), priority: f.priority } }),
    onSuccess: () => { setPartId(null); setQ(''); setF({ qty: '1', spares: '0', priority: 'medium' }); onDone(); },
  });
  return (
    <section className="box">
      <h2 style={{ marginTop: 0 }}>Add a part this project needs</h2>
      <label>Find a part<input value={chosen ? chosen.mpn : q} onChange={(e) => { setPartId(null); setQ(e.target.value); }} placeholder="MPN, description, C-number, P-0012…" /></label>
      {!chosen && matches.length > 0 && <ul className="pick">{matches.map((p) => <li key={p.id}><button className="link" onClick={() => setPartId(p.id)}>{p.code} · {p.mpn} <span className="lede">{p.description.slice(0, 60)} · {p.usableQty} in stock</span></button></li>)}</ul>}
      {!chosen && q.trim() && <p className="lede">Not in your library? <button className="link" onClick={() => { setCreating(true); setNp({ ...np, mpn: q.trim() }); }}>Create it</button></p>}
      {creating && (
        <form className="inline action" onSubmit={(e) => { e.preventDefault(); newPart.mutate(); }}>
          <label>MPN<input value={np.mpn} onChange={(e) => setNp({ ...np, mpn: e.target.value })} required /></label>
          <label>Manufacturer<input value={np.manufacturer} onChange={(e) => setNp({ ...np, manufacturer: e.target.value })} /></label>
          <label>LCSC #<input value={np.lcscCode} onChange={(e) => setNp({ ...np, lcscCode: e.target.value })} placeholder="C12345" /></label>
          <label>Category<select value={np.category} onChange={(e) => setNp({ ...np, category: e.target.value })}><option value="">Other</option>{cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select></label>
          <button type="submit" disabled={newPart.isPending}>Create part</button>
          {newPart.error && <span className="err">{(newPart.error as Error).message}</span>}
        </form>)}
      {chosen && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <label>Quantity needed<input type="number" min={1} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} autoFocus /></label>
          <label>Extra spares<input type="number" min={0} value={f.spares} onChange={(e) => setF({ ...f, spares: e.target.value })} /></label>
          <label>Priority<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
          <button type="submit" disabled={add.isPending}>Add to project</button>
          {add.error && <span className="err">{(add.error as Error).message}</span>}
        </form>)}
    </section>
  );
}

export function Projects({ projectId }: { projectId: number | null }) {
  const { data: projects = [] } = useProjects();
  const bl = useBuyList();
  const refresh = useRefreshBuying();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/projects', { body: { name } }),
    onSuccess: (r) => { setName(''); void refresh(); location.hash = `#/projects/${r.id}`; },
  });
  const setStatus = useMutation({
    mutationFn: (p: { id: number; name: string; status: string; kicadProject: string | null; notes: string }) => api(`/projects/${p.id}`, { method: 'PATCH', body: p }),
    onSuccess: () => void refresh(),
  });
  const project = projects.find((p) => p.id === projectId);

  if (projectId !== null) {
    if (!project) return <p className="lede">Loading… <a href="#/projects">All projects</a></p>;
    const lines = bl.data?.buyList.lines.filter((l) => l.projectId === projectId) ?? [];
    return (
      <>
        <p className="lede"><a href="#/projects">← All projects</a></p>
        <h1>{project.name}</h1>
        <p className="lede">Status: <select value={project.status} onChange={(e) => setStatus.mutate({ ...project, status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></p>
        <ProjectBom projectId={projectId} />
        <AddNeed projectId={projectId} onDone={() => void refresh()} />
        <h2>Needs</h2>
        {lines.length === 0 ? <p className="lede">No needs yet.</p> : <LinesTable lines={lines} suppliers={bl.data?.suppliers ?? []} refresh={() => void refresh()} />}
      </>
    );
  }
  return (
    <>
      <h1>Projects</h1>
      <p className="lede">Each project lists the parts it needs; the buy list works out what to purchase.</p>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label className="grow">New project<input value={name} onChange={(e) => setName(e.target.value)} placeholder="7.1 USB Sound Card" required /></label>
        <button type="submit" disabled={create.isPending}>Add project</button>
      </form>
      {create.error && <div className="box bad">{(create.error as Error).message}</div>}
      <table><thead><tr><th>Project</th><th>Status</th><th className="num">Needs</th><th className="num">To buy</th></tr></thead>
        <tbody>{projects.map((p) => <tr key={p.id}><td><a href={`#/projects/${p.id}`}>{p.name}</a></td><td>{p.status}</td><td className="num">{p.needCount}</td><td className="num">{p.toBuyCount}</td></tr>)}</tbody></table>
    </>
  );
}
