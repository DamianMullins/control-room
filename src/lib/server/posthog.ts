// PostHog: one HogQL query per tile, run against every configured project, merged here.
// /query/ is per-project and HogQL cannot join across projects, and each org has its own
// free allowance — so the merge happens in this process, not in PostHog. Projects come from
// POSTHOG_PROJECTS so a clone can point at its own:
//
//   POSTHOG_PROJECTS=web:Web:12345,app:App:67890    # key:label:project_id, comma separated
import { env } from '#lib/config.js';

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

export interface DayPoint extends Totals {
  day: string;
}

export interface EventPoint extends Totals {
  event: string;
}

export interface PosthogTiles {
  totals30d: Totals;
  /** Distinct users summed per project: the same person in two projects counts twice. */
  users30d: Totals & { approximate: true };
  daily14d: DayPoint[];
  topEvents7d: EventPoint[];
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

async function hogql(projectId: number, sql: string) {
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

interface Tile<T> {
  sql: string;
  merge: (per: PerProject, list: Project[]) => T;
}

const TILES = {
  totals30d: {
    sql: `SELECT count() AS n FROM events WHERE timestamp >= now() - INTERVAL 30 DAY`,
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
  users30d: {
    sql: `SELECT count(DISTINCT distinct_id) AS n FROM events WHERE timestamp >= now() - INTERVAL 30 DAY`,
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
  daily14d: {
    sql: `SELECT toDate(timestamp) AS day, count() AS events
          FROM events WHERE timestamp >= today() - INTERVAL 13 DAY
          GROUP BY day ORDER BY day`,
    merge: (per: PerProject, list: Project[]): DayPoint[] => {
      const days = new Map<string, DayPoint>();
      for (const p of list) {
        for (const row of per[p.key] ?? []) {
          const day = String(row[0]).slice(0, 10);
          const n = Number(row[1]);
          const point = days.get(day) ?? { day, total: 0, byProject: zeroes(list) };
          point.byProject[p.key] = n;
          point.total += n;
          days.set(day, point);
        }
      }
      return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
    },
  },
  topEvents7d: {
    sql: `SELECT event, count() AS n FROM events
          WHERE timestamp >= now() - INTERVAL 7 DAY
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

export async function posthogTiles(): Promise<PosthogResult> {
  const list = projects();
  const tiles = {} as PosthogTiles;
  const errors: string[] = [];
  let bytesRead = 0;

  for (const name of Object.keys(TILES) as (keyof typeof TILES)[]) {
    const tile = TILES[name] as Tile<unknown>;
    const per: PerProject = {};

    // Sequential on purpose: predictable read budget, no burst of 429s.
    for (const project of list) {
      try {
        const { rows, bytesRead: b } = await hogql(project.id, tile.sql);
        per[project.key] = rows;
        bytesRead += b;
      } catch (err) {
        per[project.key] = [];
        errors.push(`${name}/${project.key}: ${(err as Error).message}`);
      }
    }

    (tiles as unknown as Record<string, unknown>)[name] = tile.merge(per, list);
  }

  return { projects: list, tiles, bytesRead, errors };
}
