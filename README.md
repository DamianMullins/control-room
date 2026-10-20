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
  Metrics (`dataset=tracemetrics`) from whichever Sentry region you point it at.
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
| `SENTRY_AUTH_TOKEN` | Sentry user token with `event:read` + `org:read` |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Slugs from your Sentry project URL |
| `SENTRY_BASE_URL` | Region base: `https://de.sentry.io/api/0` (EU/DE) or `https://sentry.io/api/0` (US) |

`vite.config.js` loads `.env` into `process.env` in dev; adapter-node reads the real
environment in production. `src/lib/config.js` is the single place env is read.

## Tiles

- Events / distinct users / unresolved issues / error events — KPIs for the selected window
- Events per day, stacked per project, with a hover tooltip per day
- Top events, merged across projects
- Error events per day + top issues
- Application metrics from Sentry's tracemetrics dataset

The window is a query parameter: `?range=7d` (also `14d`, `30d`; default `30d`). Only those
three values are accepted, so nothing user-supplied ever reaches a SQL string.

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
