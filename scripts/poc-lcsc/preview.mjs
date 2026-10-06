// Proof of concept: what Value / Key specs would look like, built from the saved LCSC fixtures with the real
// quantity parser. Throwaway mapping (the real registry will live in src/domain/specs/). Run:
//   node scripts/poc-lcsc/preview.mjs [family]
import { readFileSync, readdirSync } from 'node:fs';
import { parseQuantity } from '../../src/domain/quantity.ts';

const parts = readdirSync('tests/fixtures/lcsc-detail').map((f) => JSON.parse(readFileSync(`tests/fixtures/lcsc-detail/${f}`, 'utf8'))).filter((p) => p.status === 'ok');
const PRE = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']];
const SYM = { ohm: 'Ω', degC: '℃', '%': '%', none: '' };
function fmt(n, unit) {
  const a = Math.abs(n);
  const [scale, p] = PRE.find(([s]) => a >= s * 0.9999) ?? PRE[PRE.length - 1];
  return `${+(n / scale).toPrecision(4)}${p}${SYM[unit] ?? unit}`;
}
const q1 = (p, label) => { const x = p.params.find((a) => a.name === label); return x ? parseQuantity(x.value)?.[0] : undefined; };
const show = (q) => (!q ? null : q.kind === 'num' ? fmt(q.n, q.unit) + (q.cond ? `@${q.cond}` : '') : q.kind === 'range' ? `${fmt(q.min, q.unit)}~${fmt(q.max, q.unit)}` : q.text);
const num = (q) => (q?.kind === 'num' ? q.n : q?.kind === 'range' ? q.max : undefined);

// family -> [value label, [key spec labels in importance order]]
const FAMILIES = {
  'Single FETs, MOSFETs': ['Drain to Source Voltage', ['Type', 'Current - Continuous Drain(Id)', 'RDS(on)', 'Gate Charge(Qg)']],
  'Chip Resistor - Surface Mount': ['Resistance', ['Power(Watts)', 'Tolerance', 'Type']],
  'Ceramic Capacitors': ['Capacitance', ['Voltage Rating', 'Temperature Coefficient', 'Tolerance']],
  'Fixed Inductors': ['Inductance', ['Current Rating', 'DC Resistance(DCR)', 'Tolerance']],
  'Voltage Regulators - Linear, Low Drop Out (LDO) Regulators': ['Output Voltage', ['Output Current', 'Operating Voltage', 'Output Type']],
  'Instrumentation, Op Amps, Buffer Amps': ['Gain Bandwidth Product', ['Number of Channels', 'Slew Rate', 'Vos - Input Offset Voltage', 'Single Supply']],
  'Audio Amplifiers': ['Output Power', ['Speaker Channels', 'Class', 'Voltage - Supply']],
  'Microcontrollers': ['Program Storage Size', ['CPU Maximum Speed', 'Number of I/O', 'CPU Core']],
  'Single Diodes': ['Voltage - DC Reverse (Vr) (Max)', ['Current - Rectified', 'Voltage - Forward(Vf@If)']],
  'Headers, Male Pins': ['Number of PINs', ['Pitch', 'Current Rating']],
  'LED Indication - Discrete': ['Illumination Color', ['Voltage - Forward(Vf)', 'Forward Current', 'Luminous Intensity']],
};
const only = process.argv[2];
for (const [catalog, [valueLabel, keys]] of Object.entries(FAMILIES)) {
  if (only && !catalog.toLowerCase().includes(only.toLowerCase())) continue;
  const list = parts.filter((p) => p.catalog === catalog);
  console.log(`\n== ${catalog} (${list.length})  Value = ${valueLabel}  Key specs = ${keys.join(' | ')}`);
  for (const p of list.slice(0, 8)) {
    const v = show(q1(p, valueLabel)) ?? '(none)';
    const k = keys.map((l) => show(q1(p, l))).filter(Boolean).join(' · ');
    console.log(`  ${p.productModel.padEnd(24)} ${p.package.padEnd(16)} | ${v.padEnd(10)} | ${k}`);
  }
}

// Sort chain demo: MOSFETs by Vds descending, then Rds(on) ascending. Note the CONDITIONS.
const fets = parts.filter((p) => p.catalog === 'Single FETs, MOSFETs').map((p) => ({ p, vds: num(q1(p, 'Drain to Source Voltage')), rds: q1(p, 'RDS(on)') }));
fets.sort((a, b) => (b.vds ?? -1) - (a.vds ?? -1) || (num(a.rds) ?? Infinity) - (num(b.rds) ?? Infinity));
console.log('\n== MOSFETs sorted by Vds (desc) then Rds(on) (asc)');
for (const { p, vds, rds } of fets) console.log(`  ${p.productModel.padEnd(14)} Vds ${String(show({ kind: 'num', n: vds, unit: 'V' })).padEnd(6)} Rds(on) ${show(rds) ?? '-'}`);
