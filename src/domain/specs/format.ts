import type { SpecDef, SpecValue } from './types';

const PRE: Array<[number, string]> = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, '\u00B5'], [1e-9, 'n'], [1e-12, 'p']];
const SYMBOL: Record<string, string> = { ohm: 'Ω', degC: '℃', '%': '%', none: '', pin: 'P', hour: 'h', year: 'y', cycle: ' cycles', deg: '°' };

function clean(x: number): string {
  return String(Number(x.toPrecision(4)));
}

/** Engineering notation with an SI prefix: 0.02 ohm -> "20mΩ", 5.13e-7 m -> "513nm". */
export function formatNumber(n: number, unit = 'none'): string {
  if (unit === 'V/s') return `${clean(n / 1e6)}V/µs`; // slew rate is quoted in V/us
  if (unit === 'V/sqrtHz') return `${clean(n / 1e-9)}nV/√Hz`;
  if (unit === 'V/degC') return `${clean(n / 1e-6)}µV/℃`;
  if (unit === 'ppm/degC') return `${clean(n)}ppm/℃`;
  if (unit === 'B') { const k = n >= 1024 ** 3 ? [1024 ** 3, 'GB'] : n >= 1024 ** 2 ? [1024 ** 2, 'MB'] : n >= 1024 ? [1024, 'KB'] : [1, 'B']; return `${clean(n / (k[0] as number))}${k[1]}`; }
  if (unit === 'bit') { const k = n >= 1024 ** 3 ? [1024 ** 3, 'Gbit'] : n >= 1024 ** 2 ? [1024 ** 2, 'Mbit'] : n >= 1024 ? [1024, 'Kbit'] : [1, 'bit']; return `${clean(n / (k[0] as number))}${k[1]}`; }
  if (unit === 'none' || unit === '%' || unit === 'pin' || unit === 'degC' || unit === 'deg' || unit === 'hour' || unit === 'year' || unit === 'cycle' || unit === 'dB') {
    return `${clean(n)}${unit === 'dB' ? 'dB' : (SYMBOL[unit] ?? '')}`;
  }
  const a = Math.abs(n);
  if (a === 0) return `0${SYMBOL[unit] ?? unit}`;
  const [scale, prefix] = PRE.find(([s]) => a >= s * 0.9999) ?? PRE[PRE.length - 1]!;
  return `${clean(n / scale)}${prefix}${SYMBOL[unit] ?? unit}`;
}

/** The text for one spec value: "30V", "4.5V~26V", "20mΩ@10V", "50W×2@4Ω", "X7R". */
export function formatSpec(def: Pick<SpecDef, 'fmt'>, v: SpecValue): string {
  if (def.fmt) return def.fmt(v);
  if (v.text !== undefined) return v.text;
  const unit = v.unit ?? 'none';
  let s: string;
  if (v.min !== undefined && v.max !== undefined && v.min !== v.max) s = `${formatNumber(v.min, unit)}~${formatNumber(v.max, unit)}`;
  else s = formatNumber(v.n ?? v.max ?? v.min ?? 0, unit);
  if (v.count !== undefined && v.count > 1) s += `×${v.count}`;
  if (v.cond) s += `@${v.cond}`;
  return s;
}

/** The number a spec sorts by (undefined sorts last). */
export function sortNumber(def: Pick<SpecDef, 'end'>, v: SpecValue | undefined): number | undefined {
  if (!v) return undefined;
  if (v.n !== undefined) return v.n;
  if (v.min !== undefined && v.max !== undefined) return def.end === 'min' ? v.min : v.max;
  return v.max ?? v.min;
}
