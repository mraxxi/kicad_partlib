import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CORE_SORT_KEYS, FAMILIES, familyById, resolveLayout, type Family, type Preset } from '../domain/specs';
import { api } from './api';
import { chainLabel } from './chain';
import { useLayouts } from './hooks';

/**
 * Per family: the importance order of its specs (the first one a part has is its Value, the next few are its Key
 * specs), how many Key specs show, and the sort presets. Saved to the database, so every machine sees the same.
 */
export function SpecLayouts() {
  const layouts = useLayouts().data;
  const qc = useQueryClient();
  const [familyId, setFamilyId] = useState(FAMILIES[0]!.id);
  const family = familyById(familyId) as Family;
  const [order, setOrder] = useState<string[]>([]);
  const [keyCount, setKeyCount] = useState(4);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const l = resolveLayout(family, layouts?.[family.id]);
    setOrder(l.order); setKeyCount(l.keyCount); setPresets(l.presets); setSaved(false);
  }, [family, layouts]);

  const save = useMutation({
    mutationFn: () => api(`/settings/speclayouts/${family.id}`, { method: 'PUT', body: { order, keyCount, presets } }),
    onSuccess: () => { setSaved(true); void qc.invalidateQueries({ queryKey: ['speclayouts'] }); },
  });
  const reset = useMutation({
    mutationFn: () => api(`/settings/speclayouts/${family.id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['speclayouts'] }),
  });

  const swap = <T,>(list: T[], i: number, d: -1 | 1): T[] => { const j = i + d; if (j < 0 || j >= list.length) return list; const n = [...list]; [n[i], n[j]] = [n[j]!, n[i]!]; return n; };
  const keys = [...family.props.map((p) => ({ key: p.key, label: p.label })), ...CORE_SORT_KEYS];
  const touch = () => setSaved(false);

  return (
    <>
      <h2>Spec layouts</h2>
      <p className="lede">What the Value and Key specs columns show for each kind of part, and the sort presets in the Sort chain menu. Saved for every machine you use.</p>
      <label className="mini-label" style={{ maxWidth: 260 }}>Kind of part
        <select value={familyId} onChange={(e) => setFamilyId(e.target.value)}>{FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>

      <h3>Importance order</h3>
      <p className="lede">The first spec a part has becomes its <b>Value</b>; the next {keyCount} are its <b>Key specs</b>. Reorder to change what matters first.</p>
      <ol className="order-list">
        {order.map((k, i) => (
          <li key={k}>
            <span className="grow">{family.props.find((p) => p.key === k)?.label ?? k}{i === 0 && <span className="est"> {'←'} Value</span>}</span>
            <button className="link" onClick={() => { setOrder(swap(order, i, -1)); touch(); }} aria-label="Move up">{'↑'}</button>
            <button className="link" onClick={() => { setOrder(swap(order, i, 1)); touch(); }} aria-label="Move down">{'↓'}</button>
          </li>))}
      </ol>
      <label className="mini-label" style={{ maxWidth: 200 }}>Key specs shown
        <input type="number" min={1} max={8} value={keyCount} onChange={(e) => { setKeyCount(Math.max(1, Math.min(8, Number(e.target.value) || 1))); touch(); }} /></label>

      <h3>Sort presets</h3>
      {presets.map((p, pi) => (
        <div key={pi} className="box">
          <div className="row"><input value={p.name} onChange={(e) => { setPresets(presets.map((x, j) => (j === pi ? { ...x, name: e.target.value } : x))); touch(); }} aria-label="Preset name" />
            <button className="link" onClick={() => { setPresets(presets.filter((_, j) => j !== pi)); touch(); }}>Delete preset</button></div>
          {p.chain.map((c, ci) => (
            <div key={ci} className="chain-row">
              <span className="num">{ci + 1}.</span>
              <select value={c.key} onChange={(e) => { setPresets(presets.map((x, j) => (j === pi ? { ...x, chain: x.chain.map((y, k) => (k === ci ? { ...y, key: e.target.value } : y)) } : x))); touch(); }}>
                {keys.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
              <button className="link" onClick={() => { setPresets(presets.map((x, j) => (j === pi ? { ...x, chain: x.chain.map((y, k) => (k === ci ? { ...y, dir: y.dir === 'asc' ? 'desc' : 'asc' } : y)) } : x))); touch(); }}>{c.dir === 'asc' ? 'low → high' : 'high → low'}</button>
              <button className="link" onClick={() => { setPresets(presets.map((x, j) => (j === pi ? { ...x, chain: swap(x.chain, ci, -1) } : x))); touch(); }} aria-label="Move up">{'↑'}</button>
              <button className="link" onClick={() => { setPresets(presets.map((x, j) => (j === pi ? { ...x, chain: swap(x.chain, ci, 1) } : x))); touch(); }} aria-label="Move down">{'↓'}</button>
              <button className="link" onClick={() => { setPresets(presets.map((x, j) => (j === pi ? { ...x, chain: x.chain.filter((_, k) => k !== ci) } : x)).filter((x) => x.chain.length > 0)); touch(); }} aria-label="Remove level">{'✕'}</button>
            </div>))}
          <button className="link" onClick={() => { setPresets(presets.map((x, j) => (j === pi ? { ...x, chain: [...x.chain, { key: family.order[0]!, dir: 'asc' }] } : x))); touch(); }}>+ add a level</button>
          <span className="est"> {p.chain.map((c) => chainLabel(family, c.key)).join(' → ')}</span>
        </div>))}
      <button className="secondary" onClick={() => { setPresets([...presets, { name: 'New preset', chain: [{ key: family.order[0]!, dir: 'asc' }] }]); touch(); }}>Add a preset</button>

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={() => save.mutate()} disabled={save.isPending}>Save {family.label.toLowerCase()} layout</button>
        <button className="secondary" onClick={() => reset.mutate()} disabled={reset.isPending}>Reset to built-in</button>
        {saved && <span className="ok-text">Saved.</span>}
        {(save.error || reset.error) && <span className="err">{((save.error ?? reset.error) as Error).message}</span>}
      </div>
    </>
  );
}
