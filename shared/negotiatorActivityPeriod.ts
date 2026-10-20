/**
 * Negotiator Activity KPI reporting periods.
 * Calendar boundaries are organization-local; PostgreSQL date_trunc('week')
 * uses ISO weeks (Monday start) — the same rule used by the server SQL.
 */

export const NEGOTIATOR_ACTIVITY_PERIODS = ['today', 'this_week', 'this_month', 'this_year'] as const;

export type NegotiatorActivityPeriod = (typeof NEGOTIATOR_ACTIVITY_PERIODS)[number];

export const NEGOTIATOR_ACTIVITY_PERIOD_LABELS: Record<NegotiatorActivityPeriod, string> = {
  today: 'Today',
  this_week: 'This Week',
  this_month: 'This Month',
  this_year: 'This Year',
};

export function isNegotiatorActivityPeriod(value: string): value is NegotiatorActivityPeriod {
  return (NEGOTIATOR_ACTIVITY_PERIODS as readonly string[]).includes(value);
}

/** Parts of an instant in a named IANA timezone. */
export function zonedDateParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sun .. 6=Sat (JS convention)
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(instant);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')),
    minute: Number(read('minute')),
    second: Number(read('second')),
    weekday: weekdayMap[read('weekday')] ?? 0,
  };
}

/**
 * Convert a local civil datetime in `timeZone` to a UTC Date.
 * Mirrors PostgreSQL: `timestamp AT TIME ZONE zone`.
 */
export function zonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const asLocal = zonedDateParts(new Date(utcGuess), timeZone);
  const asIfUtc = Date.UTC(asLocal.year, asLocal.month - 1, asLocal.day, asLocal.hour, asLocal.minute, asLocal.second);
  const offsetMs = asIfUtc - utcGuess;
  return new Date(utcGuess - offsetMs);
}

export type PeriodBounds = {
  period: NegotiatorActivityPeriod;
  timeZone: string;
  start: Date;
  end: Date;
};

/**
 * Organization-local period bounds as UTC instants [start, end).
 * Week starts Monday (ISO), matching PostgreSQL date_trunc('week', ...).
 */
export function computeNegotiatorActivityPeriodBounds(
  period: NegotiatorActivityPeriod,
  timeZone: string,
  now: Date = new Date(),
): PeriodBounds {
  const local = zonedDateParts(now, timeZone);

  if (period === 'today') {
    const start = zonedLocalToUtc(timeZone, local.year, local.month, local.day);
    const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    const end = zonedLocalToUtc(timeZone, nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate());
    return { period, timeZone, start, end };
  }

  if (period === 'this_week') {
    // ISO: Monday = start. JS weekday 0=Sun → days since Monday.
    const daysSinceMonday = (local.weekday + 6) % 7;
    const mondayUtc = new Date(Date.UTC(local.year, local.month - 1, local.day - daysSinceMonday));
    const start = zonedLocalToUtc(timeZone, mondayUtc.getUTCFullYear(), mondayUtc.getUTCMonth() + 1, mondayUtc.getUTCDate());
    const sundayPlus = new Date(Date.UTC(mondayUtc.getUTCFullYear(), mondayUtc.getUTCMonth(), mondayUtc.getUTCDate() + 7));
    const end = zonedLocalToUtc(timeZone, sundayPlus.getUTCFullYear(), sundayPlus.getUTCMonth() + 1, sundayPlus.getUTCDate());
    return { period, timeZone, start, end };
  }

  if (period === 'this_month') {
    const start = zonedLocalToUtc(timeZone, local.year, local.month, 1);
    const nextMonth = new Date(Date.UTC(local.year, local.month, 1)); // month is 1-based local; Date.UTC month 0-based: local.month is next
    const end = zonedLocalToUtc(timeZone, nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 1);
    return { period, timeZone, start, end };
  }

  // this_year
  const start = zonedLocalToUtc(timeZone, local.year, 1, 1);
  const end = zonedLocalToUtc(timeZone, local.year + 1, 1, 1);
  return { period, timeZone, start, end };
}

/** Whether an instant falls in [start, end). */
export function isInstantInPeriod(instant: Date, bounds: PeriodBounds): boolean {
  const ms = instant.getTime();
  return ms >= bounds.start.getTime() && ms < bounds.end.getTime();
}
