// Detail payloads for the click-through modal: one event, one chart bucket, or one issue group.
// Everything is shaped into the same `Detail` object so the modal has a single renderer.
import { hogql, projects } from '#lib/server/posthog.js';
import { sentryApi, sentryProjectByKey, sentryProjects } from '#lib/server/sentry.js';
import { hours, isHourly, type Range } from '#lib/server/range.js';

export interface Detail {
  title: string;
  subtitle?: string;
  stats: { label: string; value: string }[];
  series: { label: string; full: string; count: number }[];
  rows: { label: string; value: string; href?: string }[];
  rowsTitle?: string;
  link?: string;
  /** Cross-source jumps: each one re-opens this modal on another kind. */
  related: { label: string; kind: 'event' | 'bucket' | 'issue' | 'path'; params: Record<string, string> }[];
  errors: string[];
}

const nf = new Intl.NumberFormat('en-GB');
const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : nf.format(n);

/** ClickHouse string literal body. Event names are arbitrary text, so quotes must be escaped. */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const stamp = (raw: string, hourly: boolean): { label: string; full: string } => {
  const iso = raw.replace('T', ' ');
  return {
    label: hourly ? iso.slice(11, 16) : iso.slice(8, 10),
    full: hourly ? iso.slice(0, 16) : iso.slice(0, 10),
  };
};

type Rows = unknown[][];

/** Merge per-project HogQL rows into one series, keeping project attribution off the modal. */
function mergeSeries(
  per: Record<string, Rows>,
  hourly: boolean
): { label: string; full: string; count: number }[] {
  const buckets = new Map<string, { label: string; full: string; count: number }>();
  for (const rows of Object.values(per)) {
    for (const row of rows) {
      const { label, full } = stamp(String(row[0]), hourly);
      const point = buckets.get(full) ?? { label, full, count: 0 };
      point.count += Number(row[1] ?? 0);
      buckets.set(full, point);
    }
  }
  return [...buckets.values()].sort((a, b) => a.full.localeCompare(b.full));
}

export async function eventDetail(
  name: string,
  range: Range,
  only?: string[]
): Promise<Detail> {
  const list = only ? projects().filter((p) => only.includes(p.key)) : projects();
  const window = hours(range);
  const hourly = isHourly(range);
  const bucket = hourly ? 'toStartOfHour(timestamp)' : 'toDate(timestamp)';
  const where = `event = '${esc(name)}' AND timestamp >= now() - INTERVAL ${window} HOUR`;

  const per: Record<string, Rows> = {};
  const perPaths: Record<string, Rows> = {};
  const errors: string[] = [];
  let users = 0;
  let first = '';
  let last = '';

  for (const project of list) {
    try {
      const [series, totals, paths] = await Promise.all([
        hogql(project.id, `SELECT ${bucket} AS b, count() AS n FROM events WHERE ${where} GROUP BY b ORDER BY b`),
        hogql(
          project.id,
          `SELECT count() AS n, count(DISTINCT distinct_id) AS users, min(timestamp) AS first, max(timestamp) AS last
           FROM events WHERE event = '${esc(name)}'`
        ),
        hogql(
          project.id,
          `SELECT properties.$pathname AS p, count() AS n FROM events WHERE ${where}
           GROUP BY p ORDER BY n DESC LIMIT 8`
        ),
      ]);
      per[project.key] = series.rows;
      perPaths[project.key] = paths.rows;
      users += Number(totals.rows[0]?.[1] ?? 0);
      const f = String(totals.rows[0]?.[2] ?? '');
      const l = String(totals.rows[0]?.[3] ?? '');
      if (f && (!first || f < first)) first = f;
      if (l && (!last || l > last)) last = l;
    } catch (err) {
      errors.push(`${project.key}: ${(err as Error).message}`);
    }
  }

  const series = mergeSeries(per, hourly);
  const total = series.reduce((n, p) => n + p.count, 0);

  const paths = new Map<string, number>();
  for (const rows of Object.values(perPaths)) {
    for (const row of rows) {
      const path = String(row[0] ?? '(none)');
      paths.set(path, (paths.get(path) ?? 0) + Number(row[1] ?? 0));
    }
  }

  const sortedPaths = [...paths.entries()].sort((a, b) => b[1] - a[1]);
  const topPath = sortedPaths[0]?.[0];

  return {
    title: name,
    subtitle: `${list.map((p) => p.label).join(' + ')} · ${range}`,
    stats: [
      { label: `Events · ${range}`, value: num(total) },
      { label: 'Distinct users (summed)', value: num(users) },
      { label: 'First seen', value: first.slice(0, 16).replace('T', ' ') || '—' },
      { label: 'Last seen', value: last.slice(0, 16).replace('T', ' ') || '—' },
    ],
    series,
    rowsTitle: 'Top pages',
    rows: sortedPaths.slice(0, 8).map(([label, n]) => ({ label, value: num(n) })),
    related:
      topPath && topPath.startsWith('/')
        ? [{ label: `Errors on ${topPath} →`, kind: 'path' as const, params: { path: topPath } }]
        : [],
    link: `https://eu.posthog.com/project/${list[0]?.id}/events?event=${encodeURIComponent(name)}`,
    errors,
  };
}

