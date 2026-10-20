// Tiny in-process cache. /query/ draws from a per-key hourly byte-read budget and Sentry
// rate-limits per token, so a page refresh must not fan out to the APIs.
type Entry = { at: number; value: unknown };

export type Cached<T> = T & { cached: boolean; fetchedAt?: string };

const store = new Map<string, Entry>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<Cached<T>> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return { ...(hit.value as T), cached: true };
  }

  const value = await fn();
  store.set(key, { at: Date.now(), value });
  return { ...value, cached: false, fetchedAt: new Date().toISOString() };
}
