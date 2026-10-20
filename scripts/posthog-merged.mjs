#!/usr/bin/env node
// posthog-merged.mjs — fan out identical HogQL to every configured PostHog project, then
// merge. Same logic as src/lib/server/posthog.js, without the web app.
//
//   POSTHOG_PERSONAL_API_KEY=phx_... \
//   POSTHOG_PROJECTS=web:Web:12345,app:App:67890 \
//   node scripts/posthog-merged.mjs
//
// Falls back to the repo's .env for both values. No dependencies. Node 18+ (global fetch).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://eu.posthog.com/api/projects';

function fromDotEnv(name) {
  const file = join(root, '.env');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim();
}

function requireEnv(name) {
  const value = process.env[name] || fromDotEnv(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function projects() {
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

const TILES = {
  daily14d: {
    sql: `SELECT toDate(timestamp) AS day, count() AS events
          FROM events WHERE timestamp >= today() - INTERVAL 13 DAY
          GROUP BY day ORDER BY day`,
    merge: (per, list) => {
      const days = new Map();
      for (const p of list) {
        for (const [day, n] of per[p.key] || []) {
          const d = String(day).slice(0, 10);
          const row = days.get(d) || { day: d, total: 0 };
          for (const q of list) row[q.key] ??= 0;
          row[p.key] = n;
          row.total += n;
          days.set(d, row);
        }
      }
      return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
    },
  },
  topEvents7d: {
    sql: `SELECT event, count() AS n FROM events
          WHERE timestamp >= now() - INTERVAL 7 DAY
          GROUP BY event ORDER BY n DESC LIMIT 15`,
    merge: (per, list) => {
      const evs = new Map();
      for (const p of list) {
        for (const [event, n] of per[p.key] || []) {
          const row = evs.get(event) || { event, total: 0 };
          for (const q of list) row[q.key] ??= 0;
          row[p.key] = n;
          row.total += n;
          evs.set(event, row);
        }
      }
      return [...evs.values()].sort((a, b) => b.total - a.total).slice(0, 15);
    },
  },
  totalEvents30d: {
    sql: `SELECT count() AS n FROM events WHERE timestamp >= now() - INTERVAL 30 DAY`,
    merge: (per, list) => {
      const out = { total: 0 };
      for (const p of list) {
        const n = per[p.key]?.[0]?.[0] ?? 0;
        out[p.key] = n;
        out.total += n;
      }
      return out;
    },
  },
};

async function query(projectId, sql, key) {
  const res = await fetch(`${API}/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
  });
  if (res.status === 429) {
    throw new Error(`project ${projectId}: read budget exhausted, retry in ${res.headers.get('retry-after')}s`);
  }
  if (!res.ok) throw new Error(`project ${projectId}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(`project ${projectId}: ${body.error}`);
  return {
    rows: body.results,
    bytesRead: Number(res.headers.get('x-posthog-query-bytes-read') || 0),
  };
}

export async function collect() {
  const key = requireEnv('POSTHOG_PERSONAL_API_KEY');
  const list = projects();
  const tiles = {};
  let bytesRead = 0;

  for (const [name, tile] of Object.entries(TILES)) {
    const per = {};
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
    projects: list.map(({ key, label, id }) => ({ key, label, id })),
    bytes_read: bytesRead,
    tiles,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await collect(), null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
  }
}
