import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FAMILIES, detectFamily, familyById, formatSpec, resolveLayout, type LcscDetail, type SpecChange } from '../domain/specs';
import type { PartSummary } from '../domain/stock';
import { api } from './api';
import { useLayouts } from './hooks';

interface PlanItem {
  partId: number; family: string; familyLabel: string; state: string; changes: SpecChange[];
  category?: { from: string | null; to: string }; valueText?: string; title?: string;
}

const SRC_LABEL = { manual: 'by hand', lcsc: 'LCSC', description: 'description' } as const;
const ACTION_LABEL: Record<SpecChange['action'], string> = { new: 'new', update: 'changes', same: 'unchanged', kept: 'kept' };

/** The part page's specs: every spec with where it came from, manual overrides, and fetching from LCSC with a review step. */
export function PartSpecsPanel({ part, onChanged }: { part: PartSummary; onChanged: () => void }) {
  const layouts = useLayouts().data;
  const specs = part.specs;
  const family = (specs?.family ? familyById(specs.family) : undefined) ?? detectFamily(undefined, undefined, part.category);
  const layout = family ? resolveLayout(family, layouts?.[family.id]) : null;
  const [familyId, setFamilyId] = useState(family?.id ?? '');
  const chosen = familyById(familyId) ?? family ?? undefined;

  const [draft, setDraft] = useState<Record<string, string>>({});
  const initial = (key: string) => specs?.props[key]?.raw ?? '';
  const edited = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== initial(k)));
  const manualSave = useMutation({
    mutationFn: () => api(`/parts/${part.id}/specs`, { method: 'PATCH', body: {
      rev: part.rev, ...(chosen ? { family: chosen.id } : {}),
      set: Object.fromEntries(Object.entries(edited).filter(([, v]) => v.trim() !== '')),
      clear: Object.entries(edited).filter(([, v]) => v.trim() === '').map(([k]) => k),
    } }),
    onSuccess: () => { setDraft({}); onChanged(); },
  });

  // ---- fetch from LCSC, then review ----
  const [plan, setPlan] = useState<PlanItem | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const fetchPlan = useMutation({
    mutationFn: async () => {
      const f = await api<{ results: Array<{ status: string; message?: string }> }>('/enrich/fetch', { body: { partIds: [part.id] } });
      const first = f.results[0];
      if (first?.status === 'error') throw new Error(first.message ?? 'Could not reach LCSC.');
      if (first?.status === 'no_c_number') throw new Error('This part has no LCSC C-number to look up. Add one under Identity, or enter specs by hand.');
      const p = await api<{ items: PlanItem[] }>('/enrich/plan', { body: { partIds: [part.id] } });
      return p.items[0]!;
    },
    onSuccess: (item) => { setPlan(item); setPicked(Object.fromEntries(item.changes.filter((c) => c.action === 'new' || c.action === 'update').map((c) => [c.key, true]))); },
  });
  const apply = useMutation({
    mutationFn: () => api('/enrich/apply', { body: { items: [{ partId: part.id, keys: Object.entries(picked).filter(([, v]) => v).map(([k]) => k), category: !!plan?.category, valueText: !!plan?.valueText }] } }),
    onSuccess: () => { setPlan(null); onChanged(); },
  });

  // ---- everything LCSC said, read-only ----
  const [showRaw, setShowRaw] = useState(false);
  const raw = useQuery({ queryKey: ['enrichment', part.id], enabled: showRaw, queryFn: () => api<{ snapshot: { status: string; fetchedAt: string; detail: LcscDetail | null } | null }>(`/parts/${part.id}/enrichment`) });

  return (
    <section className="specs-panel">
      <div className="row"><h2 style={{ margin: 0 }}>Specs</h2>
        <button className="secondary" onClick={() => fetchPlan.mutate()} disabled={fetchPlan.isPending}>{fetchPlan.isPending ? 'Asking LCSC…' : 'Fetch from LCSC'}</button>
      </div>
      {fetchPlan.error && <p className="err">{(fetchPlan.error as Error).message}</p>}

      {plan && (
        <div className="box warn">
          {plan.state === 'not_listed' && <><b>LCSC no longer lists this part, so there is nothing to fetch.</b> <button className="link" onClick={() => setPlan(null)}>Close</button></>}
          {plan.state === 'no_family' && <><b>LCSC returned this part but it is not in a family with a spec layout yet. Its parameters are kept under "All specs LCSC lists".</b> <button className="link" onClick={() => setPlan(null)}>Close</button></>}
          {plan.state === 'unchanged' && !plan.changes.some((c) => c.action === 'kept') && <><b>Nothing new: this part&rsquo;s specs already match what LCSC says.</b> <button className="link" onClick={() => setPlan(null)}>Close</button></>}
          {(plan.state === 'ready' || plan.changes.some((c) => c.action === 'kept')) && (
            <>
              <b>{plan.state === 'ready' ? `${plan.familyLabel}: tick what to apply. Nothing is saved until you do.` : 'Nothing to apply. Where LCSC disagrees with a value you set, yours is kept:'}</b>
              <table><thead><tr><th /><th>Spec</th><th>Now</th><th>LCSC</th><th /></tr></thead>
                <tbody>{plan.changes.map((c) => {
                  const def = familyById(plan.family)?.props.find((p) => p.key === c.key);
                  const can = c.action === 'new' || c.action === 'update';
                  return (
                    <tr key={c.key}>
                      <td><input type="checkbox" disabled={!can} checked={!!picked[c.key]} onChange={(e) => setPicked({ ...picked, [c.key]: e.target.checked })} /></td>
                      <td>{def?.label ?? c.key}</td>
                      <td>{c.from && def ? formatSpec(def, c.from) : '–'}</td>
                      <td>{def ? formatSpec(def, c.to) : ''}</td>
                      <td className="est">{ACTION_LABEL[c.action]}{c.reason ? ` (${c.reason})` : ''}</td>
                    </tr>);
                })}</tbody></table>
              {plan.category && <p>LCSC files this under <b>{plan.category.to}</b> (now: {plan.category.from ?? 'none'}). It will be applied with the specs.</p>}
              <div className="row">
                {plan.state === 'ready' && <button onClick={() => apply.mutate()} disabled={apply.isPending}>Apply selected</button>}
                <button className="secondary" onClick={() => setPlan(null)}>{plan.state === 'ready' ? 'Not now' : 'Close'}</button>
                {apply.error && <span className="err">{(apply.error as Error).message}</span>}
              </div>
            </>)}

        </div>)}

      {!chosen && (
        <p className="lede">This part&rsquo;s category has no spec layout. Choose what kind of part it is to enter specs by hand:{' '}
          <select value={familyId} onChange={(e) => setFamilyId(e.target.value)}><option value="">choose&hellip;</option>{FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></p>)}

      {chosen && (
        <form className="specs-grid" onSubmit={(e) => { e.preventDefault(); manualSave.mutate(); }}>
          {(layout ? layout.order : chosen.order).map((key) => {
            const def = chosen.props.find((p) => p.key === key)!;
            const v = specs?.props[key];
            return (
              <label key={key}>
                <span>{def.label}{v && <span className={`src src-${v.src}`} title={`source: ${SRC_LABEL[v.src]}`}> {SRC_LABEL[v.src]}</span>}</span>
                <input value={draft[key] ?? initial(key)} placeholder={v ? undefined : def.kind === 'text' ? 'text' : `e.g. ${def.unit === 'ohm' ? '10kΩ' : def.unit === 'F' ? '100nF' : def.unit === 'V' ? '25V' : def.unit === 'A' ? '2A' : '…'}`}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
                {v && <span className="est">shows as {formatSpec(def, v)}</span>}
              </label>);
          })}
          <div className="row wide">
            <button type="submit" disabled={manualSave.isPending || Object.keys(edited).length === 0}>Save specs</button>
            <span className="lede">Values you type are kept over anything fetched later. Empty a box to remove a spec.</span>
            {manualSave.error && <span className="err">{(manualSave.error as Error).message}</span>}
          </div>
        </form>)}

      <details onToggle={(e) => setShowRaw((e.target as HTMLDetailsElement).open)}>
        <summary>All specs LCSC lists</summary>
        {raw.isFetching && <p className="lede">Loading&hellip;</p>}
        {raw.data && !raw.data.snapshot && <p className="lede">Nothing fetched from LCSC for this part yet.</p>}
        {raw.data?.snapshot?.status === 'not_listed' && <p className="lede">LCSC no longer lists this part (checked {raw.data.snapshot.fetchedAt.slice(0, 10)}).</p>}
        {raw.data?.snapshot?.detail && (
          <>
            <p className="lede">{raw.data.snapshot.detail.catalog} &middot; fetched {raw.data.snapshot.fetchedAt.slice(0, 10)}
              {raw.data.snapshot.detail.datasheet && <> &middot; <a href={raw.data.snapshot.detail.datasheet} target="_blank" rel="noreferrer">datasheet</a></>}</p>
            <table><tbody>{raw.data.snapshot.detail.params.map((p) => <tr key={p.name}><td>{p.name}</td><td>{p.value}</td></tr>)}</tbody></table>
          </>)}
      </details>
    </section>
  );
}
