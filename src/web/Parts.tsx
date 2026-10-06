import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable,
  type ColumnDef, type ColumnOrderState, type ColumnSizingState, type SortingState, type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CONDITION_LABEL, SOURCE_LABEL, STATUS_LABEL, parsePartCode, type PartSummary } from '../domain/stock';
import { familyById, detectFamily, formatSpec, resolveLayout, specSortValue, summarize, type Family, type ResolvedLayout, type Summary } from '../domain/specs';
import { valueSortKey } from '../domain/normalize';
import { api } from './api';
import { specColumnId } from './chain';
import { idr } from './format';
import { useCategories, useLayouts, useLocations, useParts } from './hooks';
import { PartDetail } from './PartDetail';
import { usePrefs } from './prefs';
import { setParams, useRoute } from './route';
import { SortChain } from './SortChain';
import { Segments } from './SpecCells';

// ---------------------------------------------------------------------------
// Columns. Data, not markup: the chooser, the saved layout and the table all read this list. Saved layout is keyed
// by column ID, never by position. Spec columns exist only while every visible row is the same family (voltage
// means different things for a MOSFET and a regulator), and are keyed `spec:<family>:<key>`.
// ---------------------------------------------------------------------------
const col = createColumnHelper<PartSummary>();
type Meta = { num?: boolean; pin?: boolean; label?: string; spec?: boolean };
const metaOf = (c: { columnDef: { meta?: unknown } }) => (c.columnDef.meta ?? {}) as Meta;
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** What every row shows without spec knowledge: its summary (Value, Key specs) from stored specs, memoised per load. */
function useSummaries(parts: PartSummary[] | undefined, layouts: Record<string, import('../domain/specs').LayoutOverride> | undefined) {
  return useMemo(() => {
    const map = new Map<number, { family: Family | null; summary: Summary }>();
    for (const p of parts ?? []) {
      const family = p.specs?.family ? familyById(p.specs.family) ?? null : null;
      const layout: ResolvedLayout | null = family ? resolveLayout(family, layouts?.[family.id]) : null;
      map.set(p.id, { family, summary: summarize(p.specs, layout) });
    }
    return map;
  }, [parts, layouts]);
}

const BASE_ORDER = ['code', 'mpn', 'value', 'keyspecs', 'package', 'lcsc', 'category', 'manufacturer', 'description', 'lots', 'usable', 'total', 'min', 'status', 'locations', 'worth'];
const PINNED = ['code', 'mpn'];
const DEFAULT_HIDDEN = ['manufacturer', 'lots', 'total', 'min'];
const LAYOUT_KEY = 'partlib.layout.parts.v2';

