import { toKebabSlug, toSnakeCase } from './names';

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
  });
});
