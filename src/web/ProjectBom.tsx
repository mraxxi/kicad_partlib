import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, noReason, postImport } from './api';
import { Refusal } from './Refusal';
import { useBuyList, useParts, useRefreshBuying } from './hooks';

interface Suggestion { partId: number; mpn: string; lcscCode: string | null; value: string; usableQty: number }
type Status = 'active' | 'dnp' | 'ignored' | 'removed';
interface BomLine {
  id: number; rev: number; key: string; refs: string; qty: number; value: string; footprint: string; status: Status;
  partId: number | null; linkRule: 'lcsc' | 'mpn' | 'remembered' | 'manual' | null; mpn: string | null; lcscCode: string | null; onHand: number; suggestions: Suggestion[];
}
interface Bom { boards: number; fileName: string; importedAt: string; lines: BomLine[] }
interface PlanLine { key: string; row: number | null; refs: string; value: string; footprint: string; qty: number | null; qtyBefore: number | null; action: 'new' | 'same' | 'changed' | 'removed'; partId: number | null; linkRule: string | null; status: Status; suggestions: Suggestion[] }
interface NeedChange { partId: number; label: string; action: 'create' | 'update' | 'reopen' | 'cancel' | 'hand' | 'locked' | 'same'; current: number | null; status: string | null; bom: number }
const NEED_TEXT: Record<NeedChange['action'], string> = {
  create: 'new need', update: 'quantity changes', reopen: 'cancelled need comes back', cancel: 'need is cancelled (no active line left)',
  hand: 'you set this: your number is kept', locked: 'already ordered or received: not changed', same: 'unchanged',
};
interface PlanResp {
  needs: NeedChange[];
  mode: 'plan' | 'applied'; boards: number; sameFile: boolean; unchanged?: boolean; rowsWritten?: number; warnings: string[]; lines: PlanLine[];
  summary: { total: number; linked: number; toIdentify: number; dnp: number; added: number; changed: number; removed: number; unchanged: number; needsCreated: number; needsChanged: number; needsKept: number };
}

const reasonProblem = (j: { error?: string; errors?: string[] }, status: number) => (j.error || j.errors?.length ? { error: j.error, errors: j.errors } : { error: noReason(status) });
const RULE: Record<string, string> = { lcsc: 'matched by LCSC number', mpn: 'matched by MPN', remembered: 'linked the same way in another project', manual: 'linked by you' };
const ACTION: Record<PlanLine['action'], string> = { new: 'new', same: 'unchanged', changed: 'changed', removed: 'no longer in the BOM' };

