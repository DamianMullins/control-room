// Sentry: issues, error volume, and Application Metrics (tracemetrics dataset).
// The region matters: an EU/DE org must be queried against de.sentry.io, not sentry.io.
import { env } from '#lib/config.js';

const BASE = env('SENTRY_BASE_URL') || 'https://de.sentry.io/api/0';
const ORG = env('SENTRY_ORG');
const PROJECT = env('SENTRY_PROJECT');

async function api(path, params = {}) {
  const token = env('SENTRY_AUTH_TOKEN');
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');

  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sentry ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Scalar value of a single-field /events query, or null when it never fired. */
async function scalar(field, statsPeriod, extra = {}) {
  const body = await api(`/organizations/${ORG}/events/`, {
    dataset: extra.dataset || 'tracemetrics',
    field,
    statsPeriod,
    query: extra.query || undefined,
  });
  const row = body?.data?.[0];
  if (!row) return null;
  const v = row[field];
  return typeof v === 'number' ? v : null;
}

const fmtIssue = (i) => ({
  shortId: i.shortId,
  title: i.title,
  count: i.count,
  userCount: i.userCount,
  status: i.status,
  level: i.level,
  lastSeen: i.lastSeen,
  permalink: i.permalink,
});

export async function sentryTiles() {
  const errors = [];
  const out = {
    project: `${ORG}/${PROJECT}`,
    region: BASE.includes('de.sentry.io') ? 'DE' : 'US',
    topIssues: [],
    unresolved: { count: 0, issues: [] },
    errorVolume: { d24h: null, d30d: null, daily: [] },
    metrics: [],
  };

  const settle = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      return null;
    }
  };

  // Top issues over 14d by frequency.
  const issues = await settle('issues', () =>
    api(`/projects/${ORG}/${PROJECT}/issues/`, { query: '', statsPeriod: '14d', limit: 10, sort: 'freq' })
  );
  if (issues) out.topIssues = issues.map(fmtIssue);

  const unresolved = await settle('unresolved', () =>
    api(`/projects/${ORG}/${PROJECT}/issues/`, { query: 'is:unresolved', statsPeriod: '14d', limit: 25, sort: 'freq' })
  );
  if (unresolved) {
    out.unresolved.count = unresolved.length;
    out.unresolved.issues = unresolved.slice(0, 5).map(fmtIssue);
  }

  // Error volume: 24h / 30d scalars plus a 14-day series.
  out.errorVolume.d24h = await settle('errors24h', () => scalar('count()', '24h', { dataset: 'errors' }));
  out.errorVolume.d30d = await settle('errors30d', () => scalar('count()', '30d', { dataset: 'errors' }));

  const series = await settle('errorsStats', () =>
    api(`/organizations/${ORG}/events-stats/`, { dataset: 'errors', yAxis: 'count()', statsPeriod: '14d', interval: '1d' })
  );
  if (Array.isArray(series?.data)) {
    // Sentry returns one extra leading bucket for the period — keep exactly 14 days.
    out.errorVolume.daily = series.data
      .map(([ts, vals]) => ({
        day: new Date(ts * 1000).toISOString().slice(0, 10),
        count: vals?.[0]?.count ?? 0,
      }))
      .slice(-14);
  }

  // Application metrics. Unit must match the registered unit or the query reads 0.
  const METRICS = [
    { label: 'Articles saved', field: 'count(value,articles_saved,counter,none)', period: '30d' },
    { label: 'Save duration p95 (s)', field: 'p95(value,save_duration,distribution,none)', period: '30d' },
    { label: 'Queue save p95 (ms)', field: 'p95(value,queue_save_ms,distribution,none)', period: '30d' },
    { label: 'Queue depth (max)', field: 'max(value,queue_depth,gauge,none)', period: '7d' },
  ];

  for (const m of METRICS) {
    const value = await settle(m.field, () => scalar(m.field, m.period));
    out.metrics.push({ ...m, value });
  }

  out.errors = errors;
  return out;
}
