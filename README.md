# control-room

One page that merges **product analytics across several PostHog projects** with **Sentry**
issues, error volume and Application Metrics. SvelteKit + adapter-node; every tile renders
server-side from a single `load()`, so it works with JS disabled and costs one process.

## Why the merge happens here

PostHog's `/query/` endpoint is **per project**, and HogQL cannot join across projects. If
your products live in separate PostHog orgs — a common choice, because free allowances and
billing limits are per org — there is no query that spans them. So this app fans out:

- `src/lib/server/posthog.js` — one HogQL query per tile, run against every configured
  project, merged by project key. Projects come from `POSTHOG_PROJECTS`.
- `src/lib/server/sentry.js` — issues, error volume (`dataset=errors`) and Application
  Metrics (`dataset=tracemetrics`) from **any number of Sentry projects, each in its own org
  and region** (`SENTRY_PROJECTS`). The region is part of every endpoint, so a DE org and a
  US org cannot share one base URL — each entry carries its own.
- `src/lib/server/cache.js` — 5-minute in-process cache. `/query/` draws from an hourly
  byte-read budget and Sentry rate-limits per token, so a page refresh must never fan out
  to the APIs.

## Run

```bash
cp .env.example .env   # tokens + your projects
pnpm install
pnpm dev               # http://localhost:5390
pnpm check             # svelte-check, strict
pnpm build && pnpm start
```

## Env

| Var | Notes |
| --- | --- |
| `POSTHOG_PERSONAL_API_KEY` | PostHog user settings → personal API keys, needs **Query Read** |
| `POSTHOG_PROJECTS` | `key:label:project_id`, comma separated — e.g. `web:Web:12345,app:App:67890` |
| `SENTRY_AUTH_TOKEN` | Sentry token with `event:read` + `org:read`; used for any project without its own |
| `SENTRY_PROJECTS` | `key:label:org:project:region`, comma separated — region is `de` or `us` |
| `SENTRY_TOKEN_<KEY>` | Optional per-org token (e.g. `SENTRY_TOKEN_APP`) — needed when projects live in different orgs |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_BASE_URL` | Legacy single-project setup, still honoured when `SENTRY_PROJECTS` is unset |

Two things the Sentry APIs make you notice:

- **The issues endpoint needs `project:read` on top of `event:read`.** Without it a project
  answers **403** and you get its error volumes with no titles or statuses. This app then
  harvests titles from the discover dataset (`field=issue&field=title`) and marks the status
  `unknown`, so the page keeps working while telling you what it cannot see.
- **Metrics are declared per project key** in `src/lib/server/sentry.ts`. A project with no
  entry simply has no metric rows, rather than four rows of em-dashes.

`vite.config.js` loads `.env` into `process.env` in dev; adapter-node reads the real
environment in production. `src/lib/config.js` is the single place env is read.

## Tiles

- Events / distinct users / unresolved issues / error events — KPIs for the selected window
- Events per day, stacked per project, with a hover tooltip per day
- Top events, merged across projects
- Error events broken down by issue group (unresolved first, then ignored/resolved), above a slim
  sparkline of the per-day trend, with the groups' share of the window's total spelled out
- Application metrics from Sentry's tracemetrics dataset, for the projects that declare them

**Application Metrics are declared per project, in code.** `METRICS` in
`src/lib/server/sentry.ts` maps a project key to `{ label, field }` rows, where `field` is the
MRI exactly as Sentry stored it — `count(value,api.completed,counter,none)` for a counter,
`p95(value,api.duration,distribution,millisecond)` for a distribution. Keep the dots: the
Next.js SDK registers `api.completed` verbatim, and querying the underscore form returns a
silent zero. A project with no entry simply contributes no metric rows.

Those queries are org-wide endpoints, so each one is filtered by the project's numeric id
(resolved once per process from `/projects/{org}/{project}/`). An org can hold more than one
project — an org can hold more than one project — and without the filter a tile would blend
both. The id lookup counts towards the "Sentry calls" figure in the footer.

**Click anything to drill in.** Top-event rows open that event (trend, distinct users, first/last
seen, top pages); a chart bar opens that bucket (which events, or which error groups, produced
it); an issue row opens that group (trend, event totals, URLs). The modal fetches
`/api/detail?kind=event|bucket|issue&range=…` — a JSON endpoint behind the same 5-minute cache —
closes on Escape, backdrop click or ×, and never reloads the page.

The window is a query parameter: `?range=24h` (also `7d`, `14d`, `30d`; default `30d`). Only
those four values are accepted, so nothing user-supplied ever reaches a SQL string. The choice
is remembered in a cookie, so a bare `/` reopens the last window you looked at; 24h is bucketed
by hour, the rest by day, and both charts are aligned to the same bucket boundaries with empty
buckets zero-filled.

**Project filter.** `?project=<key>` narrows every tile, chart and drill-down to a single project;
`all` (or omitting it) merges the configured ones. The keys are the ones in `POSTHOG_PROJECTS`
and `SENTRY_PROJECTS` — the same key is assumed to mean the same product across both sources —
and an unknown key falls back to `all` rather than erroring. Combining `range` and `project` is
free: the 5-minute cache is keyed on both.

**Issue count ≠ error count.** "Unresolved issues" counts *groups* and states how many events
they contain; the error chart counts *events*, including ignored bot-scan groups. The two
numbers are different units, which is why they look unrelated.

## Deploy (macOS, launchd)

Runs as a LaunchAgent so it restarts on crash and survives reboot. `start.sh` sources
`.env` (chmod 600), so tokens never live in the plist.

```bash
# ~/Library/LaunchAgents/<label>.plist points at this repo's start.sh:
#   ProgramArguments = /bin/bash <repo>/start.sh
#   RunAtLoad, KeepAlive = true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
launchctl print gui/$(id -u)/<label> | grep -E 'state|pid'

