import type { Segment } from '../domain/specs';

/** A summary token list. Specs in `hl` are highlighted (the ones the table is sorted by); all stay visible. */
export function Segments({ segments, hl, sep = ' · ' }: { segments: Segment[]; hl: ReadonlyMap<string, number>; sep?: string }) {
  return (
    <>
      {segments.map((s, i) => {
        const rank = hl.get(s.key);
        return (
          <span key={s.key}>
            {i > 0 && sep}
            <span className={rank === undefined ? undefined : rank === 0 ? 'hl hl0' : 'hl'} title={s.label}>{s.text}</span>
          </span>
        );
      })}
    </>
  );
}
