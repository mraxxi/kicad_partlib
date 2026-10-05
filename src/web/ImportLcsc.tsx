import { useState } from 'react';

interface PlanLine {
  row: number; lcsc: string; mpn: string; manufacturer: string; qty: number; unitPriceMicro: number;
  action: 'create_part' | 'match_part' | 'skip_duplicate'; matchedBy: string | null; category: string;
  needsReview: boolean; reviewReasons: string[]; setLcscCode: boolean; manufacturerVariant: boolean;
}
interface Order { orderNo: string; orderDate: string; fxIdrPerUsd: string; shippingIdr: number; dutiesIdr: number }
interface Plan {
  summary: { total: number; newParts: number; matchedParts: number; duplicates: number; lotsToCreate: number; piecesToReceive: number; totalUsdMicro: number };
  errors: string[]; warnings: string[]; lines: PlanLine[];
}
interface Resp { mode?: 'plan' | 'applied'; order?: Order; plan?: Plan; errors?: string[]; error?: string; rowsWritten?: number; summary?: Plan['summary'] }

const usd = (micro: number, digits = 4) => `$${(micro / 1e6).toFixed(digits)}`;
const ACTION: Record<PlanLine['action'], string> = {
  create_part: 'New part', match_part: 'Existing part', skip_duplicate: 'Already imported',
};

export function ImportLcsc() {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [form, setForm] = useState({ orderNo: '', orderDate: '', fx: '', shipping: '', duties: '' });
  const [resp, setResp] = useState<Resp | null>(null);
  const [previewed, setPreviewed] = useState('');
  const [busy, setBusy] = useState(false);

  const key = JSON.stringify([file?.name, form]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function send(apply: boolean) {
    if (!file) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { filename: file.name, csv: file.text, apply };
      if (form.orderNo) body.orderNo = form.orderNo;
      if (form.orderDate) body.orderDate = form.orderDate;
      if (form.fx) body.fxIdrPerUsd = form.fx;
      if (form.shipping) body.shippingIdr = Number(form.shipping);
      if (form.duties) body.dutiesIdr = Number(form.duties);
      const res = await fetch('/api/import/lcsc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json: Resp = await res.json();
      // An apply response carries no plan; keep the previewed one on screen next to the result.
      setResp((prev) => (json.mode === 'applied' ? { ...json, plan: prev?.plan } : json));
      if (json.order && !apply) {
        // Show what the server resolved, so the owner corrects a value rather than guessing it.
        const next = { orderNo: json.order.orderNo, orderDate: json.order.orderDate, fx: json.order.fxIdrPerUsd,
          shipping: String(json.order.shippingIdr || ''), duties: String(json.order.dutiesIdr || '') };
        setForm(next);
        setPreviewed(JSON.stringify([file.name, next]));
      }
    } catch {
      setResp({ error: 'Could not reach the server. This app keeps no data locally, so nothing works offline.' });
    } finally {
      setBusy(false);
    }
  }

  const plan = resp?.plan;
  const applied = resp?.mode === 'applied';
  const canApply = !!plan && plan.errors.length === 0 && plan.summary.lotsToCreate > 0 && previewed === key && !applied && !busy;

  return (
    <>
      <h1>Import an LCSC order</h1>
      <p className="lede">Choose the CSV exported from LCSC, check the details, preview, then apply. Nothing is written until you apply.</p>
      <form className="import" onSubmit={(e) => { e.preventDefault(); void send(false); }}>
        <label>LCSC CSV file
          <input type="file" accept=".csv,text/csv" onChange={async (e) => {
            const f = e.target.files?.[0];
            setResp(null); setPreviewed('');
            setForm({ orderNo: '', orderDate: '', fx: '', shipping: '', duties: '' });
            setFile(f ? { name: f.name, text: await f.text() } : null);
          }} />
        </label>
        <label>Order number<input value={form.orderNo} onChange={set('orderNo')} placeholder="from filename" /></label>
        <label>Order date<input type="date" value={form.orderDate} onChange={set('orderDate')} /></label>
        <label>USD → IDR rate (frozen on this order)<input inputMode="decimal" value={form.fx} onChange={set('fx')} placeholder="default from settings" /></label>
        <label>Shipping (Rp)<input inputMode="numeric" value={form.shipping} onChange={set('shipping')} placeholder="0" /></label>
        <label>Duties / tax (Rp)<input inputMode="numeric" value={form.duties} onChange={set('duties')} placeholder="0" /></label>
        <div className="row"><button type="submit" disabled={!file || busy}>Preview</button></div>
      </form>

      {resp?.error && <div className="box bad">{resp.error}</div>}
      {resp?.errors && <div className="box bad"><b>This cannot be imported:</b><ul>{resp.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}

      {plan && (
        <>
          {plan.errors.length > 0 && <div className="box bad"><b>Fix these first:</b><ul>{plan.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
          {plan.warnings.length > 0 && <div className="box warn"><b>Worth a look:</b><ul>{plan.warnings.map((e) => <li key={e}>{e}</li>)}</ul></div>}
          <div className="box stats">
            <div><b>{plan.summary.newParts}</b><span>new parts</span></div>
            <div><b>{plan.summary.matchedParts}</b><span>existing parts</span></div>
            <div><b>{plan.summary.duplicates}</b><span>already imported</span></div>
            <div><b>{plan.summary.piecesToReceive.toLocaleString('id-ID')}</b><span>pieces to receive</span></div>
            <div><b>{usd(plan.summary.totalUsdMicro, 2)}</b><span>parts total</span></div>
          </div>
          {applied
            ? <div className="box ok"><b>Imported.</b> {resp.summary?.lotsToCreate} lots received ({resp.rowsWritten} database rows written).</div>
            : <div className="row">
                <button onClick={() => void send(true)} disabled={!canApply}>
                  {plan.summary.lotsToCreate === 0 ? 'Nothing new to import' : `Apply: receive ${plan.summary.piecesToReceive.toLocaleString('id-ID')} pieces`}
                </button>
                {previewed !== key && <span className="lede">Details changed since the preview; preview again.</span>}
              </div>}
          <div className="scroll">
            <table>
              <thead><tr><th>Row</th><th>LCSC #</th><th>MPN</th><th>Manufacturer</th><th>Category</th><th className="num">Qty</th><th className="num">Unit</th><th>Result</th></tr></thead>
              <tbody>
                {plan.lines.map((l) => (
                  <tr key={l.row}>
                    <td>{l.row}</td><td>{l.lcsc}</td><td>{l.mpn}</td><td>{l.manufacturer}</td><td>{l.category}</td>
                    <td className="num">{l.qty}</td><td className="num">{usd(l.unitPriceMicro)}</td>
                    <td>
                      <span className={`chip ${l.action}`}>{ACTION[l.action]}</span>{' '}
                      {l.needsReview && <span className="chip review" title={l.reviewReasons.join('; ')}>Review</span>}{' '}
                      {l.manufacturerVariant && <span className="chip" title="LCSC spells the manufacturer differently; kept as an alias">Alias</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
