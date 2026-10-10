import { useState } from 'react';
import { STATUS_LABEL, type StockStatus } from '../domain/stock';
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

function Counter({ label, val, link, isErr, isWarn }: { label: string; val: number; link?: string; isErr?: boolean; isWarn?: boolean }) {
  const isZero = val === 0;
  const content = (
    <>
      <div className="dh-counter-num">{num(val)}</div>
      <div className="dh-counter-lbl">{label}</div>
    </>
  );
  let cls = 'dh-counter';
  if (isZero) cls += ' is-0';
  else if (isErr) cls += ' is-err';
  else if (isWarn) cls += ' is-warn';
  else if (link) cls += ' is-link';

  if (!isZero && link) {
    return <a href={link} className={cls}>{content}</a>;
  }
  return <div className={cls}>{content}</div>;
}

function StockBar({ usableQty, minQty, status }: { usableQty: number; minQty: number | null; status: StockStatus }) {
  if (minQty === null) {
    return <span>{num(usableQty)}</span>;
  }
  const pct = minQty > 0 ? Math.min(usableQty / minQty, 1) * 100 : 0;
  return (
    <div className="dh-stock-bar">
      <div className="dh-stock-track">
        <div className={`dh-stock-fill st-${status}`} style={{ width: `${Math.max(pct, 0)}%` }} />
      </div>
      <span>{num(usableQty)} of {num(minQty)}</span>
    </div>
  );
}

export function Dashboard() {
  const { data: d, error } = useDashboard();
  const { data: u } = useUsage();
  const [showTable, setShowTable] = useState(false);

  if (error) return <div className="box bad">{(error as Error).message}</div>;
  if (!d) return <p className="lede">Loading…</p>;

  const hasEstAnywhere = d.byCategory.some(c => c.valueEstimatedIdr > 0);
  const totalAnywhere = d.byCategory.some(c => c.valueRealIdr > 0 || c.valueEstimatedIdr > 0);
  
  let chartRows = d.byCategory;
  if (chartRows.length > 8) {
    const top = chartRows.slice(0, 8);
    const rest = chartRows.slice(8);
    const other = rest.reduce((acc, c) => {
      acc.parts += c.parts;
      acc.units += c.units;
      acc.valueRealIdr += c.valueRealIdr;
      acc.valueEstimatedIdr += c.valueEstimatedIdr;
      return acc;
    }, { category: `Other (${rest.length} categories)`, parts: 0, units: 0, valueRealIdr: 0, valueEstimatedIdr: 0 });
    chartRows = [...top, other];
  }
  const maxVal = Math.max(...chartRows.map(c => c.valueRealIdr + c.valueEstimatedIdr), 0);
  const forceTable = !totalAnywhere;
  const isTableView = showTable || forceTable;

  return (
    <>
      <div className="dh-head">
        <h1>Dashboard</h1>
        <span>{num(d.partLines)} parts · {num(d.unitsOnHand)} units on hand</span>
      </div>

      <div className="dh-grid">
      <div className="box dh-hero dh-a-hero">
        <div>
          <div className="dh-hero-lbl">Stock value (paid for)</div>
          <div className="dh-hero-val">{idr(d.valueRealIdr)}</div>
        </div>
        <div>
          <div className="dh-hero-lbl">Salvaged, estimated</div>
          <div className="dh-hero-est">~{idr(d.valueEstimatedIdr)}</div>
        </div>
      </div>

      <section className="dh-a-attn">
        <h2>Needs attention</h2>
        <div className="dh-counters">
          <Counter label="Out of stock" val={d.outCount} link="#/parts?st=out" isErr />
          <Counter label="Below minimum" val={d.reorderCount} link="#/parts?st=reorder" isWarn />
          <Counter label="Parts to review" val={d.needsReviewCount} link="#/parts?review=1" />
          <Counter label="Untested salvaged units" val={d.untestedSalvageUnits} />
        </div>

        {d.reorder.length === 0 ? (
          <p className="lede">Nothing is out of stock or below its minimum.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Part</th>
                  <th>MPN</th>
                  <th>Stock</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.reorder.map((r) => (
                  <tr key={r.id}>
                    <td><a href={`#/parts/${r.id}`}>{r.code}</a></td>
                    <td>{r.mpn}</td>
                    <td><StockBar usableQty={r.usableQty} minQty={r.minQty} status={r.status} /></td>
                    <td><span className={`chip st-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dh-chart-wrap dh-a-money">
        <h2>Where the money sits</h2>
        <div className="dh-chart-controls">
          <div className="dh-legend">
            <div className="dh-legend-item"><span className="dh-swatch paid"></span>Paid for</div>
            {hasEstAnywhere && <div className="dh-legend-item"><span className="dh-swatch est"></span>Estimated (salvage)</div>}
          </div>
          {!forceTable && (
            <button className="link" onClick={() => setShowTable(!showTable)}>
              {showTable ? 'Show as chart' : 'Show as table'}
            </button>
          )}
        </div>
        
        {isTableView ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Parts</th>
                  <th className="num">Units</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {d.byCategory.map((c) => (
                  <tr key={c.category}>
                    <td>{c.category}</td>
                    <td className="num">{c.parts}</td>
                    <td className="num">{num(c.units)}</td>
                    <td className="num">
                      {idr(c.valueRealIdr)}
                      {c.valueEstimatedIdr > 0 && <span className="est"> + ~{idr(c.valueEstimatedIdr)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dh-chart">
            {chartRows.map(c => {
              const pctPaid = maxVal > 0 ? (c.valueRealIdr / maxVal) * 100 : 0;
              const pctEst = maxVal > 0 ? (c.valueEstimatedIdr / maxVal) * 100 : 0;
              return (
                <div key={c.category} className="dh-chart-row" tabIndex={0} 
                     title={`${c.category}: ${idr(c.valueRealIdr)} paid, ~${idr(c.valueEstimatedIdr)} estimated, ${c.parts} parts, ${num(c.units)} units`}
                     aria-label={`${c.category}: ${idr(c.valueRealIdr)} paid, ~${idr(c.valueEstimatedIdr)} estimated, ${c.parts} parts, ${num(c.units)} units`}>
                  <div className="dh-chart-lbl">{c.category}</div>
                  <div className="dh-chart-bar-area">
                    {c.valueRealIdr > 0 && <div className="dh-bar-paid" style={{ width: `${pctPaid}%` }} />}
                    {c.valueEstimatedIdr > 0 && <div className="dh-bar-est" style={{ width: `${pctEst}%` }} />}
                  </div>
                  <div className="dh-chart-val">
                    {idr(c.valueRealIdr)}
                    {c.valueEstimatedIdr > 0 && <span className="dh-chart-val-est"> + ~{idr(c.valueEstimatedIdr)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {u && (
        <section className="dh-a-usage">
          <h2>Today's database usage</h2>
          <div className="two">
            <Meter label="Rows read" used={u.rowsRead} limit={u.limits.rowsRead} />
            <Meter label="Rows written" used={u.rowsWritten} limit={u.limits.rowsWritten} />
          </div>
          <p className="lede">Counts only what this app recorded; other Workers on the account share the same free daily quota.</p>
        </section>
      )}
      </div>
    </>
  );
}
