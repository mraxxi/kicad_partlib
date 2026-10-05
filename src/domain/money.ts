/**
 * Money is an integer everywhere. This module owns the only two places a
 * decimal string or a rate becomes an integer, and neither touches a float.
 *
 *   USD  -> micro-USD   ("0.0046" -> 4600)
 *   micro-USD x FX      -> micro-IDR (BigInt: 3.9e6 x 1.7e10 overflows 2^53)
 */

export class MoneyError extends Error {}

/** Parse a non-negative decimal string into integer micro-units (6 places). */
export function parseMicro(input: string): number {
  const s = input.trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new MoneyError(`"${input}" is not a price with at most 6 decimal places.`);
  const frac = (m[2] ?? '').padEnd(6, '0');
  const micro = Number(m[1]) * 1_000_000 + Number(frac);
  if (!Number.isSafeInteger(micro)) throw new MoneyError(`"${input}" is too large.`);
  return micro;
}

/**
 * IDR per piece, as micro-IDR, from a micro-USD unit price and an FX rate held
 * as IDR-per-USD x 1e6. Rounds half up. Micro-IDR, not whole IDR, because a
 * 0.0002 USD part costs 3.3 IDR and whole-rupiah rounding is a 10% error there.
 */
export function costIdrMicro(unitPriceMicro: number, fxIdrPerUsdMicro: number): number {
  const num = BigInt(unitPriceMicro) * BigInt(fxIdrPerUsdMicro);
  const den = 1_000_000n;
  return Number((num + den / 2n) / den);
}

/** Whole IDR for display or totals (round half up). */
export function microIdrToIdr(micro: number): number {
  return Math.round(micro / 1_000_000);
}
