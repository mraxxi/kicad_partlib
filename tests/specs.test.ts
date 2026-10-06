/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import {
  FAMILIES, detectFamily, familyById, mergeSpecs, resolveLayout, specSortValue, specsFromDescription, specsFromLcsc, summarize,
  type LcscDetail, type PartSpecs,
} from '../src/domain/specs';

const all = Object.values(import.meta.glob<LcscDetail & { status: string }>('./fixtures/lcsc-detail/*.json', { eager: true, import: 'default' })).filter((f) => f.status === 'ok');
const byModel = (m: string) => all.find((f) => f.productModel === m)!;
const specs = (m: string, category: string | null = null) => specsFromLcsc(byModel(m), category);
const line = (m: string) => { const s = summarize(specs(m)); return { value: s.value?.text, keys: s.keys.map((k) => k.text) }; };

describe('mapping real LCSC records onto families', () => {
  it('maps a MOSFET, with the test condition kept apart from the number', () => {
    const s = specs('AON7410');
    expect(s.family).toBe('mosfet');
    expect(s.props.vds).toMatchObject({ n: 30, unit: 'V', src: 'lcsc' });
    expect(s.props.rds_on).toMatchObject({ n: 0.02, unit: 'ohm', cond: '10V' });
    expect(s.props.qg).toMatchObject({ n: 1.2e-8, cond: '10V' });
    expect(line('AON7410')).toEqual({ value: '30V', keys: ['N-ch', '50A', '20mΩ@10V', '12nC@10V', '2.5V'] });
  });

  it('reads polarity from Number when Type is missing, and counts dual devices', () => {
    expect(summarize(specs('20P02D')).all.find((s) => s.key === 'channel')?.text).toBe('P-ch');
    expect(summarize(specs('2N7002KDW')).all.find((s) => s.key === 'channel')?.text).toBe('2×N-ch');
  });

  it('maps an audio amplifier: power with channels and load, a supply range, a class', () => {
    const s = specs('TPA3116D2DADR');
    expect(s.family).toBe('audio_amp');
    expect(s.props.power).toMatchObject({ n: 50, unit: 'W', count: 2, cond: '4Ω' });
    expect(s.props.supply).toMatchObject({ min: 4.5, max: 26 });
    expect(line('TPA3116D2DADR')).toMatchObject({ value: '50W×2@4Ω', keys: ['2ch', 'Class D', '4.5V~26V', '0.1%'] });
  });

  it('takes the headline of several alternatives and keeps the full text', () => {
    expect(specs('TPA3255DDVR').props.power).toMatchObject({ n: 315, count: 2, cond: '4Ω', raw: '315W×2@4Ω;600W×1@2Ω' });
  });

  it('makes Value the first AVAILABLE spec: a part with no flash size shows its clock', () => {
    expect(specs('RP2350A').props.flash).toBeUndefined();
    expect(line('RP2350A').value).toBe('150MHz');
    expect(line('RP2354B').value).toBe('2MB');
  });

  it('shows what little LCSC gave for a sparse record (RC4580IDR carries amplifier labels under op amps)', () => {
    const s = summarize(specs('RC4580IDR'));
    expect(s.value).toMatchObject({ key: 'iq', text: '9mA' });
    expect(s.keys).toEqual([]);
  });

  it('falls back to LCSC\'s own title when no spec could be mapped', () => {
    const d: LcscDetail = { ...byModel('AON7410'), params: [] };
    expect(summarize(specsFromLcsc(d, null)).value).toMatchObject({ key: 'title', text: 'N-Channel 30V 50A Surface Mount DFN-8(3x3)' });
  });

  it('keeps no family for categories not in the registry, and still keeps the title', () => {
    const s = specs('PCM5102APWR');
    expect(s.family).toBe('');
    expect(summarize(s).value?.key).toBe('title');
  });

  it('refuses a value whose unit is not the one the spec expects', () => {
    const d: LcscDetail = { ...byModel('AON7410'), params: [{ name: 'Drain to Source Voltage', value: '30A', number: 30 }] };
    expect(specsFromLcsc(d, null).props.vds).toBeUndefined();
  });

  it('formats units the way people write them', () => {
    expect(line('OPA1678IDR').keys).toContain('9V/µs');
    expect(line('PMS150C-S08').value).toBe('2KB');
    expect(line('XC6206P332MR-MS')).toMatchObject({ value: '3.3V' });
    expect(line('F.0402.00001/P2-0402G1TS2-045T-001').value).toBe('Emerald Green');
  });

  it('finds the family from LCSC\'s category, falling back to the owner\'s category', () => {
    expect(detectFamily('Single FETs, MOSFETs', 'Transistors/Thyristors', null)?.id).toBe('mosfet');
    expect(detectFamily(undefined, undefined, 'Passive - Resistor')?.id).toBe('resistor');
    expect(detectFamily('Memory', 'Memory', 'IC - Memory')).toBeNull();
  });

  it('keeps the registry consistent: every ordered key exists, every preset key is a spec or a core column', () => {
    for (const f of FAMILIES) {
      const keys = new Set(f.props.map((p) => p.key));
      expect(new Set(f.order)).toEqual(keys);
      for (const p of f.presets) for (const c of p.chain) expect(keys.has(c.key) || c.key.startsWith('col:')).toBe(true);
    }
  });
});

