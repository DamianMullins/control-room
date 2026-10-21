// Tiny in-process cache. /query/ draws from a per-key hourly byte-read budget and Sentry
// rate-limits per token, so a page refresh must not fan out to the APIs.
type Entry = { at: number; value: unknown };

export type Cached<T> = T & { cached: boolean; fetchedAt?: string };

const store = new Map<string, Entry>();

// A render takes seconds, so two requests for the same key overlap easily: a hover preload
// followed by the click, or a fast double-click on the range tabs. Hold the in-flight promise
// so the second caller joins the first rather than firing a duplicate round of upstream calls.
const inflight = new Map<string, Promise<unknown>>();

const shape = <T>(value: T, cached: boolean): Cached<T> => ({
  ...value,
  cached,
  ...(cached ? {} : { fetchedAt: new Date().toISOString() }),
});

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<Cached<T>> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return shape(hit.value as T, true);

  const pending = inflight.get(key);
  if (pending) return shape((await pending) as T, true);

  const run = fn()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, run);
  return shape(await run, false);
}

/** Keys currently cached, for the health endpoint. */
export const cachedKeys = (): string[] => [...store.keys()];
