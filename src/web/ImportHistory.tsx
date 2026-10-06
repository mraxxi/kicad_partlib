import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api';
import { Refusal } from './Refusal';
import { useImports, useRefreshImports } from './hooks';
import { when } from './format';

/** The name is display only; the real order number (or the file's SHA-256) is what detects a re-import. */
function NameCell({ path, label, alias, rev }: { path: string; label: string; alias: string | null; rev: number }) {
  const refresh = useRefreshImports();
  const [text, setText] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api(path, { method: 'PATCH', body: { alias: text ?? '', rev } }),
    onSuccess: () => { setText(null); void refresh(); },
  });
  if (text === null) return <td>{label} <button className="link" onClick={() => setText(alias ?? '')}>Rename</button></td>;
  return (
    <td>
      <form className="row" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <input value={text} autoFocus maxLength={60} onChange={(e) => setText(e.target.value)} placeholder={`${label} (leave empty for the default)`} />
        <button type="submit" disabled={save.isPending}>Save</button>
        <button type="button" className="link" onClick={() => setText(null)}>Cancel</button>
      </form>
      <Refusal error={save.error ? (save.error as Error).message : undefined} />
    </td>
  );
}

/** Orders and carts already imported, by readable name, with a rename. */
export function ImportHistory() {
  const { data, error } = useImports();
  if (error) return <Refusal error={(error as Error).message} />;
  if (!data) return null;
  return (
    <>
      <h2>Orders imported</h2>
      {data.orders.length === 0 ? <p className="lede">No order has been imported yet.</p> : (
        <div className="scroll"><table>
          <thead><tr><th>Name</th><th>LCSC order number</th><th>Order date</th><th className="num">Lines</th></tr></thead>
          <tbody>{data.orders.map((o) => (
            <tr key={o.id}><NameCell path={`/orders/${o.id}`} label={o.label} alias={o.alias} rev={o.rev} /><td>{o.orderNo}</td><td>{o.orderDate}</td><td className="num">{o.lines}</td></tr>))}</tbody></table></div>)}
      <h2>Carts imported</h2>
      {data.carts.length === 0 ? <p className="lede">No cart has been imported yet.</p> : (
        <div className="scroll"><table>
          <thead><tr><th>Name</th><th>File</th><th>Imported</th><th className="num">Lines</th></tr></thead>
          <tbody>{data.carts.map((k) => (
            <tr key={k.id}><NameCell path={`/imports/${k.id}`} label={k.label} alias={k.alias} rev={k.rev} /><td>{k.filename}</td><td>{when(k.at)}</td><td className="num">{k.rowsIn}</td></tr>))}</tbody></table></div>)}
    </>
  );
}
