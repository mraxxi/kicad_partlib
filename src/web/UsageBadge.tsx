import { useEffect, useId, useRef, useState } from 'react';
import { num } from './format';
import { useUsage } from './hooks';

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, (used / limit) * 100);
  return (
    <div className="meter">
      <div className="meter-head"><span>{label}</span><span>{num(used)} / {num(limit)}</span></div>
      <div className="bar"><div style={{ width: `${Math.max(pct, 0.5)}%` }} className={pct > 80 ? 'hot' : ''} /></div>
    </div>
  );
}

export function UsageBadge({ variant }: { variant: 'sysbar' | 'phone' }) {
  const { data: u } = useUsage();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Two badges can be mounted at once (header and phone dashboard), so the popover id must be per instance.
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node) && btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!u) return null;

  const pctR = u.limits.rowsRead > 0 ? (u.rowsRead / u.limits.rowsRead) * 100 : 0;
  const pctW = u.limits.rowsWritten > 0 ? (u.rowsWritten / u.limits.rowsWritten) * 100 : 0;
  const maxPct = Math.max(pctR, pctW);

  let pctText = maxPct.toFixed(1);
  if (maxPct > 0 && maxPct < 0.05) {
    pctText = '<0.1';
  }

  const isHot = maxPct > 80;

  return (
    <div className={`usage usage-${variant}`}>
      <button ref={btnRef} type="button" className={isHot ? 'usage-btn hot' : 'usage-btn'} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={popId}>
        D1 {pctText}% today
      </button>
      {open && (
        <div id={popId} ref={popRef} className="usage-pop">
          <h3>Today's database usage</h3>
          <Meter label="Rows read" used={u.rowsRead} limit={u.limits.rowsRead} />
          <Meter label="Rows written" used={u.rowsWritten} limit={u.limits.rowsWritten} />
          <p>{num(u.requests)} requests</p>
          <p className="usage-note">Counts only what this app recorded; other Workers on the account share the same free daily quota.</p>
        </div>
      )}
    </div>
  );
}