describe('every real resistor, capacitor and inductor', () => {
  const passives = all.filter((f) => ['resistor', 'capacitor', 'inductor'].includes(detectFamily(f.catalog, f.parentCatalog, null)?.id ?? ''));

  it('has a Value from LCSC', () => {
    expect(passives.length).toBeGreaterThan(60);
    for (const f of passives) expect(summarize(specsFromLcsc(f, null)).value, f.productModel).not.toBeNull();
  });

  it('reads the same specs from the DESCRIPTION text as LCSC reports (the offline path agrees with the source)', () => {
    let compared = 0;
    const disagreements: string[] = [];
    for (const f of passives) {
      const lc = specsFromLcsc(f, null);
      const fromText = specsFromDescription(lc.family, f.intro ?? f.desc ?? '');
      if (!fromText) continue;
      for (const [k, v] of Object.entries(fromText.props)) {
        const ref = lc.props[k];
        if (!ref) continue;
        compared++;
        const a = v.n ?? v.text, b = ref.n ?? ref.text;
        if (typeof a === 'number' && typeof b === 'number' ? Math.abs(a / b - 1) > 1e-9 : a !== b) disagreements.push(`${f.productModel} ${k}: description ${a} vs LCSC ${b}`);
      }
    }
    console.log(`description vs LCSC: ${compared} values compared, disagreements: ${JSON.stringify(disagreements)}`);
    expect(compared).toBeGreaterThan(200);
    expect(disagreements).toEqual([]);
  });

  it('reads a typical resistor line completely', () => {
    const s = specsFromDescription('resistor', '125mW 100Ω 150V Thick Film Resistor ±100ppm/℃ ±1% 0805 Chip Resistor - Surface Mount RoHS')!;
    expect(s.props.resistance).toMatchObject({ n: 100, src: 'description' });
    expect(s.props.power!.n).toBeCloseTo(0.125, 12);
    expect(s.props).toMatchObject({ voltage: { n: 150 }, tolerance: { n: 1 }, tempco: { n: 100 } });
    expect(s.props.technology!.text).toBe('Thick Film Resistor');
  });

  it('reads an inductor line: first current is rated, second is saturation', () => {
    const s = specsFromDescription('inductor', '2.4A 10uH ±20% 330mΩ 2.5A Molded inductor 1210 Fixed Inductors RoHS')!;
    expect(s.props).toMatchObject({ inductance: { n: 1e-5 }, current: { n: 2.4 }, isat: { n: 2.5 }, tolerance: { n: 20 } });
    expect(s.props.dcr!.n).toBeCloseTo(0.33, 12);
  });

  it('offers nothing for families it has no text rules for', () => {
    expect(specsFromDescription('mosfet', 'N-Channel 30V 50A')).toBeNull();
  });
});

