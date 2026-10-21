import { toKebabSlug, toSnakeCase, uniqueKebabSlug } from './names';

describe('names', () => {
  it('converts camelCase keys to snake_case', () => {
    expect(toSnakeCase('usdValue')).toBe('usd_value');
    expect(toSnakeCase('chainId')).toBe('chain_id');
    expect(toSnakeCase('already_snake')).toBe('already_snake');
  });

  it('converts event display names to kebab slugs', () => {
    expect(toKebabSlug('App Opened')).toBe('app-opened');
    expect(toKebabSlug('Perp Trade Transaction')).toBe(
      'perp-trade-transaction',
    );
    expect(toKebabSlug('Foo Bar')).toBe(toKebabSlug('Foo-Bar'));
  });

  it('keeps a free slug and suffixes a taken one', () => {
    expect(uniqueKebabSlug('App Opened', new Set())).toBe('app-opened');
    expect(uniqueKebabSlug('Foo-Bar', new Set(['foo-bar']))).toBe('foo-bar-2');
    expect(uniqueKebabSlug('Foo-Bar', new Set(['foo-bar', 'foo-bar-2']))).toBe(
      'foo-bar-3',
    );
    expect(uniqueKebabSlug('***', new Set())).toBe('event');
  });

  it('throws when every slug suffix is taken', () => {
    const taken = new Set<string>(['foo-bar']);
    for (let suffix = 2; suffix <= 99; suffix += 1) {
      taken.add(`foo-bar-${suffix}`);
    }

    expect(() => uniqueKebabSlug('Foo Bar', taken)).toThrow(
      'No free schema filename for event "Foo Bar"',
    );
  });
});
