// The windows the dashboard can show. Kept in one place so the API queries and the
// selector cannot drift apart, and so only known-good values ever reach a SQL string.
export const RANGES = ['24h', '7d', '14d', '30d'] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = '30d';

/** Window length in hours — HogQL takes a unit, so normalise everything to hours. */
export const hours = (range: Range): number => {
  const value = Number(range.replace(/[hd]/, ''));
  return range.endsWith('h') ? value : value * 24;
};

/** 24h is bucketed by hour; every other window by day. */
export const isHourly = (range: Range): boolean => range.endsWith('h');

/** Human-facing length, e.g. "24 hours" / "14 days". */
export const describe = (range: Range): string =>
  isHourly(range) ? `${hours(range)} hours` : `${hours(range) / 24} days`;

export const isRange = (value: string | null): value is Range =>
  value !== null && (RANGES as readonly string[]).includes(value);
