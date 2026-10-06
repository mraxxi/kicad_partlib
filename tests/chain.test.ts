import { describe, expect, it } from 'vitest';
import { chainLabel, chainToSorting, sortingToChain, specColumnId } from '../src/web/chain';
import { familyById } from '../src/domain/specs';

const mosfet = familyById('mosfet')!;

describe('sort chain <-> table sorting', () => {
  it('round-trips spec keys and core columns, keeping order and direction', () => {
    const chain = [{ key: 'vds', dir: 'desc' as const }, { key: 'rds_on', dir: 'asc' as const }, { key: 'col:package', dir: 'asc' as const }];
    const sorting = chainToSorting(mosfet, chain);
    expect(sorting).toEqual([
      { id: specColumnId('mosfet', 'vds'), desc: true }, { id: specColumnId('mosfet', 'rds_on'), desc: false }, { id: 'package', desc: false },
    ]);
    expect(sortingToChain(mosfet, sorting)).toEqual(chain);
  });

  it('ignores sorting on columns a chain cannot describe, and on another family\'s specs', () => {
    expect(sortingToChain(mosfet, [{ id: 'code', desc: false }, { id: 'spec:resistor:power', desc: true }, { id: 'value', desc: false }]))
      .toEqual([{ key: 'col:value', dir: 'asc' }]);
  });

  it('labels spec and core keys for display', () => {
    expect(chainLabel(mosfet, 'rds_on')).toBe('Rds(on)');
    expect(chainLabel(mosfet, 'col:package')).toBe('Footprint');
  });
});
