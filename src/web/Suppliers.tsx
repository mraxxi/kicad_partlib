import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from './api';
import { useRefreshBuying, useSuppliers, type SupplierRow } from './hooks';

function Row({ s }: { s: SupplierRow }) {
  const refresh = useRefreshBuying();
  const [f, setF] = useState({ ship: String(s.orderShippingIdr), free: s.freeShipOverIdr === null ? '' : String(s.freeShipOverIdr), lead: s.leadDays === null ? '' : String(s.leadDays), notes: s.notes ?? '' });
  const m = useMutation({
    mutationFn: () => api(`/suppliers/${s.id}`, { method: 'PATCH', body: { orderShippingIdr: Number(f.ship) || 0, freeShipOverIdr: f.free === '' ? null : Number(f.free), leadDays: f.lead === '' ? null : Number(f.lead), url: s.url, notes: f.notes || null } }),
    onSuccess: () => void refresh(),
  });
  return (
    <tr>
      <td>{s.name}</td><td>{s.kind}</td>
      <td><input className="narrow" type="number" min={0} value={f.ship} onChange={(e) => setF({ ...f, ship: e.target.value })} /></td>
      <td><input className="narrow" type="number" min={0} value={f.free} onChange={(e) => setF({ ...f, free: e.target.value })} placeholder="never" /></td>
      <td><input className="narrow" type="number" min={0} value={f.lead} onChange={(e) => setF({ ...f, lead: e.target.value })} /></td>
      <td><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></td>
      <td><button onClick={() => m.mutate()} disabled={m.isPending}>Save</button>{m.error && <span className="err"> {(m.error as Error).message}</span>}</td>
    </tr>
  );
}

export function Suppliers() {
  const { data = [] } = useSuppliers();
  return (
    <>
      <h1>Suppliers</h1>
      <p className="lede">Order shipping is charged once per supplier and is free once the order reaches the threshold. Marketplaces usually charge shipping per listing instead; enter that on each quote.</p>
      <div className="scroll"><table className="entry">
        <thead><tr><th>Supplier</th><th>Type</th><th>Order shipping (Rp)</th><th>Free shipping over (Rp)</th><th>Lead (days)</th><th>Notes</th><th /></tr></thead>
        <tbody>{data.map((s) => <Row key={s.id} s={s} />)}</tbody>
      </table></div>
    </>
  );
}
