// PostHog: one HogQL query per tile, run against every configured project, merged here.
// /query/ is per-project and HogQL cannot join across projects, and each org has its own
// free allowance — so the merge happens in this process, not in PostHog. Projects come from
// POSTHOG_PROJECTS so a clone can point at its own:
//
//   POSTHOG_PROJECTS=web:Web:12345,app:App:67890    # key:label:project_id, comma separated
import { env } from '#lib/config.js';
import { hours, isHourly, type Range, DEFAULT_RANGE } from '#lib/server/range.js';

const API = 'https://eu.posthog.com/api/projects';

export interface Project {
  key: string;
  label: string;
  id: number;
}

/** Count per project key, plus the sum across projects. */
export interface Totals {
  total: number;
  byProject: Record<string, number>;
}

/** One point on a time series: a short axis label, a full label for the tooltip, counts. */
export interface Bucket extends Totals {
  label: string;
  full: string;
}

export interface EventPoint extends Totals {
  event: string;
}

export interface PosthogTiles {
  totals: Totals;
  /** Distinct users summed per project: the same person in two projects counts twice. */
  users: Totals & { approximate: true };
  series: Bucket[];
  topEvents: EventPoint[];
}

export interface PosthogResult {
  projects: Project[];
  tiles: PosthogTiles;
  bytesRead: number;
  errors: string[];
}

type Rows = unknown[][];
type PerProject = Record<string, Rows>;

export function projects(): Project[] {
  const raw = env('POSTHOG_PROJECTS');
  if (!raw) throw new Error('POSTHOG_PROJECTS is not set (expected key:label:project_id,...)');

  return raw.split(',').map((entry) => {
    const [key, label, id] = entry.split(':').map((s) => s.trim());
    const numeric = Number(id);
    if (!key || !label || !Number.isInteger(numeric)) {
      throw new Error(`POSTHOG_PROJECTS: bad entry "${entry}" — expected key:label:project_id`);
    }
    return { key, label, id: numeric };
  });
}

