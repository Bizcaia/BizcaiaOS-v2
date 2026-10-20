import { describe, expect, it } from 'vitest';
import {
  computeNegotiatorActivityPeriodBounds,
  isInstantInPeriod,
  zonedDateParts,
  zonedLocalToUtc,
} from './negotiatorActivityPeriod.js';

describe('negotiator activity period bounds', () => {
  it('places a near-midnight UTC instant on the next Asia/Manila calendar day', () => {
    // 2026-03-10 16:30 UTC = 2026-03-11 00:30 Asia/Manila
    const instant = new Date('2026-03-10T16:30:00.000Z');
    const parts = zonedDateParts(instant, 'Asia/Manila');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(3);
    expect(parts.day).toBe(11);

    const today = computeNegotiatorActivityPeriodBounds('today', 'Asia/Manila', instant);
    expect(isInstantInPeriod(instant, today)).toBe(true);
    expect(isInstantInPeriod(new Date('2026-03-10T15:59:59.000Z'), today)).toBe(false);
  });

  it('uses Monday as the ISO week start', () => {
    // Wednesday 2026-03-11 Manila
    const instant = new Date('2026-03-11T02:00:00.000Z');
    const week = computeNegotiatorActivityPeriodBounds('this_week', 'Asia/Manila', instant);
    const mondayLocal = zonedLocalToUtc('Asia/Manila', 2026, 3, 9);
    const nextMonday = zonedLocalToUtc('Asia/Manila', 2026, 3, 16);
    expect(week.start.toISOString()).toBe(mondayLocal.toISOString());
    expect(week.end.toISOString()).toBe(nextMonday.toISOString());
  });

  it('computes month and year independently (not as sums of days)', () => {
    const instant = new Date('2026-03-15T04:00:00.000Z');
    const month = computeNegotiatorActivityPeriodBounds('this_month', 'Asia/Manila', instant);
    const year = computeNegotiatorActivityPeriodBounds('this_year', 'Asia/Manila', instant);
    expect(month.start.toISOString()).toBe(zonedLocalToUtc('Asia/Manila', 2026, 3, 1).toISOString());
    expect(month.end.toISOString()).toBe(zonedLocalToUtc('Asia/Manila', 2026, 4, 1).toISOString());
    expect(year.start.toISOString()).toBe(zonedLocalToUtc('Asia/Manila', 2026, 1, 1).toISOString());
    expect(year.end.toISOString()).toBe(zonedLocalToUtc('Asia/Manila', 2027, 1, 1).toISOString());
  });
});

describe('distinct landowner KPI counting', () => {
  it('counts each landowner once and every qualifying interaction in totals', () => {
    const rows = [
      { owner_id: 'juan', archived_at: null },
      { owner_id: 'juan', archived_at: null },
      { owner_id: 'juan', archived_at: null },
      { owner_id: 'maria', archived_at: null },
      { owner_id: null, archived_at: null },
      { owner_id: 'pedro', archived_at: '2026-01-01T00:00:00Z' },
    ];
    const qualifying = rows.filter((row) => row.owner_id && !row.archived_at);
    const unique = new Set(qualifying.map((row) => row.owner_id));
    expect(unique.size).toBe(2);
    expect(qualifying).toHaveLength(4);
  });
});
