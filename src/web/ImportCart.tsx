import { useState } from 'react';
import { PRIORITIES } from '../domain/purchasing';
import { postImport } from './api';
import { Refusal } from './Refusal';
import { idr } from './format';
import { useProjects, useRefreshBuying, useRefreshImports } from './hooks';

interface Line {
  row: number; lcsc: string; mpn: string; manufacturer: string; qty: number; moq: number; unitPriceMicro: number;
  part: 'create_part' | 'match_part' | 'skip_duplicate'; partId: number | null; needsReview: boolean;
  need: { action: 'create' | 'exists'; existingQty?: number }; stock: number; willBuy: number;
  quote: { action: 'create' | 'update' | 'same' | 'skip'; unitPriceIdr: number; moq: number; reason?: string };
}
interface Resp {
  mode?: 'plan' | 'applied'; alias?: string; project?: { name: string; isNew: boolean }; fxIdrPerUsd?: string; rowsWritten?: number;
  summary?: { total: number; newParts: number; matchedParts: number; needsToCreate: number; needsExisting: number; quotesToWrite: number; lowStock: number };
  warnings?: string[]; errors?: string[]; error?: string; lines?: Line[];
}
const NEW = '__new__';
const QUOTE_LABEL = { create: 'new quote', update: 'price changes', same: 'unchanged', skip: 'no quote' } as const;

/** Import an LCSC cart export: preview, then apply. Writes nothing until you apply. */
export function ImportCart() {
  const { data: projects = [] } = useProjects();
  const refresh = useRefreshBuying();
  const refreshImports = useRefreshImports();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [f, setF] = useState({ project: NEW, newName: '', alias: '', priority: 'medium', fx: '', quotes: true });
  const [resp, setResp] = useState<Resp | null>(null);
  const [previewed, setPreviewed] = useState('');
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([file?.name, f]);

  async function send(apply: boolean) {
    if (!file) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { filename: file.name, csv: file.text, priority: f.priority, updateQuotes: f.quotes, apply };
      if (f.alias.trim()) body.alias = f.alias.trim();
      if (f.project === NEW) body.newProjectName = f.newName.trim(); else body.projectId = Number(f.project);
      if (f.fx) body.fxIdrPerUsd = f.fx;
      const res = await postImport<Resp>('/import/lcsc-cart', body);
      if ('problem' in res) { setResp({ error: res.problem }); return; }
      const json = res.json;
      setResp((prev) => (json.mode === 'applied' ? { ...json, lines: json.lines ?? prev?.lines } : json));
      if (json.mode === 'plan') {
        // Show the rate the server used, so you correct a number instead of guessing it; the preview stays valid for it.
        const next = { ...f, fx: f.fx || json.fxIdrPerUsd || '' };
        setF(next);
        setPreviewed(JSON.stringify([file.name, next]));
      }
      if (json.mode === 'applied') { void refresh(); void refreshImports(); }
    } finally { setBusy(false); }
  }

  const sum = resp?.summary;
  const applied = resp?.mode === 'applied';
  const nameOk = f.project !== NEW || f.newName.trim().length > 0;
  const canApply = !!resp && resp.mode === 'plan' && !resp.errors?.length && previewed === key && !busy && !applied;

  return (
    <>
      <p className="lede">Choose the cart CSV exported from LCSC. Each line becomes something the project needs, and the cart&rsquo;s price and minimum order become an LCSC quote. Nothing is written until you apply.</p>
      <form className="import" onSubmit={(e) => { e.preventDefault(); void send(false); }}>
        <label>LCSC cart CSV
          <input type="file" accept=".csv,text/csv" onChange={async (e) => { const fl = e.target.files?.[0]; setResp(null); setPreviewed(''); setFile(fl ? { name: fl.name, text: await fl.text() } : null); }} /></label>
        <label>Project
          <select value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })}>
            <option value={NEW}>New project&hellip;</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {f.project === NEW && <label>New project name<input value={f.newName} onChange={(e) => setF({ ...f, newName: e.target.value })} placeholder="TPA3255 Amp" /></label>}
        <label>Name (optional)<input value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} placeholder={resp?.alias ?? 'from the file name'} /></label>
        <label>Priority
          <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>USD &rarr; IDR rate (for the quotes)<input inputMode="decimal" value={f.fx} onChange={(e) => setF({ ...f, fx: e.target.value })} placeholder="default from settings" /></label>
        <label className="check"><input type="checkbox" checked={f.quotes} onChange={(e) => setF({ ...f, quotes: e.target.checked })} /> Set LCSC quotes from the cart prices</label>
        <div className="row"><button type="submit" disabled={!file || busy || !nameOk}>Preview</button></div>
      </form>

      <Refusal error={resp?.error} errors={resp?.errors} heading={resp?.mode === 'plan' ? 'Fix these first:' : 'This cannot be imported:'} />
      {resp?.warnings && resp.warnings.length > 0 && <div className="box warn"><b>Worth a look:</b><ul>{resp.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}

      {sum && resp?.lines && (
        <>
          <div className="box stats">
            <div><b>{sum.needsToCreate}</b><span>needs to add{resp.project?.isNew ? ` to the new project "${resp.project.name}"` : ` to ${resp.project?.name}`}</span></div>
            <div><b>{sum.newParts}</b><span>new parts</span></div>
            <div><b>{sum.matchedParts}</b><span>parts you already have</span></div>
            <div><b>{sum.quotesToWrite}</b><span>LCSC quotes to set</span></div>
            <div><b>{sum.needsExisting}</b><span>already needed (kept)</span></div>
            <div><b>{sum.lowStock}</b><span>fully covered by stock</span></div>
          </div>
          {applied
            ? <div className="box ok"><b>Imported.</b> {sum.needsToCreate} needs added, {sum.newParts} new parts, {sum.quotesToWrite} quotes set ({resp.rowsWritten} database rows written). <a href="#/buy">Open the buy list</a></div>
            : <div className="row">
                <button onClick={() => void send(true)} disabled={!canApply}>{sum.needsToCreate + sum.newParts + sum.quotesToWrite === 0 ? 'Nothing new to import' : `Apply: ${sum.needsToCreate} needs, ${sum.newParts} new parts, ${sum.quotesToWrite} quotes`}</button>
                {previewed !== key && <span className="lede">Details changed since the preview; preview again.</span>}
              </div>}
          <div className="scroll"><table>
            <thead><tr><th>Row</th><th>LCSC #</th><th>MPN</th><th className="num">Cart qty</th><th className="num">In stock</th><th className="num">Will buy</th><th>Part</th><th>Need</th><th>LCSC quote</th></tr></thead>
            <tbody>{resp.lines.map((l) => (
              <tr key={l.row}>
                <td>{l.row}</td><td>{l.lcsc}</td><td>{l.mpn}</td><td className="num">{l.qty}</td><td className="num">{l.stock}</td>
                <td className="num"><b>{l.willBuy}</b></td>
                <td><span className={`chip ${l.part === 'create_part' ? 'create_part' : ''}`}>{l.part === 'create_part' ? 'New part' : 'Existing'}</span>{l.needsReview && <span className="chip review"> Review</span>}</td>
                <td>{l.need.action === 'create' ? 'add' : `kept (${l.need.existingQty})`}</td>
                <td title={l.quote.reason}>{l.quote.action === 'skip' ? <span className="est">{QUOTE_LABEL.skip}</span> : <>{idr(l.quote.unitPriceIdr)} <span className="est">{QUOTE_LABEL[l.quote.action]}, MOQ {l.quote.moq}</span></>}</td>
              </tr>))}</tbody></table></div>
        </>)}
    </>
  );
}
