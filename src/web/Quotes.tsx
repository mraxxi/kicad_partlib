import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RISKS, type PriceBreak, type Quote } from '../domain/purchasing';
import { api } from './api';
import { idr } from './format';
import { useRefreshBuying, useSuppliers } from './hooks';

type QuoteRow = Quote & { supplierName: string; notes: string };

const breaksText = (b: PriceBreak[]) => b.map((x) => `${x.qty}:${x.priceIdr}`).join(', ');
function parseBreaks(t: string): PriceBreak[] {
  return t.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const [q, p] = s.split(':').map((x) => Number(x.trim()));
    return { qty: q ?? NaN, priceIdr: p ?? NaN };
  });
}
const ageDays = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

export function Quotes({ partId }: { partId: number }) {
  const suppliers = useSuppliers().data ?? [];
  const refresh = useRefreshBuying();
  const { data: quotes = [] } = useQuery({ queryKey: ['quotes', partId], queryFn: async () => (await api<{ quotes: QuoteRow[] }>(`/parts/${partId}/quotes`)).quotes });
  const blank = { supplierId: '', seller: '', price: '', moq: '1', breaks: '', ship: '0', lead: '', risk: 'low', url: '' };
  const [f, setF] = useState(blank);
  const save = useMutation({
    mutationFn: () => api(`/parts/${partId}/quotes`, { method: 'PUT', body: {
      supplierId: Number(f.supplierId), seller: f.seller, unitPriceIdr: Number(f.price), moq: Number(f.moq) || 1, priceBreaks: parseBreaks(f.breaks),
      listingShippingIdr: Number(f.ship) || 0, leadDays: f.lead === '' ? null : Number(f.lead), risk: f.risk, url: f.url } }),
    onSuccess: () => { setF(blank); void refresh(); },
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/quotes/${id}`, { method: 'DELETE' }), onSuccess: () => void refresh() });
  const edit = (q: QuoteRow) => setF({ supplierId: String(q.supplierId), seller: q.seller, price: String(q.unitPriceIdr), moq: String(q.moq), breaks: breaksText(q.priceBreaks), ship: String(q.listingShippingIdr), lead: q.leadDays === null ? '' : String(q.leadDays), risk: q.risk, url: q.url });
  return (
    <>
      <h2>Quotes</h2>
      <p className="lede">One price per supplier, in rupiah. Saving a supplier again replaces its quote and restamps the date, so stale prices show as stale.</p>
      {quotes.length > 0 && (
        <div className="scroll"><table>
          <thead><tr><th>Supplier</th><th>Seller</th><th className="num">Unit</th><th className="num">MOQ</th><th>Price breaks</th><th className="num">Listing shipping</th><th className="num">Lead</th><th>Risk</th><th>Quoted</th><th /></tr></thead>
          <tbody>{quotes.map((q) => (
            <tr key={q.id}><td>{q.url ? <a href={q.url} target="_blank" rel="noreferrer">{q.supplierName}</a> : q.supplierName}</td><td>{q.seller}</td><td className="num">{idr(q.unitPriceIdr)}</td><td className="num">{q.moq}</td>
              <td>{breaksText(q.priceBreaks)}</td><td className="num">{idr(q.listingShippingIdr)}</td><td className="num">{q.leadDays ?? ''}</td><td>{q.risk}</td>
              <td className={ageDays(q.quotedAt) > 30 ? 'err' : ''}>{ageDays(q.quotedAt) === 0 ? 'today' : `${ageDays(q.quotedAt)} d ago`}</td>
              <td><button className="link" onClick={() => edit(q)}>Edit</button><button className="link" onClick={() => del.mutate(q.id)}>Delete</button></td></tr>))}</tbody>
        </table></div>)}
      <form className="inline action" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label>Supplier<select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })} required><option value="">choose</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Seller / listing<input value={f.seller} onChange={(e) => setF({ ...f, seller: e.target.value })} /></label>
        <label>Unit price (Rp)<input type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required /></label>
        <label>MOQ<input className="narrow" type="number" min={1} value={f.moq} onChange={(e) => setF({ ...f, moq: e.target.value })} /></label>
        <label>Price breaks (qty:price, …)<input value={f.breaks} onChange={(e) => setF({ ...f, breaks: e.target.value })} placeholder="100:80, 1000:60" /></label>
        <label>Listing shipping (Rp)<input type="number" min={0} value={f.ship} onChange={(e) => setF({ ...f, ship: e.target.value })} /></label>
        <label>Lead (days)<input className="narrow" type="number" min={0} value={f.lead} onChange={(e) => setF({ ...f, lead: e.target.value })} /></label>
        <label>Authenticity risk<select value={f.risk} onChange={(e) => setF({ ...f, risk: e.target.value })}>{RISKS.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <label className="grow">Link<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
        <button type="submit" disabled={save.isPending}>Save quote</button>
        {save.error && <span className="err">{(save.error as Error).message}</span>}
      </form>
    </>
  );
}