describe('merging: manual > lcsc > description', () => {
  const val = (n: number, src: 'manual' | 'lcsc' | 'description') => ({ n, unit: 'V', raw: `${n}V`, src });
  const mk = (props: PartSpecs['props']): PartSpecs => ({ v: 1, family: 'mosfet', props });

  it('adds what is missing and reports what is unchanged', () => {
    const { next, changes } = mergeSpecs(mk({ vds: val(30, 'lcsc') }), mk({ vds: val(30, 'lcsc'), vgs_th: val(2, 'lcsc') }));
    expect(changes.map((c) => [c.key, c.action])).toEqual([['vds', 'same'], ['vgs_th', 'new']]);
    expect(Object.keys(next.props).sort()).toEqual(['vds', 'vgs_th']);
  });

  it('never overwrites a value you set by hand', () => {
    const { next, changes } = mergeSpecs(mk({ vds: val(25, 'manual') }), mk({ vds: val(30, 'lcsc') }));
    expect(next.props.vds!.n).toBe(25);
    expect(changes[0]).toMatchObject({ action: 'kept', reason: 'you set this by hand' });
  });

  it('lets LCSC update LCSC, and LCSC replace a description, but not the reverse', () => {
    expect(mergeSpecs(mk({ vds: val(30, 'lcsc') }), mk({ vds: val(40, 'lcsc') })).next.props.vds!.n).toBe(40);
    expect(mergeSpecs(mk({ vds: val(30, 'description') }), mk({ vds: val(40, 'lcsc') })).next.props.vds!.n).toBe(40);
    const back = mergeSpecs(mk({ vds: val(40, 'lcsc') }), mk({ vds: val(30, 'description') }));
    expect(back.next.props.vds!.n).toBe(40);
    expect(back.changes[0]!.action).toBe('kept');
  });

  it('planning is pure: the inputs are not modified', () => {
    const before = mk({ vds: val(25, 'manual') });
    const copy = JSON.stringify(before);
    mergeSpecs(before, mk({ vds: val(30, 'lcsc') }));
    expect(JSON.stringify(before)).toBe(copy);
  });
});

describe('layouts and sorting', () => {
  const mosfet = familyById('mosfet')!;

  it('applies the owner\'s order and key count over the built-in layout, dropping unknown keys', () => {
    const l = resolveLayout(mosfet, { order: ['rds_on', 'nonsense', 'vds'], keyCount: 2 });
    expect(l.order.slice(0, 2)).toEqual(['rds_on', 'vds']);
    expect(l.order).toContain('qg');
    expect(l.keyCount).toBe(2);
    expect(summarize(specs('AON7410'), l).value?.text).toBe('20mΩ@10V');
  });

  it('sorts a MOSFET list by Vds descending, then Rds(on) ascending', () => {
    const fets = all.filter((f) => f.catalog.includes('MOSFET')).map((f) => ({ m: f.productModel, s: specsFromLcsc(f, null) }));
    const fam = mosfet;
    fets.sort((a, b) => {
      const va = specSortValue(fam, a.s, 'vds') as number, vb = specSortValue(fam, b.s, 'vds') as number;
      if (va !== vb) return vb - va;
      return ((specSortValue(fam, a.s, 'rds_on') as number) ?? Infinity) - ((specSortValue(fam, b.s, 'rds_on') as number) ?? Infinity);
    });
    expect(fets.map((f) => f.m).slice(0, 3)).toEqual(['SKQ05P10AD', '2N7002KDW', '50N04F']);
  });

  it('sorts LED colour by wavelength, and puts parts without the spec last', () => {
    const led = familyById('led')!;
    expect(typeof specSortValue(led, specs('F.0402.00001/P2-0402G1TS2-045T-001'), 'color')).toBe('number');
    expect(specSortValue(mosfet, specs('AON7410'), 'qg')).toBeDefined();
    expect(specSortValue(mosfet, null, 'vds')).toBeUndefined();
  });
});
