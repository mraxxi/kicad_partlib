import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable,
  type ColumnOrderState, type ColumnSizingState, type SortingState, type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CONDITION_LABEL, SOURCE_LABEL, STATUS_LABEL, parsePartCode, type PartSummary } from '../domain/stock';
import { valueSortKey } from '../domain/normalize';
import { idr } from './format';
import { useCategories, useLocations, useParts } from './hooks';
import { PartDetail } from './PartDetail';
import { usePrefs } from './prefs';
import { setParams, useRoute } from './route';

// ---------------------------------------------------------------------------
// Columns. Data, not markup: the chooser, the saved layout and the table all
// read this list. Saved layout is keyed by column ID, never by position, so
// adding a column later cannot shift someone's saved widths onto the wrong one.
// ---------------------------------------------------------------------------
const col = createColumnHelper<PartSummary>();
const columns = [
  col.accessor('code', { id: 'code', header: 'Part', size: 78, minSize: 60, meta: { pin: true, label: 'Part code' },
    cell: (c) => <a href={`#/parts/${c.row.original.id}`} tabIndex={-1}>{c.getValue()}</a> }),
  col.accessor('mpn', { id: 'mpn', header: 'MPN', size: 190, minSize: 90, meta: { pin: true, label: 'MPN' } }),
  // The accessor is the SORT KEY (unit, then magnitude: 10nF < 100nF < 1uF, which text order gets wrong);
  // the cell still shows the part's own text. Unparseable values sort last.
  col.accessor((p) => valueSortKey(p.value) ?? undefined, { id: 'value', header: 'Value', size: 96, minSize: 60, meta: { label: 'Value (10kΩ, 100nF…)' },
    sortUndefined: 'last', cell: (c) => <b>{c.row.original.value}</b> }),
  col.accessor('package', { id: 'package', header: 'Footprint', size: 128, minSize: 70, meta: { label: 'Footprint (package)' } }),
  col.accessor((p) => p.lcscCode ?? '', { id: 'lcsc', header: 'LCSC #', size: 108, minSize: 70, meta: { label: 'LCSC part number' } }),
  col.accessor((p) => p.category ?? '', { id: 'category', header: 'Category', size: 160, minSize: 80, meta: { label: 'Category' } }),
  col.accessor('manufacturer', { id: 'manufacturer', header: 'Manufacturer', size: 150, minSize: 80, meta: { label: 'Manufacturer' } }),
  col.accessor('description', { id: 'description', header: 'Description', size: 340, minSize: 120, meta: { label: 'Description' } }),
  col.accessor('lotCount', { id: 'lots', header: 'Lots', size: 56, minSize: 44, meta: { num: true, label: 'Lots' } }),
  col.accessor('usableQty', { id: 'usable', header: 'Usable', size: 72, minSize: 50, meta: { num: true, label: 'Usable stock' } }),
  col.accessor('totalQty', { id: 'total', header: 'Total', size: 66, minSize: 50, meta: { num: true, label: 'Total on hand' } }),
  col.accessor((p) => p.minQty ?? -1, { id: 'min', header: 'Min', size: 60, minSize: 44, meta: { num: true, label: 'Minimum stock' }, cell: (c) => (c.getValue() < 0 ? '–' : c.getValue()) }),
  col.accessor('status', { id: 'status', header: 'Stock', size: 86, minSize: 60, meta: { label: 'Stock status' },
    cell: (c) => <span className={`chip st-${c.getValue()}`}>{STATUS_LABEL[c.getValue()]}</span> }),
  col.accessor((p) => p.locations.join(', '), { id: 'locations', header: 'Location', size: 110, minSize: 60, meta: { label: 'Location' } }),
  col.accessor((p) => p.valueRealIdr + p.valueEstimatedIdr, { id: 'worth', header: 'Worth', size: 120, minSize: 80, meta: { num: true, label: 'Worth (Rp)' },
    cell: (c) => <>{idr(c.getValue())}{c.row.original.valueEstimatedIdr > 0 && <span className="est" title="includes an estimate for salvaged lots"> ~</span>}</> }),
];
const PINNED = ['code', 'mpn'];
const DEFAULT_ORDER = columns.map((c) => c.id as string);
const DEFAULT_VISIBLE: VisibilityState = Object.fromEntries(DEFAULT_ORDER.map((id) => [id, !['manufacturer', 'lots', 'total', 'min'].includes(id)]));
const LAYOUT_KEY = 'partlib.layout.parts.v1';
type Meta = { num?: boolean; pin?: boolean; label?: string };
const metaOf = (c: { columnDef: { meta?: unknown } }) => (c.columnDef.meta ?? {}) as Meta;

