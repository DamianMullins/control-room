#!/usr/bin/env node
// posthog-merged.ts — fan out identical HogQL to every configured PostHog project, then
// merge. Same logic as src/lib/server/posthog.ts, without the web app.
//
//   POSTHOG_PERSONAL_API_KEY=phx_... \
//   POSTHOG_PROJECTS=web:Web:12345,app:App:67890 \
//   node scripts/posthog-merged.ts
//
// Falls back to the repo's .env for both values. Needs Node 22+ (native type stripping).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://eu.posthog.com/api/projects';

interface Project {
  key: string;
  label: string;
  id: number;
}

interface Totals {
  total: number;
  byProject: Record<string, number>;
}

type Rows = unknown[][];
type PerProject = Record<string, Rows>;

function fromDotEnv(name: string): string | undefined {
  const file = join(root, '.env');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim();
}

function requireEnv(name: string): string {
  const value = process.env[name] ?? fromDotEnv(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function projects(): Project[] {
  return requireEnv('POSTHOG_PROJECTS')
    .split(',')
    .map((entry) => {
      const [key, label, id] = entry.split(':').map((s) => s.trim());
      const numeric = Number(id);
      if (!key || !label || !Number.isInteger(numeric)) {
        throw new Error(`POSTHOG_PROJECTS: bad entry "${entry}" — expected key:label:project_id`);
      }
      return { key, label, id: numeric };
    });
}

const zeroes = (list: Project[]): Record<string, number> =>
  Object.fromEntries(list.map((p) => [p.key, 0]));

const TILES = {
  daily14d: {
    sql: `SELECT toDate(timestamp) AS day, count() AS events
          FROM events WHERE timestamp >= today() - INTERVAL 13 DAY
          GROUP BY day ORDER BY day`,
    merge: (per: PerProject, list: Project[]) => {
      const days = new Map<string, Totals & { day: string }>();
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
          GROUP BY event ORDER BY n DESC LIMIT 15`,
    merge: (per: PerProject, list: Project[]) => {
      const events = new Map<string, Totals & { event: string }>();
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
      return [...events.values()].sort((a, b) => b.total - a.total).slice(0, 15);
    },
  },
  totalEvents30d: {
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
};

async function query(projectId: number, sql: string, key: string) {
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
  if (!res.ok) throw new Error(`project ${projectId}: HTTP ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { results?: Rows; error?: string | null };
  if (body.error) throw new Error(`project ${projectId}: ${body.error}`);

  return {
    rows: (body.results ?? []) as Rows,
    bytesRead: Number(res.headers.get('x-posthog-query-bytes-read') ?? 0),
  };
}

export async function collect() {
  const key = requireEnv('POSTHOG_PERSONAL_API_KEY');
  const list = projects();
  const tiles: Record<string, unknown> = {};
  let bytesRead = 0;

  for (const [name, tile] of Object.entries(TILES)) {
    const per: PerProject = {};
    // Sequential on purpose: predictable read budget, no burst of 429s.
    for (const project of list) {
      const { rows, bytesRead: b } = await query(project.id, tile.sql, key);
      bytesRead += b;
      per[project.key] = rows;
    }
    tiles[name] = tile.merge(per, list);
  }

  return {
    generated_at: new Date().toISOString(),
    projects: list.map(({ key: k, label, id }) => ({ key: k, label, id })),
    bytes_read: bytesRead,
    tiles,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await collect(), null, 2));
  } catch (err) {
    console.error('FAILED:', (err as Error).message);
    process.exit(1);
  }
}
