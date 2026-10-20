import type { PageServerLoad } from './$types';
import { cached } from '#lib/server/cache.js';
import { posthogTiles, projects } from '#lib/server/posthog.js';
import { sentryTiles, sentryProjects } from '#lib/server/sentry.js';
import { RANGES, DEFAULT_RANGE, isRange } from '#lib/server/range.js';

const TTL = 5 * 60 * 1000;
const RANGE_COOKIE = 'range';

/** Union of the configured keys, labelled from whichever source names it best. */
function projectOptions(): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const p of projects()) seen.set(p.key, p.label);
  for (const p of sentryProjects()) if (!seen.has(p.key)) seen.set(p.key, p.label);
  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}

export const load: PageServerLoad = async ({ url, cookies }) => {
  // Precedence: the URL wins, then the last choice remembered in a cookie, then 30d.
  // Only allowlisted values ever reach the queries, and the cache key carries both filters
  // so switching back and forth does not re-hit the APIs.
  const requested = url.searchParams.get('range');
  const remembered = cookies.get(RANGE_COOKIE) ?? null;
  const range = isRange(requested) ? requested : isRange(remembered) ? remembered : DEFAULT_RANGE;

  if (isRange(requested) && requested !== remembered) {
    cookies.set(RANGE_COOKIE, requested, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      httpOnly: true,
      sameSite: 'lax',
      // Served over plain http on a private network (Tailscale). SvelteKit defaults the
      // Secure flag on for any non-localhost host, and a Secure cookie is never sent back
      // over http — so the remembered range silently failed until this was pinned off.
      secure: false,
    });
  }

  // Same idea for the project filter: an unknown key falls back to "all", never an error.
  const options = projectOptions();
  const requestedProject = url.searchParams.get('project');
  const selected =
    requestedProject && options.some((o) => o.key === requestedProject) ? requestedProject : null;
  const only = selected ? [selected] : undefined;

  const [posthog, sentry] = await Promise.all([
    cached(`posthog:${range}:${selected ?? 'all'}`, TTL, () => posthogTiles(range, only)),
    cached(`sentry:${range}:${selected ?? 'all'}`, TTL, () => sentryTiles(range, only)),
  ]);

  return {
    posthog,
    sentry,
    range,
    ranges: RANGES,
    projects: options,
    selected,
    renderedAt: new Date().toISOString(),
  };
};
