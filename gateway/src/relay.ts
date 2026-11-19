// A team on its own computer (docs/architecture.md, "A team on its own computer"): the team's brain
// runs there on 127.0.0.1, and the gateway reaches it through the computer's runner, over the long
// poll it keeps open anyway. The computer needs no domain, no open port and no certificate; it can
// sit behind NAT. Its address is `computer://<hostId>`; `relayingFetch` makes that address work
// wherever the gateway fetches a team server (TeamLink), so nothing else changes.
//
//   TeamLink ──fetch("computer://<host>/v1/query")──▶ relay ──▶ http job on the long poll
//      ◀── Response ◀── POST /v1/host/relay/:jobId (the team server's answer, as is) ◀── runner
//
// The worker, in a process of its own, relays through the gateway's internal route.

export const COMPUTER_SCHEME = "computer://";

export interface RelayRequest {
  method: string;
  /** Path and query on the team server, e.g. "/v1/query?x=1". */
  path: string;
  headers: Record<string, string>;
  /** Base64, or null for none. */
  body: string | null;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type Relay = (hostId: string, req: RelayRequest, timeoutMs: number) => Promise<RelayResponse>;

/** Where a team's brain runs, for the apps: Ambient's server, the team's own computer, or nowhere yet. */
export function serverKind(url: string | null | undefined): "hosted" | "computer" | "none" {
  return !url ? "none" : url.startsWith(COMPUTER_SCHEME) ? "computer" : "hosted";
}

/** The host of a `computer://` address, or null for any other. */
export function computerHost(url: string): string | null {
  if (!url.startsWith(COMPUTER_SCHEME)) return null;
  const host = url.slice(COMPUTER_SCHEME.length).split(/[/?#]/)[0] ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(host) ? host : null;
}

/** Headers a hop doesn't pass on. */
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "host", "content-length"]);

export function passHeaders(h: Headers | Record<string, string> | [string, string][] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  const entries = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of entries) if (!HOP.has(k.toLowerCase())) out[k.toLowerCase()] = String(v);
  return out;
}

async function bodyOf(body: unknown): Promise<string | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8").toString("base64");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("base64");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("base64");
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer()).toString("base64");
  throw new Error("a relayed request's body must be text or bytes");
}

/** How long a relayed request may take when the caller set no deadline of its own. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** `fetch`, with `computer://` addresses going through `relay`. */
export function relayingFetch(relay: Relay, base: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = computerHost(url);
    if (!host) return base(input, init);
    const path = url.slice(COMPUTER_SCHEME.length + host.length) || "/";
    const req: RelayRequest = {
      method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      path: path.startsWith("/") ? path : `/${path}`,
      headers: passHeaders((init?.headers as Headers | Record<string, string> | undefined) ?? (input instanceof Request ? input.headers : undefined)),
      body: await bodyOf(init?.body),
    };
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const answer = relay(host, req, DEFAULT_TIMEOUT_MS);
    const res = signal
      ? await Promise.race([
          answer,
          new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true })),
        ])
      : await answer;
    return new Response(res.status === 204 || res.status === 304 ? null : new Uint8Array(res.body), { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

/** The worker's relay: through the gateway's internal route, with the service secret. */
export function gatewayRelay(url: string, secret: string, fetchImpl: typeof fetch = fetch): Relay {
  return async (hostId, req, timeoutMs) => {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/v1/internal/relay`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId, request: req, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
    const status = Number(res.headers.get("x-ambient-status"));
    if (!status) {
      const json = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(json.message ?? `the gateway couldn't relay to the team's computer (${res.status})`);
    }
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(Buffer.from(res.headers.get("x-ambient-headers") ?? "", "base64").toString("utf8")) as Record<string, string>;
    } catch {}
    return { status, headers, body: Buffer.from(await res.arrayBuffer()) };
  };
}