/** Plan, then apply: nothing is written until you apply. */
function Upload({ projectId, boards, onApplied }: { projectId: number; boards: number; onApplied: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [n, setN] = useState(String(boards));
  const [plan, setPlan] = useState<PlanResp | null>(null);
  const [seen, setSeen] = useState('');
  const key = JSON.stringify([file?.name, file?.text.length, n]);
  const [problem, setProblem] = useState<{ error?: string; errors?: string[] } | null>(null);
  const send = useMutation({
    mutationFn: async (apply: boolean) => {
      const res = await postImport<PlanResp & { error?: string; errors?: string[] }>(`/projects/${projectId}/bom`, { filename: file!.name, csv: file!.text, boards: Number(n), apply });
      if ('problem' in res) { setProblem({ error: res.problem }); return; }
      if (res.status >= 400 || !res.json.mode) { setProblem(reasonProblem(res.json, res.status)); return; }
      setProblem(null); setPlan(res.json);
      if (res.json.mode === 'plan') setSeen(key); else onApplied();
    },
  });
  const canApply = plan?.mode === 'plan' && seen === key && !plan.sameFile && !send.isPending;
  return (
    <section className="box">
      <h2 style={{ marginTop: 0 }}>Import a KiCad BOM</h2>
      <p className="lede">In KiCad: Schematic Editor &rarr; File &rarr; Export &rarr; BOM, with the LCSC and MPN fields you use added. Lines are matched to your parts by LCSC number, then MPN. Nothing is written until you apply.</p>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); setPlan(null); setProblem(null); send.mutate(false); }}>
        <label>BOM CSV<input type="file" accept=".csv,text/csv,.txt" onChange={async (e) => { const fl = e.target.files?.[0]; setPlan(null); setFile(fl ? { name: fl.name, text: await fl.text() } : null); }} /></label>
        <label>Boards to build<input type="number" min={1} value={n} onChange={(e) => setN(e.target.value)} style={{ width: 90 }} /></label>
        <button type="submit" disabled={!file || send.isPending}>Preview</button>
        <button type="button" disabled={!canApply} onClick={() => send.mutate(true)}>Apply</button>
      </form>
      {problem && <Refusal error={problem.error} errors={problem.errors} heading="Fix these first:" />}
      {plan?.mode === 'applied' && <div className="box ok">{plan.unchanged ? 'This is the same file for the same number of boards, so nothing changed.' : `Applied: ${plan.summary.total} lines, ${plan.summary.linked} linked to your parts and ${plan.summary.toIdentify} still to identify.`}</div>}
      {plan?.mode === 'plan' && (
        <>
          <p>{plan.summary.total} lines: {plan.summary.linked} matched, <b>{plan.summary.toIdentify} to identify</b>, {plan.summary.dnp} DNP. {plan.summary.added} new, {plan.summary.changed} changed, {plan.summary.removed} no longer in the BOM, {plan.summary.unchanged} unchanged.
            {plan.sameFile && <> This is the file already loaded for {plan.boards} board(s); applying it changes nothing.</>}</p>
          <p>Needs: {plan.summary.needsCreated} new, {plan.summary.needsChanged} changed, <b>{plan.summary.needsKept} kept as you set them</b>. Only needs this BOM created are ever changed by it.</p>
          {plan.needs.some((x) => x.action !== 'same') && (
            <table><thead><tr><th>Part</th><th className="num">Now</th><th className="num">BOM says</th><th>What happens</th></tr></thead>
              <tbody>{plan.needs.filter((x) => x.action !== 'same').map((x) => <tr key={x.partId}><td>{x.label}</td><td className="num">{x.current ?? ''}</td><td className="num">{x.bom}</td><td>{x.action === 'hand' && x.status === 'cancelled' ? 'you cancelled this: it stays cancelled' : NEED_TEXT[x.action]}</td></tr>)}</tbody></table>)}
          {plan.warnings.length > 0 && <div className="box warn"><b>Check these:</b><ul>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
          <table><thead><tr><th>Refs</th><th>Value</th><th>Footprint</th><th className="num">Qty/board</th><th>Match</th><th>Change</th></tr></thead>
            <tbody>{plan.lines.map((l) => (
              <tr key={l.key}>
                <td title={l.refs}>{l.refs.length > 24 ? `${l.refs.slice(0, 24)}…` : l.refs}</td><td>{l.value}</td><td>{l.footprint}</td>
                <td className="num">{l.qtyBefore !== null && l.qtyBefore !== l.qty ? `${l.qtyBefore} → ${l.qty ?? 0}` : l.qty}</td>
                <td>{l.status === 'dnp' ? 'DNP' : l.partId ? RULE[l.linkRule ?? ''] : l.suggestions.length ? `to identify (${l.suggestions.length} suggestion${l.suggestions.length > 1 ? 's' : ''})` : 'to identify'}</td>
                <td>{ACTION[l.action]}</td>
              </tr>))}</tbody></table>
        </>)}
    </section>
  );
}

