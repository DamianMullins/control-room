import type { PageServerLoad } from './$types';
import { cached } from '#lib/server/cache.js';
import { posthogTiles } from '#lib/server/posthog.js';
import { sentryTiles } from '#lib/server/sentry.js';
import { RANGES, DEFAULT_RANGE, isRange } from '#lib/server/range.js';

const TTL = 5 * 60 * 1000;
const RANGE_COOKIE = 'range';

export const load: PageServerLoad = async ({ url, cookies }) => {
  // Precedence: the URL wins, then the last choice remembered in a cookie, then 30d.
  // Only allowlisted values ever reach the queries, and the cache key carries the range
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

  const [posthog, sentry] = await Promise.all([
    cached(`posthog:${range}`, TTL, () => posthogTiles(range)),
    cached(`sentry:${range}`, TTL, () => sentryTiles(range)),
  ]);

  return { posthog, sentry, range, ranges: RANGES, renderedAt: new Date().toISOString() };
};
