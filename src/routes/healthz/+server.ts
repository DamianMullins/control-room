import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '#lib/config.js';

// Cheap liveness endpoint: no upstream calls, so it is safe to poll.
// It answers "is the process up and configured", not "are PostHog and Sentry healthy" —
// checking those would burn the same read budgets the dashboard runs on.
const startedAt = Date.now();

export const GET: RequestHandler = () => {
  const configured = {
    posthog: Boolean(env('POSTHOG_PERSONAL_API_KEY') && env('POSTHOG_PROJECTS')),
    sentry: Boolean(env('SENTRY_AUTH_TOKEN') && env('SENTRY_ORG') && env('SENTRY_PROJECT')),
  };

  return json(
    {
      status: 'ok',
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      configured,
      time: new Date().toISOString(),
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};
