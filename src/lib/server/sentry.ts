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

export interface IssueGroup {
  shortId: string;
  title: string;
  status: string;
  permalink: string;
  count: number;
}

export interface SentryTiles {
  project: string;
  region: string;
  topIssues: IssueGroup[];
  /** Ignored/resolved groups, highest-volume first — the noise behind the error chart. */
  otherIssues: IssueGroup[];
  /** How much of the window's error volume the listed groups account for. */
  attribution: { shown: number; total: number | null };
  /**
   * Issue GROUPS, not events: `count` is how many groups are unresolved and `events`
   * is what those groups contain. The error-volume tile counts EVENTS, so the two
   * numbers are different units on purpose.
   */
  unresolved: { count: number; events: number; issues: IssueGroup[] };
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

type Params = Record<string, string | number | string[] | undefined | null>;

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
      if (v === undefined || v === null) continue;
      // Repeated params (field=issue&field=count()) carry a string[].
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
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
    otherIssues: [],
    attribution: { shown: 0, total: null },
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
      limit: 100,
      sort: 'freq',
    })
  );

  // Metadata (title, status, link) per group, so the volume bars can be labelled.
  const meta = new Map<string, IssueGroup>();
  for (const raw of issues ?? []) {
    const issue = fmtIssue(raw);
    meta.set(issue.shortId, {
      shortId: issue.shortId,
      title: issue.title,
      status: issue.status,
      permalink: issue.permalink,
      count: issue.count,
    });
  }

  // Event counts per group IN THIS WINDOW. `issue.count` is the group's lifetime total, so
  // bars built from it can add up to more events than the window holds — this grouped events
  // query is the only honest source for "how many of the window's errors came from group X".
  const grouped = await settle('groups', () =>
    api<{ data?: { issue: string; 'issue.id': number; 'count()': number }[] }>(
      `/organizations/${ORG}/events/`,
      { dataset: 'errors', field: ['issue', 'count()'], statsPeriod: range, sort: '-count()', per_page: 25 }
    )
  );

  const groups: IssueGroup[] = (grouped?.data ?? []).map((row) => {
    const known = meta.get(row.issue);
    return {
      shortId: row.issue,
      title: known?.title ?? row.issue,
      status: known?.status ?? 'unknown',
      permalink: known?.permalink ?? '',
      count: row['count()'],
    };
  });

  // The rendered lists must be the same sets the KPI counts, or the tile contradicts itself.
  out.topIssues = groups.filter((g) => g.status === 'unresolved');
  out.otherIssues = groups.filter((g) => g.status !== 'unresolved').slice(0, 6);
  out.unresolved.count = out.topIssues.length;
  out.unresolved.events = out.topIssues.reduce((n, g) => n + g.count, 0);
  out.unresolved.issues = out.topIssues.slice(0, 5);

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
  out.attribution = {
    shown: [...out.topIssues, ...out.otherIssues].reduce((n, i) => n + i.count, 0),
    total: out.errorVolume.total,
  };
  return out;
}
