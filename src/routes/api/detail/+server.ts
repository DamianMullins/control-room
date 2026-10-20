import { error, json } from '@sveltejs/kit';
import { cached } from '#lib/server/cache.js';
import { bucketDetail, eventDetail, issueDetail, pathDetail } from '#lib/server/detail.js';
import { DEFAULT_RANGE, isRange } from '#lib/server/range.js';
import type { RequestHandler } from './$types';

const TTL = 5 * 60 * 1000;
const BUCKET = /^\d{4}-\d{2}-\d{2}( \d{2})?$/;

export const GET: RequestHandler = async ({ url }) => {
  const kind = url.searchParams.get('kind');
  const rangeParam = url.searchParams.get('range');
  const range = isRange(rangeParam) ? rangeParam : DEFAULT_RANGE;

  if (kind === 'event') {
    const name = url.searchParams.get('name');
    if (!name || name.length > 200) throw error(400, 'name required');
    return json(await cached(`detail:event:${range}:${name}`, TTL, () => eventDetail(name, range)));
  }

  if (kind === 'bucket') {
    const at = url.searchParams.get('at');
    // The bucket key comes from our own tooltip text; anything else is not a bucket.
    if (!at || !BUCKET.test(at)) throw error(400, 'bad bucket');
    const source = url.searchParams.get('source') === 'errors' ? 'errors' : 'events';
    return json(
      await cached(`detail:bucket:${range}:${source}:${at}`, TTL, () =>
        bucketDetail(at, source, range)
      )
    );
  }

  if (kind === 'issue') {
    const id = url.searchParams.get('id');
    const projectKey = url.searchParams.get('project');
    if (!id || !/^\d+$/.test(id)) throw error(400, 'bad issue id');
    // Issue ids are per org — the same number is meaningless without its project.
    if (!projectKey || !/^[\w-]+$/.test(projectKey)) throw error(400, 'project required');

    // Hints let a project whose issues API is forbidden still render something useful.
    const shortId = url.searchParams.get('shortId') ?? undefined;
    const title = url.searchParams.get('title') ?? undefined;
    if (shortId && !/^[A-Za-z0-9-]{1,40}$/.test(shortId)) throw error(400, 'bad shortId');

    return json(
      await cached(`detail:issue:${range}:${projectKey}:${id}:${shortId ?? ''}`, TTL, () =>
        issueDetail(id, projectKey, range, { shortId, title: title?.slice(0, 200) })
      )
    );
  }

  if (kind === 'path') {
    const path = url.searchParams.get('path');
    // A page path only: no scheme, host or quotes ever reach a SQL string.
    if (!path || path.length > 200 || !/^\/[\w\-./]*$/.test(path)) throw error(400, 'bad path');
    return json(await cached(`detail:path:${range}:${path}`, TTL, () => pathDetail(path, range)));
  }

  throw error(400, 'unknown kind');
};