interface Layout { visibility: VisibilityState; order: ColumnOrderState; sizing: ColumnSizingState }
function loadLayout(): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<Layout>;
    const saved = (v.order ?? []).filter((id) => BASE_ORDER.includes(id) || id.startsWith('spec:'));
    const order = [...PINNED, ...saved.filter((id) => !PINNED.includes(id)), ...BASE_ORDER.filter((id) => !saved.includes(id) && !PINNED.includes(id))];
    return { visibility: { ...Object.fromEntries(DEFAULT_HIDDEN.map((id) => [id, false])), ...(v.visibility ?? {}) }, order, sizing: v.sizing ?? {} };
  } catch { return { visibility: Object.fromEntries(DEFAULT_HIDDEN.map((id) => [id, false])), order: BASE_ORDER, sizing: {} }; }
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
  const layouts = useLayouts().data;
  const qc = useQueryClient();
  const prefs = usePrefs();
  const wide = useMedia('(min-width: 1400px)');
  const { path, params } = useRoute();
  const viewport = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const info = useSummaries(data, layouts);

  // ---- filters live in the URL ----
  const f = { q: params.get('q') ?? '', review: params.get('review') === '1', fam: params.get('fam') ?? '', cat: params.get('cat') ?? '', src: params.get('src') ?? '', cond: params.get('cond') ?? '', loc: params.get('loc') ?? '', st: params.get('st') ?? '' };
  const sel = Number(params.get('sel')) || null;
  const queryString = params.toString();
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
    () => (data ?? []).map((p) => ({ p, blob: `${p.code} ${p.mpn} ${p.manufacturer} ${p.description} ${p.lcscCode ?? ''} ${p.package} ${p.value} ${info.get(p.id)?.summary.all.map((s) => s.text).join(' ') ?? ''}`.toLowerCase() })),
    [data, info],
  );
  const rows = useMemo(() => {
    const t = query.trim().toLowerCase();
    const codeId = parsePartCode(t);
    return indexed
      .filter(({ p, blob }) =>
        (!t || blob.includes(t) || p.id === codeId) &&
        (!f.review || p.needsReview) &&
        (!f.fam || p.specs?.family === f.fam) &&
        (!f.cat || p.category === f.cat) && (!f.src || (p.sources as string[]).includes(f.src)) &&
        (!f.cond || (p.conditions as string[]).includes(f.cond)) && (!f.loc || p.locations.includes(f.loc)) && (!f.st || p.status === f.st))
      .map(({ p }) => p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexed, query, f.review, f.fam, f.cat, f.src, f.cond, f.loc, f.st]);

  // ---- which family are we looking at? Spec sorting only makes sense for one (voltage differs between families). ----
  const familiesHere = useMemo(() => {
    const ids = new Map<string, number>();
    for (const p of rows) { const fam = p.specs?.family || detectFamily(undefined, undefined, p.category)?.id; if (fam) ids.set(fam, (ids.get(fam) ?? 0) + 1); }
    return ids;
  }, [rows]);
  const loneFamily = useMemo(() => {
    // One family among rows that have any family at all, and no row of another kind hiding in the list.
    const unknown = rows.filter((p) => !(p.specs?.family || detectFamily(undefined, undefined, p.category))).length;
    return familiesHere.size === 1 && unknown === 0 ? familyById([...familiesHere.keys()][0]!) ?? null : null;
  }, [familiesHere, rows]);
  const layout = useMemo(() => (loneFamily ? resolveLayout(loneFamily, layouts?.[loneFamily.id]) : null), [loneFamily, layouts]);

  // The chain's highlight: spec key -> position in the chain (0 = primary).
  const hl = useMemo(() => {
    const m = new Map<string, number>();
    if (!loneFamily) return m;
    const prefix = `spec:${loneFamily.id}:`;
    sorting.forEach((s, i) => { if (s.id.startsWith(prefix)) m.set(s.id.slice(prefix.length), i); });
    // Sorting by Value highlights whichever spec is currently #0 for each row.
    return m;
  }, [sorting, loneFamily]);
  const sortedByValue = sorting.some((s) => s.id === 'value');

  const columns = useMemo<ColumnDef<PartSummary, any>[]>(() => {
    const base: ColumnDef<PartSummary, any>[] = [
      col.accessor('code', { id: 'code', header: 'Part', size: 78, minSize: 60, meta: { pin: true, label: 'Part code' as const } as Meta,
        cell: (c) => <a href={`#/parts/${c.row.original.id}`} tabIndex={-1}>{c.getValue()}</a> }),
      col.accessor('mpn', { id: 'mpn', header: 'MPN', size: 190, minSize: 90, meta: { pin: true, label: 'MPN' } as Meta }),
      // Value = spec #0 (the first available spec in importance order), else the plain text it always had.
      col.display({ id: 'value', header: 'Value', size: 130, minSize: 60, meta: { label: 'Value (spec #0)' } as Meta,
        sortingFn: (a, b) => {
          const pa = a.original, pb = b.original;
          const ca = pa.category ?? '', cb = pb.category ?? '';
          if (ca !== cb) return ca < cb ? -1 : 1; // a mixed list groups by category first: 30 V and 10 kΩ are not comparable
          const key = (p: PartSummary) => { const i = info.get(p.id); const k = i?.summary.value?.key; return i?.family && k && k !== 'title' ? specSortValue(i.family, p.specs, k) : valueSortKey(p.value) ?? undefined; };
          const ka = key(pa), kb = key(pb);
          if (ka === undefined && kb === undefined) return 0;
          if (ka === undefined) return 1;
          if (kb === undefined) return -1;
          return typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
        },
        cell: (c) => {
          const p = c.row.original; const seg = info.get(p.id)?.summary.value;
          if (!seg) return <b>{p.value}</b>;
          return <b className={sortedByValue ? 'hl hl0' : undefined} title={seg.label}>{seg.text}</b>;
        } }),
      col.display({ id: 'keyspecs', header: 'Key specs', size: 300, minSize: 100, enableSorting: false, meta: { label: 'Key specs' } as Meta,
        cell: (c) => {
          const s = info.get(c.row.original.id)?.summary;
          return s && s.keys.length ? <Segments segments={s.keys} hl={hl} /> : null;
        } }),
      col.accessor('package', { id: 'package', header: 'Footprint', size: 128, minSize: 70, sortingFn: (a, b) => natural.compare(a.original.package, b.original.package), meta: { label: 'Footprint (package)' } as Meta }),
      col.accessor((p) => p.lcscCode ?? '', { id: 'lcsc', header: 'LCSC #', size: 108, minSize: 70, meta: { label: 'LCSC part number' } as Meta }),
      col.accessor((p) => p.category ?? '', { id: 'category', header: 'Category', size: 160, minSize: 80, meta: { label: 'Category' } as Meta }),
      col.accessor('manufacturer', { id: 'manufacturer', header: 'Manufacturer', size: 150, minSize: 80, meta: { label: 'Manufacturer' } as Meta }),
      col.accessor('description', { id: 'description', header: 'Description', size: 340, minSize: 120, meta: { label: 'Description' } as Meta }),
      col.accessor('lotCount', { id: 'lots', header: 'Lots', size: 56, minSize: 44, meta: { num: true, label: 'Lots' } as Meta }),
      col.accessor('usableQty', { id: 'usable', header: 'Usable', size: 72, minSize: 50, meta: { num: true, label: 'Usable stock' } as Meta }),
      col.accessor('totalQty', { id: 'total', header: 'Total', size: 66, minSize: 50, meta: { num: true, label: 'Total on hand' } as Meta }),
      col.accessor((p) => p.minQty ?? -1, { id: 'min', header: 'Min', size: 60, minSize: 44, meta: { num: true, label: 'Minimum stock' } as Meta, cell: (c) => (c.getValue() < 0 ? '–' : c.getValue()) }),
      col.accessor('status', { id: 'status', header: 'Stock', size: 86, minSize: 60, meta: { label: 'Stock status' } as Meta,
        cell: (c) => <span className={`chip st-${c.getValue()}`}>{STATUS_LABEL[c.getValue() as keyof typeof STATUS_LABEL]}</span> }),
      col.accessor((p) => p.locations.join(', '), { id: 'locations', header: 'Location', size: 110, minSize: 60, meta: { label: 'Location' } as Meta }),
      col.accessor((p) => p.valueRealIdr + p.valueEstimatedIdr, { id: 'worth', header: 'Worth', size: 120, minSize: 80, meta: { num: true, label: 'Worth (Rp)' } as Meta,
        cell: (c) => <>{idr(c.getValue())}{c.row.original.valueEstimatedIdr > 0 && <span className="est" title="includes an estimate for salvaged lots"> ~</span>}</> }),
    ];
    if (!loneFamily) return base;
    // One column per spec of the family. Hidden until the owner turns them on, but always sortable so the chain can use them.
    const specCols = loneFamily.props.map((def): ColumnDef<PartSummary, any> => ({
      id: specColumnId(loneFamily.id, def.key), header: def.label, size: def.kind === 'text' ? 110 : 100, minSize: 60,
      accessorFn: (p) => specSortValue(loneFamily, p.specs, def.key),
      sortUndefined: 'last', sortDescFirst: false,
      meta: { num: def.kind !== 'text', spec: true, label: `${def.label} (${loneFamily.label})` } as Meta,
      cell: (c) => { const v = c.row.original.specs?.props[def.key]; return v ? <span className={hl.get(def.key) === undefined ? undefined : hl.get(def.key) === 0 ? 'hl hl0' : 'hl'}>{formatSpec(def, v)}</span> : null; },
    }));
    return [...base, ...specCols];
  }, [info, loneFamily, hl, sortedByValue]);

  const table = useReactTable({
    data: rows, columns,
    state: { sorting, columnVisibility: { ...visibility, ...Object.fromEntries(columns.filter((c) => (c.meta as Meta | undefined)?.spec && visibility[c.id as string] === undefined).map((c) => [c.id as string, false])) }, columnOrder: order, columnSizing: sizing },
    onSortingChange: setSorting, onColumnVisibilityChange: setVisibility, onColumnOrderChange: setOrder, onColumnSizingChange: setSizing,
    columnResizeMode: 'onChange', enableColumnResizing: true, enableMultiSort: true, isMultiSortEvent: (e) => (e as MouseEvent).shiftKey,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    defaultColumn: { sortDescFirst: false, sortUndefined: 'last' },
  });
  const sortedRows = table.getRowModel().rows;

  // On a wide screen the Description column soaks up the spare width, so the table fills the window.
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
  // The vertical scrollbar appearing narrows the box; re-measure after every render (a no-op when unchanged).
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
  const virt = useVirtualizer({ count: sortedRows.length, getScrollElement: () => viewport.current, estimateSize: () => rowH, overscan: 14 });
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
    const idx = sortedRows.findIndex((r) => r.original.id === sel);
    if (e.key === 'Escape') { setParams({ sel: null }); return; }
    if (e.key === 'Enter') { if (sel !== null) location.hash = `#/parts/${sel}`; return; }
    e.preventDefault();
    const next = Math.min(sortedRows.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)));
    const row = sortedRows[next];
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

  // How many different test conditions the visible rows carry for each spec (Rds(on) at 10 V and at 2.5 V are not comparable).
  const conditions = useMemo(() => {
    const out: Record<string, number> = {};
    if (!loneFamily) return out;
    for (const def of loneFamily.props) {
      const seen = new Set<string>();
      for (const p of rows) { const v = p.specs?.props[def.key]; if (v) seen.add(v.cond ?? ''); }
      if (seen.size > 1) out[def.key] = seen.size;
    }
    return out;
  }, [loneFamily, rows]);

  const saveLayout = useMutation({
    mutationFn: (presets: Array<{ name: string; chain: Array<{ key: string; dir: 'asc' | 'desc' }> }> | null) =>
      presets === null ? api(`/settings/speclayouts/${loneFamily!.id}`, { method: 'DELETE' })
        : api(`/settings/speclayouts/${loneFamily!.id}`, { method: 'PUT', body: { ...(layouts?.[loneFamily!.id] ?? {}), presets } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['speclayouts'] }),
  });

  const active = FILTERS.filter((x) => f[x.key]);
  // Offered only while something is flagged (or the filter is already on, so it can always be switched off).
  const reviewCount = useMemo(() => (data ?? []).filter((p) => p.needsReview).length, [data]);
  const options: Record<string, Array<[string, string]>> = {
    cat: cats.map((c) => [c.name, c.name]), src: Object.entries(SOURCE_LABEL), cond: Object.entries(CONDITION_LABEL),
    loc: locs.map((l) => [l.code, l.code]), st: Object.entries(STATUS_LABEL),
  };
  const [chooser, setChooser] = useState(false);
  const leaf = table.getAllLeafColumns();
  const move = (id: string, dir: -1 | 1) => {
    const ids = leaf.map((c) => c.id);
    const i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < PINNED.length || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setOrder(ids);
  };

  if (error) return <div className="box bad">{(error as Error).message}</div>;
  return (
    <div className="workspace">
      <div className="toolbar">
        <h1>Parts</h1>
        <label className="search"><span className="sr">Search</span>
          <input ref={searchBox} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search value, footprint, MPN, C-number&hellip;  ( / )" /></label>
        {FILTERS.map(({ key, label }) => (
          <label key={key} className="mini-label">{label}
            <select value={f[key]} onChange={(e) => setParams({ [key]: e.target.value })}>
              <option value="">All</option>{options[key]!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>))}
        {familiesHere.size > 1 && (
          <label className="mini-label">Type
            <select value={f.fam} onChange={(e) => setParams({ fam: e.target.value })}>
              <option value="">All</option>{[...familiesHere].map(([id, n]) => <option key={id} value={id}>{familyById(id)?.label ?? id} ({n})</option>)}</select></label>)}
        {(reviewCount > 0 || f.review) && (
          <button className={f.review ? 'toggle on' : 'toggle'} aria-pressed={f.review} onClick={() => setParams({ review: f.review ? null : '1' })}>
            Needs review ({reviewCount})
          </button>)}
        {loneFamily && layout && (
          <SortChain family={loneFamily} layout={layout} sorting={sorting} setSorting={setSorting} conditions={conditions} busy={saveLayout.isPending}
            error={saveLayout.error ? (saveLayout.error as Error).message : null}
            onSavePreset={(name, chain) => saveLayout.mutate([...layout.presets.filter((p) => p.name !== name), { name, chain }])}
            onDeletePreset={(name) => saveLayout.mutate(layout.presets.filter((p) => p.name !== name))}
            onResetPresets={() => saveLayout.mutate(null)} />)}
        <div className="chooser-wrap">
          <button className="secondary" onClick={() => setChooser(!chooser)} aria-expanded={chooser}>Columns</button>
          {chooser && (
            <div className="chooser" role="dialog" aria-label="Choose columns">
              {leaf.map((c) => {
                const pinned = PINNED.includes(c.id);
                return (
                  <div key={c.id} className="chooser-row">
                    <label><input type="checkbox" checked={c.getIsVisible()} disabled={pinned} onChange={(e) => c.toggleVisibility(e.target.checked)} /> {metaOf(c).label ?? c.id}</label>
                    {!pinned && <span><button className="link" aria-label="Move left" onClick={() => move(c.id, -1)}>{'↑'}</button><button className="link" aria-label="Move right" onClick={() => move(c.id, 1)}>{'↓'}</button></span>}
                  </div>);
              })}
              <button className="link" onClick={() => { setVisibility(Object.fromEntries(DEFAULT_HIDDEN.map((id) => [id, false]))); setOrder(BASE_ORDER); setSizing({}); }}>Reset to default</button>
            </div>)}
        </div>
      </div>
      <div className="statusline">
        <span>{rows.length.toLocaleString('id-ID')} of {(data?.length ?? 0).toLocaleString('id-ID')} parts{isFetching ? ' · refreshing…' : ''}</span>
        {loneFamily && <span className="chip">{loneFamily.label}s: spec sorting on</span>}
        {f.review && <button className="chip removable" onClick={() => setParams({ review: null })}>Needs review {'×'}</button>}
        {f.fam && <button className="chip removable" onClick={() => setParams({ fam: null })}>Type: {familyById(f.fam)?.label ?? f.fam} {'×'}</button>}
        {active.map((x) => <button key={x.key} className="chip removable" onClick={() => setParams({ [x.key]: null })}>{x.label}: {f[x.key]} {'×'}</button>)}
        {(active.length > 0 || f.q || f.review || f.fam) && <button className="link" onClick={() => { setQ(''); setParams({ q: null, review: null, fam: null, cat: null, src: null, cond: null, loc: null, st: null }); }}>Clear all</button>}
        <button className="link" onClick={() => void refetch()}>Refresh</button>
      </div>
      <div className="split">
        <div className="viewport" ref={viewport} tabIndex={0} onKeyDown={onKey} aria-label="Parts table">
          <table className="vt" style={{ width: table.getTotalSize() + extra, ['--row-h' as string]: `${rowH}px` }}>
            <colgroup>{visibleCols.map((c) => <col key={c.id} style={{ width: widthOf(c) }} />)}</colgroup>
            <thead>{table.getHeaderGroups().map((g) => (
              <tr key={g.id}>{g.headers.map((h) => {
                const pin = pinLeft.get(h.column.id);
                const s = h.column.getIsSorted();
                const rank = sorting.findIndex((x) => x.id === h.column.id);
                return (
                  <th key={h.id} className={`${metaOf(h.column).num ? 'num ' : ''}${pin !== undefined ? 'pinned' : ''}`} style={pin !== undefined ? { left: pin } : undefined}
                    onClick={h.column.getCanSort() ? h.column.getToggleSortingHandler() : undefined} aria-sort={s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : 'none'}>
                    <span className="th-label">{flexRender(h.column.columnDef.header, h.getContext())}{s ? (s === 'asc' ? ' ▲' : ' ▼') : ''}{s && sorting.length > 1 ? <sup>{rank + 1}</sup> : null}</span>
                    <span className="resizer" onClick={(e) => e.stopPropagation()} onMouseDown={h.getResizeHandler()} onTouchStart={h.getResizeHandler()} onDoubleClick={() => h.column.resetSize()} />
                  </th>);
              })}</tr>))}</thead>
            <tbody>
              {padTop > 0 && <tr style={{ height: padTop }}><td colSpan={visibleCols.length} /></tr>}
              {items.map((v) => {
                const r = sortedRows[v.index]!;
                return (
                  <tr key={r.id} className={`${r.original.id === sel ? 'sel' : ''}${r.original.needsReview ? ' review-row' : ''}`} onClick={() => open(r.original.id)} onDoubleClick={() => (location.hash = `#/parts/${r.original.id}`)}>
                    {r.getVisibleCells().map((c) => {
                      const pin = pinLeft.get(c.column.id);
                      const tip = c.column.id === 'description' ? r.original.description : c.column.id === 'keyspecs' ? info.get(r.original.id)?.summary.all.map((s) => `${s.label}: ${s.text}`).join('\n') : undefined;
                      return <td key={c.id} title={tip} className={`${metaOf(c.column).num ? 'num ' : ''}${pin !== undefined ? 'pinned' : ''}`} style={pin !== undefined ? { left: pin } : undefined}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>;
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
            <div className="panel-bar"><a href={`#/parts/${sel}`}>Open full page {'↗'}</a><button className="link" onClick={() => setParams({ sel: null })}>Close {'✕'}</button></div>
            <PartDetail key={sel} id={sel!} embedded />
          </aside>)}
      </div>
    </div>
  );
}

