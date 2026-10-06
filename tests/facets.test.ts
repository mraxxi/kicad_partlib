import { describe, expect, it } from 'vitest';
import { NONE_KEY, facetOptions, familyById, matchesFacets, packageSource, specSource, type PartSpecs } from '../src/domain/specs';

const cap = familyById('capacitor')!;
const mos = familyById('mosfet')!;
const sp = (family: string, props: PartSpecs['props']): PartSpecs => ({ v: 1, family, props });
const c = (n: number, v: number, pkg: string, extra: Record<string, unknown> = {}) =>
  ({ package: pkg, specs: sp('capacitor', { capacitance: { n, unit: 'F', raw: '', src: 'lcsc' }, voltage: { n: v, unit: 'V', raw: '', src: 'lcsc' } }), ...extra });

const parts = [
  c(1e-5, 16, '0805'), c(1e-5, 25, '1206'), c(1e-7, 50, '0805'), c(2.2e-5, 16, '0805'),
  { package: '0603', specs: null }, // not enriched
  c(1e-5 * 1.00001, 10, '0603'), // same 10µF after rounding
];
type P = (typeof parts)[number];
const sources = [packageSource<P>(), specSource(cap, 'capacitance')!, specSource(cap, 'voltage')!];
const [pkg, capacitance] = sources as [typeof sources[0], typeof sources[1], typeof sources[2]];

describe('spec facets', () => {
  it('lists the footprints you have a 10µF in (10uF and 10.00001µF are one value)', () => {
    const o = facetOptions(parts, pkg, sources, { capacitance: ['0.00001'] });
    expect(o.map((x) => [x.label, x.count])).toEqual([['0603', 1], ['0805', 1], ['1206', 1]]);
  });
  it('lists the capacitances you have in 0805, in value order, not alphabetically', () => {
    const o = facetOptions(parts, capacitance, sources, { pkg: ['0805'] });
    expect(o.map((x) => [x.label, x.count])).toEqual([['100nF', 1], ['10µF', 1], ['22µF', 1]]);
  });
  it('counts a facet against the OTHER filters, not its own selection', () => {
    const o = facetOptions(parts, pkg, sources, { pkg: ['0805'] });
    expect(o.find((x) => x.label === '1206')?.count).toBe(1); // still offered while 0805 is ticked
  });
  it('shows un-enriched parts as (none), last, instead of hiding them', () => {
    const o = facetOptions(parts, capacitance, sources, {});
    expect(o[o.length - 1]).toEqual({ key: NONE_KEY, label: '(none)', count: 1 });
  });
  it('is any-of within a facet and all-of across facets', () => {
    const sel = { capacitance: ['0.00001', '0.000022'], pkg: ['0805'] };
    expect(parts.filter((p) => matchesFacets(p, sources, sel))).toHaveLength(2);
  });
  it('keeps a selected value at 0 so it can be unticked', () => {
    const o = facetOptions(parts, capacitance, sources, { pkg: ['1206'], capacitance: ['0.000022'] });
    expect(o.find((x) => x.label === '22µF')).toEqual({ key: '0.000022', label: '22µF', count: 0 });
  });
  it('keeps measurement conditions apart', () => {
    const r = (n: number, cond: string) => ({ package: 'SOT-23', specs: sp('mosfet', { rds_on: { n, unit: 'ohm', raw: '', cond, src: 'lcsc' } }) });
    const ms = [r(0.02, '10V'), r(0.02, '4.5V')];
    const src = specSource(mos, 'rds_on')!;
    expect(facetOptions(ms, src, [src], {})).toHaveLength(2);
  });
  it('does not mistake a package that is literally "-" for a missing value', () => {
    const ps = [{ package: '-', specs: null }, { package: '', specs: null }];
    const o = facetOptions(ps, packageSource<(typeof ps)[number]>(), [packageSource<(typeof ps)[number]>()], {});
    expect(o.map((x) => [x.label, x.count]).sort()).toEqual([['(none)', 1], ['-', 1]]);
  });
  it('has no source for a spec the family lacks', () => {
    expect(specSource(cap, 'rds_on')).toBeNull();
  });
});
