import type { PageServerLoad } from './$types';
import { cached } from '#lib/server/cache.js';
import { posthogTiles } from '#lib/server/posthog.js';
import { sentryTiles } from '#lib/server/sentry.js';
import { RANGES, DEFAULT_RANGE, isRange } from '#lib/server/range.js';

const TTL = 5 * 60 * 1000;

export const load: PageServerLoad = async ({ url }) => {
  // Only known-good windows ever reach the queries, and the cache key carries the range
  // so switching back and forth does not re-hit the APIs.
  const requested = url.searchParams.get('range');
  const range = isRange(requested) ? requested : DEFAULT_RANGE;

  const [posthog, sentry] = await Promise.all([
    cached(`posthog:${range}`, TTL, () => posthogTiles(range)),
    cached(`sentry:${range}`, TTL, () => sentryTiles(range)),
  ]);

  return { posthog, sentry, range, ranges: RANGES, renderedAt: new Date().toISOString() };
};
