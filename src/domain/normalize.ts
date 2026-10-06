/**
 * The identity of a part is (mpn, manufacturer_norm). LCSC spells one maker
 * several ways -- PAM8013AKR is "DIODES" in one export and "Diodes
 * Incorporated" in another -- and without a single normalising function that
 * becomes two parts and split stock. Only corporate suffixes are dropped:
 * dropping "electronics" or "semiconductor" would merge makers that differ.
 */
const SUFFIXES = new Set([
  'incorporated', 'inc', 'corporation', 'corp', 'co', 'ltd', 'limited', 'llc', 'gmbh', 'company',
]);

export function normalizeManufacturer(raw: string): string {
  const tokens = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join('');
}

/**
 * The owner's own taxonomy, taken from the 'Lists' tab of the Google Sheet
 * prototype. Must match the categories seeded by migrations 0002/0003; a test
 * checks it, because a guess naming a missing category inserts a NULL category.
 */
export const CATEGORY_NAMES = [
  'Connector', 'Discrete - Diode', 'Discrete - MOSFET', 'Discrete - Transistor', 'Display',
  'IC - Audio', 'IC - MCU', 'IC - Memory', 'IC - Op Amp', 'IC - Power', 'IC - Other',
  'Mechanical', 'Module', 'Optoelectronics - LED', 'Passive - Capacitor', 'Passive - Inductor',
  'Passive - Resistor', 'Crystal / Oscillator', 'Switch', 'Other',
] as const;
export type CategoryName = (typeof CATEGORY_NAMES)[number];

// Order matters: "Audio Amplifiers" must win over a generic amplifier match.
const RULES: Array<[RegExp, CategoryName]> = [
  [/audio amplifier/i, 'IC - Audio'],
  [/op amps?|instrumentation|\(general purpose\) amplifier/i, 'IC - Op Amp'],
  [/microcontroller/i, 'IC - MCU'],
  [/power management|battery management|voltage regulator/i, 'IC - Power'],
  [/\b(eeprom|flash|dram|sram|memory)\b/i, 'IC - Memory'],
  [/\b[np]-channel\b/i, 'Discrete - MOSFET'],
  [/crystal|oscillator/i, 'Crystal / Oscillator'],
  [/resistor/i, 'Passive - Resistor'],
  [/capacitor/i, 'Passive - Capacitor'],
  [/inductor/i, 'Passive - Inductor'],
  [/\bLED\b/, 'Optoelectronics - LED'],
  [/\bdiode\b/i, 'Discrete - Diode'],
  [/switch/i, 'Switch'],
  [/connector|header|wire to board|terminal block/i, 'Connector'],
];

export function guessCategory(description: string): CategoryName {
  for (const [re, name] of RULES) if (re.test(description)) return name;
  return 'Other';
}

/** "10kΩ", "100nF", "3.3Ω", "10uH": the first description token that is a value. */
export function guessValue(description: string, category: CategoryName): string {
  if (category !== 'Passive - Resistor' && category !== 'Passive - Capacitor' && category !== 'Passive - Inductor') return '';
  for (const tok of description.split(/\s+/)) if (/^\d[\d.]*[a-zA-Z\u00B5\u03BC]*[\u03A9\u2126FH]$/.test(tok)) return tok;
  return '';
}

// micro is written u, U+00B5 (micro sign) or U+03BC (Greek mu) depending on the source.
const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, '\u00B5': 1e-6, '\u03BC': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
// LCSC writes ohms as U+03A9 (Greek capital omega); U+2126 (the ohm sign) looks identical and may appear elsewhere.
const UNIT_RANK: Record<string, number> = { '\u03A9': 1, '\u2126': 1, F: 2, H: 3 };

/**
 * "100nF" -> 1e-7 farads, "10kΩ" -> 10000 ohms. The text 100nF, 0.1uF and
 * 1e-7 neither sort nor compare (AGENTS.md rule 9), so the table sorts on this.
 * Case matters and is meant: "68mΩ" is milli, "10MΩ" is mega. Anything that is
 * not a plain resistance / capacitance / inductance returns null and sorts last.
 */
export function valueToSi(value: string): { si: number; unit: 'ohm' | 'farad' | 'henry' } | null {
  const m = /^(\d+(?:\.\d+)?)\s*([pnu\u00B5\u03BCmkKMG]?)\s*([\u03A9\u2126FH])$/.exec(value.trim());
  if (!m) return null;
  const si = Number(m[1]) * (m[2] ? PREFIX[m[2]]! : 1);
  const unit = UNIT_RANK[m[3]!] === 1 ? 'ohm' : m[3] === 'F' ? 'farad' : 'henry';
  return { si, unit };
}

/** One number that orders values: by unit (ohm < farad < henry), then by magnitude. Null when unparseable. */
export function valueSortKey(value: string): number | null {
  const v = valueToSi(value);
  if (!v || v.si <= 0) return null;
  const rank = v.unit === 'ohm' ? 1 : v.unit === 'farad' ? 2 : 3;
  return rank * 1000 + Math.log10(v.si) + 100;
}
