import { error, json } from '@sveltejs/kit';
import { cached } from '#lib/server/cache.js';
import { bucketDetail, eventDetail, issueDetail } from '#lib/server/detail.js';
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
    if (!id || !/^\d+$/.test(id)) throw error(400, 'bad issue id');
    return json(await cached(`detail:issue:${range}:${id}`, TTL, () => issueDetail(id, range)));
  }

  throw error(400, 'unknown kind');
};
