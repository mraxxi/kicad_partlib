import { parseQuantity } from '../quantity';
import { formatSpec } from './format';
import type { Family, LcscDetail, Preset, SpecDef, SpecValue } from './types';

/**
 * The registry. DATA, not logic: which specs a family has, which LCSC labels feed each, how they rank, and the
 * built-in sort presets. Everything here was taken from the labels seen in real LCSC responses
 * (docs/lcsc-poc-report.md). A family not listed here simply has no summary or spec sort yet: its raw LCSC
 * parameters are still stored and shown, so nothing is lost and a family can be added later without refetching.
 */
const num = (key: string, label: string, unit: SpecDef['unit'], lcsc: string[], extra: Partial<SpecDef> = {}): SpecDef => ({ key, label, kind: 'number', unit, lcsc, ...extra });
const rng = (key: string, label: string, unit: SpecDef['unit'], lcsc: string[], extra: Partial<SpecDef> = {}): SpecDef => ({ key, label, kind: 'range', unit, lcsc, ...extra });
const txt = (key: string, label: string, lcsc: string[], extra: Partial<SpecDef> = {}): SpecDef => ({ key, label, kind: 'text', lcsc, ...extra });
const chain = (name: string, ...items: Array<[string, 'asc' | 'desc']>): Preset => ({ name, chain: items.map(([key, dir]) => ({ key, dir })) });

const param = (d: LcscDetail, name: string): string | undefined => d.params.find((p) => p.name === name)?.value;

/** First integer in strings like "2-Channel;1-Channel" or "1 N-channel". */
const leadingInt = (s: string | undefined): number | null => { const m = s ? /\d+/.exec(s) : null; return m ? Number(m[0]) : null; };

// ---- MOSFET: channel polarity comes from `Type`, else from `Number` ("1 P-Channel"), and `Number` gives the count.
const channel: SpecDef = {
  key: 'channel', label: 'Channel', kind: 'text', lcsc: ['Type', 'Number'],
  derive: (d) => {
    const raw = param(d, 'Type') ?? param(d, 'Number') ?? '';
    const pol = /\b([NP])-?\s*channel/i.exec(raw)?.[1]?.toUpperCase();
    if (!pol) return null;
    const count = leadingInt(param(d, 'Number'));
    return { text: pol, raw, ...(count && count > 1 ? { count } : {}), src: 'lcsc' };
  },
  fmt: (v) => `${v.count && v.count > 1 ? `${v.count}×` : ''}${v.text}-ch`,
};

// ---- Connector pin count: "4P", else rows x pins per row.
const pins: SpecDef = {
  key: 'pins', label: 'Positions', kind: 'number', unit: 'pin', lcsc: ['Number of PINs'],
  derive: (d) => {
    const direct = parseQuantity(param(d, 'Number of PINs') ?? '')?.[0];
    if (direct?.kind === 'num' && direct.unit === 'pin') return { n: direct.n, unit: 'pin', raw: direct.raw, src: 'lcsc' };
    const rows = leadingInt(param(d, 'Number of Rows')), per = leadingInt(param(d, 'Number of PINs Per Row'));
    return rows && per ? { n: rows * per, unit: 'pin', raw: `${rows} x ${per}`, src: 'lcsc' } : null;
  },
  fmt: (v) => `${v.n}P`,
};

// ---- Audio amplifier channels: "2-Channel;1-Channel" -> 2.
const channels = (label: string): SpecDef => ({
  key: 'channels', label: 'Channels', kind: 'number', unit: 'none', lcsc: [label],
  derive: (d) => { const n = leadingInt(param(d, label)); return n ? { n, unit: 'none', raw: param(d, label) ?? '', src: 'lcsc' } : null; },
  fmt: (v) => `${v.n}ch`,
});

