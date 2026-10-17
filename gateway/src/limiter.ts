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

/**
 * The key an address is limited by: an IPv4 address as is, an IPv6 one by its /64. One host or
 * network usually gets a whole /64, and switching addresses inside it would get round a
 * per-address limit.
 */
export function addressKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
