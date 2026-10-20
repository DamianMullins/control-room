import { cached } from '#lib/server/cache.js';
import { posthogTiles } from '#lib/server/posthog.js';
import { sentryTiles } from '#lib/server/sentry.js';

const TTL = 5 * 60 * 1000;

export async function load() {
  const [posthog, sentry] = await Promise.all([
    cached('posthog', TTL, posthogTiles),
    cached('sentry', TTL, sentryTiles),
  ]);

  return { posthog, sentry, renderedAt: new Date().toISOString() };
}
