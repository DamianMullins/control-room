// Sentry: issues, error volume, and Application Metrics (tracemetrics dataset).
// The region matters: an EU/DE org must be queried against de.sentry.io, not sentry.io.
import { env } from '#lib/config.js';
import { hours, isHourly, type Range, DEFAULT_RANGE } from '#lib/server/range.js';

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
  value: number | null;
}

export interface VolumePoint {
  label: string;
  full: string;
  count: number;
}

export interface SentryTiles {
  project: string;
  region: string;
  topIssues: SentryIssue[];
  /**
   * Issue GROUPS, not events: `count` is how many groups are unresolved and `events`
   * is what those groups contain. The error-volume tile counts EVENTS, so the two
   * numbers are different units on purpose.
   */
  unresolved: { count: number; events: number; issues: SentryIssue[] };
  errorVolume: { d24h: number | null; total: number | null; series: VolumePoint[] };
  metrics: SentryMetric[];
  /** Successful API calls made for this render — the Sentry counterpart to PostHog's bytes. */
  calls: number;
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

export async function sentryTiles(range: Range = DEFAULT_RANGE): Promise<SentryTiles> {
  const errors: string[] = [];
  const hourly = isHourly(range);
  const window = hours(range);
  let calls = 0;

  async function api<T>(path: string, params: Params = {}): Promise<T> {
    const token = env('SENTRY_AUTH_TOKEN');
    if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');
    if (!ORG || !PROJECT) throw new Error('SENTRY_ORG and SENTRY_PROJECT must be set');

    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    calls += 1;
    if (!res.ok) throw new Error(`sentry ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Scalar value of a single-field /events query, or null when it never fired. */
  async function scalar(field: string, statsPeriod: string, dataset = 'tracemetrics') {
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

  const out: SentryTiles = {
    project: `${ORG ?? ''}/${PROJECT ?? ''}`,
    region: BASE.includes('de.sentry.io') ? 'DE' : 'US',
    topIssues: [],
    unresolved: { count: 0, events: 0, issues: [] },
    errorVolume: { d24h: null, total: null, series: [] },
    metrics: [],
    calls: 0,
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

  // The issues endpoint only accepts statsPeriod '', '24h' or '14d' — anything else 400s.
  // So the window lives in the QUERY (`lastSeen:-…`) and statsPeriod only drives the
  // unused sparkline series.
  const issueWindow = hourly ? `lastSeen:-${window}h` : `lastSeen:-${window / 24}d`;
  const issueStatsPeriod = hourly ? '24h' : '14d';

  const issues = await settle('issues', () =>
    api<RawIssue[]>(`/projects/${ORG}/${PROJECT}/issues/`, {
      query: issueWindow,
      statsPeriod: issueStatsPeriod,
      limit: 10,
      sort: 'freq',
    })
  );
  if (issues) out.topIssues = issues.map(fmtIssue);

  const unresolved = await settle('unresolved', () =>
    api<RawIssue[]>(`/projects/${ORG}/${PROJECT}/issues/`, {
      query: `is:unresolved ${issueWindow}`,
      statsPeriod: issueStatsPeriod,
      limit: 25,
      sort: 'freq',
    })
  );
  if (unresolved) {
    out.unresolved.count = unresolved.length;
    out.unresolved.events = unresolved.reduce((n, i) => n + Number(i.count), 0);
    out.unresolved.issues = unresolved.slice(0, 5).map(fmtIssue);
  }

  // Error volume: an unfiltered EVENTS count, which is why it dwarfs the issue count —
  // it includes every event in every group, resolved and ignored ones included.
  out.errorVolume.d24h = await settle('errors24h', () => scalar('count()', '24h', 'errors'));
  out.errorVolume.total = await settle('errors', () => scalar('count()', range, 'errors'));

  const series = await settle('errorsStats', () =>
    api<{ data?: [number, { count?: number }[]][] }>(`/organizations/${ORG}/events-stats/`, {
      dataset: 'errors',
      yAxis: 'count()',
      statsPeriod: range,
      interval: hourly ? '1h' : '1d',
    })
  );
  if (Array.isArray(series?.data)) {
    // Align to the same window the PostHog chart uses (ending now), rather than trusting
    // Sentry's bucket boundaries — otherwise the two charts end an hour apart.
    const wanted = hourly ? window : window / 24;
    const step = hourly ? 3_600_000 : 86_400_000;
    const byFull = new Map<string, number>();
    for (const [ts, values] of series.data) {
      const iso = new Date(ts * 1000).toISOString();
      const full = hourly ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10);
      byFull.set(full, (byFull.get(full) ?? 0) + (values?.[0]?.count ?? 0));
    }

    const now = Date.now();
    out.errorVolume.series = [];
    for (let i = wanted - 1; i >= 0; i -= 1) {
      const iso = new Date(now - i * step).toISOString();
      const full = hourly ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10);
      out.errorVolume.series.push({
        label: hourly ? `${iso.slice(11, 13)}:00` : iso.slice(8, 10),
        full,
        count: byFull.get(full) ?? 0,
      });
    }
  }

  // Application metrics. Unit must match the registered unit or the query reads 0.
  const METRICS: { label: string; field: string }[] = [
    { label: 'Articles saved', field: 'count(value,articles_saved,counter,none)' },
    { label: 'Save duration p95 (s)', field: 'p95(value,save_duration,distribution,none)' },
    { label: 'Queue save p95 (ms)', field: 'p95(value,queue_save_ms,distribution,none)' },
    { label: 'Queue depth (max)', field: 'max(value,queue_depth,gauge,none)' },
  ];

  for (const metric of METRICS) {
    const value = await settle(metric.field, () => scalar(metric.field, range));
    out.metrics.push({ label: metric.label, field: metric.field, value });
  }

  out.calls = calls;
  return out;
}
