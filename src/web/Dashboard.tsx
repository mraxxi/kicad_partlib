import { STATUS_LABEL } from '../domain/stock';
import { idr, num } from './format';
import { useDashboard, useUsage } from './hooks';

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, (used / limit) * 100);
  return (
    <div className="meter">
      <div className="meter-head"><span>{label}</span><span>{num(used)} / {num(limit)}</span></div>
      <div className="bar"><div style={{ width: `${Math.max(pct, 0.5)}%` }} className={pct > 80 ? 'hot' : ''} /></div>
    </div>
  );
}

export function Dashboard() {
  const { data: d, error } = useDashboard();
  const { data: u } = useUsage();
  if (error) return <div className="box bad">{(error as Error).message}</div>;
  if (!d) return <p className="lede">Loading…</p>;
  return (
    <>
      <h1>Dashboard</h1>
      <div className="box stats">
        <div><b>{num(d.partLines)}</b><span>parts</span></div>
        <div><b>{num(d.unitsOnHand)}</b><span>units on hand</span></div>
        <div><b className="money">{idr(d.valueRealIdr)}</b><span>stock value (paid for)</span></div>
        <div><b className="est-value">{idr(d.valueEstimatedIdr)}</b><span>salvaged value, estimated</span></div>
      </div>
      <div className="box stats">
        <div><b>{d.reorderCount}</b><span>below minimum</span></div>
        <div><b>{d.outCount}</b><span>out of stock</span></div>
        <div><b>{num(d.untestedSalvageUnits)}</b><span>untested salvaged units</span></div>
        <div><b>{d.needsReviewCount > 0 ? <a href="#/parts?review=1">{d.needsReviewCount}</a> : d.needsReviewCount}</b><span>parts to review</span></div>
      </div>
      <div className="two">
        <section>
          <h2>To reorder</h2>
          {d.reorder.length === 0 ? <p className="lede">Nothing is below its minimum.</p> : (
            <div className="scroll"><table><thead><tr><th>Part</th><th>MPN</th><th className="num">Usable</th><th className="num">Min</th><th>Status</th></tr></thead>
              <tbody>{d.reorder.map((r) => (
                <tr key={r.id}><td><a href={`#/parts/${r.id}`}>{r.code}</a></td><td>{r.mpn}</td><td className="num">{r.usableQty}</td>
                  <td className="num">{r.minQty ?? '–'}</td><td><span className={`chip st-${r.status}`}>{STATUS_LABEL[r.status]}</span></td></tr>
              ))}</tbody></table></div>
          )}
        </section>
        <section>
          <h2>Stock by category</h2>
          <div className="scroll"><table><thead><tr><th>Category</th><th className="num">Parts</th><th className="num">Units</th><th className="num">Value</th></tr></thead>
            <tbody>{d.byCategory.map((c) => (
              <tr key={c.category}><td>{c.category}</td><td className="num">{c.parts}</td><td className="num">{num(c.units)}</td>
                <td className="num">{idr(c.valueRealIdr)}{c.valueEstimatedIdr > 0 && <span className="est"> + ~{idr(c.valueEstimatedIdr)}</span>}</td></tr>
            ))}</tbody></table></div>
        </section>
      </div>
      {u && (
        <section>
          <h2>Today's database usage</h2>
          <div className="two">
            <Meter label="Rows read" used={u.rowsRead} limit={u.limits.rowsRead} />
            <Meter label="Rows written" used={u.rowsWritten} limit={u.limits.rowsWritten} />
          </div>
          <p className="lede">Counts only what this app recorded; other Workers on the account share the same free daily quota.</p>
        </section>
      )}
    </>
  );
}
