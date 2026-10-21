import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '#lib/config.js';
import { cachedKeys } from '#lib/server/cache.js';

// Cheap liveness endpoint: no upstream calls, so it is safe to poll.
// It answers "is the process up and configured", not "are PostHog and Sentry healthy" —
// checking those would burn the same read budgets the dashboard runs on. A missing
// token flips the body to "degraded" and the status to 503, so a plain 2xx monitor
// (or a keyword match on "status":"ok") fails instead of reporting a working service.
const startedAt = Date.now();

export const GET: RequestHandler = () => {
  const configured = {
    posthog: Boolean(env('POSTHOG_PERSONAL_API_KEY') && env('POSTHOG_PROJECTS')),
    // SENTRY_PROJECTS is the current shape; the single-project vars are the legacy fallback.
    sentry: Boolean(env('SENTRY_PROJECTS') || (env('SENTRY_ORG') && env('SENTRY_PROJECT'))),
  };

  const healthy = configured.posthog && configured.sentry;

  return json(
    {
      status: healthy ? 'ok' : 'degraded',
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      configured,
      // Which range/project slices are warm. Reading the cache costs nothing upstream, so a
      // non-zero count after a page view is the quickest proof the background warming ran.
      cache: { keys: cachedKeys().length },
      time: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } }
  );
};
