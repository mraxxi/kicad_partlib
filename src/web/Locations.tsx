import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from './api';
import { num } from './format';
import { useLocations, useRefreshStock } from './hooks';

export function Locations() {
  const { data } = useLocations();
  const refresh = useRefreshStock();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { setMsg(null); void refresh(); },
    onError: (e: Error) => setMsg(e.message),
  });
  return (
    <>
      <h1>Locations</h1>
      <p className="lede">Drawers, bins and shelves. A location can only be deleted once nothing is stored in it.</p>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); run.mutate(async () => { await api('/locations', { body: { code, name } }); setCode(''); setName(''); }); }}>
        <label>Code<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A1" required /></label>
        <label className="grow">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Drawer A1, SMD resistors" /></label>
        <button type="submit">Add</button>
      </form>
      {msg && <div className="box bad">{msg}</div>}
      <div className="scroll"><table>
        <thead><tr><th>Code</th><th>Name</th><th className="num">Lots</th><th className="num">Units</th><th /></tr></thead>
        <tbody>{(data ?? []).map((l) => (
          <tr key={l.id}><td>{l.code}</td><td>{l.name}</td><td className="num">{l.lotCount}</td><td className="num">{num(l.units)}</td>
            <td><button className="link" onClick={() => run.mutate(() => api(`/locations/${l.id}`, { method: 'DELETE' }))}>Delete</button></td></tr>
        ))}</tbody>
      </table></div>
    </>
  );
}
