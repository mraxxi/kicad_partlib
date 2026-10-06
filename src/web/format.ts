const IDR = new Intl.NumberFormat('id-ID');
export const idr = (n: number): string => `Rp ${IDR.format(Math.round(n))}`;
export const num = (n: number): string => IDR.format(n);
/** micro-IDR (IDR x 1e6) per piece, shown with the decimals tiny parts need. */
export const unitIdr = (micro: number): string => `Rp ${(micro / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;
export const when = (iso: string): string =>
  new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