function CreatePart({ line, onDone }: { line: BomLine; onDone: () => void }) {
  const [f, setF] = useState({ lcsc: '', mpn: '', mf: '' });
  const make = useMutation({
    mutationFn: () => api(`/bom-lines/${line.id}/create-part`, { body: { rev: line.rev, lcscCode: f.lcsc.trim() || null, mpn: f.mpn.trim(), manufacturer: f.mf.trim() } }),
    onSuccess: onDone,
  });
  return (
    <form className="inline action" onSubmit={(e) => { e.preventDefault(); make.mutate(); }}>
      <label>LCSC #<input value={f.lcsc} onChange={(e) => setF({ ...f, lcsc: e.target.value })} placeholder="C12345 (fills in the rest)" /></label>
      <label>MPN<input value={f.mpn} onChange={(e) => setF({ ...f, mpn: e.target.value })} placeholder="or type it" /></label>
      <label>Manufacturer<input value={f.mf} onChange={(e) => setF({ ...f, mf: e.target.value })} /></label>
      <button type="submit" disabled={make.isPending || (!f.lcsc.trim() && !f.mpn.trim())}>Create part</button>
      {make.error && <span className="err">{(make.error as Error).message}</span>}
    </form>
  );
}

function LinkPicker({ onPick }: { onPick: (partId: number) => void }) {
  const { data: parts = [] } = useParts();
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? parts.filter((p) => `${p.mpn} ${p.description} ${p.code} ${p.lcscCode ?? ''}`.toLowerCase().includes(t)).slice(0, 8) : [];
  }, [q, parts]);
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a part: MPN, description, C-number, P-0012…" autoFocus />
      {matches.length > 0 && <ul className="pick">{matches.map((p) => <li key={p.id}><button className="link" onClick={() => onPick(p.id)}>{p.code} · {p.mpn} <span className="lede">{p.description.slice(0, 60)} · {p.usableQty} in stock</span></button></li>)}</ul>}
    </div>
  );
}

function FieldNames() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['bom-fields'], queryFn: async () => (await api<{ fields: Record<'lcsc' | 'mpn' | 'manufacturer', string[]> }>('/settings/bom-fields')).fields });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const save = useMutation({
    mutationFn: () => api('/settings/bom-fields', { method: 'PUT', body: Object.fromEntries(Object.entries(draft!).map(([k, v]) => [k, v.split(',').map((s) => s.trim()).filter(Boolean)])) }),
    onSuccess: () => { setDraft(null); void qc.invalidateQueries({ queryKey: ['bom-fields'] }); },
  });
  if (!q.data) return null;
  const cur = draft ?? Object.fromEntries(Object.entries(q.data).map(([k, v]) => [k, v.join(', ')]));
  const labels = { lcsc: 'LCSC number', mpn: 'MPN', manufacturer: 'Manufacturer' } as const;
  return (
    <details className="box">
      <summary>Which BOM columns hold the LCSC number, MPN and manufacturer</summary>
      <p className="lede">Column names in your KiCad BOM, separated by commas. The first one found in the file is used.</p>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {(Object.keys(labels) as Array<keyof typeof labels>).map((k) => <label key={k} className="grow">{labels[k]}<input value={cur[k]} onChange={(e) => setDraft({ ...cur, [k]: e.target.value })} /></label>)}
        <button type="submit" disabled={!draft || save.isPending}>Save</button>
      </form>
      {save.error && <span className="err">{(save.error as Error).message}</span>}
    </details>
  );
}

