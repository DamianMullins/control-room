// PostHog: one HogQL query per tile, run against every configured project, merged here.
// /query/ is per-project and HogQL cannot join across projects, and each org has its own
// free allowance — so the merge happens in this process, not in PostHog. Projects come from
// POSTHOG_PROJECTS so a clone can point at its own:
//
//   POSTHOG_PROJECTS=web:Web:12345,app:App:67890    # key:label:project_id, comma separated
import { env } from '#lib/config.js';

const API = 'https://eu.posthog.com/api/projects';

/** @returns {{key: string, label: string, id: number}[]} */
export function projects() {
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

/** @param {number} projectId @param {string} sql */
async function hogql(projectId, sql) {
  const key = env('POSTHOG_PERSONAL_API_KEY');
  if (!key) throw new Error('POSTHOG_PERSONAL_API_KEY is not set');

  const res = await fetch(`${API}/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
  });

  if (res.status === 429) {
    throw new Error(`project ${projectId}: read budget exhausted, retry in ${res.headers.get('retry-after')}s`);
  }
  if (!res.ok) throw new Error(`project ${projectId}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`project ${projectId}: ${body.error}`);

  return {
    rows: body.results || [],
    bytesRead: Number(res.headers.get('x-posthog-query-bytes-read') || 0),
    budgetLeft: Number(res.headers.get('x-posthog-query-budget-remaining-bytes') || 0),
  };
}

const blank = (list) => Object.fromEntries(list.map((p) => [p.key, 0]));

const TILES = {
  totals30d: {
    sql: `SELECT count() AS n FROM events WHERE timestamp >= now() - INTERVAL 30 DAY`,
    merge: (per, list) => {
      const out = { ...blank(list), total: 0 };
      for (const p of list) out[p.key] = per[p.key]?.[0]?.[0] ?? 0;
      out.total = list.reduce((n, p) => n + out[p.key], 0);
      return out;
    },
  },
  users30d: {
    sql: `SELECT count(DISTINCT distinct_id) AS n FROM events WHERE timestamp >= now() - INTERVAL 30 DAY`,
    merge: (per, list) => {
      const out = {};
      let total = 0;
      for (const p of list) {
        out[p.key] = per[p.key]?.[0]?.[0] ?? 0;
        total += out[p.key];
      }
      // Distinct across projects can't be summed exactly — flag it rather than lie.
      return { ...out, total, approximate: true };
    },
  },
  daily14d: {
    sql: `SELECT toDate(timestamp) AS day, count() AS events
          FROM events WHERE timestamp >= today() - INTERVAL 13 DAY
          GROUP BY day ORDER BY day`,
    merge: (per, list) => {
      const days = new Map();
      for (const p of list) {
        for (const [day, n] of per[p.key] || []) {
          const d = String(day).slice(0, 10);
          const row = days.get(d) || { day: d, ...blank(list), total: 0 };
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
          GROUP BY event ORDER BY n DESC LIMIT 12`,
    merge: (per, list) => {
      const evs = new Map();
      for (const p of list) {
        for (const [event, n] of per[p.key] || []) {
          const row = evs.get(event) || { event, ...blank(list), total: 0 };
          row[p.key] = n;
          row.total += n;
          evs.set(event, row);
        }
      }
      return [...evs.values()].sort((a, b) => b.total - a.total).slice(0, 12);
    },
  },
};

export async function posthogTiles() {
  const list = projects();
  const tiles = {};
  const errors = [];
  let bytesRead = 0;

  for (const [name, tile] of Object.entries(TILES)) {
    const per = {};
    // Sequential on purpose: predictable read budget, no burst of 429s.
    for (const project of list) {
      try {
        const { rows, bytesRead: b } = await hogql(project.id, tile.sql);
        per[project.key] = rows;
        bytesRead += b;
      } catch (err) {
        per[project.key] = [];
        errors.push(`${name}/${project.key}: ${err.message}`);
      }
    }
    tiles[name] = tile.merge(per, list);
  }

  return { projects: list, tiles, bytesRead, errors };
}
