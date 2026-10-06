/**
 * Parse the value strings LCSC (and part descriptions) use for specifications into NUMBERS IN SI BASE UNITS.
 * The application owns this, not an LLM: SI prefixes, units, ranges, conditions and tolerances are
 * deterministic (docs/spec-enrichment.md). Shapes handled, all seen in real LCSC data:
 *
 *   "30V"  "20mOhm@10V"  "12nC@10V"  "4.5V~26V"  "-55C~+150C"  "0.5~2.5"  "+-5%"  "+-100ppm/C"  "+-20V"
 *   "9V/us"  "4.5nV/sqrtHz@1kHz"  "2KB"  "32Mbit"  "3Wx1@4Ohm"  "315Wx2@4Ohm;600Wx1@2Ohm"  "-18V~-2.25V;2.25V~18V"
 *   "N-Channel", "Class D", "X7R" (text), "-" (not available).
 *
 * Byte and bit sizes use binary prefixes (2KB = 2048), as LCSC does. A unit the parser does not know is
 * kept as `?<token>` rather than guessed, so a mapping can refuse a value whose unit is not the one it expects.
 */
export type Unit =
  | 'ohm' | 'V' | 'A' | 'W' | 'F' | 'H' | 'Hz' | 's' | 'm' | 'N' | 'cd' | 'C' | 'dB' | 'bit' | 'B'
  | 'degC' | 'deg' | '%' | 'ppm' | 'hour' | 'year' | 'cycle' | 'sqrtHz' | 'pin' | 'none' | `${string}/${string}` | `?${string}`;

export type Quantity =
  | { kind: 'num'; n: number; unit: Unit; raw: string; cond?: string; count?: number; plusMinus?: boolean }
  | { kind: 'range'; min: number; max: number; unit: Unit; raw: string; cond?: string }
  | { kind: 'text'; text: string; raw: string };

const OHM = ['Ω', 'Ω', 'ohm', 'Ohm'];
const UNITS: Array<[Unit, string[]]> = [
  ['ohm', OHM], ['V', ['V']], ['A', ['A']], ['W', ['W']], ['F', ['F']], ['H', ['H']], ['Hz', ['Hz']], ['s', ['s']],
  ['m', ['m']], ['N', ['N']], ['cd', ['cd']], ['C', ['C']], ['dB', ['dB']], ['bit', ['bit', 'Bit']], ['B', ['B']],
  ['degC', ['℃', '°C']], ['deg', ['°']], ['%', ['%']], ['ppm', ['ppm']], ['hour', ['hrs', 'hours']],
  ['year', ['Years', 'Year']], ['cycle', ['cycles']], ['sqrtHz', ['√Hz']], ['pin', ['P']],
];
const ALIASES = UNITS.flatMap(([u, names]) => names.map((a) => [a, u] as const)).sort((a, b) => b[0].length - a[0].length);
const PREFIX: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9,
};
const BINARY: Record<string, number> = { k: 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

function singleUnit(tok: string): { unit: Unit; scale: number } | null {
  for (const [alias, unit] of ALIASES) {
    if (!tok.endsWith(alias)) continue;
    const pre = tok.slice(0, tok.length - alias.length);
    if (pre === '') return { unit, scale: 1 };
    const table = unit === 'bit' || unit === 'B' ? BINARY : PREFIX;
    if (table[pre] !== undefined) return { unit, scale: table[pre]! };
  }
  return null;
}

function parseUnit(token: string): { unit: Unit; scale: number } {
  const t = token.trim();
  if (t === '') return { unit: 'none', scale: 1 };
  const slash = t.indexOf('/');
  if (slash > 0) {
    const a = singleUnit(t.slice(0, slash)), b = singleUnit(t.slice(slash + 1));
    if (a && b) return { unit: `${a.unit}/${b.unit}`, scale: a.scale / b.scale };
    return { unit: `?${t}`, scale: 1 };
  }
  return singleUnit(t) ?? { unit: `?${t}`, scale: 1 };
}

/** Round away binary floating-point noise (4.5 * 1e-3 -> 0.0045, not 0.004500000000000001). */
const clean = (x: number): number => Number(x.toPrecision(12));

const NUM = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
const toNumber = (s: string): number => Number(s.replace(/,/g, '').replace(/^\+/, ''));
const UNIT_TOK = String.raw`[^\s~@;x×\d+-][^\s~@;]*`; // a unit starts with a letter or symbol, never a digit or sign

function one(rawAlt: string): Quantity {
  const raw = rawAlt.trim();
  let main = raw;
  let cond: string | undefined;
  const at = raw.indexOf('@');
  if (at > 0) { main = raw.slice(0, at).trim(); cond = raw.slice(at + 1).trim() || undefined; }

  // Range: "4.5V~26V", "-18V~-2.25V", "0.5~2.5", "-55C~+155C" (the unit may sit on one end or both)
  const rng = new RegExp(`^(${NUM})\\s*(${UNIT_TOK})?\\s*~\\s*(${NUM})\\s*(${UNIT_TOK})?$`).exec(main);
  if (rng) {
    const u = parseUnit(rng[4] ?? rng[2] ?? '');
    const lo = clean(toNumber(rng[1]!) * parseUnit(rng[2] ?? rng[4] ?? '').scale);
    const hi = clean(toNumber(rng[3]!) * u.scale);
    return { kind: 'range', min: Math.min(lo, hi), max: Math.max(lo, hi), unit: u.unit, raw, ...(cond ? { cond } : {}) };
  }

  // Multiplicity: "3Wx1@4Ohm" -> 3 W, count 1
  const mul = new RegExp(`^(${NUM})\\s*(${UNIT_TOK})\\s*[x\\u00D7X]\\s*(\\d+)$`).exec(main);
  if (mul) {
    const u = parseUnit(mul[2]!);
    return { kind: 'num', n: clean(toNumber(mul[1]!) * u.scale), unit: u.unit, raw, count: Number(mul[3]), ...(cond ? { cond } : {}) };
  }

  // A signed or +- number with a unit: "+-5%", "+-100ppm/C", "+-20V", "20mOhm", "12bit", "8 Bit"
  const pm = main.startsWith('±');
  const body = pm ? main.slice(1).trim() : main;
  const num = new RegExp(`^(${NUM})\\s*(${UNIT_TOK})?$`).exec(body);
  if (num) {
    const u = parseUnit(num[2] ?? '');
    return { kind: 'num', n: clean(toNumber(num[1]!) * u.scale), unit: u.unit, raw, ...(cond ? { cond } : {}), ...(pm ? { plusMinus: true } : {}) };
  }
  return { kind: 'text', text: raw, raw };
}

/** Alternatives separated by ';' ("315Wx2@4Ohm;600Wx1@2Ohm"). null means "not available" ("-" or empty). */
export function parseQuantity(raw: string): Quantity[] | null {
  const t = raw.trim();
  if (t === '' || t === '-') return null;
  return t.split(';').map((s) => s.trim()).filter((s) => s !== '' && s !== '-').map(one);
}
