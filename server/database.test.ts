import { describe, expect, it } from 'vitest';
import { pool } from './database.js';

// The API's connection pool decides how column values reach the routes.
describe('API database pool', () => {
  const parser = (oid: number) => pool.options.types!.getTypeParser(oid) as (value: string) => unknown;

  it('returns a date column as the stored day, not as an instant in the server timezone', () => {
    const DATE = 1082;
    for (const day of ['2026-09-26', '2026-01-01', '2028-02-29', '0001-01-01']) {
      expect(parser(DATE)(day)).toBe(day);
    }
  });

  it('leaves every other type to the driver', () => {
    const TIMESTAMPTZ = 1184;
    const INT8 = 20;
    const BOOL = 16;
    const instant = parser(TIMESTAMPTZ)('2026-09-26 00:00:00+00');
    expect(instant).toBeInstanceOf(Date);
    expect((instant as Date).toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(parser(INT8)('42')).toBe('42');
    expect(parser(BOOL)('t')).toBe(true);
  });
});