export const FAMILIES: Family[] = [
  {
    id: 'resistor', label: 'Resistor', category: 'Passive - Resistor', keyCount: 4,
    matches: (c) => /Resistor/i.test(c) && !/Network|Array|Variable|Thermistor|Varistor|Potentiometer/i.test(c),
    props: [
      num('resistance', 'Resistance', 'ohm', ['Resistance']),
      num('power', 'Power', 'W', ['Power(Watts)']),
      num('tolerance', 'Tolerance', '%', ['Tolerance'], { fmt: (v) => `±${formatTol(v)}` }),
      txt('technology', 'Technology', ['Type'], { fmt: (v) => (v.text ?? '').replace(/\s*Resistors?$/i, '') }),
      num('voltage', 'Voltage rating', 'V', ['Voltage Rating']),
      num('tempco', 'Temp. coefficient', 'ppm/degC', ['Temperature Coefficient'], { fmt: (v) => `±${v.n}ppm/℃` }),
    ],
    order: ['resistance', 'power', 'tolerance', 'technology', 'voltage', 'tempco'],
    presets: [chain('Value, power, footprint', ['resistance', 'asc'], ['power', 'asc'], ['col:package', 'asc']), chain('Value, footprint, tolerance', ['resistance', 'asc'], ['col:package', 'asc'], ['tolerance', 'asc'])],
  },
  {
    id: 'capacitor', label: 'Capacitor', category: 'Passive - Capacitor', keyCount: 4,
    matches: (c, p) => (/Capacitors?/i.test(c) || /^Capacitors$/i.test(p)) && !/Trimmer|Variable/i.test(c),
    props: [
      num('capacitance', 'Capacitance', 'F', ['Capacitance']),
      num('voltage', 'Voltage rating', 'V', ['Voltage Rating']),
      txt('dielectric', 'Dielectric', ['Temperature Coefficient']),
      num('tolerance', 'Tolerance', '%', ['Tolerance'], { fmt: (v) => `±${formatTol(v)}` }),
      num('esr', 'ESR', 'ohm', ['Equivalent Series Resistance(ESR)']),
      num('ripple', 'Ripple current', 'A', ['Ripple Current']),
    ],
    order: ['capacitance', 'voltage', 'dielectric', 'tolerance', 'esr', 'ripple'],
    presets: [chain('Value, voltage, footprint', ['capacitance', 'asc'], ['voltage', 'asc'], ['col:package', 'asc']), chain('Value, footprint, dielectric', ['capacitance', 'asc'], ['col:package', 'asc'], ['dielectric', 'asc'])],
  },
  {
    id: 'inductor', label: 'Inductor', category: 'Passive - Inductor', keyCount: 4,
    matches: (c, p) => /Inductors/i.test(c) || /^Inductors/i.test(p),
    props: [
      num('inductance', 'Inductance', 'H', ['Inductance']),
      num('current', 'Rated current', 'A', ['Current Rating']),
      num('isat', 'Saturation current', 'A', ['Current - Saturation(Isat)']),
      num('dcr', 'DCR', 'ohm', ['DC Resistance(DCR)']),
      num('tolerance', 'Tolerance', '%', ['Tolerance'], { fmt: (v) => `±${formatTol(v)}` }),
    ],
    order: ['inductance', 'current', 'isat', 'dcr', 'tolerance'],
    presets: [chain('Value, current, footprint', ['inductance', 'asc'], ['current', 'desc'], ['col:package', 'asc'])],
  },
  {
    id: 'mosfet', label: 'MOSFET', category: 'Discrete - MOSFET', keyCount: 5,
    matches: (c) => /MOSFET/i.test(c),
    props: [
      num('vds', 'Vds', 'V', ['Drain to Source Voltage']),
      channel,
      num('id', 'Id', 'A', ['Current - Continuous Drain(Id)']),
      num('rds_on', 'Rds(on)', 'ohm', ['RDS(on)']),
      num('qg', 'Qg', 'C', ['Gate Charge(Qg)']),
      num('vgs_th', 'Vgs(th)', 'V', ['Gate Threshold Voltage (Vgs(th))']),
      num('pd', 'Power dissipation', 'W', ['Pd - Power Dissipation']),
      num('ciss', 'Ciss', 'F', ['Ciss-Input Capacitance']),
    ],
    order: ['vds', 'channel', 'id', 'rds_on', 'qg', 'vgs_th', 'pd', 'ciss'],
    presets: [chain('Highest Vds, lowest Rds(on)', ['vds', 'desc'], ['rds_on', 'asc']), chain('Lowest Rds(on)', ['rds_on', 'asc'], ['vds', 'desc']), chain('Highest current', ['id', 'desc'], ['rds_on', 'asc'])],
  },
  {
    id: 'diode', label: 'Diode', category: 'Discrete - Diode', keyCount: 4,
    matches: (c) => /Single Diodes|Schottky|Switching Diodes|Rectifier|Fast Recovery/i.test(c),
    props: [
      num('vr', 'Reverse voltage', 'V', ['Voltage - DC Reverse (Vr) (Max)']),
      num('if', 'Forward current', 'A', ['Current - Rectified']),
      num('vf', 'Forward voltage', 'V', ['Voltage - Forward(Vf@If)']),
      num('ir', 'Reverse leakage', 'A', ['Reverse Leakage Current (Ir)']),
      num('ifsm', 'Surge current', 'A', ['Non-Repetitive Peak Forward Surge Current']),
    ],
    order: ['vr', 'if', 'vf', 'ir', 'ifsm'],
    presets: [chain('Highest voltage, highest current', ['vr', 'desc'], ['if', 'desc']), chain('Lowest Vf', ['vf', 'asc'], ['if', 'desc'])],
  },
  {
    id: 'ldo', label: 'LDO regulator', category: 'IC - Power', keyCount: 4,
    matches: (c) => /Linear.*(LDO|Low Drop)|Voltage Regulators - Linear/i.test(c),
    props: [
      num('vout', 'Output voltage', 'V', ['Output Voltage']),
      num('iout', 'Output current', 'A', ['Output Current']),
      num('vin_max', 'Input voltage (max)', 'V', ['Operating Voltage']),
      txt('type', 'Output type', ['Output Type']),
      num('iq', 'Quiescent current', 'A', ['Supply Current (Iq)']),
    ],
    order: ['vout', 'iout', 'vin_max', 'type', 'iq'],
    presets: [chain('Output voltage, current', ['vout', 'asc'], ['iout', 'desc']), chain('Lowest quiescent current', ['iq', 'asc'], ['vout', 'asc'])],
  },
  {
    id: 'opamp', label: 'Op amp', category: 'IC - Op Amp', keyCount: 4,
    matches: (c) => /Op Amps/i.test(c),
    props: [
      num('gbw', 'Gain-bandwidth', 'Hz', ['Gain Bandwidth Product']),
      num('channels', 'Channels', 'none', ['Number of Channels'], { fmt: (v) => `${v.n}ch` }),
      num('slew', 'Slew rate', 'V/s', ['Slew Rate']),
      num('vos', 'Input offset', 'V', ['Vos - Input Offset Voltage']),
      rng('supply', 'Supply (single)', 'V', ['Single Supply'], { end: 'max' }),
      num('iq', 'Quiescent current', 'A', ['Quiescent Current']),
    ],
    order: ['gbw', 'channels', 'slew', 'vos', 'supply', 'iq'],
    presets: [chain('Bandwidth, slew rate', ['gbw', 'desc'], ['slew', 'desc']), chain('Lowest offset', ['vos', 'asc'], ['gbw', 'desc'])],
  },
  {
    id: 'audio_amp', label: 'Audio amplifier', category: 'IC - Audio', keyCount: 4,
    matches: (c) => /Audio Amplifiers/i.test(c),
    props: [
      num('power', 'Output power', 'W', ['Output Power']),
      channels('Speaker Channels'),
      txt('class', 'Class', ['Class']),
      rng('supply', 'Supply', 'V', ['Voltage - Supply'], { end: 'max' }),
      num('thd', 'THD+N', '%', ['Total Harmonic Distortion + Noise (THD+N)']),
      num('iq', 'Quiescent current', 'A', ['Quiescent Current']),
    ],
    order: ['power', 'channels', 'class', 'supply', 'thd', 'iq'],
    presets: [chain('Most power', ['power', 'desc'], ['supply', 'desc'])],
  },
  {
    id: 'led', label: 'LED', category: 'Optoelectronics - LED', keyCount: 4,
    matches: (c) => /LED Indication/i.test(c),
    props: [
      txt('color', 'Colour', ['Illumination Color'], { sortVia: 'wavelength' }),
      num('wavelength', 'Wavelength', 'm', ['Peak Wavelength']),
      rng('vf', 'Forward voltage', 'V', ['Voltage - Forward(Vf)'], { end: 'max' }),
      num('if', 'Forward current', 'A', ['Forward Current']),
      num('intensity', 'Luminous intensity', 'cd', ['Luminous Intensity']),
    ],
    order: ['color', 'wavelength', 'vf', 'if', 'intensity'],
    presets: [chain('Colour, brightness', ['color', 'asc'], ['intensity', 'desc'])],
  },
  {
    id: 'connector', label: 'Header / connector', category: 'Connector', keyCount: 4,
    matches: (c) => /Headers|Wire to Board|Female Header|Pin Header/i.test(c),
    props: [
      pins,
      num('pitch', 'Pitch', 'm', ['Pitch']),
      num('current', 'Current rating', 'A', ['Current Rating']),
      num('voltage', 'Voltage rating', 'V', ['Voltage Rating (Max)']),
      num('rows', 'Rows', 'none', ['Number of Rows'], { fmt: (v) => `${v.n} row${v.n === 1 ? '' : 's'}` }),
    ],
    order: ['pins', 'pitch', 'current', 'voltage', 'rows'],
    presets: [chain('Positions, pitch', ['pins', 'asc'], ['pitch', 'asc'])],
  },
  {
    id: 'mcu', label: 'Microcontroller', category: 'IC - MCU', keyCount: 4,
    matches: (c) => /Microcontrollers/i.test(c),
    props: [
      num('flash', 'Program memory', 'B', ['Program Storage Size']),
      num('clock', 'Clock', 'Hz', ['CPU Maximum Speed']),
      num('io', 'I/O pins', 'none', ['Number of I/O'], { fmt: (v) => `${v.n} I/O` }),
      txt('core', 'Core', ['CPU Core'], { fmt: (v) => v.text ?? '' }),
      num('bits', 'Bit width', 'bit', ['Core Size'], { fmt: (v) => `${v.n}-bit` }),
      rng('supply', 'Supply', 'V', ['Voltage - Supply'], { end: 'max' }),
    ],
    order: ['flash', 'clock', 'io', 'core', 'bits', 'supply'],
    presets: [chain('Most memory, fastest', ['flash', 'desc'], ['clock', 'desc'])],
  },
];

export const familyById = (id: string): Family | undefined => FAMILIES.find((f) => f.id === id);

/** Which family an LCSC category belongs to; falls back to the owner's own category when LCSC's is unknown. */
export function detectFamily(catalog: string | undefined, parent: string | undefined, ownerCategory: string | null): Family | null {
  if (catalog) { const hit = FAMILIES.find((f) => f.matches(catalog, parent ?? '')); if (hit) return hit; }
  return FAMILIES.find((f) => f.category === ownerCategory) ?? null;
}

function formatTol(v: SpecValue): string {
  return `${v.n}${v.unit === '%' ? '%' : (v.unit ?? '')}`;
}
