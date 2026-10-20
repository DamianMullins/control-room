// Sentry: issues, error volume, and Application Metrics (tracemetrics dataset).
// The region matters: an EU/DE org must be queried against de.sentry.io, not sentry.io.
import { env } from '#lib/config.js';

const BASE = env('SENTRY_BASE_URL') ?? 'https://de.sentry.io/api/0';
const ORG = env('SENTRY_ORG');
const PROJECT = env('SENTRY_PROJECT');

export interface SentryIssue {
  shortId: string;
  title: string;
  count: number;
  userCount: number;
  status: string;
  level: string;
  lastSeen: string;
  permalink: string;
}

export interface SentryMetric {
  label: string;
  field: string;
  period: string;
  value: number | null;
}

export interface SentryTiles {
  project: string;
  region: string;
  topIssues: SentryIssue[];
  unresolved: { count: number; issues: SentryIssue[] };
  errorVolume: { d24h: number | null; d30d: number | null; daily: { day: string; count: number }[] };
  metrics: SentryMetric[];
  errors: string[];
}

interface RawIssue {
  shortId: string;
  title: string;
  count: string | number;
  userCount: number;
  status: string;
  level: string;
  lastSeen: string;
  permalink: string;
}

type Params = Record<string, string | number | undefined | null>;

async function api<T>(path: string, params: Params = {}): Promise<T> {
  const token = env('SENTRY_AUTH_TOKEN');
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');
  if (!ORG || !PROJECT) throw new Error('SENTRY_ORG and SENTRY_PROJECT must be set');

  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sentry ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Scalar value of a single-field /events query, or null when it never fired. */
async function scalar(field: string, statsPeriod: string, dataset = 'tracemetrics'): Promise<number | null> {
  const body = await api<{ data?: Record<string, number>[] }>(`/organizations/${ORG}/events/`, {
    dataset,
    field,
    statsPeriod,
  });
  const value = body.data?.[0]?.[field];
  return typeof value === 'number' ? value : null;
}

const fmtIssue = (i: RawIssue): SentryIssue => ({
  shortId: i.shortId,
  title: i.title,
  count: Number(i.count),
  userCount: i.userCount,
  status: i.status,
  level: i.level,
  lastSeen: i.lastSeen,
  permalink: i.permalink,
});

export async function sentryTiles(): Promise<SentryTiles> {
  const errors: string[] = [];
  const out: SentryTiles = {
    project: `${ORG ?? ''}/${PROJECT ?? ''}`,
    region: BASE.includes('de.sentry.io') ? 'DE' : 'US',
    topIssues: [],
    unresolved: { count: 0, issues: [] },
    errorVolume: { d24h: null, d30d: null, daily: [] },
    metrics: [],
    errors,
  };

  const settle = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message}`);
      return null;
    }
  };

  const issues = await settle('issues', () =>
    api<RawIssue[]>(`/projects/${ORG}/${PROJECT}/issues/`, {
      query: '',
      statsPeriod: '14d',
      limit: 10,
      sort: 'freq',
    })
  );
  if (issues) out.topIssues = issues.map(fmtIssue);

  const unresolved = await settle('unresolved', () =>
    api<RawIssue[]>(`/projects/${ORG}/${PROJECT}/issues/`, {
      query: 'is:unresolved',
      statsPeriod: '14d',
      limit: 25,
      sort: 'freq',
    })
  );
  if (unresolved) {
    out.unresolved.count = unresolved.length;
    out.unresolved.issues = unresolved.slice(0, 5).map(fmtIssue);
  }

  out.errorVolume.d24h = await settle('errors24h', () => scalar('count()', '24h', 'errors'));
  out.errorVolume.d30d = await settle('errors30d', () => scalar('count()', '30d', 'errors'));

  const series = await settle('errorsStats', () =>
    api<{ data?: [number, { count?: number }[]][] }>(`/organizations/${ORG}/events-stats/`, {
      dataset: 'errors',
      yAxis: 'count()',
      statsPeriod: '14d',
      interval: '1d',
    })
  );
  if (Array.isArray(series?.data)) {
    // Sentry returns one extra leading bucket for the period — keep exactly 14 days.
    out.errorVolume.daily = series.data
      .map(([ts, values]) => ({
        day: new Date(ts * 1000).toISOString().slice(0, 10),
        count: values?.[0]?.count ?? 0,
      }))
      .slice(-14);
  }

  // Application metrics. Unit must match the registered unit or the query reads 0.
  const METRICS: Omit<SentryMetric, 'value'>[] = [
    { label: 'Articles saved', field: 'count(value,articles_saved,counter,none)', period: '30d' },
    { label: 'Save duration p95 (s)', field: 'p95(value,save_duration,distribution,none)', period: '30d' },
    { label: 'Queue save p95 (ms)', field: 'p95(value,queue_save_ms,distribution,none)', period: '30d' },
    { label: 'Queue depth (max)', field: 'max(value,queue_depth,gauge,none)', period: '7d' },
  ];

  for (const metric of METRICS) {
    const value = await settle(metric.field, () => scalar(metric.field, metric.period));
    out.metrics.push({ ...metric, value });
  }

  return out;
}
