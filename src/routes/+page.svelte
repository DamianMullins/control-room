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
  // With one project selected the per-project split chips are just noise.
  const multi = $derived(data.projects.length > 1 && !data.selected);
  const bucketUnit = $derived(range === '24h' ? 'hour' : 'day');

  type Detail = import('#lib/server/detail.js').Detail;

  let detail = $state<Detail | null>(null);
  let loading = $state(false);
  let failed = $state<string | null>(null);

  // One endpoint, three kinds. The server caches each answer for 5 minutes, so reopening a
  // row you just looked at costs no upstream reads.
  async function open(
    kind: 'event' | 'bucket' | 'issue' | 'path',
    params: Record<string, string>
  ) {
    const qs = new URLSearchParams({ kind, range, ...params });
    if (data.selected && !params.project) qs.set('project', data.selected);
    loading = true;
    failed = null;
    detail = null;
    try {
      const res = await fetch(`/api/detail?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      detail = (await res.json()) as Detail;
    } catch (err) {
      failed = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  const close = () => {
    detail = null;
    loading = false;
    failed = null;
  };

  const seriesMax = (points: { count: number }[]) => Math.max(1, ...points.map((p) => p.count));

  const onEnter = (e: KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
</script>

<svelte:head>
  <title>Control room{label ? ` — ${label}` : ''}</title>
</svelte:head>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') close();
  }}
/>

<main>
  <header>
    <div>
      <h1>Control room</h1>
      <p class="sub">
        {#if data.selected}
          {projects[0]?.label ?? data.selected} · PostHog events + Sentry errors
        {:else}
          PostHog ({projects.length} project{projects.length === 1 ? '' : 's'}, merged) · Sentry
          {#if se.projects.length}
            {se.projects.map((p) => `${p.label} (${p.region})`).join(' + ')}
          {:else}
            not configured for this project
          {/if}
        {/if}
      </p>
    </div>
    <div class="meta">
      <span class="ctrl-label">project</span>
      <nav class="ranges" aria-label="Project">
        <a
          href="?range={range}"
          class:active={!data.selected}
          aria-current={!data.selected ? 'true' : undefined}>all</a
        >
        {#each data.projects as option}
          <a
            href="?range={range}&project={option.key}"
            class:active={data.selected === option.key}
            aria-current={data.selected === option.key ? 'true' : undefined}>{option.label}</a
          >
        {/each}
      </nav>
      <span class="ctrl-label">range</span>
      <nav class="ranges" aria-label="Time range">
        {#each data.ranges as option}
          <a
            href="?range={option}{data.selected ? `&project=${data.selected}` : ''}"
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
      {#if multi}
        <p class="split">
          {#each projects as p, i}
            <span class="dot" style="background:{colour(i)}"></span>{num(ph.totals.byProject[p.key])}
            {p.label.toLowerCase()}
          {/each}
        </p>
      {/if}
    </article>

    <article class="card">
      <h2>Distinct users · {range}</h2>
      <p class="big">{num(ph.users.total)}</p>
      {#if multi}
        <p class="split">
          {#each projects as p, i}
            <span class="dot" style="background:{colour(i)}"></span>{num(ph.users.byProject[p.key])}
            {p.label.toLowerCase()}
          {/each}
        </p>
        <p class="note">summed per project — the same person in two projects counts twice</p>
      {/if}
    </article>

    <article class="card">
      <h2>Unresolved issues</h2>
      <p class="big" class:warn={se.unresolved.count > 0}>{num(se.unresolved.count)}</p>
      <p class="split">
        {num(se.unresolved.events)} events across those issues · {range}
      </p>
      {#if multi}
        <p class="split">
          {#each se.projects as p, i}
            <span class="dot" style="background:{colour(i)}"></span>{num(
              se.unresolved.byProject[p.key]
            )}
            {p.label.toLowerCase()}
          {/each}
        </p>
      {/if}
    </article>

    <article class="card">
      <h2>Error events · 24h</h2>
      <p class="big">{num(se.errorVolume.d24h)}</p>
      <p class="split">{num(se.errorVolume.total)} in {range}</p>
      {#if multi}
        <p class="split">
          {#each se.projects as p, i}
            <span class="dot" style="background:{colour(i)}"></span>{num(
              se.errorVolume.d24hByProject[p.key]
            )}
            {p.label.toLowerCase()}
          {/each}
        </p>
      {/if}
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
        <div
          class="col clickable"
          role="button"
          tabindex="0"
          aria-label="Break down {d.full}"
          onclick={() => open('bucket', { at: d.full, source: 'events' })}
          onkeydown={(ev) => onEnter(ev, () => open('bucket', { at: d.full, source: 'events' }))}
        >
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
            <button
              type="button"
              class="rowbtn row3"
              onclick={() => open('event', { name: e.event })}
            >
              <code>{e.event}</code>
              <span class="bar-mini"><i style="width:{(e.total / maxEvent) * 100}%"></i></span>
              <b>{num(e.total)}</b>
            </button>
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
          <div
            class="scol clickable"
            role="button"
            tabindex="0"
            aria-label="Break down {d.full}"
            onclick={() => open('bucket', { at: d.full, source: 'errors' })}
            onkeydown={(ev) => onEnter(ev, () => open('bucket', { at: d.full, source: 'errors' }))}
          >
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
            <button
              type="button"
              class="rowbtn row4"
              onclick={() =>
                open('issue', { id: String(i.id), project: i.projectKey, shortId: i.shortId, title: i.title })}
            >
              <span class="iwrap"><span class="ititle">{i.title}</span><span class="proj">{i.projectLabel}</span></span>
              <span class="tag {i.status}">{i.status}</span>
              <span class="bar-mini"><i style="width:{barWidth(i.count)}%; background:#f0883e"></i></span>
              <b>{num(i.count)}</b>
            </button>
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
              <button
                type="button"
                class="rowbtn row4 dim"
                onclick={() =>
                  open('issue', { id: String(i.id), project: i.projectKey, shortId: i.shortId, title: i.title })}
              >
                <span class="iwrap"><span class="ititle">{i.title}</span><span class="proj">{i.projectLabel}</span></span>
                <span class="tag {i.status}">{i.status}</span>
                <span class="bar-mini"><i style="width:{barWidth(i.count)}%; background:#6e7681"></i></span>
                <b>{num(i.count)}</b>
              </button>
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
          {#each se.projects.filter((p) => m.byProject[p.key] !== undefined) as p}
            <span class="value">{dec(m.byProject[p.key])}<i class="pname">{p.label}</i></span>
          {/each}
          <span class="period">{range}</span>
        </div>
      {:else}
        <p class="note">No Application Metrics are configured for these projects.</p>
      {/each}
    </div>
  </section>

  <footer>
    <span>PostHog read: {num(data.posthog.bytesRead)} bytes</span>
    <span>Sentry calls: {num(se.calls)}</span>
    {#if data.posthog.errors?.length}<span class="warn">posthog: {data.posthog.errors.join('; ')}</span>{/if}
    {#if data.sentry.errors?.length}<span class="warn">sentry: {data.sentry.errors.join('; ')}</span>{/if}
  </footer>

  {#if loading || detail || failed}
    <div
      class="backdrop"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onkeydown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        aria-label={detail?.title ?? 'Details'}
      >
        <div class="mhead">
          <div>
            <h2 class="mtitle">{detail?.title ?? 'Loading…'}</h2>
            {#if detail?.subtitle}<p class="sub">{detail.subtitle}</p>{/if}
          </div>
          <button class="x" onclick={close} aria-label="Close">×</button>
        </div>

        {#if loading}
          <p class="dim">Loading…</p>
        {:else if failed}
          <p class="warn">Could not load: {failed}</p>
        {:else if detail}
          {#if detail.errors.length}
            <p class="warn">{detail.errors.join('; ')}</p>
          {/if}

          <div class="mstats">
            {#each detail.stats as s}
              <div class="mstat">
                <span class="label">{s.label}</span>
                <span class="value">{s.value}</span>
              </div>
            {/each}
          </div>

          {#if detail.series.length}
            <div class="mseries">
              {#each detail.series as p}
                <div class="mcol" title="{p.full}: {p.count}">
                  <div
                    class="mbar"
                    style="height:{Math.max(2, (p.count / seriesMax(detail.series)) * 100)}%"
                  ></div>
                </div>
              {/each}
            </div>
            <p class="spark-axis">
              <span>{detail.series[0].full}</span>
              <span>{detail.series[detail.series.length - 1].full}</span>
            </p>
          {/if}

          {#if detail.rows.length}
            <h3>{detail.rowsTitle}</h3>
            <ul class="rows plain">
              {#each detail.rows as r}
                <li><div class="row2"><span class="iwrap">{r.label}</span><b>{r.value}</b></div></li>
              {/each}
            </ul>
          {/if}

          {#if detail.related.length}
            <div class="related">
              {#each detail.related as r}
                <button type="button" class="relbtn" onclick={() => open(r.kind, r.params)}>
                  {r.label}
                </button>
              {/each}
            </div>
          {/if}

          {#if detail.link}
            <a class="ext" href={detail.link} target="_blank" rel="noreferrer">Open in source →</a>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
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

  .ctrl-label { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #6e7681; }
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
  .col { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; height: 100%; }
  .stack { display: flex; flex-direction: column-reverse; justify-content: flex-start; width: 100%; height: 100%; }
  .bar { width: 100%; min-height: 1px; }
  .tick { font-size: 10px; color: #6e7681; }

  /* Slim trend strip above the group rows: shape only, numbers live in the tooltip. */
  .spark { display: flex; align-items: flex-end; gap: 2px; height: 34px; }
  .scol { position: relative; flex: 1; min-width: 0; height: 100%; display: flex; align-items: flex-end; }
  .sbar { width: 100%; min-height: 1px; background: #f0883e; opacity: 0.7; border-radius: 1px; }
  .scol:hover .sbar { opacity: 1; }
  .scol:hover .tip { opacity: 1; }
  .spark-axis { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: #6e7681; margin: 4px 0 16px; }
  .rows li.empty { color: #6e7681; font-size: 12px; display: block; }
  .rows.dim b { color: #8b949e; }

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
  /* Edge bars: anchor the tooltip inside the card, otherwise it hangs off the page and
     makes the whole document scroll sideways on a phone. */
  .col:nth-child(-n + 7) .tip,
  .scol:nth-child(-n + 7) .tip { left: 0; transform: none; }
  .col:nth-last-child(-n + 7) .tip,
  .scol:nth-last-child(-n + 7) .tip { left: auto; right: 0; transform: none; }

  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .rows li { font-size: 13px; }
  /* Rows are real buttons so the whole line is keyboard-operable. */
  .rowbtn { display: grid; align-items: center; gap: 10px; width: 100%; margin: 0 -6px; padding: 3px 6px; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .rowbtn:hover { background: #1c2129; }
  .rowbtn:focus-visible { outline: 2px solid #1f6feb; outline-offset: 1px; }
  .row3 { grid-template-columns: 1fr 90px 56px; }
  .row4 { grid-template-columns: 1fr 92px 140px 46px; }
  .row2 { display: grid; grid-template-columns: 1fr 70px; align-items: center; gap: 10px; }
  .rowbtn.dim { color: #8b949e; }
  .rows.groups .tag { justify-self: start; white-space: nowrap; font-size: 9.5px; padding: 1px 5px; }
  .rows code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rows b { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar-mini { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; }
  .bar-mini i { display: block; height: 100%; background: #58a6ff; }
  .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; border: 1px solid #30363d; border-radius: 999px; padding: 1px 6px; text-align: center; }
  .tag.unresolved { color: #f0883e; border-color: #6b3b0f; }
  .tag.ignored { color: #6e7681; }
  .tag.unknown { color: #6e7681; border-style: dashed; }

  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .metric { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
  .metric .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .metric .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .metric .period { font-size: 11px; color: #6e7681; }
  .metric .pname { margin-left: 6px; font-size: 10px; font-style: normal; color: #6e7681; }

  footer { margin-top: 20px; display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: #6e7681; }
  .warn { color: #f0883e; }

  .iwrap { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
  /* One line per row: the title truncates, the project tag and status stay visible. */
  .ititle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj { flex: none; font-size: 9.5px; color: #6e7681; text-transform: uppercase; letter-spacing: 0.05em; }

  /* Chart bars are buttons too: click a bucket to see what was inside it. */
  .col.clickable, .scol.clickable { cursor: pointer; }
  .col.clickable:hover .bar, .scol.clickable:hover .sbar { filter: brightness(1.3); }
  .col.clickable:focus-visible, .scol.clickable:focus-visible { outline: 2px solid #1f6feb; outline-offset: 1px; }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 16px;
    overflow: auto;
    background: #000a;
    backdrop-filter: blur(2px);
  }
  .modal {
    width: min(760px, 100%);
    padding: 18px 20px 22px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    box-shadow: 0 24px 60px #000c;
  }
  .mhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .mtitle { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0; text-transform: none; color: #e6edf3; }
  .x { width: 28px; height: 28px; border-radius: 7px; border: 1px solid #30363d; background: #21262d; color: #8b949e; font-size: 16px; line-height: 1; cursor: pointer; }
  .x:hover { color: #e6edf3; border-color: #8b949e; }
  .mstats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
  .mstat { display: flex; flex-direction: column; gap: 1px; padding: 8px 10px; background: #0d1117; border: 1px solid #21262d; border-radius: 8px; }
  .mstat .label { font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.04em; }
  .mstat .value { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .mseries { display: flex; align-items: flex-end; gap: 2px; height: 90px; }
  .mcol { position: relative; flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .mbar { width: 100%; min-height: 1px; background: #58a6ff; border-radius: 1px; }
  .rows.plain li { display: block; }
  .ext { display: inline-block; margin-top: 14px; font-size: 12px; }
  .related { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .relbtn { padding: 5px 10px; border: 1px solid #30363d; border-radius: 999px; background: #21262d; color: #7cc4ff; font: inherit; font-size: 12px; cursor: pointer; }
  .relbtn:hover { border-color: #1f6feb; background: #1f6feb33; }

  @media (max-width: 860px) {
    .kpis, .metrics { grid-template-columns: repeat(2, 1fr); }
    .cols { grid-template-columns: 1fr; }
    /* The tabs read fine on their own once the row wraps; the labels are just width. */
    .ctrl-label { display: none; }
  }

  @media (max-width: 640px) {
    main { padding: 20px 12px 48px; }
    header { flex-wrap: wrap; }
    .meta { flex-wrap: wrap; justify-content: flex-start; }
    .big { font-size: 26px; }
    .card { padding: 14px; }
    /* The volume bar is the first thing to lose: the title, status and count matter more. */
    .row4 { grid-template-columns: 1fr 82px 42px; }
    .row4 .bar-mini { display: none; }
    .row3 { grid-template-columns: 1fr 56px 44px; }
    .rows.groups .tag { font-size: 8.5px; padding: 1px 4px; }
    .chart { gap: 3px; }
    /* 30 day labels cannot fit across 350px — show every fifth one. */
    .tick { display: none; }
    .col:nth-child(5n + 1) .tick { display: block; }
    .mstats { grid-template-columns: repeat(2, 1fr); }
    .modal { padding: 14px 14px 18px; }
    .backdrop { padding: 16px 10px; }
  }
</style>