# reload after a rebuild
launchctl bootout gui/$(id -u)/<label>
pnpm build && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
```

`start.sh` binds `0.0.0.0:${PORT:-5391}`; put it behind whatever private network you use
(Tailscale, WireGuard, a reverse proxy with auth). It has **no authentication of its own** —
do not expose it to the internet as-is.

`scripts/posthog-merged.ts` is the same fan-out as a standalone CLI, useful for checking
numbers without the web app — `node scripts/posthog-merged.ts` (Node 22+ strips the types
natively).

## Health

`GET /healthz` returns `{"status":"ok","uptime_s":…,"configured":{"posthog":…,"sentry":…}}`
with `cache-control: no-store` and **no upstream calls** — it answers "is the process up and
configured", not "are PostHog and Sentry healthy", so it is safe to poll every minute.
A missing token answers **503** with `"status":"degraded"`, so a 2xx-only monitor (or a
keyword match on `"status":"ok"`) goes red when the process is up but useless.

## Gotchas found the hard way

- **"Last 14 days" needs `today() - INTERVAL 13 DAY`.** `now() - INTERVAL 14 DAY` is
  inclusive of both endpoints and renders 15 buckets. Sentry's `events-stats` also returns
  one leading bucket — sliced to 14 in `sentry.js`.
- **Distinct users across projects is summed, not deduplicated.** The same person active in
  both products counts twice; the tile says so rather than pretending otherwise.
- **Sentry metric units are whatever the SDK registered.** A metric named `queue_save_ms`
  reported `~6,660` with unit `none` — query with the wrong unit in the MRI and you get 0,
  which reads exactly like "this never happened".
- **SvelteKit 3:** `svelte.config.js` is gone (config lives in the `sveltekit()` Vite
  plugin), `$lib` is `#lib` (declared via `"imports": { "#lib/*": "./src/lib/*" }` in
  package.json), and `$env/dynamic/private` is `$app/env/private` with `defineEnvVars`.

## License

MIT — see [LICENSE](./LICENSE).
