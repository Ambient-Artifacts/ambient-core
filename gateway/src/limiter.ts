// Small in-process counters for rate limits (one gateway VM in the MVP). Old entries are pruned
// when a map grows large; never all at once, which would let anyone reset everyone's counts by
// sending enough distinct keys.

/** A fixed-window limit per key: true while the key is within `limit` calls in `windowMs`. */
export function limiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { at: number; n: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.at > windowMs) {
      if (hits.size > 50_000) prune(hits, now, windowMs);
      hits.set(key, { at: now, n: 1 });
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}

/** Failures per key in a fixed window: `blocked` once a key has had `limit` of them. */
export function strikes(limit: number, windowMs: number) {
  const hits = new Map<string, { at: number; n: number }>();
  const live = (key: string, now: number) => {
    const h = hits.get(key);
    return h && now - h.at <= windowMs ? h : undefined;
  };
  return {
    blocked: (key: string) => (live(key, Date.now())?.n ?? 0) >= limit,
    add: (key: string) => {
      const now = Date.now();
      const h = live(key, now);
      if (h) {
        h.n++;
        return;
      }
      if (hits.size > 50_000) prune(hits, now, windowMs);
      hits.set(key, { at: now, n: 1 });
    },
    clear: (key: string) => {
      hits.delete(key);
    },
  };
}

function prune(hits: Map<string, { at: number }>, now: number, windowMs: number) {
  for (const [key, h] of hits) if (now - h.at > windowMs) hits.delete(key);
}
