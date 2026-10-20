<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const ph = $derived(data.posthog.tiles);
  const se = $derived(data.sentry);
  // Project list comes from the API response, so the UI follows POSTHOG_PROJECTS.
  const projects = $derived(data.posthog.projects ?? []);
  const range = $derived(data.range);

  const palette = ['#58a6ff', '#3fb950', '#f0883e', '#a371f7', '#e3b341'];
  const colour = (i: number): string => palette[i % palette.length];

  const maxDaily = $derived(Math.max(1, ...ph.series.map((d) => d.total)));
  const maxErrors = $derived(Math.max(1, ...se.errorVolume.series.map((d) => d.count)));
  const maxGroup = $derived(
    Math.max(1, ...se.topIssues.map((i) => i.count), ...se.otherIssues.map((i) => i.count))
  );
  // Log scale: the ignored crawler groups are ~200× the unresolved ones, so a linear bar turns
  // every real bug into an invisible sliver. Ordering survives, magnitudes don't — read the numbers.
  const barWidth = $derived((n: number): number => (Math.log1p(n) / Math.log1p(maxGroup)) * 100);
  const maxEvent = $derived(Math.max(1, ...ph.topEvents.map((e) => e.total)));

  const nf = new Intl.NumberFormat('en-GB');
  const num = (v: number | null | undefined): string =>
    v === null || v === undefined ? '—' : nf.format(Math.round(v * 100) / 100);
  const dec = (v: number | null | undefined): number | string =>
    v === null || v === undefined ? '—' : Math.round(v * 100) / 100;

  const stale = $derived(data.posthog.cached && data.sentry.cached);
  const label = $derived(projects.map((p) => p.label).join(' + '));
  const bucketUnit = $derived(range === '24h' ? 'hour' : 'day');
</script>

<svelte:head>
  <title>Control room{label ? ` — ${label}` : ''}</title>
</svelte:head>

