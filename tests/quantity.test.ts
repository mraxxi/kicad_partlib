/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { parseQuantity, type Quantity } from '../src/domain/quantity';

const num = (raw: string) => parseQuantity(raw)![0] as Extract<Quantity, { kind: 'num' }>;
const range = (raw: string) => parseQuantity(raw)![0] as Extract<Quantity, { kind: 'range' }>;

describe('parseQuantity: single values become SI numbers', () => {
  it.each([
    ['30V', 30, 'V'], ['100mW', 0.1, 'W'], ['24kΩ', 24000, 'ohm'], ['68mΩ', 0.068, 'ohm'], ['1MΩ', 1e6, 'ohm'],
    ['10uF', 1e-5, 'F'], ['220pF', 2.2e-10, 'F'], ['1.201nF', 1.201e-9, 'F'], ['10uH', 1e-5, 'H'],
    ['500uV', 5e-4, 'V'], ['10pA', 1e-11, 'A'], ['340mA', 0.34, 'A'], ['133MHz', 1.33e8, 'Hz'],
    ['1.5mm', 0.0015, 'm'], ['513nm', 5.13e-7, 'm'], ['1.6N', 1.6, 'N'], ['350mcd', 0.35, 'cd'],
    ['12nC', 1.2e-8, 'C'], ['110dB', 110, 'dB'], ['0.14%', 0.14, '%'], ['12bit', 12, 'bit'], ['8 Bit', 8, 'bit'],
    ['250ms', 0.25, 's'], ['2000hrs', 2000, 'hour'],
  ])('%s -> %s %s', (raw, n, unit) => {
    const q = num(raw);
    expect(q.unit).toBe(unit);
    expect(q.n).toBeCloseTo(n, 14);
  });

  it('uses binary prefixes for memory sizes, as LCSC does', () => {
    expect(num('2KB').n).toBe(2048);
    expect(num('2MB').n).toBe(2 * 1024 ** 2);
    expect(num('32Mbit').n).toBe(32 * 1024 ** 2);
  });

  it('tells milli from mega by case, and metre from milli', () => {
    expect(num('68mΩ').n).toBeCloseTo(0.068, 12);
    expect(num('10MΩ').n).toBe(1e7);
    expect(num('5mm').unit).toBe('m');
    expect(num('5m').n).toBe(5);
  });

  it('reads compound units and keeps the condition apart', () => {
    expect(num('9V/us')).toMatchObject({ unit: 'V/s', n: 9e6 });
    expect(num('4.5nV/√Hz@1kHz')).toMatchObject({ unit: 'V/sqrtHz', cond: '1kHz' });
    expect(num('20mΩ@10V')).toMatchObject({ n: 0.02, unit: 'ohm', cond: '10V' });
    expect(num('490mV@3A')).toMatchObject({ n: 0.49, unit: 'V', cond: '3A' });
    expect(num('100,000 cycles').n).toBe(100000);
  });

  it('reads tolerances and +- values', () => {
    expect(num('±5%')).toMatchObject({ n: 5, unit: '%', plusMinus: true });
    expect(num('±100ppm/℃')).toMatchObject({ n: 100, unit: 'ppm/degC', plusMinus: true });
    expect(num('±20V')).toMatchObject({ n: 20, unit: 'V', plusMinus: true });
  });

  it('reads multiplicity ("3Wx1@4 ohm" is 3 W on one channel at 4 ohm)', () => {
    expect(num('3Wx1@4Ω')).toMatchObject({ n: 3, unit: 'W', count: 1, cond: '4Ω' });
    expect(num('50W×2@4Ω')).toMatchObject({ n: 50, unit: 'W', count: 2 });
  });

  it('keeps a unit it does not know instead of guessing', () => {
    expect(num('4P')).toMatchObject({ unit: 'pin', n: 4 }); // connector pin counts
    expect(num('3 widgets').unit).toBe('?widgets');
    expect(num('2').unit).toBe('none');
  });
});

describe('parseQuantity: ranges, alternatives, text, not-available', () => {
  it('reads ranges whichever end carries the unit', () => {
    expect(range('4.5V~26V')).toMatchObject({ min: 4.5, max: 26, unit: 'V' });
    expect(range('-18V~-2.25V')).toMatchObject({ min: -18, max: -2.25 });
    expect(range('-55℃~+155℃')).toMatchObject({ min: -55, max: 155, unit: 'degC' });
    expect(range('0.5~2.5')).toMatchObject({ min: 0.5, max: 2.5, unit: 'none' });
    expect(range('510nm~530nm')).toMatchObject({ unit: 'm' });
    expect(range('-40℃~+85℃@(Tj)')).toMatchObject({ cond: '(Tj)' });
  });

  it('splits alternatives on ";"', () => {
    const q = parseQuantity('315W×2@4Ω;600W×1@2Ω')!;
    expect(q).toHaveLength(2);
    expect(q[1]).toMatchObject({ n: 600, count: 1, cond: '2Ω' });
    const sup = parseQuantity('-18V~-2.25V;2.25V~18V')!;
    expect(sup.map((x) => (x as { max: number }).max)).toEqual([-2.25, 18]);
  });

  it('treats words as text and "-" as not available', () => {
    expect(parseQuantity('N-Channel')![0]).toMatchObject({ kind: 'text' });
    expect(parseQuantity('Class D')![0]).toMatchObject({ kind: 'text' });
    expect(parseQuantity('X7R')![0]).toMatchObject({ kind: 'text' });
    expect(parseQuantity('-')).toBeNull();
    expect(parseQuantity('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// The oracle. Real LCSC responses (tests/fixtures/lcsc-detail) carry LCSC's own number for many parameters,
// but NOT in SI base units: it is per label (capacitance 1nF is 1000, i.e. picofarads; inductance 10uH is 10).
// So the check is that, for each label and unit, LCSC's number is a CONSTANT multiple of ours across all parts.
// A parser bug (a wrong prefix, a mis-read unit) breaks the constancy.
// ---------------------------------------------------------------------------------------------------------
interface Fixture { status: string; productCode: string; catalog: string; params: Array<{ name: string; value: string; number: number | null }> }
const fixtures = Object.values(import.meta.glob<Fixture>('./fixtures/lcsc-detail/*.json', { eager: true, import: 'default' })).filter((f) => f.status === 'ok');

describe('against real LCSC data', () => {
  it('has the fixtures', () => { expect(fixtures.length).toBeGreaterThan(100); });

  it('agrees with LCSC\'s own numbers, up to one constant unit per label', () => {
    const groups = new Map<string, number[]>();
    let compared = 0, unparsed = 0;
    for (const f of fixtures) {
      for (const p of f.params) {
        if (p.number === null || p.number === -1) continue;
        const q = parseQuantity(p.value)?.[0];
        if (!q || q.kind !== 'num' || q.unit.startsWith('?')) { unparsed++; continue; }
        compared++;
        const key = `${f.catalog} | ${p.name} | ${q.unit}`;
        groups.set(key, [...(groups.get(key) ?? []), p.number / q.n]);
      }
    }
    const inconsistent = [...groups].filter(([, r]) => r.some((x) => Math.abs(x / r[0]! - 1) > 1e-6)).map(([k]) => k);
    console.log(`oracle: ${compared} values compared in ${groups.size} label groups, ${unparsed} not comparable, inconsistent: ${JSON.stringify(inconsistent)}`);
    expect(compared).toBeGreaterThan(300);
    // Known LCSC data quirks, not parser faults (reviewed by hand): see the report.
    expect(inconsistent).toEqual([]);
  });
});
