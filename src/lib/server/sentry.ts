// Sentry: issues, error volume, and Application Metrics (tracemetrics dataset).
//
// Multiple Sentry projects, potentially in DIFFERENT ORGS AND REGIONS, are merged here — the
// region is part of each endpoint, so one org's data cannot be read from another's host.
// Configure with:
//
//   SENTRY_PROJECTS=key:label:org:project:region, ...
//   SENTRY_TOKEN_<KEY>=...            # optional per-org token; falls back to SENTRY_AUTH_TOKEN
import { env } from '#lib/config.js';
import { hours, isHourly, type Range, DEFAULT_RANGE } from '#lib/server/range.js';

const REGION_BASE: Record<string, string> = {
  de: 'https://de.sentry.io/api/0',
  us: 'https://sentry.io/api/0',
};

export interface SentryProjectRef {
  key: string;
  label: string;
  org: string;
  project: string;
  base: string;
  region: string;
}

export interface IssueGroup {
  id: number;
  shortId: string;
  title: string;
  status: string;
  permalink: string;
  count: number;
  projectKey: string;
  projectLabel: string;
}

export interface VolumePoint {
  label: string;
  full: string;
  count: number;
}

export interface MetricRow {
  label: string;
  field: string;
  byProject: Record<string, number | null>;
}

export interface SentryTiles {
  projects: { key: string; label: string; region: string }[];
  topIssues: IssueGroup[];
  /** Ignored/resolved groups, highest-volume first — the noise behind the error chart. */
  otherIssues: IssueGroup[];
  /** How much of the window's error volume the listed groups account for. */
  attribution: { shown: number; total: number };
  /**
   * Issue GROUPS, not events: `count` is how many groups are unresolved and `events`
   * is what those groups contain. The error-volume tile counts EVENTS, so the two
   * numbers are different units on purpose.
   */
  unresolved: {
    count: number;
    events: number;
    byProject: Record<string, number>;
    issues: IssueGroup[];
  };
  errorVolume: {
    d24h: number;
    total: number;
    d24hByProject: Record<string, number>;
    byProject: Record<string, number>;
    series: VolumePoint[];
  };
  metrics: MetricRow[];
  /** Successful API calls made for this render — the Sentry counterpart to PostHog's bytes. */
  calls: number;
  errors: string[];
}