/** One bar of either chart. `at` is the bucket key already shown in the tooltip. */
export async function bucketDetail(
  at: string,
  source: 'events' | 'errors',
  range: Range,
  only?: string[]
): Promise<Detail> {
  const hourly = at.includes(' ');
  // Compare the SAME truncated expression the chart grouped by, rather than a
  // midnight-to-midnight range: a project timezone offset would otherwise make the
  // bucket total disagree with the bar you clicked.
  const bucketWhere = hourly
    ? `toStartOfHour(timestamp) = toStartOfHour(toDateTime('${esc(at)}:00:00'))`
    : `toDate(timestamp) = toDate('${esc(at)}')`;
  const errors: string[] = [];

  // Sentry takes explicit ISO bounds for a bucket.
  const startIso = hourly ? `${at.replace(' ', 'T')}:00:00Z` : `${at}T00:00:00Z`;
  const endIso = new Date(
    new Date(startIso).getTime() + (hourly ? 3_600_000 : 86_400_000)
  ).toISOString();

  if (source === 'errors') {
    let rows: { label: string; value: string }[] = [];
    let total = 0;
    // Both orgs' events land in this bucket; query each and merge.
    const sentryList = only ? sentryProjects().filter((p) => only.includes(p.key)) : sentryProjects();
    for (const ref of sentryList) {
      try {
        const body = await sentryApi<{ data?: { issue: string; 'count()': number }[] }>(
          ref,
          `/organizations/${ref.org}/events/`,
          {
            dataset: 'errors',
            field: ['issue', 'count()'],
            start: startIso,
            end: endIso,
            sort: '-count()',
            per_page: 10,
          }
        );
        for (const r of body.data ?? []) {
          rows.push({
            label: `${r.issue}${ref.key === sentryList[0]?.key ? '' : ` (${ref.label})`}`,
            value: num(r['count()']),
          });
          total += r['count()'];
        }
      } catch (err) {
        errors.push(`${ref.key}: ${(err as Error).message}`);
      }
    }
    rows = rows.sort((a, b) => Number(b.value.replace(/,/g, '')) - Number(a.value.replace(/,/g, '')));
    return {
      title: `Error events · ${at}`,
      subtitle: `Sentry · ${sentryList.map((p) => p.label).join(' + ')} · ${range}`,
      stats: [
        { label: 'Events in bucket', value: num(total) },
        { label: 'Issue groups', value: num(rows.length) },
      ],
      series: [],
      rowsTitle: 'Groups producing these events',
      rows,
      related: [
        {
          label: 'All events in this bucket →',
          kind: 'bucket' as const,
          params: { at, source: 'events' },
        },
      ],
      errors,
    };
  }

  const list = only ? projects().filter((p) => only.includes(p.key)) : projects();
  const per: Record<string, Rows> = {};
  for (const project of list) {
    try {
      // No LIMIT: the displayed list is sliced in code, but the bucket total must count
      // every event name or it silently disagrees with the bar that was clicked.
      const { rows } = await hogql(
        project.id,
        `SELECT event, count() AS n FROM events
         WHERE ${bucketWhere}
         GROUP BY event ORDER BY n DESC`
      );
      per[project.key] = rows;
    } catch (err) {
      errors.push(`${project.key}: ${(err as Error).message}`);
    }
  }

  const merged = new Map<string, number>();
  for (const rows of Object.values(per)) {
    for (const row of rows) {
      const name = String(row[0]);
      merged.set(name, (merged.get(name) ?? 0) + Number(row[1] ?? 0));
    }
  }
  const all = [...merged.entries()].sort((a, b) => b[1] - a[1]);
  const rows = all.slice(0, 10);

  return {
    title: `Events · ${at}`,
    subtitle: `${list.map((p) => p.label).join(' + ')} · bucket`,
    stats: [
      { label: 'Events in bucket', value: num(all.reduce((n, [, v]) => n + v, 0)) },
      { label: 'Event names', value: num(merged.size) },
    ],
    series: [],
    rowsTitle: 'Top events in this bucket',
    rows: rows.map(([label, n]) => ({ label, value: num(n) })),
    related: [
      { label: 'Error events in this bucket →', kind: 'bucket' as const, params: { at, source: 'errors' } },
    ],
    errors,
  };
}

