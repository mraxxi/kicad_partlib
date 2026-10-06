import { useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { CORE_SORT_KEYS, type Family, type Preset, type ResolvedLayout } from '../domain/specs';
import { chainLabel, chainToSorting, sortingToChain } from './chain';

interface Props {
  family: Family;
  layout: ResolvedLayout;
  sorting: SortingState;
  setSorting: (s: SortingState) => void;
  /** spec key -> how many different test conditions the visible rows carry (Rds(on) at 10 V vs 2.5 V). */
  conditions: Record<string, number>;
  onSavePreset: (name: string, chain: Preset['chain']) => void;
  onDeletePreset: (name: string) => void;
  onResetPresets: () => void;
  busy: boolean;
  error: string | null;
}

/**
 * The sort chain: first by this, then by that. It edits the table's own sorting, so a header click and this panel are
 * the same thing. Presets are built in per family and the owner's changes are saved (shared across machines).
 */
export function SortChain({ family, layout, sorting, setSorting, conditions, onSavePreset, onDeletePreset, onResetPresets, busy, error }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const chain = sortingToChain(family, sorting);
  const used = new Set(chain.map((c) => c.key));
  const options = [...family.props.map((p) => ({ key: p.key, label: p.label })), ...CORE_SORT_KEYS].filter((o) => !used.has(o.key));
  const apply = (next: typeof chain) => setSorting(chainToSorting(family, next));
  const move = (i: number, d: -1 | 1) => { const n = [...chain]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; apply(n); };

  return (
    <div className="chooser-wrap">
      <button className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>Sort chain{chain.length ? ` (${chain.length})` : ''}</button>
      {open && (
        <div className="chooser wide-pop" role="dialog" aria-label="Sort chain">
          <p className="lede" style={{ margin: '0 0 6px' }}>Sort {family.label.toLowerCase()}s by the first, then break ties with the next. Header clicks edit the same chain (Shift-click adds a level).</p>
          {chain.length === 0 && <p className="lede">No chain yet. Pick a preset or add a level.</p>}
          {chain.map((c, i) => (
            <div key={c.key} className="chain-row">
              <span className="num">{i + 1}.</span>
              <span className="grow">{chainLabel(family, c.key)}
                {(conditions[c.key] ?? 0) > 1 && <span className="est" title="These values were measured under different conditions; the condition is shown next to each value."> · {conditions[c.key]} test conditions</span>}
              </span>
              <button className="link" onClick={() => apply(chain.map((x, j) => (j === i ? { ...x, dir: x.dir === 'asc' ? 'desc' : 'asc' } : x)))} aria-label="Flip direction">{c.dir === 'asc' ? 'low → high' : 'high → low'}</button>
              <button className="link" onClick={() => move(i, -1)} aria-label="Move up">{'↑'}</button>
              <button className="link" onClick={() => move(i, 1)} aria-label="Move down">{'↓'}</button>
              <button className="link" onClick={() => apply(chain.filter((_, j) => j !== i))} aria-label="Remove">{'✕'}</button>
            </div>
          ))}
          {options.length > 0 && (
            <label className="mini-label">Add a level
              <select value="" onChange={(e) => { if (e.target.value) apply([...chain, { key: e.target.value, dir: 'asc' }]); }}>
                <option value="">choose a spec&hellip;</option>{options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>)}
          <h4>Presets</h4>
          {layout.presets.map((p) => (
            <div key={p.name} className="chain-row">
              <button className="link grow left" onClick={() => setSorting(chainToSorting(family, p.chain))}>{p.name}</button>
              <span className="est">{p.chain.map((c) => chainLabel(family, c.key)).join(' → ')}</span>
              <button className="link" onClick={() => onDeletePreset(p.name)} aria-label={`Delete preset ${p.name}`}>{'✕'}</button>
            </div>))}
          <form className="inline" onSubmit={(e) => { e.preventDefault(); if (name.trim() && chain.length) { onSavePreset(name.trim(), chain); setName(''); } }}>
            <label className="grow mini-label">Save the current chain as
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="preset name" /></label>
            <button type="submit" disabled={busy || !name.trim() || chain.length === 0}>Save</button>
          </form>
          <button className="link" onClick={onResetPresets} disabled={busy}>Reset presets to built-in</button>
          {error && <p className="err">{error}</p>}
        </div>)}
    </div>
  );
}