interface RawIssue {
  id: string | number;
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

/**
 * Application Metrics per project, keyed by the project's `key`. A project with no entry gets
 * no metric rows — better than four rows of em-dashes that look like a broken query.
 */
const METRICS: Record<string, { label: string; field: string }[]> = {
  projectA: [
    { label: 'Articles saved', field: 'count(value,articles_saved,counter,none)' },
    { label: 'Save duration p95 (s)', field: 'p95(value,save_duration,distribution,none)' },
    { label: 'Queue save p95 (ms)', field: 'p95(value,queue_save_ms,distribution,none)' },
    { label: 'Queue depth (max)', field: 'max(value,queue_depth,gauge,none)' },
  ],
};

export function sentryProjects(): SentryProjectRef[] {
  const raw = env('SENTRY_PROJECTS');
  if (raw) {
    return raw.split(',').map((entry) => {
      const [key, label, org, project, region] = entry.split(':').map((s) => s.trim());
      if (!key || !label || !org || !project) {
        throw new Error(
          `SENTRY_PROJECTS: bad entry "${entry}" — expected key:label:org:project:region`
        );
      }
      const r = (region || 'de').toLowerCase();
      return {
        key,
        label,
        org,
        project,
        base: REGION_BASE[r] ?? REGION_BASE.de,
        region: r.toUpperCase(),
      };
    });
  }

  // Legacy single-project configuration.
  const org = env('SENTRY_ORG');
  const project = env('SENTRY_PROJECT');
  if (!org || !project) {
    throw new Error('SENTRY_PROJECTS (or SENTRY_ORG + SENTRY_PROJECT) must be set');
  }
  const base = env('SENTRY_BASE_URL') ?? REGION_BASE.de;
  return [
    {
      key: 'default',
      label: project,
      org,
      project,
      base,
      region: base.includes('de.sentry.io') ? 'DE' : 'US',
    },
  ];
}

/** Per-org token: SENTRY_TOKEN_<KEY>, else the shared SENTRY_AUTH_TOKEN. */
const tokenFor = (ref: SentryProjectRef): string => {
  const named = `SENTRY_TOKEN_${ref.key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const token = env(named) ?? env('SENTRY_AUTH_TOKEN');
  if (!token) throw new Error(`no Sentry token for "${ref.key}" (set ${named})`);
  return token;
};

export async function sentryApi<T>(
  ref: SentryProjectRef,
  path: string,
  params: Params = {}
): Promise<T> {
  const url = new URL(`${ref.base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    // Repeated params (field=issue&field=count()) carry a string[].
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${tokenFor(ref)}` } });
  if (!res.ok) throw new Error(`${ref.key} ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const sentryProjectByKey = (key: string): SentryProjectRef => {
  const found = sentryProjects().find((p) => p.key === key);
  if (!found) throw new Error(`unknown Sentry project "${key}"`);
  return found;
};

export async function sentryTiles(range: Range = DEFAULT_RANGE): Promise<SentryTiles> {
  const list = sentryProjects();
  const hourly = isHourly(range);
  const window = hours(range);
  const errors: string[] = [];
  let calls = 0;

  const zeroes = (): Record<string, number> => Object.fromEntries(list.map((p) => [p.key, 0]));

  const out: SentryTiles = {
    projects: list.map((p) => ({ key: p.key, label: p.label, region: p.region })),
    topIssues: [],
    otherIssues: [],
    attribution: { shown: 0, total: 0 },
    unresolved: { count: 0, events: 0, byProject: zeroes(), issues: [] },
    errorVolume: { d24h: 0, total: 0, d24hByProject: zeroes(), byProject: zeroes(), series: [] },
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

  const groups: IssueGroup[] = [];
  const seriesByFull = new Map<string, number>();

  for (const ref of list) {
    const api = <T>(path: string, params: Params = {}): Promise<T> => {
      calls += 1;
      return sentryApi<T>(ref, path, params);
    };

    const issues = await settle(`${ref.key}/issues`, () =>
      api<RawIssue[]>(`/projects/${ref.org}/${ref.project}/issues/`, {
        query: issueWindow,
        statsPeriod: issueStatsPeriod,
        limit: 100,
        sort: 'freq',
      })
    );

    // Metadata (title, status, link) per group, so the volume bars can be labelled.
    const meta = new Map<string, RawIssue>();
    for (const raw of issues ?? []) meta.set(raw.shortId, raw);

    // Event counts per group IN THIS WINDOW. `issue.count` is the group's lifetime total, so
    // bars built from it can add up to more events than the window holds.
    const grouped = await settle(`${ref.key}/groups`, () =>
      api<{ data?: { issue: string; 'issue.id': number; 'count()': number }[] }>(
        `/organizations/${ref.org}/events/`,
        {
          dataset: 'errors',
          // Group by the ISSUE only. Adding `title` fragments the aggregation (one row per
          // title variant), which then fills the page with repeats of the top two groups.
          field: ['issue', 'count()'],
          statsPeriod: range,
          sort: '-count()',
          per_page: 25,
        }
      )
    );

    // A project whose issues API is forbidden (no project:read) has no titles yet. Harvest
    // them in a separate fragmenting query and keep the first row per issue.
    const titles = new Map<string, string>();
    if (!issues) {
      const named = await settle(`${ref.key}/titles`, () =>
        api<{ data?: { issue: string; title?: string }[] }>(`/organizations/${ref.org}/events/`, {
          dataset: 'errors',
          field: ['issue', 'title', 'count()'],
          statsPeriod: range,
          sort: '-count()',
          per_page: 50,
        })
      );
      for (const row of named?.data ?? []) {
        if (row.title && !titles.has(row.issue)) titles.set(row.issue, row.title);
      }
    }

    for (const row of grouped?.data ?? []) {
      const known = meta.get(row.issue);
      groups.push({
        id: known ? Number(known.id) : row['issue.id'],
        shortId: row.issue,
        title: known?.title ?? titles.get(row.issue) ?? row.issue,
        status: known?.status ?? 'unknown',
        permalink: known?.permalink ?? '',
        count: row['count()'],
        projectKey: ref.key,
        projectLabel: ref.label,
      });
    }

    // Error volume: unfiltered EVENT counts, which is why they dwarf the issue counts —
    // every event in every group, ignored and resolved included.
    const d24h = await settle(`${ref.key}/errors24h`, () =>
      api<{ data?: Record<string, number>[] }>(`/organizations/${ref.org}/events/`, {
        dataset: 'errors',
        field: 'count()',
        statsPeriod: '24h',
      })
    );
    const total = await settle(`${ref.key}/errors`, () =>
      api<{ data?: Record<string, number>[] }>(`/organizations/${ref.org}/events/`, {
        dataset: 'errors',
        field: 'count()',
        statsPeriod: range,
      })
    );
    out.errorVolume.d24hByProject[ref.key] = d24h?.data?.[0]?.['count()'] ?? 0;
    out.errorVolume.byProject[ref.key] = total?.data?.[0]?.['count()'] ?? 0;

    const series = await settle(`${ref.key}/errorsStats`, () =>
      api<{ data?: [number, { count?: number }[]][] }>(
        `/organizations/${ref.org}/events-stats/`,
        {
          dataset: 'errors',
          yAxis: 'count()',
          statsPeriod: range,
          interval: hourly ? '1h' : '1d',
        }
      )
    );
    for (const [ts, values] of series?.data ?? []) {
      const iso = new Date(ts * 1000).toISOString();
      const full = hourly ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10);
      seriesByFull.set(full, (seriesByFull.get(full) ?? 0) + (values?.[0]?.count ?? 0));
    }

    // Application metrics, only for projects that declare them.
    for (const metric of METRICS[ref.key] ?? []) {
      const body = await settle(`${ref.key}/${metric.field}`, () =>
        api<{ data?: Record<string, number>[] }>(`/organizations/${ref.org}/events/`, {
          dataset: 'tracemetrics',
          field: metric.field,
          statsPeriod: range,
        })
      );
      const value = body?.data?.[0]?.[metric.field];
      let row = out.metrics.find((m) => m.field === metric.field);
      if (!row) {
        row = { label: metric.label, field: metric.field, byProject: {} };
        out.metrics.push(row);
      }
      row.byProject[ref.key] = typeof value === 'number' ? value : null;
    }
  }

  // Merge + shape.
  groups.sort((a, b) => b.count - a.count);
  out.topIssues = groups.filter((g) => g.status === 'unresolved');
  out.otherIssues = groups.filter((g) => g.status !== 'unresolved').slice(0, 6);
  out.unresolved.count = out.topIssues.length;
  out.unresolved.events = out.topIssues.reduce((n, g) => n + g.count, 0);
  out.unresolved.issues = out.topIssues.slice(0, 5);
  for (const g of out.topIssues) {
    out.unresolved.byProject[g.projectKey] = (out.unresolved.byProject[g.projectKey] ?? 0) + g.count;
  }

  out.errorVolume.total = Object.values(out.errorVolume.byProject).reduce((n, v) => n + v, 0);
  out.errorVolume.d24h = Object.values(out.errorVolume.d24hByProject).reduce((n, v) => n + v, 0);

  // Align to the same window the PostHog chart uses (ending now) and zero-fill, otherwise
  // the two charts end a bucket apart and quiet days silently vanish.
  const wanted = hourly ? window : window / 24;
  const step = hourly ? 3_600_000 : 86_400_000;
  const now = Date.now();
  out.errorVolume.series = [];
  for (let i = wanted - 1; i >= 0; i -= 1) {
    const iso = new Date(now - i * step).toISOString();
    const full = hourly ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10);
    out.errorVolume.series.push({
      label: hourly ? `${iso.slice(11, 13)}:00` : iso.slice(8, 10),
      full,
      count: seriesByFull.get(full) ?? 0,
    });
  }

  out.calls = calls;
  out.attribution = {
    shown: [...out.topIssues, ...out.otherIssues].reduce((n, i) => n + i.count, 0),
    total: out.errorVolume.total,
  };
  return out;
}