/** Single HogQL query against one project. Exported so the detail endpoint reuses it. */
export async function hogql(projectId: number, sql: string) {
  const key = env('POSTHOG_PERSONAL_API_KEY');
  if (!key) throw new Error('POSTHOG_PERSONAL_API_KEY is not set');

  const res = await fetch(`${API}/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
  });

  if (res.status === 429) {
    throw new Error(
      `project ${projectId}: read budget exhausted, retry in ${res.headers.get('retry-after')}s`
    );
  }
  if (!res.ok) throw new Error(`project ${projectId}: HTTP ${res.status}`);

  const body = (await res.json()) as { results?: Rows; error?: string | null };
  if (body.error) throw new Error(`project ${projectId}: ${body.error}`);

  return {
    rows: (body.results ?? []) as Rows,
    bytesRead: Number(res.headers.get('x-posthog-query-bytes-read') ?? 0),
  };
}

const zeroes = (list: Project[]): Record<string, number> =>
  Object.fromEntries(list.map((p) => [p.key, 0]));

/**
 * HogQL only returns buckets that have events, so a quiet hour or day simply vanishes and
 * the chart silently compresses its x-axis. Build the full window and zero-fill instead.
 * Buckets are UTC, which is what HogQL's now()/today() compare against.
 */
function fillSeries(buckets: Bucket[], window: number, hourly: boolean, list: Project[]): Bucket[] {
  const step = hourly ? 3_600_000 : 86_400_000;
  const now = Date.now();
  const byFull = new Map(buckets.map((b) => [b.full, b]));
  const out: Bucket[] = [];

  for (let i = window - 1; i >= 0; i -= 1) {
    const iso = new Date(now - i * step).toISOString();
    const full = hourly ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10);
    out.push(
      byFull.get(full) ?? {
        label: hourly ? `${iso.slice(11, 13)}:00` : iso.slice(8, 10),
        full,
        total: 0,
        byProject: zeroes(list),
      }
    );
  }

  return out;
}

interface Tile<T> {
  sql: (window: number, hourly: boolean) => string;
  merge: (per: PerProject, list: Project[], hourly: boolean) => T;
}

const TILES = {
  totals: {
    sql: (window: number) =>
      `SELECT count() AS n FROM events WHERE timestamp >= now() - INTERVAL ${window} HOUR`,
    merge: (per: PerProject, list: Project[]): Totals => {
      const byProject = zeroes(list);
      let total = 0;
      for (const p of list) {
        byProject[p.key] = Number(per[p.key]?.[0]?.[0] ?? 0);
        total += byProject[p.key];
      }
      return { total, byProject };
    },
  },
  users: {
    sql: (window: number) =>
      `SELECT count(DISTINCT distinct_id) AS n FROM events
       WHERE timestamp >= now() - INTERVAL ${window} HOUR`,
    merge: (per: PerProject, list: Project[]): Totals & { approximate: true } => {
      const byProject = zeroes(list);
      let total = 0;
      for (const p of list) {
        byProject[p.key] = Number(per[p.key]?.[0]?.[0] ?? 0);
        total += byProject[p.key];
      }
      // Distinct across projects can't be summed exactly — flag it rather than lie.
      return { total, byProject, approximate: true };
    },
  },
  series: {
    // Hourly for 24h, daily otherwise. `toStartOfHour` comes back as a DateTime string.
    sql: (window: number, hourly: boolean) =>
      hourly
        ? `SELECT toStartOfHour(timestamp) AS bucket, count() AS events
           FROM events WHERE timestamp >= now() - INTERVAL ${window} HOUR
           GROUP BY bucket ORDER BY bucket`
        : `SELECT toDate(timestamp) AS bucket, count() AS events
           FROM events WHERE timestamp >= today() - INTERVAL ${window / 24 - 1} DAY
           GROUP BY bucket ORDER BY bucket`,
    merge: (per: PerProject, list: Project[], hourly: boolean): Bucket[] => {
      const buckets = new Map<string, Bucket>();
      for (const p of list) {
        for (const row of per[p.key] ?? []) {
          // HogQL can hand back 'YYYY-MM-DD HH:…' or ISO with a 'T' — normalise before
          // slicing, or the same hour lands in two buckets with one label.
          const raw = String(row[0]).replace('T', ' ');
          const n = Number(row[1]);
          const key = hourly ? raw.slice(0, 13) : raw.slice(0, 10); // 'YYYY-MM-DD HH' | 'YYYY-MM-DD'
          const point =
            buckets.get(key) ??
            ({
              label: hourly ? `${key.slice(11, 13)}:00` : key.slice(8),
              full: hourly ? `${key.slice(0, 10)} ${key.slice(11, 13)}:00` : key,
              total: 0,
              byProject: zeroes(list),
            } satisfies Bucket);
          point.byProject[p.key] = n;
          point.total += n;
          buckets.set(key, point);
        }
      }
      return [...buckets.values()].sort((a, b) => a.full.localeCompare(b.full));
    },
  },
  topEvents: {
    sql: (window: number) =>
      `SELECT event, count() AS n FROM events
       WHERE timestamp >= now() - INTERVAL ${window} HOUR
       GROUP BY event ORDER BY n DESC LIMIT 12`,
    merge: (per: PerProject, list: Project[]): EventPoint[] => {
      const events = new Map<string, EventPoint>();
      for (const p of list) {
        for (const row of per[p.key] ?? []) {
          const name = String(row[0]);
          const n = Number(row[1]);
          const point = events.get(name) ?? { event: name, total: 0, byProject: zeroes(list) };
          point.byProject[p.key] = n;
          point.total += n;
          events.set(name, point);
        }
      }
      return [...events.values()].sort((a, b) => b.total - a.total).slice(0, 12);
    },
  },
} satisfies Record<string, Tile<unknown>>;

export async function posthogTiles(range: Range = DEFAULT_RANGE): Promise<PosthogResult> {
  const list = projects();
  const window = hours(range);
  const hourly = isHourly(range);
  const tiles = {} as PosthogTiles;
  const errors: string[] = [];
  let bytesRead = 0;

  for (const name of Object.keys(TILES) as (keyof typeof TILES)[]) {
    const tile = TILES[name] as Tile<unknown>;
    const per: PerProject = {};

    // Sequential on purpose: predictable read budget, no burst of 429s.
    for (const project of list) {
      try {
        const { rows, bytesRead: b } = await hogql(project.id, tile.sql(window, hourly));
        per[project.key] = rows;
        bytesRead += b;
      } catch (err) {
        per[project.key] = [];
        errors.push(`${name}/${project.key}: ${(err as Error).message}`);
      }
    }

    (tiles as unknown as Record<string, unknown>)[name] = tile.merge(per, list, hourly);
  }

  // window is in HOURS; fillSeries wants a bucket count.
  tiles.series = fillSeries(tiles.series, hourly ? window : window / 24, hourly, list);

  return { projects: list, tiles, bytesRead, errors };
}
