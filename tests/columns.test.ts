import { describe, expect, it } from 'vitest';
import { BASE_ORDER, LAYOUT_KEY, moveColumn, parseLayout, stepColumn } from '../src/web/columns';

describe('Parts column order', () => {
  it('puts LCSC # right after MPN by default', () => {
    expect(BASE_ORDER.slice(0, 4)).toEqual(['code', 'mpn', 'lcsc', 'value']);
    expect(parseLayout(null, null).order.slice(0, 4)).toEqual(['code', 'mpn', 'lcsc', 'value']);
  });

  it('upgrades a v2 layout: LCSC # moves after MPN, widths, hidden columns and the rest of the order stay', () => {
    const v2 = JSON.stringify({ order: ['code', 'mpn', 'value', 'package', 'lcsc', 'category'], visibility: { category: false, worth: false }, sizing: { mpn: 222 } });
    const l = parseLayout(null, v2);
    expect(l.order.slice(0, 6)).toEqual(['code', 'mpn', 'lcsc', 'value', 'package', 'category']);
    expect(l.sizing).toEqual({ mpn: 222 });
    expect(l.visibility.category).toBe(false);
    expect(l.visibility.manufacturer).toBe(false); // default hidden still applies
    expect(l.order).toHaveLength(BASE_ORDER.length);
  });

  it('prefers a v3 layout over v2 and does not move LCSC # again', () => {
    const v3 = JSON.stringify({ order: ['code', 'mpn', 'value', 'lcsc'] });
    expect(parseLayout(v3, JSON.stringify({ order: ['code', 'mpn', 'lcsc'] })).order.slice(0, 4)).toEqual(['code', 'mpn', 'value', 'lcsc']);
    expect(LAYOUT_KEY).toContain('v3');
  });

  it('drops unknown ids, appends new columns and survives bad JSON', () => {
    expect(parseLayout(JSON.stringify({ order: ['nope', 'worth', 'spec:capacitor:esr'] }), null).order).toEqual(
      ['code', 'mpn', 'worth', 'spec:capacitor:esr', ...BASE_ORDER.filter((x) => !['code', 'mpn', 'worth'].includes(x))]);
    expect(parseLayout('{bad', null).order).toEqual(BASE_ORDER);
    expect(parseLayout('null', null).order).toEqual(BASE_ORDER);
  });

  const ids = ['code', 'mpn', 'a', 'b', 'c'];
  it('moves a column before or after another', () => {
    expect(moveColumn(ids, 'c', 'a', 'before')).toEqual(['code', 'mpn', 'c', 'a', 'b']);
    expect(moveColumn(ids, 'a', 'c', 'after')).toEqual(['code', 'mpn', 'b', 'c', 'a']);
  });
  it('never moves a pinned column and never drops anything in front of one', () => {
    expect(moveColumn(ids, 'mpn', 'c', 'after')).toEqual(ids);
    expect(moveColumn(ids, 'c', 'code', 'before')).toEqual(['code', 'mpn', 'c', 'a', 'b']);
    expect(moveColumn(ids, 'c', 'mpn', 'before')).toEqual(['code', 'mpn', 'c', 'a', 'b']);
    expect(moveColumn(ids, 'c', 'zzz', 'after')).toEqual(ids);
  });
  it('steps one place and stops at the pinned edge and the end', () => {
    expect(stepColumn(ids, 'b', -1)).toEqual(['code', 'mpn', 'b', 'a', 'c']);
    expect(stepColumn(ids, 'a', -1)).toEqual(ids);
    expect(stepColumn(ids, 'c', 1)).toEqual(ids);
  });
});
