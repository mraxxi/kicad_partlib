import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PRIORITIES, type BuyLine, type LineState, type Priority } from '../domain/purchasing';
import { api } from './api';
import { idr, num } from './format';
import { useBuyList, useRefreshBuying, type SupplierRow } from './hooks';

const STATE_LABEL: Record<LineState, string> = {
  buy: 'To buy', covered: 'Covered by stock', no_quote: 'No quotes', ordered: 'Ordered', received: 'Received', cancelled: 'Cancelled',
};
// Badge colours follow the design system: money still to spend is orange, an order in flight is blue.
const STATE_CLASS: Record<LineState, string> = { buy: 'need-buy', covered: 'need-covered', no_quote: 'st-reorder', ordered: 'need-ordered', received: 'st-ok', cancelled: 'need-cancelled' };

interface OrderPlan {
  supplierName: string; lines: Array<{ needId: number; projectName: string; mpn: string; qty: number; totalIdr: number }>;
  groups: Array<{ mpn: string; orderQty: number; unitPriceIdr: number; totalIdr: number }>;
  partsIdr: number; orderShippingIdr: number; grandTotalIdr: number;
}

export function LineRow({ l, suppliers, refresh }: { l: BuyLine; suppliers: SupplierRow[]; refresh: () => void }) {
  const save = useMutation({
    mutationFn: (edit: Record<string, unknown>) => api(`/needs/${l.needId}`, { method: 'PATCH', body: { rev: l.rev, ...edit } }),
    onSuccess: refresh,
  });
  const editable = l.status === 'to_buy';
  const name = (id: number | null) => suppliers.find((s) => s.id === id)?.name ?? '–';
  return (
    <tr className={save.error ? 'review-row' : ''} title={(save.error as Error | null)?.message}>
      <td>{l.projectName}</td>
      <td><a href={`#/parts/${l.partId}`}>{l.mpn}</a></td>
      <td className="num">{editable ? <input className="mini" type="number" min={1} defaultValue={l.qtyNeeded} onBlur={(e) => Number(e.target.value) !== l.qtyNeeded && save.mutate({ qtyNeeded: Number(e.target.value) })} /> : l.qtyNeeded}</td>
      <td className="num">{l.usableInStock}</td>
      <td className="num">{l.shortfall}</td>
      <td className="num">{editable ? <input className="mini" type="number" min={0} defaultValue={l.spares} onBlur={(e) => Number(e.target.value) !== l.spares && save.mutate({ spares: Number(e.target.value) })} /> : l.spares}</td>
      <td className="num"><b>{l.buyQty || ''}</b></td>
      <td>{l.bestSupplierId ? name(l.bestSupplierId) : ''}</td>
      <td>{editable ? (
        <select value={l.overrideSupplierId ?? ''} onChange={(e) => save.mutate({ overrideSupplierId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">best</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>) : name(l.overrideSupplierId)}</td>
      <td className="num money">{l.unitPriceIdr !== null ? idr(l.unitPriceIdr) : ''}</td>
      <td className="num">{l.moq ?? ''}</td>
      <td className="num">{l.orderQty ?? ''}</td>
      <td className="num money">{l.state === 'ordered' ? idr(l.orderedTotalIdr) : l.lineTotalIdr ? idr(l.lineTotalIdr) : ''}</td>
      <td>{editable ? (
        <select value={l.priority} onChange={(e) => save.mutate({ priority: e.target.value as Priority })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>) : l.priority}</td>
      <td><span className={`chip ${STATE_CLASS[l.state]}`}>{STATE_LABEL[l.state]}</span></td>
      <td className="actions">
        {l.status === 'to_buy' && <button className="link" onClick={() => save.mutate({ status: 'cancelled' })}>Cancel</button>}
        {l.status === 'ordered' && <><button className="link" onClick={() => save.mutate({ status: 'received' })}>Mark received</button><button className="link" onClick={() => save.mutate({ status: 'to_buy' })}>Undo order</button></>}
      </td>
    </tr>
  );
}

export function LinesTable({ lines, suppliers, refresh }: { lines: BuyLine[]; suppliers: SupplierRow[]; refresh: () => void }) {
  return (
    <div className="scroll"><table>
      <thead><tr><th>Project</th><th>MPN</th><th className="num">Need</th><th className="num">In stock</th><th className="num">Short</th><th className="num">Spares</th><th className="num">Buy</th>
        <th>Best</th><th>Supplier</th><th className="num">Unit</th><th className="num">MOQ</th><th className="num">Order qty</th><th className="num">Total</th><th>Priority</th><th>Status</th><th /></tr></thead>
      <tbody>{lines.map((l) => <LineRow key={l.needId} l={l} suppliers={suppliers} refresh={refresh} />)}</tbody>
    </table></div>
  );
}

function OrderDialog({ supplier, onClose }: { supplier: SupplierRow; onClose: () => void }) {
  const refresh = useRefreshBuying();
  const [plan, setPlan] = useState<OrderPlan | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const preview = useMutation({ mutationFn: () => api<{ plan: OrderPlan }>('/buylist/order', { body: { supplierId: supplier.id } }), onSuccess: (r) => setPlan(r.plan) });
  const apply = useMutation({ mutationFn: () => api<{ ordered: number }>('/buylist/order', { body: { supplierId: supplier.id, apply: true } }), onSuccess: (r) => { setDone(r.ordered); void refresh(); } });
  if (!plan && !preview.isPending && !preview.error && done === null) preview.mutate();
  return (
    <section className="box">
      <div className="row"><h2 style={{ margin: 0 }}>Order from {supplier.name}</h2><button className="link" onClick={onClose}>Close</button></div>
      {preview.error && <div className="box bad">{(preview.error as Error).message}</div>}
      {plan && done === null && (
        <>
          <p className="lede">Marking these lines ordered freezes what they cost now; later price changes will not touch them.</p>
          <table><thead><tr><th>MPN</th><th className="num">Order qty</th><th className="num">Unit</th><th className="num">Total</th></tr></thead>
            <tbody>{plan.groups.map((g) => <tr key={g.mpn}><td>{g.mpn}</td><td className="num">{num(g.orderQty)}</td><td className="num">{idr(g.unitPriceIdr)}</td><td className="num">{idr(g.totalIdr)}</td></tr>)}</tbody></table>
          <p>Parts {idr(plan.partsIdr)} + order shipping {idr(plan.orderShippingIdr)} = <b>{idr(plan.grandTotalIdr)}</b> across {plan.lines.length} line{plan.lines.length === 1 ? '' : 's'}.</p>
          <div className="row"><button className="buy" onClick={() => apply.mutate()} disabled={apply.isPending}>Mark {plan.lines.length} line{plan.lines.length === 1 ? '' : 's'} ordered</button>
            {apply.error && <span className="err">{(apply.error as Error).message}</span>}</div>
        </>)}
      {done !== null && <div className="box ok">{done} line{done === 1 ? '' : 's'} marked ordered. Import the LCSC export when the order arrives to receive them.</div>}
    </section>
  );
}

export function BuyList() {
  const { data, error } = useBuyList();
  const refresh = useRefreshBuying();
  const [order, setOrder] = useState<SupplierRow | null>(null);
  if (error) return <div className="box bad">{(error as Error).message}</div>;
  if (!data) return <p className="lede">Loading…</p>;
  const { buyList: b, suppliers } = data;
  const lines = b.lines.filter((l) => l.state !== 'covered' || l.status === 'to_buy');
  const name = (id: number) => suppliers.find((s) => s.id === id)?.name ?? String(id);
  return (
    <>
      <h1>Buy list</h1>
      <p className="lede">What each project needs, less what you already have, priced at the cheapest supplier once shipping is counted. Stock is shared across projects, highest priority first.</p>
      <LinesTable lines={lines} suppliers={suppliers} refresh={() => void refresh()} />
      {lines.length === 0 && <p className="lede">Nothing to buy. Add needs from a project.</p>}

      <h2>Purchase recap</h2>
      <p className="lede">By supplier. Order shipping is charged once per supplier and waived above its free-shipping threshold.
        {' '}<a className="button buy" href="/api/buylist/cart.csv" download>Download LCSC cart (CSV)</a></p>
      <div className="scroll"><table>
        <thead><tr><th>Supplier</th><th className="num">Lines</th><th className="num">Parts</th><th className="num">Listing shipping</th><th className="num">Order shipping</th><th className="num">Total to buy</th><th className="num">Ordered, in transit</th><th /></tr></thead>
        <tbody>
          <tr><td><b>Total</b></td><td className="num">{b.recapTotal.lines}</td><td className="num">{idr(b.recapTotal.subtotalIdr)}</td><td className="num">{idr(b.recapTotal.listingShippingIdr)}</td>
            <td className="num">{idr(b.recapTotal.orderShippingIdr)}</td><td className="num"><b>{idr(b.recapTotal.totalIdr)}</b></td><td className="num">{idr(b.recapTotal.orderedInTransitIdr)}</td><td /></tr>
          {b.recap.map((r) => (
            <tr key={r.supplierId}><td>{r.name}</td><td className="num">{r.lines}</td><td className="num">{idr(r.subtotalIdr)}</td><td className="num">{idr(r.listingShippingIdr)}</td>
              <td className="num">{idr(r.orderShippingIdr)}</td><td className="num">{idr(r.totalIdr)}</td><td className="num">{idr(r.orderedInTransitIdr)}</td>
              <td>{r.lines > 0 && <button className="link" onClick={() => setOrder(suppliers.find((s) => s.id === r.supplierId) ?? null)}>Mark ordered…</button>}</td></tr>))}
        </tbody>
      </table></div>
      {order && <OrderDialog key={order.id} supplier={order} onClose={() => setOrder(null)} />}

      <div className="two">
        {[['Spend by project', b.byProject], ['Spend by priority', b.byPriority]].map(([title, rows]) => (
          <section key={title as string}>
            <h2>{title as string}</h2>
            <p className="lede">Excludes order shipping.</p>
            <table><thead><tr><th>{title === 'Spend by project' ? 'Project' : 'Priority'}</th><th className="num">Lines</th><th className="num">To buy</th><th className="num">Ordered</th></tr></thead>
              <tbody>{(rows as typeof b.byProject).map((s) => <tr key={s.key}><td>{s.key}</td><td className="num">{s.lines}</td><td className="num">{idr(s.toBuyIdr)}</td><td className="num">{idr(s.orderedIdr)}</td></tr>)}</tbody></table>
          </section>))}
      </div>

      <h2>Landed cost per unit, by supplier</h2>
      <p className="lede">Price × the quantity you would order (never below the MOQ) plus listing shipping, divided by the quantity you need. Lowest is highlighted.</p>
      <div className="scroll"><table>
        <thead><tr><th>MPN</th><th className="num">Need</th>{suppliers.map((s) => <th key={s.id} className="num">{s.name}</th>)}</tr></thead>
        <tbody>{b.matrix.map((m) => (
          <tr key={m.partId}><td><a href={`#/parts/${m.partId}`}>{m.mpn}</a></td><td className="num">{m.demand}</td>
            {suppliers.map((s) => { const c = m.bySupplier[s.id]; return <td key={s.id} className={`num${c?.best ? ' best' : ''}`}>{c ? idr(c.landedPerUnitIdr) : ''}</td>; })}</tr>))}</tbody>
      </table></div>
      <p className="lede">Names: {suppliers.map((s) => name(s.id)).join(', ')}</p>
    </>
  );
}