interface Layout { visibility: VisibilityState; order: ColumnOrderState; sizing: ColumnSizingState }
function loadLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<Layout>;
    const known = new Set(DEFAULT_ORDER);
    const saved = (v.order ?? []).filter((id) => known.has(id));
    // Columns added since the layout was saved are appended; pinned ones always lead.
    const order = [...PINNED, ...saved.filter((id) => !PINNED.includes(id)), ...DEFAULT_ORDER.filter((id) => !saved.includes(id) && !PINNED.includes(id))];
    return { visibility: { ...DEFAULT_VISIBLE, ...(v.visibility ?? {}) }, order, sizing: v.sizing ?? {} };
  } catch { return { visibility: DEFAULT_VISIBLE, order: DEFAULT_ORDER, sizing: {} }; }
}

function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => { const mq = window.matchMedia(query); const on = () => setM(mq.matches); mq.addEventListener('change', on); on(); return () => mq.removeEventListener('change', on); }, [query]);
  return m;
}

const FILTERS = [
  { key: 'cat', label: 'Category' }, { key: 'src', label: 'Source' }, { key: 'cond', label: 'Condition' },
  { key: 'loc', label: 'Location' }, { key: 'st', label: 'Stock' },
] as const;

export function Parts() {
  const { data, error, isFetching, refetch } = useParts();
  const cats = useCategories().data ?? [];
  const locs = useLocations().data ?? [];
  const prefs = usePrefs();
  const wide = useMedia('(min-width: 1400px)');
  const { path, params } = useRoute();
  const viewport = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  // ---- filters live in the URL ----
  const f = { q: params.get('q') ?? '', review: params.get('review') === '1', cat: params.get('cat') ?? '', src: params.get('src') ?? '', cond: params.get('cond') ?? '', loc: params.get('loc') ?? '', st: params.get('st') ?? '' };
  const sel = Number(params.get('sel')) || null;
  const queryString = params.toString();
  // Remember the view as it is now (however you arrived at it), for the "back to all parts" link.
  // Only while we are actually on /parts: as you leave, this component briefly sees the NEXT page's (empty) query.
  useEffect(() => { if (path !== '/parts') return; try { sessionStorage.setItem('partlib.partsQuery', queryString); } catch { /* ignore */ } }, [queryString, path]);
  const [q, setQ] = useState(f.q);
  useEffect(() => { setQ(f.q); }, [f.q]);
  useEffect(() => { const t = setTimeout(() => { if (q !== f.q) setParams({ q }); }, 200); return () => clearTimeout(t); }, [q, f.q]);
  const query = useDeferredValue(f.q);

  // ---- saved layout ----
  const initial = useMemo(loadLayout, []);
  const [visibility, setVisibility] = useState(initial.visibility);
  const [order, setOrder] = useState(initial.order);
  const [sizing, setSizing] = useState(initial.sizing);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'code', desc: false }]);
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ visibility, order, sizing })); } catch { /* not saved */ } }, 300);
    return () => clearTimeout(t);
  }, [visibility, order, sizing]);

  // Search text built once per load: filtering runs on every keystroke.
  const indexed = useMemo(
    () => (data ?? []).map((p) => ({ p, blob: `${p.code} ${p.mpn} ${p.manufacturer} ${p.description} ${p.lcscCode ?? ''} ${p.package} ${p.value}`.toLowerCase() })),
    [data],
  );
  const rows = useMemo(() => {
    const t = query.trim().toLowerCase();
    const codeId = parsePartCode(t);
    return indexed
      .filter(({ p, blob }) =>
        (!t || blob.includes(t) || p.id === codeId) &&
        (!f.review || p.needsReview) &&
        (!f.cat || p.category === f.cat) && (!f.src || (p.sources as string[]).includes(f.src)) &&
        (!f.cond || (p.conditions as string[]).includes(f.cond)) && (!f.loc || p.locations.includes(f.loc)) && (!f.st || p.status === f.st))
      .map(({ p }) => p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexed, query, f.review, f.cat, f.src, f.cond, f.loc, f.st]);

  const table = useReactTable({
    data: rows, columns,
    state: { sorting, columnVisibility: visibility, columnOrder: order, columnSizing: sizing },
    onSortingChange: setSorting, onColumnVisibilityChange: setVisibility, onColumnOrderChange: setOrder, onColumnSizingChange: setSizing,
    columnResizeMode: 'onChange', enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    // Numeric columns default to descending on first click; people expect ascending first.
    defaultColumn: { sortDescFirst: false, sortUndefined: 'last' },
  });
  const valueSorted = table.getRowModel().rows;

  // On a wide screen the Description column soaks up the spare width, so the table fills the window
  // instead of ending in a blank strip; on a narrow one the table scrolls sideways inside its own box.
  const [vw, setVw] = useState(0);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setVw(el.clientWidth);
    measure(); // not only on resize: some environments never deliver the first observer callback
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  // The vertical scrollbar appears once rows load and narrows the box; re-measure after every render (a no-op when unchanged).
  useLayoutEffect(() => { if (viewport.current && viewport.current.clientWidth !== vw) setVw(viewport.current.clientWidth); });
  const visibleCols = table.getVisibleLeafColumns();
  const extra = Math.max(0, vw - table.getTotalSize() - 2);
  const flexId = visibleCols.some((c) => c.id === 'description') ? 'description' : visibleCols[visibleCols.length - 1]?.id;
  const widthOf = (c: { id: string; getSize: () => number }) => c.getSize() + (c.id === flexId ? extra : 0);
  const pinLeft = useMemo(() => {
    const m = new Map<string, number>();
    let x = 0;
    for (const c of visibleCols) { if (metaOf(c).pin) { m.set(c.id, x); x += c.getSize(); } }
    return m;
  }, [visibleCols, sizing]);

  const rowH = prefs.density === 'compact' ? 30 : 40;
  const virt = useVirtualizer({ count: valueSorted.length, getScrollElement: () => viewport.current, estimateSize: () => rowH, overscan: 14 });
  useEffect(() => { virt.measure(); }, [rowH]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = virt.getVirtualItems();
  const padTop = items.length ? items[0]!.start : 0;
  const padBottom = items.length ? virt.getTotalSize() - items[items.length - 1]!.end : 0;

  // Come back to where you were after opening a part.
  useEffect(() => {
    const y = Number(sessionStorage.getItem('partlib.partsScroll')) || 0;
    if (y && viewport.current) viewport.current.scrollTop = y;
    const el = viewport.current;
    return () => { try { sessionStorage.setItem('partlib.partsScroll', String(el?.scrollTop ?? 0)); } catch { /* ignore */ } };
  }, [data ? 1 : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const panelOpen = wide && prefs.sidePanel && sel !== null;
  const open = useCallback((id: number) => {
    if (wide && prefs.sidePanel) setParams({ sel: String(id) }); else location.hash = `#/parts/${id}`;
  }, [wide, prefs.sidePanel]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== 'Escape') return;
    const idx = valueSorted.findIndex((r) => r.original.id === sel);
    if (e.key === 'Escape') { setParams({ sel: null }); return; }
    if (e.key === 'Enter') { if (sel !== null) location.hash = `#/parts/${sel}`; return; }
    e.preventDefault();
    const next = Math.min(valueSorted.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)));
    const row = valueSorted[next];
    if (!row) return;
    setParams({ sel: String(row.original.id) });
    virt.scrollToIndex(next, { align: 'auto' });
  };
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) { e.preventDefault(); searchBox.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const active = FILTERS.filter((x) => f[x.key]);
  // Offered only while something is flagged (or the filter is already on, so it can always be switched off).
  const reviewCount = useMemo(() => (data ?? []).filter((p) => p.needsReview).length, [data]);
  const options: Record<string, Array<[string, string]>> = {
    cat: cats.map((c) => [c.name, c.name]), src: Object.entries(SOURCE_LABEL), cond: Object.entries(CONDITION_LABEL),
    loc: locs.map((l) => [l.code, l.code]), st: Object.entries(STATUS_LABEL),
  };
  const [chooser, setChooser] = useState(false);
  const move = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id), j = i + dir;
    if (i < 0 || j < PINNED.length || j >= order.length) return;
    const next = [...order]; [next[i], next[j]] = [next[j]!, next[i]!]; setOrder(next);
  };

  if (error) return <div className="box bad">{(error as Error).message}</div>;
  return (
    <div className="workspace">
      <div className="toolbar">
        <h1>Parts</h1>
        <label className="search"><span className="sr">Search</span>
          <input ref={searchBox} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search value, footprint, MPN, C-number…  ( / )" /></label>
        {FILTERS.map(({ key, label }) => (
          <label key={key} className="mini-label">{label}
            <select value={f[key]} onChange={(e) => setParams({ [key]: e.target.value })}>
              <option value="">All</option>{options[key]!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>))}
        {(reviewCount > 0 || f.review) && (
          <button className={f.review ? 'toggle on' : 'toggle'} aria-pressed={f.review} onClick={() => setParams({ review: f.review ? null : '1' })}>
            Needs review ({reviewCount})
          </button>)}
        <div className="chooser-wrap">
          <button className="secondary" onClick={() => setChooser(!chooser)} aria-expanded={chooser}>Columns</button>
          {chooser && (
            <div className="chooser" role="dialog" aria-label="Choose columns">
              {order.map((id) => {
                const c = table.getColumn(id)!;
                const pinned = PINNED.includes(id);
                return (
                  <div key={id} className="chooser-row">
                    <label><input type="checkbox" checked={c.getIsVisible()} disabled={pinned} onChange={(e) => c.toggleVisibility(e.target.checked)} /> {metaOf(c).label ?? id}</label>
                    {!pinned && <span><button className="link" aria-label="Move left" onClick={() => move(id, -1)}>↑</button><button className="link" aria-label="Move right" onClick={() => move(id, 1)}>↓</button></span>}
                  </div>);
              })}
              <button className="link" onClick={() => { setVisibility(DEFAULT_VISIBLE); setOrder(DEFAULT_ORDER); setSizing({}); }}>Reset to default</button>
            </div>)}
        </div>
      </div>
      <div className="statusline">
        <span>{rows.length.toLocaleString('id-ID')} of {(data?.length ?? 0).toLocaleString('id-ID')} parts{isFetching ? ' · refreshing…' : ''}</span>
        {f.review && <button className="chip removable" onClick={() => setParams({ review: null })}>Needs review ×</button>}
        {active.map((x) => <button key={x.key} className="chip removable" onClick={() => setParams({ [x.key]: null })}>{x.label}: {f[x.key]} ×</button>)}
        {(active.length > 0 || f.q || f.review) && <button className="link" onClick={() => { setQ(''); setParams({ q: null, review: null, cat: null, src: null, cond: null, loc: null, st: null }); }}>Clear all</button>}
        <button className="link" onClick={() => void refetch()}>Refresh</button>
      </div>
      <div className="split">
        <div className="viewport" ref={viewport} tabIndex={0} onKeyDown={onKey} aria-label="Parts table">
          <table className="vt" style={{ width: table.getTotalSize() + extra, ['--row-h' as string]: `${rowH}px` }}>
            <colgroup>{visibleCols.map((c) => <col key={c.id} style={{ width: widthOf(c) }} />)}</colgroup>
            <thead>{table.getHeaderGroups().map((g) => (
              <tr key={g.id}>{g.headers.map((h) => {
                const pin = pinLeft.get(h.column.id);
                return (
                  <th key={h.id} className={`${metaOf(h.column).num ? 'num ' : ''}${pin !== undefined ? 'pinned' : ''}`} style={pin !== undefined ? { left: pin } : undefined}
                    onClick={h.column.getToggleSortingHandler()} aria-sort={h.column.getIsSorted() === 'asc' ? 'ascending' : h.column.getIsSorted() === 'desc' ? 'descending' : 'none'}>
                    <span className="th-label">{flexRender(h.column.columnDef.header, h.getContext())}{{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}</span>
                    <span className="resizer" onClick={(e) => e.stopPropagation()} onMouseDown={h.getResizeHandler()} onTouchStart={h.getResizeHandler()} onDoubleClick={() => h.column.resetSize()} />
                  </th>);
              })}</tr>))}</thead>
            <tbody>
              {padTop > 0 && <tr style={{ height: padTop }}><td colSpan={visibleCols.length} /></tr>}
              {items.map((v) => {
                const r = valueSorted[v.index]!;
                return (
                  <tr key={r.id} className={`${r.original.id === sel ? 'sel' : ''}${r.original.needsReview ? ' review-row' : ''}`} onClick={() => open(r.original.id)} onDoubleClick={() => (location.hash = `#/parts/${r.original.id}`)}>
                    {r.getVisibleCells().map((c) => {
                      const pin = pinLeft.get(c.column.id);
                      const text = c.column.id === 'description' ? r.original.description : undefined;
                      return <td key={c.id} title={text} className={`${metaOf(c.column).num ? 'num ' : ''}${pin !== undefined ? 'pinned' : ''}`} style={pin !== undefined ? { left: pin } : undefined}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>;
                    })}
                  </tr>);
              })}
              {padBottom > 0 && <tr style={{ height: padBottom }}><td colSpan={visibleCols.length} /></tr>}
            </tbody>
          </table>
          {rows.length === 0 && <p className="lede empty">{data ? 'No parts match these filters.' : 'Loading…'}</p>}
        </div>
        {panelOpen && (
          <aside className="panel" aria-label="Part details">
            <div className="panel-bar"><a href={`#/parts/${sel}`}>Open full page ↗</a><button className="link" onClick={() => setParams({ sel: null })}>Close ✕</button></div>
            <PartDetail key={sel} id={sel!} embedded />
          </aside>)}
      </div>
    </div>
  );
}
