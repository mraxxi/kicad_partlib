import { useEffect, useRef, useState } from 'react';
import type { FacetOption, FacetSource } from '../domain/specs';

export interface Facet<T> { src: FacetSource<T>; options: FacetOption[]; selected: readonly string[] }

/**
 * One button per filterable field (Footprint, then the family's specs), each opening a checklist of the values that
 * occur with counts. Counts already reflect the other filters (see facetOptions), so ticking Footprint = 0805 turns
 * the Capacitance list into "what I have in 0805". Pure presentation: state lives in the URL, owned by Parts.
 */
export function SpecFilters<T>({ facets, onChange }: { facets: Facet<T>[]; onChange: (id: string, keys: string[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => { setFind(''); }, [open]);

  return (
    <div className="facets" ref={wrap} role="group" aria-label="Filter by spec">
      <span className="facets-title">Filter</span>
      {facets.map(({ src, options, selected }) => {
        const shown = find ? options.filter((o) => o.label.toLowerCase().includes(find.toLowerCase())) : options;
        const toggle = (key: string, on: boolean) => onChange(src.id, on ? [...selected, key] : selected.filter((k) => k !== key));
        return (
          <div key={src.id} className="facet">
            <button className={selected.length ? 'secondary on' : 'secondary'} aria-expanded={open === src.id} onClick={() => setOpen(open === src.id ? null : src.id)}>
              {src.label}{selected.length ? ` (${selected.length})` : ''} {'▾'}
            </button>
            {open === src.id && (
              <div className="facet-pop" role="dialog" aria-label={`${src.label} values`}>
                {options.length > 12 && <input className="facet-find" autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find…" />}
                <ul>
                  {shown.map((o) => (
                    <li key={o.key}>
                      <label><input type="checkbox" checked={selected.includes(o.key)} onChange={(e) => toggle(o.key, e.target.checked)} /> <span className="facet-label">{o.label}</span> <span className="facet-count">{o.count}</span></label>
                    </li>))}
                  {shown.length === 0 && <li className="facet-empty">No values.</li>}
                </ul>
                {selected.length > 0 && <button className="link" onClick={() => onChange(src.id, [])}>Clear {src.label}</button>}
              </div>)}
          </div>);
      })}
    </div>
  );
}
