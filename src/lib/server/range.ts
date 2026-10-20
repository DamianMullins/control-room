// The windows the dashboard can show. Kept in one place so the API queries and the
// selector cannot drift apart, and so only known-good values ever reach a SQL string.
export const RANGES = ['7d', '14d', '30d'] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = '30d';

export const days = (range: Range): number => Number(range.replace('d', ''));

export const isRange = (value: string | null): value is Range =>
  value !== null && (RANGES as readonly string[]).includes(value);