<main>
  <header>
    <div>
      <h1>Control room</h1>
      <p class="sub">
        PostHog ({projects.length} project{projects.length === 1 ? '' : 's'}, merged) · Sentry
        {se.project} ({se.region})
      </p>
    </div>
    <div class="meta">
      <nav class="ranges" aria-label="Time range">
        {#each data.ranges as option}
          <a
            href="?range={option}"
            class:active={option === range}
            aria-current={option === range ? 'true' : undefined}>{option}</a
          >
        {/each}
      </nav>
      <span class="pill" class:live={!stale}>{stale ? 'cached' : 'fresh'}</span>
      <span class="dim">{new Date(data.renderedAt).toLocaleTimeString('en-GB')}</span>
    </div>
  </header>

  <section class="kpis">
    <article class="card">
      <h2>Events · {range}</h2>
      <p class="big">{num(ph.totals.total)}</p>
      <p class="split">
        {#each projects as p, i}
          <span class="dot" style="background:{colour(i)}"></span>{num(ph.totals.byProject[p.key])}
          {p.label.toLowerCase()}
        {/each}
      </p>
    </article>

    <article class="card">
      <h2>Distinct users · {range}</h2>
      <p class="big">{num(ph.users.total)}</p>
      <p class="split">
        {#each projects as p, i}
          <span class="dot" style="background:{colour(i)}"></span>{num(ph.users.byProject[p.key])}
          {p.label.toLowerCase()}
        {/each}
      </p>
      <p class="note">summed per project — the same person in two projects counts twice</p>
    </article>

    <article class="card">
      <h2>Unresolved issues</h2>
      <p class="big" class:warn={se.unresolved.count > 0}>{num(se.unresolved.count)}</p>
      <p class="split">
        {num(se.unresolved.events)} events across those issues · {range}
      </p>
    </article>

    <article class="card">
      <h2>Error events · 24h</h2>
      <p class="big">{num(se.errorVolume.d24h)}</p>
      <p class="split">{num(se.errorVolume.total)} in {range}</p>
      <p class="note">every error event, ignored issues included</p>
    </article>
  </section>

  <section class="card">
    <h2>
      Events per {bucketUnit} · {range}
      <span class="legend">
        {#each projects as p, i}<i style="background:{colour(i)}"></i>{p.label}{/each}
      </span>
    </h2>
    <div class="chart">
      {#each ph.series as d}
        <div class="col">
          <div class="stack">
            {#each projects as p, i}
              <div
                class="bar"
                style="height:{(d.byProject[p.key] / maxDaily) * 100}%; background:{colour(i)}"
              ></div>
            {/each}
          </div>
          <span class="tick">{d.label}</span>

          <div class="tip" role="tooltip">
            <b>{d.full}</b>
            {#each projects as p, i}
              <span><i style="background:{colour(i)}"></i>{p.label} {num(d.byProject[p.key])}</span>
            {/each}
            <span class="tot">total {num(d.total)}</span>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <section class="cols">
    <article class="card">
      <h2>Top events · {range}</h2>
      <ul class="rows">
        {#each ph.topEvents as e}
          <li>
            <code>{e.event}</code>
            <span class="bar-mini"><i style="width:{(e.total / maxEvent) * 100}%"></i></span>
            <b>{num(e.total)}</b>
          </li>
        {:else}
          <li class="empty">No events in this window</li>
        {/each}
      </ul>
    </article>

    <article class="card">
      <h2>Error events by issue group · {range}</h2>

      <div class="spark">
        {#each se.errorVolume.series as d}
          <div class="scol">
            <div class="sbar" style="height:{(d.count / maxErrors) * 100}%"></div>
            <div class="tip" role="tooltip">
              <b>{d.full}</b>
              <span>{num(d.count)} error events</span>
            </div>
          </div>
        {/each}
      </div>
      <p class="spark-axis">
        <span>{se.errorVolume.series[0]?.label}</span>
        <span>{num(se.errorVolume.total)} in {range} · trend per {bucketUnit}</span>
        <span>{se.errorVolume.series[se.errorVolume.series.length - 1]?.label}</span>
      </p>

      <h3>Unresolved · {se.unresolved.count}</h3>
      <ul class="rows groups">
        {#each se.topIssues as i}
          <li>
            <a href={i.permalink} target="_blank" rel="noreferrer">{i.title}</a>
            <span class="tag {i.status}">{i.status}</span>
            <span class="bar-mini"
              ><i style="width:{barWidth(i.count)}%; background:#f0883e"></i></span
            >
            <b>{num(i.count)}</b>
          </li>
        {:else}
          <li class="empty">No issues in this window</li>
        {/each}
      </ul>

      {#if se.otherIssues.length}
        <h3>Not unresolved</h3>
        <ul class="rows groups dim">
          {#each se.otherIssues as i}
            <li>
              <a href={i.permalink} target="_blank" rel="noreferrer">{i.title}</a>
              <span class="tag {i.status}">{i.status}</span>
              <span class="bar-mini"
                ><i style="width:{barWidth(i.count)}%; background:#6e7681"></i></span
              >
              <b>{num(i.count)}</b>
            </li>
          {/each}
        </ul>
      {/if}

      <p class="note">
        Bars are log-scaled so small groups stay visible — read the numbers, not the lengths. These
        groups account for {num(se.attribution.shown)} of {num(se.attribution.total)} error events
        in {range}.
      </p>
    </article>
  </section>

  <section class="card">
    <h2>Application metrics · Sentry tracemetrics · {range}</h2>
    <div class="metrics">
      {#each se.metrics as m}
        <div class="metric">
          <span class="label">{m.label}</span>
          <span class="value">{dec(m.value)}</span>
          <span class="period">{range}</span>
        </div>
      {/each}
    </div>
  </section>

  <footer>
    <span>PostHog read: {num(data.posthog.bytesRead)} bytes</span>
    <span>Sentry calls: {num(se.calls)}</span>
    {#if data.posthog.errors?.length}<span class="warn">posthog: {data.posthog.errors.join('; ')}</span>{/if}
    {#if data.sentry.errors?.length}<span class="warn">sentry: {data.sentry.errors.join('; ')}</span>{/if}
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0d1117;
    color: #e6edf3;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  :global(a) { color: #7cc4ff; text-decoration: none; }
  :global(a:hover) { text-decoration: underline; }
  main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 24px; }
  h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b949e; margin: 0 0 12px; font-weight: 600; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b949e; margin: 20px 0 8px; }
  .sub { margin: 4px 0 0; color: #8b949e; font-size: 13px; }
  .meta { display: flex; gap: 10px; align-items: center; font-size: 12px; }
  .dim { color: #8b949e; }
  .pill { padding: 2px 8px; border-radius: 999px; background: #21262d; border: 1px solid #30363d; color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .pill.live { color: #3fb950; border-color: #238636; }

  .ranges { display: flex; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  .ranges a { padding: 3px 10px; font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.06em; }
  .ranges a:hover { background: #21262d; text-decoration: none; }
  .ranges a.active { background: #1f6feb33; color: #7cc4ff; }

  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .card { position: relative; background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px 18px; margin-bottom: 12px; }
  .kpis .card { margin: 0; }

  .big { font-size: 30px; font-weight: 650; margin: 0; letter-spacing: -0.02em; }
  .big.warn { color: #f0883e; }
  .split { margin: 6px 0 0; font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .note { margin: 6px 0 0; font-size: 11px; color: #6e7681; }
  .dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-left: 6px; }
  .dot:first-child { margin-left: 0; }

  .legend { font-size: 11px; text-transform: none; letter-spacing: 0; color: #8b949e; margin-left: 10px; display: inline-flex; gap: 6px; align-items: center; }
  .legend i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; margin-left: 6px; }

  .chart { display: flex; align-items: flex-end; gap: 6px; height: 180px; padding-top: 8px; }
  .col { position: relative; flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; height: 100%; }
  .stack { display: flex; flex-direction: column-reverse; justify-content: flex-start; width: 100%; height: 100%; }
  .bar { width: 100%; min-height: 1px; }
  .tick { font-size: 10px; color: #6e7681; }

  /* Slim trend strip above the group rows: shape only, numbers live in the tooltip. */
  .spark { display: flex; align-items: flex-end; gap: 2px; height: 34px; }
  .scol { position: relative; flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .sbar { width: 100%; min-height: 1px; background: #f0883e; opacity: 0.7; border-radius: 1px; }
  .scol:hover .sbar { opacity: 1; }
  .scol:hover .tip { opacity: 1; }
  .spark-axis { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: #6e7681; margin: 4px 0 16px; }
  .rows li.empty { color: #6e7681; font-size: 12px; display: block; }
  .rows.dim a, .rows.dim b { color: #8b949e; }

  .tip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 116px;
    padding: 7px 9px;
    background: #010409;
    border: 1px solid #30363d;
    border-radius: 7px;
    box-shadow: 0 6px 18px #000a;
    font-size: 11px;
    color: #c9d1d9;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 90ms ease;
    z-index: 5;
  }
  .tip b { font-weight: 600; color: #e6edf3; }
  .tip i { width: 7px; height: 7px; border-radius: 2px; display: inline-block; margin-right: 5px; }
  .tip .tot { border-top: 1px solid #21262d; margin-top: 3px; padding-top: 3px; color: #8b949e; }
  .col:hover .tip { opacity: 1; }

  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .rows li { display: grid; grid-template-columns: 1fr 90px 56px; align-items: center; gap: 10px; font-size: 13px; }
  /* Issue rows carry a bar between the status pill and the count, sized by event volume. */
  .rows.groups li { grid-template-columns: 1fr 92px 140px 46px; }
  .rows.groups .tag { justify-self: start; white-space: nowrap; font-size: 9.5px; padding: 1px 5px; }
  .rows code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rows b { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar-mini { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; }
  .bar-mini i { display: block; height: 100%; background: #58a6ff; }
  .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; border: 1px solid #30363d; border-radius: 999px; padding: 1px 6px; text-align: center; }
  .tag.unresolved { color: #f0883e; border-color: #6b3b0f; }
  .tag.ignored { color: #6e7681; }

  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .metric { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
  .metric .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .metric .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .metric .period { font-size: 11px; color: #6e7681; }

  footer { margin-top: 20px; display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: #6e7681; }
  .warn { color: #f0883e; }

  @media (max-width: 860px) {
    .kpis, .metrics { grid-template-columns: repeat(2, 1fr); }
    .cols { grid-template-columns: 1fr; }
  }
</style>
