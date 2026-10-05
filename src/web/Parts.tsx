import { useDeferredValue, useMemo, useState } from 'react';
import { createColumnHelper, flexRender, getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable, type SortingState } from '@tanstack/react-table';
import { CONDITION_LABEL, SOURCE_LABEL, STATUS_LABEL, parsePartCode, type PartSummary } from '../domain/stock';
import { idr } from './format';
import { useCategories, useLocations, useParts } from './hooks';

const col = createColumnHelper<PartSummary>();
const columns = [
  col.accessor('code', { header: 'Part', cell: (c) => <a href={`#/parts/${c.row.original.id}`}>{c.getValue()}</a> }),
  col.accessor('mpn', { header: 'MPN' }),
  col.accessor('manufacturer', { header: 'Manufacturer' }),
  col.accessor((p) => p.category ?? '', { id: 'category', header: 'Category' }),
  col.accessor('package', { header: 'Package' }),
  col.accessor('value', { header: 'Value' }),
  col.accessor('lotCount', { header: 'Lots', meta: { num: true } }),
  col.accessor('usableQty', { header: 'Usable', meta: { num: true } }),
  col.accessor('totalQty', { header: 'Total', meta: { num: true } }),
  col.accessor((p) => p.minQty ?? -1, { id: 'minQty', header: 'Min', meta: { num: true }, cell: (c) => (c.getValue() < 0 ? '–' : c.getValue()) }),
  col.accessor('status', { header: 'Status', cell: (c) => <span className={`chip st-${c.getValue()}`}>{STATUS_LABEL[c.getValue()]}</span> }),
  col.accessor((p) => p.locations.join(', '), { id: 'locations', header: 'Location' }),
  col.accessor((p) => p.valueRealIdr + p.valueEstimatedIdr, { id: 'value_idr', header: 'Value', meta: { num: true },
    cell: (c) => <>{idr(c.getValue())}{c.row.original.valueEstimatedIdr > 0 && <span className="est" title="includes an estimate for salvaged lots"> ~</span>}</> }),
];

const ALL = '';

export function Parts() {
  const { data, error, isFetching, refetch } = useParts();
  const cats = useCategories().data ?? [];
  const locs = useLocations().data ?? [];
  const [q, setQ] = useState('');
  const [f, setF] = useState({ category: ALL, source: ALL, condition: ALL, location: ALL, status: ALL });
  const [sorting, setSorting] = useState<SortingState>([{ id: 'code', desc: false }]);
  const query = useDeferredValue(q);

  // Search blob per part, built once per load: filtering runs on every keystroke.
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
        (!f.category || p.category === f.category) &&
        (!f.source || (p.sources as string[]).includes(f.source)) &&
        (!f.condition || (p.conditions as string[]).includes(f.condition)) &&
        (!f.location || p.locations.includes(f.location)) &&
        (!f.status || p.status === f.status))
      .map(({ p }) => p);
  }, [indexed, query, f]);

  const table = useReactTable({
    data: rows, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 100 } }, autoResetPageIndex: true,
  });
  const sel = (k: keyof typeof f, label: string, options: Array<[string, string]>) => (
    <label>{label}
      <select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
        <option value={ALL}>All</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );

  if (error) return <div className="box bad">{(error as Error).message}</div>;
  return (
    <>
      <h1>Parts</h1>
      <div className="filters">
        <label className="grow">Search<input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="MPN, description, C-number, P-0012…" /></label>
        {sel('category', 'Category', cats.map((c) => [c.name, c.name]))}
        {sel('source', 'Source', Object.entries(SOURCE_LABEL))}
        {sel('condition', 'Condition', Object.entries(CONDITION_LABEL))}
        {sel('location', 'Location', locs.map((l) => [l.code, l.code]))}
        {sel('status', 'Stock', Object.entries(STATUS_LABEL))}
      </div>
      <p className="lede">{rows.length.toLocaleString('id-ID')} of {(data?.length ?? 0).toLocaleString('id-ID')} parts{isFetching ? ' · refreshing…' : ''} <button className="link" onClick={() => void refetch()}>Refresh</button></p>
      <div className="scroll">
        <table>
          <thead>{table.getHeaderGroups().map((g) => (
            <tr key={g.id}>{g.headers.map((h) => (
              <th key={h.id} className={(h.column.columnDef.meta as { num?: boolean } | undefined)?.num ? 'num sortable' : 'sortable'} onClick={h.column.getToggleSortingHandler()}>
                {flexRender(h.column.columnDef.header, h.getContext())}{{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
              </th>))}</tr>))}
          </thead>
          <tbody>{table.getRowModel().rows.map((r) => (
            <tr key={r.id} className={r.original.needsReview ? 'review-row' : ''}>{r.getVisibleCells().map((c) => (
              <td key={c.id} className={(c.column.columnDef.meta as { num?: boolean } | undefined)?.num ? 'num' : ''}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>))}</tr>))}
          </tbody>
        </table>
      </div>
      {table.getPageCount() > 1 && (
        <div className="row">
          <button className="secondary" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>Previous</button>
          <span className="lede">Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}</span>
          <button className="secondary" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>Next</button>
        </div>
      )}
    </>
  );
}
