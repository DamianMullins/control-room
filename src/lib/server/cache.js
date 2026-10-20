// Tiny in-process cache. /query/ draws from a per-key hourly byte-read budget and
// Sentry rate-limits per token, so a page refresh must not fan out to the APIs.
const store = new Map();

/** @param {string} key @param {number} ttlMs @param {() => Promise<any>} fn */
export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { ...hit.value, cached: true };
  const value = await fn();
  store.set(key, { at: Date.now(), value });
  return { ...value, cached: false, fetchedAt: new Date().toISOString() };
}
