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
  for (const tok of description.split(/\s+/)) if (/^\d[\d.]*[a-zA-Zµ]*[ΩFH]$/.test(tok)) return tok;
  return '';
}