/** One Sentry issue group: its trend, its URLs, and its lifetime counters. */
export async function issueDetail(
  id: string,
  projectKey: string,
  range: Range,
  hints: { shortId?: string; title?: string } = {}
): Promise<Detail> {
  const ref = sentryProjectByKey(projectKey);
  const org = ref.org;
  const hourly = isHourly(range);
  const errors: string[] = [];

  interface RawIssue {
    shortId: string;
    title: string;
    status: string;
    count: string | number;
    userCount: number;
    firstSeen: string;
    lastSeen: string;
    permalink: string;
  }

  let meta: RawIssue | null = null;
  try {
    // Issue detail is org-scoped; /projects/{org}/{project}/issues/{id}/ answers 404.
    meta = await sentryApi<RawIssue>(ref, `/issues/${id}/`);
  } catch (err) {
    const message = (err as Error).message;
    errors.push(
      message.includes('403')
        ? `${ref.label}: the token can't read this org's issues (needs project:read) — showing event data only`
        : `issue: ${message}`
    );
  }

  // Without the issues API (a token lacking project:read answers 403), fall back to the
  // short id carried by the row that opened this modal — discover still answers everything.
  const shortId = meta?.shortId ?? hints.shortId;

  let series: { label: string; full: string; count: number }[] = [];
  if (shortId) {
    try {
      const body = await sentryApi<{ data?: [number, { count?: number }[]][] }>(
        ref,
        `/organizations/${org}/events-stats/`,
        {
          dataset: 'errors',
          yAxis: 'count()',
          query: `issue:${shortId}`,
          statsPeriod: range,
          interval: hourly ? '1h' : '1d',
        }
      );
      series = (body.data ?? []).map(([ts, values]) => {
        const iso = new Date(ts * 1000).toISOString();
        return {
          label: (hourly ? iso.slice(11, 16) : iso.slice(8, 10)) ?? '',
          full: hourly ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10),
          count: values?.[0]?.count ?? 0,
        };
      });
    } catch (err) {
      errors.push(`series: ${(err as Error).message}`);
    }
  }

  let urls: { label: string; value: string }[] = [];
  if (shortId) {
    try {
      const body = await sentryApi<{ data?: { url?: string; 'count()': number }[] }>(
        ref,
        `/organizations/${org}/events/`,
        {
          dataset: 'errors',
          field: ['url', 'count()'],
          query: `issue:${shortId}`,
          statsPeriod: range,
          sort: '-count()',
          per_page: 8,
        }
      );
      urls = (body.data ?? []).map((r) => ({
        label: r.url ?? '(no url)',
        value: num(r['count()']),
      }));
    } catch (err) {
      errors.push(`urls: ${(err as Error).message}`);
    }
  }

  // Cross-source jump: the same URL's traffic in PostHog.
  const topUrl = urls[0]?.label;
  let topPath: string | null = null;
  if (topUrl) {
    try {
      topPath = new URL(topUrl).pathname;
    } catch {
      topPath = topUrl.startsWith('/') ? topUrl : null;
    }
  }

  // Without the issues API there is no lastSeen; the newest non-empty bucket is the honest
  // substitute ("last event in this window").
  const lastActive = [...series].reverse().find((p) => p.count > 0)?.full;

  return {
    title: meta?.title ?? hints.title ?? `Issue ${id}`,
    subtitle: `${shortId ?? id} · ${meta?.status ?? 'status unavailable'} · ${range}`,
    stats: [
      { label: `Events · ${range}`, value: num(series.reduce((n, p) => n + p.count, 0)) },
      { label: 'All-time events', value: num(meta ? Number(meta.count) : null) },
      { label: 'Users (all time)', value: num(meta?.userCount ?? null) },
      { label: 'Last seen', value: meta?.lastSeen.slice(0, 16).replace('T', ' ') ?? lastActive ?? '—' },
    ],
    series,
    rowsTitle: 'URLs',
    rows: urls,
    related: topPath
      ? [{ label: `Traffic for ${topPath} →`, kind: 'path' as const, params: { path: topPath } }]
      : [],
    link: meta?.permalink,
    errors,
  };
}