export function ProjectBom({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const refreshBuying = useRefreshBuying();
  const bl = useBuyList();
  const bom = useQuery({ queryKey: ['bom', projectId], queryFn: async () => (await api<{ bom: Bom | null }>(`/projects/${projectId}/bom`)).bom });
  const [open, setOpen] = useState<{ id: number; mode: 'link' | 'create' } | null>(null);
  const changed = () => { setOpen(null); void qc.invalidateQueries({ queryKey: ['bom', projectId] }); void refreshBuying(); };
  const edit = useMutation({
    mutationFn: (a: { line: BomLine; partId?: number | null; status?: Status }) => api(`/bom-lines/${a.line.id}`, { method: 'PATCH', body: { rev: a.line.rev, ...(a.partId !== undefined ? { partId: a.partId } : {}), ...(a.status ? { status: a.status } : {}) } }),
    onSuccess: changed,
    onError: () => void qc.invalidateQueries({ queryKey: ['bom', projectId] }),
  });
  const need = (l: BomLine) => bl.data?.buyList.lines.find((x) => x.projectId === projectId && x.partId === l.partId);
  const data = bom.data;
  const open_ = data?.lines.filter((l) => l.partId === null && l.status === 'active').length ?? 0;

  return (
    <>
      <Upload projectId={projectId} boards={data?.boards ?? 1} onApplied={changed} />
      <FieldNames />
      {data && (
        <section>
          <h2>BOM <span className="lede">{data.fileName} · for {data.boards} board{data.boards > 1 ? 's' : ''}{open_ > 0 && <> · <b>{open_} to identify</b></>}</span></h2>
          {edit.error && <div className="box bad">{(edit.error as Error).message}</div>}
          <table>
            <thead><tr><th>Refs</th><th>Value</th><th>Footprint</th><th className="num">Need</th><th>Part</th><th className="num">On hand</th><th className="num">For this project</th><th className="num">To buy</th><th /></tr></thead>
            <tbody>{data.lines.map((l) => {
              const n = need(l);
              const dim = l.status !== 'active';
              return (
                <Fragment key={l.id}>
                  <tr style={dim ? { opacity: 0.55 } : undefined}>
                    <td title={l.refs}>{l.refs.length > 24 ? `${l.refs.slice(0, 24)}…` : l.refs}</td><td>{l.value}</td><td>{l.footprint}</td>
                    <td className="num">{l.qty * data.boards}</td>
                    <td>{l.status === 'dnp' ? 'DNP' : l.status === 'ignored' ? 'ignored' : l.partId ? <><a href={`#/parts/${l.partId}`}>{l.mpn}</a> <span className="lede" title={l.linkRule ? RULE[l.linkRule] : ''}>{l.lcscCode} · {l.linkRule}</span></> : <b>to identify</b>}</td>
                    <td className="num">{l.partId ? l.onHand : ''}</td>
                    <td className="num">{n ? n.stockAllotted : ''}</td>
                    <td className="num">{n ? n.buyQty : ''}</td>
                    <td>
                      <button className="link" onClick={() => setOpen(open?.id === l.id && open.mode === 'link' ? null : { id: l.id, mode: 'link' })}>{l.partId ? 'Relink' : 'Link'}</button>{' '}
                      {l.partId === null && <button className="link" onClick={() => setOpen(open?.id === l.id && open.mode === 'create' ? null : { id: l.id, mode: 'create' })}>New part</button>}{' '}
                      {l.partId !== null && <button className="link" onClick={() => edit.mutate({ line: l, partId: null })}>Unlink</button>}{' '}
                      {l.status === 'active' ? <><button className="link" onClick={() => edit.mutate({ line: l, status: 'dnp' })}>DNP</button>{' '}<button className="link" onClick={() => edit.mutate({ line: l, status: 'ignored' })}>Ignore</button></>
                        : <button className="link" onClick={() => edit.mutate({ line: l, status: 'active' })}>Use</button>}
                    </td>
                  </tr>
                  {l.partId === null && l.status === 'active' && l.suggestions.length > 0 && open?.id !== l.id && (
                    <tr key={`${l.id}-s`}><td colSpan={9} className="lede">Looks like: {l.suggestions.map((s) => <button key={s.partId} className="link" onClick={() => edit.mutate({ line: l, partId: s.partId })}>{s.mpn} ({[s.value, `${s.usableQty} in stock`].filter(Boolean).join(', ')})</button>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, ' · ', x] : [x]), [])}</td></tr>)}
                  {open?.id === l.id && <tr key={`${l.id}-o`}><td colSpan={9}>{open.mode === 'link' ? <LinkPicker onPick={(partId) => edit.mutate({ line: l, partId })} /> : <CreatePart line={l} onDone={changed} />}</td></tr>}
                </Fragment>
              );
            })}</tbody>
          </table>
        </section>)}
      {bom.isSuccess && !data && <p className="lede">No BOM loaded for this project yet.</p>}
    </>
  );
}
