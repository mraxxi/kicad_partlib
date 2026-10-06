/**
 * Readable names for imports. The real LCSC number stays the key that detects a re-import; these only decide what a
 * person reads. Pure, so the same label shows everywhere.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2024-08-25" -> "25 Aug 2024". */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** An order's name: its alias, else "LCSC 25 Aug 2024", with " (2)" for the second order of that date, and so on. */
export function orderLabel(o: { alias: string | null; orderDate: string }, nthOfDay = 1): string {
  if (o.alias) return o.alias;
  return `LCSC ${longDate(o.orderDate)}${nthOfDay > 1 ? ` (${nthOfDay})` : ''}`;
}

/** A cart's default name from LCSC's filename "export_cart_20261006_140514.csv": "Cart 6 Oct 2026 14:05". */
export function cartLabel(filename: string): string {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}/.exec(filename.split(/[\\/]/).pop() ?? filename);
  return m ? `Cart ${longDate(`${m[1]}-${m[2]}-${m[3]}`)} ${m[4]}:${m[5]}` : `Cart ${filename}`;
}

/** What a typed name becomes: trimmed, empty means "use the default", too long is refused with a sentence. */
export function cleanAlias(s: string | null | undefined): { ok: true; alias: string | null } | { ok: false; message: string } {
  const t = (s ?? '').trim();
  if (t.length > 60) return { ok: false, message: `A name can have at most 60 characters; this one has ${t.length}.` };
  return { ok: true, alias: t || null };
}

/**
 * The USD to IDR rate a person typed. Indonesian formatting is the trap: "17.893" means seventeen thousand, but read as
 * a decimal it is 17.893 and every quote would come out as Rp 18. Returns a sentence, or null when the rate is fine.
 */
export function fxProblem(s: string): string | null {
  const t = s.trim();
  if (/,/.test(t)) return 'Type the rate with a dot for decimals and no thousands separator, for example 17893 or 17893.5.';
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return `"${t}" is not a rate; type digits only, for example 17893 or 17893.5.`;
  if (Number(t) < 1000) return `A rate of ${t} rupiah per dollar is too low to be right (a dollar is worth about 17,000); type 17893, not 17.893.`;
  return null;
}