/** One page path, viewed from both sides: PostHog traffic and Sentry errors on it. */
export async function pathDetail(path: string, range: Range, only?: string[]): Promise<Detail> {
  const list = only ? projects().filter((p) => only.includes(p.key)) : projects();
  const window = hours(range);
  const hourly = isHourly(range);
  const bucketExpr = hourly ? 'toStartOfHour(timestamp)' : 'toDate(timestamp)';
  // Traffic means PAGEVIEWS: counting every event on the path (vitals, autocapture) made the
  // stat read as visits when it was really event volume.
  const where = `event = '$pageview' AND properties.$pathname = '${esc(path)}' AND timestamp >= now() - INTERVAL ${window} HOUR`;
  const errors: string[] = [];

  const per: Record<string, Rows> = {};
  let users = 0;
  for (const project of list) {
    try {
      const [series, distinct] = await Promise.all([
        hogql(
          project.id,
          `SELECT ${bucketExpr} AS b, count() AS n FROM events WHERE ${where} GROUP BY b ORDER BY b`
        ),
        hogql(project.id, `SELECT count(DISTINCT distinct_id) AS u FROM events WHERE ${where}`),
      ]);
      per[project.key] = series.rows;
      users += Number(distinct.rows[0]?.[0] ?? 0);
    } catch (err) {
      errors.push(`${project.key}: ${(err as Error).message}`);
    }
  }

  const series = mergeSeries(per, hourly);
  const pageviews = series.reduce((n, p) => n + p.count, 0);

  const match = `url:*${path}*`;
  let groups: { label: string; value: string }[] = [];
  let groupLinks: Detail['related'] = [];
  let errorEvents = 0;

  const sentryList = only ? sentryProjects().filter((p) => only.includes(p.key)) : sentryProjects();
  for (const ref of sentryList) {
    try {
      const grouped = await sentryApi<
        { data?: { issue: string; 'issue.id': number; 'count()': number }[] }
      >(ref, `/organizations/${ref.org}/events/`, {
        dataset: 'errors',
        field: ['issue', 'count()'],
        query: match,
        statsPeriod: range,
        sort: '-count()',
        per_page: 10,
      });
      const rowsData = grouped.data ?? [];
      const suffix = ref.key === sentryList[0]?.key ? '' : ` (${ref.label})`;
      groups.push(...rowsData.map((r) => ({ label: `${r.issue}${suffix}`, value: num(r['count()']) })));
      groupLinks.push(
        ...rowsData.slice(0, 3).map((r) => ({
          label: `${r.issue} →`,
          kind: 'issue' as const,
          params: { id: String(r['issue.id']), project: ref.key },
        }))
      );

      const scalar = await sentryApi<{ data?: Record<string, number>[] }>(
        ref,
        `/organizations/${ref.org}/events/`,
        { dataset: 'errors', field: 'count()', query: match, statsPeriod: range }
      );
      errorEvents += scalar.data?.[0]?.['count()'] ?? 0;
    } catch (err) {
      errors.push(`${ref.key}: ${(err as Error).message}`);
    }
  }

  return {
    title: path,
    subtitle: `PostHog traffic + Sentry errors · ${range}`,
    stats: [
      { label: 'Pageviews', value: num(pageviews) },
      { label: 'Distinct users (summed)', value: num(users) },
      { label: 'Error events', value: num(errorEvents) },
      { label: 'Error groups', value: num(groups.length) },
    ],
    series,
    rowsTitle: 'Error groups on this page',
    rows: groups,
    related: groupLinks,
    errors,
  };
}
