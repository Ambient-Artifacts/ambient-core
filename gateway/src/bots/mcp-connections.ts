// Connections to MCP servers (docs/bots.md, "MCP connections"): a person or a team connects a
// service's MCP server once (its address and, when it needs one, a key), and then gives it to
// individual bots, or to Amb. A bot starts with none.
//
//   the app or an AI app ──▶ add(owner, { name, url, key }) ──▶ the server is asked for its tools
//        ──▶ kept sealed: the address, the key, the tools, and who has it
//   a server that wants a sign-in instead of a key ──▶ add() answers with a link to the service's
//        own sign-in page ──▶ the person allows it there ──▶ /v1/mcp/connected (code, state)
//        ──▶ Ambient holds the sign-in, renews it by itself, and asks again when it can't
//   grant(owner, id, bot, on) ──▶ that bot's next run gets it
//   a bot's run ──▶ POST /v1/bot/mcp/<id> (its run token) ──▶ the gateway checks the grant
//        ──▶ calls the service with the key ──▶ the answer goes back to the run
//
// The key never leaves the gateway: a run only holds its own token, good while it runs, and an
// address at Ambient. Taking a connection away from a bot, or removing it, holds from the bot's
// next tool call. Tools only (no resources or prompts), over Streamable HTTP.
//
// Kept in the sealed records under the owner's key (no table of its own): one record per
// connection, with its grants inside.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as pinnedFetch } from "undici";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, discoverOAuthServerInfo, extractWWWAuthenticateParams, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { CATALOG, CATEGORIES, type CatalogEntry } from "./mcp-catalog.ts";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { isPrivateAddress } from "@brain/wiki";
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";

const KIND = "mcp:connection";
/** A sign-in that was started and not finished yet, kept by its `state`. */
const PENDING = "mcp:pending";
/** Whose sign-in a `state` belongs to: looked up when the service sends the person back. */
const STATE = "mcp:state";
const INDEX_OWNER = { ownerKind: "team" as const, ownerId: "_mcp" };
const PENDING_TTL_MS = 30 * 60_000;
const NAME_MAX = 60;
const TOOLS_MAX = 200;
/** A tool's description and schema are what the model reads on every run: kept within reason. */
const DESCRIPTION_MAX = 2_000;
const SCHEMA_MAX = 20_000;
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
/** Names a run's own servers have: a connection can't take them. */
const RESERVED = new Set(["ambient", "ambient-bot"]);

export class McpConnectionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface McpTool {
  name: string;
  description: string;
  /** The tool's JSON Schema for its arguments, as the server gave it. */
  inputSchema: Record<string, unknown>;
}

interface Stored {
  id: string;
  name: string;
  /** The name a run knows it by (its tools are mcp__<slug>__<tool>): lowercase, no spaces. */
  slug: string;
  url: string;
  /** Sent as "Authorization: Bearer <key>", or in `header` when the service wants another one. */
  key?: string;
  header?: string;
  tools: McpTool[];
  /** The bots that have it (their routine ids), and whether Amb does. */
  bots: string[];
  amb: boolean;
  addedAt: number;
  checkedAt: number;
  /** The catalogue entry it was connected from (mcp-catalog.ts), for its logo. */
  catalog?: string;
  /** Signed in at the service (OAuth) instead of a key: Ambient as its client, and the sign-in it holds. */
  oauth?: SignInState;
  /** The sign-in ran out and couldn't be renewed: the person signs in again. */
  needsSignIn?: boolean;
}

/** What a sign-in holds: Ambient as the service's client, its tokens, and the proof for the code in between. */
interface SignInState {
  /** How Ambient shows the service who it is at the token endpoint: "none" where the service takes clients without a secret, else with the secret it gave. */
  method?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

/** A sign-in on its way: what it will connect (or which connection it renews), until the person is sent back. */
interface Pending extends SignInState {
  state: string;
  name: string;
  url: string;
  /** Renewing an existing connection's sign-in. */
  connectionId?: string;
  catalog?: string;
  exp: number;
}

/** A connection as the app and AI apps see it: never its key. */
export interface McpConnection {
  id: string;
  name: string;
  slug: string;
  /** The service's host ("mcp.notion.com"), not the whole address. */
  host: string;
  hasKey: boolean;
  /** How Ambient gets in: with a key, with a sign-in at the service, or the server is open. */
  signIn: "key" | "oauth" | "none";
  /** The sign-in ran out: sign in again (POST …/:id/sign-in). */
  needsSignIn: boolean;
  /** The catalogue entry it came from, or null for one added by its address. */
  catalog: string | null;
  tools: { name: string; description: string }[];
  bots: string[];
  amb: boolean;
  addedAt: number;
}

const ownerArgs = (owner: Owner) => (owner.kind === "user" ? { ownerKind: "user" as const, ownerId: owner.uid } : { ownerKind: "team" as const, ownerId: owner.teamId });

function view(c: Stored): McpConnection {
  let host = "";
  try {
    host = new URL(c.url).host;
  } catch {
    // Kept as it was stored.
  }
  return { id: c.id, name: c.name, slug: c.slug, host, hasKey: !!c.key, signIn: c.oauth ? "oauth" : c.key ? "key" : "none", needsSignIn: !!c.needsSignIn, catalog: c.catalog ?? null, tools: c.tools.map((t) => ({ name: t.name, description: t.description })), bots: c.bots, amb: c.amb, addedAt: c.addedAt };
}

/** Whether a failure says "not let in": the SDK's own error for it, a 401 or 403, or the words an OAuth server uses. */
function unauthorized(err: unknown): boolean {
  const e = err as { name?: string; code?: unknown; message?: string };
  // The SDK's OAuth errors carry their kind in the name, often with no message.
  if (/^(Unauthorized|InvalidGrant|InvalidToken|InvalidClient|UnauthorizedClient|AccessDenied)Error$/.test(e.name ?? "")) return true;
  return e.code === 401 || e.code === 403 || /\b40[13]\b|unauthori[sz]ed|forbidden|invalid_token|invalid_grant/i.test(e.message ?? "");
}

export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "server";
}

/**
 * Ambient as an OAuth client of one service, for the SDK's sign-in and renewal: it reads and
 * writes one `SignInState`, and `save` keeps it (a connection's record, or a sign-in on its way).
 * `link` is set when the service wants the person at its sign-in page; where nobody is there to
 * go (a bot's call with a sign-in that ran out), that's an error.
 */
class SignIn implements OAuthClientProvider {
  link: URL | undefined;

  constructor(
    private box: SignInState,
    private o: { redirectUrl: string; state?: string; interactive: boolean; save: () => Promise<void> },
  ) {}

  get redirectUrl(): string {
    return this.o.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Ambient", redirect_uris: [this.o.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: this.box.method ?? "none" };
  }

  state(): string {
    return this.o.state ?? "";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.box.client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    this.box.client = client;
    await this.o.save();
  }

  tokens(): OAuthTokens | undefined {
    return this.box.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // A renewal may leave the refresh token out: the one we hold stays good.
    this.box.tokens = { ...tokens, ...(tokens.refresh_token ? {} : this.box.tokens?.refresh_token ? { refresh_token: this.box.tokens.refresh_token } : {}) };
    await this.o.save();
  }

  redirectToAuthorization(url: URL): void {
    if (!this.o.interactive) throw new McpConnectionError("signin_required", "The sign-in at this service ran out. Sign in again under Connections.", 409);
    this.link = url;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.box.verifier = verifier;
    await this.o.save();
  }

  codeVerifier(): string {
    return this.box.verifier ?? "";
  }
}

export class McpConnections {
  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      /** The gateway's public address: where a service sends the person back after signing in. */
      origin: string;
      fetchImpl?: typeof fetch;
      /** Tests: a stand-in server on 127.0.0.1, and http. */
      allowLocal?: boolean;
      /** Tests: the catalogue (mcp-catalog.ts otherwise). */
      catalog?: CatalogEntry[];
      /** Tests: how a name is looked up (the system's resolver otherwise). */
      lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private async resolve(host: string): Promise<{ address: string; family: number }[]> {
    if (this.d.lookup) return this.d.lookup(host);
    return (await lookup(host, { all: true }).catch(() => [])).map((a) => ({ address: a.address, family: a.family }));
  }

  /**
   * The connections to a service are made to an address that was looked up and checked right
   * here, in the connection's own lookup: a name that answers a public address to one lookup and
   * a private one to the next (DNS rebinding) can't get a request, or a key, into our own
   * network. Checking before the request alone wouldn't do: the connection would look the name
   * up again. As the repo path pins its address (wiki/src/git.ts).
   */
  private agent = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        void this.resolve(hostname).then(
          (addrs) => {
            const ok = addrs.length > 0 && (!addrs.some((a) => isPrivateAddress(a.address)) || (this.d.allowLocal === true && hostname === "127.0.0.1"));
            if (!ok) {
              callback(Object.assign(new Error(addrs.length ? "That address isn't reachable from Ambient." : `Can't find ${hostname}.`), { code: "ENOTFOUND" }) as NodeJS.ErrnoException, "", 0);
              return;
            }
            if ((options as { all?: boolean }).all) (callback as unknown as (err: null, list: { address: string; family: number }[]) => void)(null, addrs);
            else callback(null, addrs[0]!.address, addrs[0]!.family);
          },
          (err: Error) => callback(err as NodeJS.ErrnoException, "", 0),
        );
      },
    },
  });

  // ---- records ----

  private async read(owner: Owner, id: string): Promise<Stored | null> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind: KIND, key: id })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    return this.open(owner, r);
  }

  private async open(owner: Owner, r: { iv: string; ct: string }): Promise<Stored | null> {
    const raw = await this.d.keys.open(owner, `record:${KIND}`, r.iv, r.ct).catch(() => null);
    try {
      return raw ? (JSON.parse((JSON.parse(raw) as { c: string }).c) as Stored) : null;
    } catch {
      return null;
    }
  }

  private async write(owner: Owner, c: Stored, deleted = false): Promise<void> {
    const content = JSON.stringify(deleted ? {} : c);
    const sealed = await this.d.keys.seal(owner, `record:${KIND}`, JSON.stringify({ c: content }));
    await this.d.control.m(api.records.put, { ...ownerArgs(owner), kind: KIND, key: c.id, iv: sealed.iv, ct: sealed.ciphertext, size: Buffer.byteLength(content), byKind: "user", ...(deleted ? { deleted: true } : {}), keep: 1, now: this.now() });
  }

  private async readPending(owner: Owner, state: string): Promise<Pending | null> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind: PENDING, key: state })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    const raw = await this.d.keys.open(owner, `record:${PENDING}`, r.iv, r.ct).catch(() => null);
    try {
      return raw ? (JSON.parse((JSON.parse(raw) as { c: string }).c) as Pending) : null;
    } catch {
      return null;
    }
  }

  private async writePending(owner: Owner, p: Pending, deleted = false): Promise<void> {
    const content = JSON.stringify(deleted ? {} : p);
    const sealed = await this.d.keys.seal(owner, `record:${PENDING}`, JSON.stringify({ c: content }));
    await this.d.control.m(api.records.put, { ...ownerArgs(owner), kind: PENDING, key: p.state, iv: sealed.iv, ct: sealed.ciphertext, size: Buffer.byteLength(content), byKind: "user", ...(deleted ? { deleted: true } : {}), keep: 1, now: this.now() });
  }

  /** Whose sign-in a state is (ids only, so the service's redirect finds its owner). */
  private async stateOwner(state: string): Promise<Owner | null> {
    const r = (await this.d.control.q(api.records.get, { ...INDEX_OWNER, kind: STATE, key: state })) as { ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    try {
      const o = JSON.parse(Buffer.from(r.ct, "base64url").toString("utf8")) as { k?: string; i?: string };
      if (o.k === "user" && o.i) return { kind: "user", uid: o.i };
      if (o.k === "team" && o.i) return { kind: "team", teamId: o.i };
    } catch {
      // Not ours.
    }
    return null;
  }

  private async setStateOwner(state: string, owner: Owner | null): Promise<void> {
    const ct = owner ? Buffer.from(JSON.stringify({ k: owner.kind, i: owner.kind === "user" ? owner.uid : owner.teamId })).toString("base64url") : "-";
    await this.d.control.m(api.records.put, { ...INDEX_OWNER, kind: STATE, key: state, iv: "-", ct, size: ct.length, byKind: "user", ...(owner ? {} : { deleted: true }), keep: 1, now: this.now() });
  }

  private get redirectUrl(): string {
    return `${this.d.origin}/v1/mcp/connected`;
  }

  private async all(owner: Owner): Promise<Stored[]> {
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: KIND, prefix: "" })) as { iv: string; ct: string }[];
    const out = await Promise.all(rows.map((r) => this.open(owner, r)));
    return out.filter((c): c is Stored => !!c?.id).sort((a, b) => a.addedAt - b.addedAt);
  }

  // ---- the service's server ----

  /** A clean https address of a public host; nothing inside our own network. */
  private async checkUrl(raw: string): Promise<URL> {
    let u: URL;
    const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
    try {
      u = new URL(text);
    } catch {
      throw new McpConnectionError("bad_url", "That isn't a valid address.");
    }
    if (u.username || u.password) throw new McpConnectionError("bad_url", "Put the key in the key field, not in the address.");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (this.d.allowLocal && u.protocol === "http:" && host === "127.0.0.1") return u;
    // Tests with their own resolver may use http for a made-up name.
    if (u.protocol !== "https:" && !(this.d.allowLocal && this.d.lookup && u.protocol === "http:")) throw new McpConnectionError("bad_url", "Use the server's https:// address.");
    const addrs = isIP(host) ? [host] : (await this.resolve(host)).map((a) => a.address);
    if (!addrs.length) throw new McpConnectionError("bad_url", `Can't find ${host}.`);
    if (addrs.some(isPrivateAddress)) throw new McpConnectionError("bad_url", "That address isn't reachable from Ambient.");
    return u;
  }

  /**
   * Fetch for the service's server: the address is checked before every request (for a clear
   * answer), the connection itself goes only to an address checked in its own lookup (`agent`),
   * and a redirect is refused, so the key only ever goes to the host it was given for.
   */
  private guarded(): typeof fetch {
    const pinned = ((input: Parameters<typeof pinnedFetch>[0], init?: Parameters<typeof pinnedFetch>[1]) => pinnedFetch(input, { ...init, dispatcher: this.agent })) as unknown as typeof fetch;
    const inner = this.d.fetchImpl ?? pinned;
    return async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      await this.checkUrl(url);
      const res = await inner(input, { ...init, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) throw new McpConnectionError("redirected", "The server redirected elsewhere; use its final address.", 400);
      return res;
    };
  }

  private async client(c: Pick<Stored, "url" | "key" | "header" | "oauth">, save: () => Promise<void> = async () => undefined): Promise<Client> {
    const url = await this.checkUrl(c.url);
    const headers: Record<string, string> = c.key ? (c.header ? { [c.header]: c.key } : { authorization: `Bearer ${c.key}` }) : {};
    // Signed in at the service: the SDK sends the token, renews it when it ran out (and `save` keeps the new one).
    const authProvider = c.oauth ? new SignIn(c.oauth, { redirectUrl: this.redirectUrl, interactive: false, save }) : undefined;
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: this.guarded(), ...(authProvider ? { authProvider } : {}) });
    const client = new Client({ name: "ambient", version: "1.0.0" });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
  }

  /** The server's tools, as kept for the runs (cut to what a model should have to read). */
  private async fetchTools(c: Pick<Stored, "url" | "key" | "header" | "oauth">, save?: () => Promise<void>): Promise<McpTool[]> {
    let client: Client;
    try {
      client = await this.client(c, save);
    } catch (err) {
      if (err instanceof McpConnectionError) throw err;
      const text = (err as Error).message ?? "";
      if (unauthorized(err)) throw new McpConnectionError("refused", "The server didn't accept that key. Check it, or whether the server needs a sign-in instead.", 400);
      throw new McpConnectionError("unreachable", `Couldn't reach an MCP server at that address${text ? `: ${text.slice(0, 200)}` : ""}.`, 400);
    }
    try {
      const out = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      return out.tools.slice(0, TOOLS_MAX).map((t) => {
        const schema = JSON.stringify(t.inputSchema ?? {});
        return {
          name: t.name,
          description: (t.description ?? "").slice(0, DESCRIPTION_MAX),
          inputSchema: schema.length > SCHEMA_MAX ? { type: "object" } : (t.inputSchema as Record<string, unknown>),
        };
      });
    } catch (err) {
      throw new McpConnectionError("unreachable", `The server answered, but not with its tools: ${(err as Error).message.slice(0, 200)}.`, 400);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // ---- connecting ----

  async list(owner: Owner): Promise<McpConnection[]> {
    return (await this.all(owner)).map(view);
  }

  private get entries(): CatalogEntry[] {
    return this.d.catalog ?? CATALOG;
  }

  /**
   * The services offered by name, in their categories, each with the owner's connection to it
   * when there is one (so the app shows "Connected" and where to go).
   */
  async catalog(owner: Owner): Promise<{ categories: { id: string; name: string }[]; services: (CatalogEntry & { host: string; connection: { id: string; needsSignIn: boolean } | null })[] }> {
    const mine = await this.all(owner);
    const services = this.entries.map((entry) => {
      const c = mine.find((x) => x.catalog === entry.id) ?? mine.find((x) => x.url.replace(/\/$/, "") === entry.url.replace(/\/$/, ""));
      return { ...entry, host: new URL(entry.url).host, connection: c ? { id: c.id, needsSignIn: !!c.needsSignIn } : null };
    });
    return { categories: CATEGORIES.filter((c) => services.some((x) => x.category === c.id)), services };
  }

  /**
   * Connects a server: its address is checked, it's asked for its tools, and it's kept. Nobody has
   * it yet. A server that wants a sign-in instead of a key isn't kept yet: `signIn` is the link to
   * the service's own page, and the connection appears once the person allowed it there.
   */
  async add(owner: Owner, given: { name?: string; url?: string; key?: string; header?: string; catalog?: string }): Promise<{ connection: McpConnection } | { signIn: { url: string } }> {
    // By name from the catalogue: its address and name come from there.
    const entry = given.catalog ? this.entries.find((x) => x.id === given.catalog) : undefined;
    if (given.catalog && !entry) throw new McpConnectionError("no_such_service", "Ambient doesn't offer that service by name. Add it by its address.", 404);
    const input = { ...given, name: given.name?.trim() || entry?.name || "", url: given.url?.trim() || entry?.url || "" };
    if (entry) {
      const have = (await this.all(owner)).find((c) => c.catalog === entry.id);
      // Connected already: the same connection, not a second one.
      if (have && !have.needsSignIn) return { connection: view(have) };
      if (have?.oauth) return { signIn: await this.signInAgain(owner, have.id) };
    }
    const name = input.name.trim().slice(0, NAME_MAX);
    if (!name) throw new McpConnectionError("bad_request", "Give it a name.");
    const url = (await this.checkUrl(input.url)).toString();
    const key = input.key?.trim() || undefined;
    // A service that's reached with a token made there: no sign-in to try, say where to make one.
    if (entry?.signIn === "key" && !key) {
      throw new McpConnectionError("needs_key", `${entry.name} needs a token you make at ${entry.key?.url ?? new URL(entry.url).host}. ${entry.key?.help ?? ""}`.trim(), 400);
    }
    const header = input.header?.trim() || undefined;
    if (header && !/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new McpConnectionError("bad_request", "That isn't a header's name.");
    const existing = await this.all(owner);
    if (existing.length >= 50) throw new McpConnectionError("too_many", "That's 50 connections; remove one first.");
    const slug = await this.freeSlug(owner, name);
    let tools: McpTool[];
    try {
      tools = await this.fetchTools({ url, key, header });
    } catch (err) {
      // No key given and the server wants one: it may take a sign-in at its own page instead.
      if (!key && err instanceof McpConnectionError && err.code === "refused") {
        const link = await this.beginSignIn(owner, { name, url, ...(entry ? { catalog: entry.id } : {}) }).catch((e: Error) => (console.warn(`[mcp] no sign-in offered: ${e.message}`), null));
        if (link) return { signIn: { url: link } };
        throw new McpConnectionError("refused", "The server wants a key, and offers no sign-in Ambient can use. Add its key.", 400);
      }
      throw err;
    }
    const now = this.now();
    const stored: Stored = { id: randomBytes(8).toString("hex"), name, slug, url, ...(key ? { key } : {}), ...(header ? { header } : {}), ...(entry ? { catalog: entry.id } : {}), tools, bots: [], amb: false, addedAt: now, checkedAt: now };
    await this.write(owner, stored);
    return { connection: view(stored) };
  }

  private async freeSlug(owner: Owner, name: string, except?: string): Promise<string> {
    let slug = slugOf(name);
    if (RESERVED.has(slug)) slug = `${slug}-server`;
    const taken = new Set((await this.all(owner)).filter((c) => c.id !== except).map((c) => c.slug));
    for (let i = 2; taken.has(slug); i++) slug = `${slugOf(name).slice(0, 28)}-${i}`;
    return slug;
  }

  // ---- signing in at the service (OAuth, as MCP has it) ----

  /**
   * Starts a sign-in: finds the service's sign-in server, registers Ambient as its client when it
   * lets clients do that, and returns the link to its sign-in page. What's needed to finish is
   * kept by `state` for half an hour. Throws when the service offers no such sign-in.
   */
  private async beginSignIn(owner: Owner, what: { name: string; url: string; connectionId?: string; catalog?: string; client?: OAuthClientInformationMixed; method?: string }): Promise<string> {
    const pending: Pending = { state: randomBytes(24).toString("base64url"), name: what.name, url: what.url, ...(what.connectionId ? { connectionId: what.connectionId } : {}), ...(what.catalog ? { catalog: what.catalog } : {}), ...(what.client ? { client: what.client } : {}), ...(what.method ? { method: what.method } : {}), exp: this.now() + PENDING_TTL_MS };
    const provider = new SignIn(pending, { redirectUrl: this.redirectUrl, state: pending.state, interactive: true, save: async () => undefined });
    // What the server says when it turns a request away: where its sign-in is described, and
    // which permissions to ask for (Notion: "default", Linear: "read write").
    const hint = await this.guarded()(what.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
      .then((res) => (res.status === 401 ? extractWWWAuthenticateParams(res) : {}))
      .catch(() => ({}) as { resourceMetadataUrl?: URL; scope?: string });
    // Most services take a client without a secret; some only ones with (Figma, GitLab, Supabase):
    // there Ambient registers as one that gets a secret, which stays sealed with the sign-in.
    if (!pending.method) {
      const info = await discoverOAuthServerInfo(what.url, { fetchFn: this.guarded(), ...(hint.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}) }).catch(() => null);
      const methods = info?.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
      pending.method = !methods || methods.includes("none") ? "none" : methods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
    }
    const result = await auth(provider, { serverUrl: what.url, fetchFn: this.guarded(), ...(hint.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}), ...(hint.scope ? { scope: hint.scope } : {}) });
    if (result !== "REDIRECT" || !provider.link) throw new McpConnectionError("no_sign_in", "The service didn't offer a sign-in.", 400);
    await this.writePending(owner, pending);
    await this.setStateOwner(pending.state, owner);
    return provider.link.toString();
  }

  /** A new sign-in for a connection whose sign-in ran out (or to switch accounts): the link to the service's page. */
  async signInAgain(owner: Owner, id: string): Promise<{ url: string }> {
    const c = await this.need(owner, id);
    if (!c.oauth) throw new McpConnectionError("not_a_sign_in", `${c.name} is connected with a key, not a sign-in.`, 400);
    return { url: await this.beginSignIn(owner, { name: c.name, url: c.url, connectionId: c.id, ...(c.oauth.client ? { client: c.oauth.client } : {}), ...(c.oauth.method ? { method: c.oauth.method } : {}) }) };
  }

  /**
   * The service sent the person back with a code: it's exchanged for the sign-in, the server is
   * asked for its tools, and the connection is kept (or its sign-in renewed). A state nobody
   * started, or one that's too old, is refused.
   */
  async finishSignIn(state: string, code: string): Promise<{ name: string }> {
    const owner = /^[A-Za-z0-9_-]{20,64}$/.test(state) ? await this.stateOwner(state) : null;
    const pending = owner ? await this.readPending(owner, state) : null;
    if (!owner || !pending?.state || pending.exp < this.now()) throw new McpConnectionError("bad_state", "This sign-in wasn't started in Ambient, or it took too long. Start it again.", 400);
    // Used once, whatever comes of it.
    await this.setStateOwner(state, null);
    await this.writePending(owner, pending, true);
    const box: SignInState = { ...(pending.method ? { method: pending.method } : {}), ...(pending.client ? { client: pending.client } : {}), ...(pending.verifier ? { verifier: pending.verifier } : {}) };
    const provider = new SignIn(box, { redirectUrl: this.redirectUrl, state, interactive: false, save: async () => undefined });
    try {
      const result = await auth(provider, { serverUrl: pending.url, authorizationCode: code, fetchFn: this.guarded() });
      if (result !== "AUTHORIZED" || !box.tokens) throw new Error("no sign-in came back");
    } catch (err) {
      throw new McpConnectionError("sign_in_failed", `The service didn't complete the sign-in: ${(err as Error).message.slice(0, 200)}.`, 400);
    }
    const oauth: SignInState = { ...(box.method ? { method: box.method } : {}), ...(box.client ? { client: box.client } : {}), tokens: box.tokens };
    const now = this.now();
    const before = pending.connectionId ? await this.read(owner, pending.connectionId) : null;
    const base: Stored = before?.id
      ? { ...before }
      : { id: randomBytes(8).toString("hex"), name: pending.name, slug: await this.freeSlug(owner, pending.name), url: pending.url, ...(pending.catalog ? { catalog: pending.catalog } : {}), tools: [], bots: [], amb: false, addedAt: now, checkedAt: now };
    const { needsSignIn: _was, ...rest } = base;
    const stored: Stored = { ...rest, oauth, checkedAt: now };
    stored.tools = await this.fetchTools(stored, () => this.write(owner, stored));
    await this.write(owner, stored);
    return { name: stored.name };
  }

  /** Asks the server for its tools again (it may have gained some). */
  async refresh(owner: Owner, id: string): Promise<McpConnection> {
    const c = await this.need(owner, id);
    const tools = await this.withSignIn(owner, c, () => this.fetchTools(c, () => this.write(owner, c)));
    const next = { ...c, tools, checkedAt: this.now() };
    await this.write(owner, next);
    return view(next);
  }

  async remove(owner: Owner, id: string): Promise<void> {
    const c = await this.need(owner, id);
    await this.write(owner, c, true);
  }

  private async need(owner: Owner, id: string): Promise<Stored> {
    const c = /^[0-9a-f]{16}$/.test(id) ? await this.read(owner, id) : null;
    if (!c?.id) throw new McpConnectionError("no_such_connection", "There's no such connection.", 404);
    return c;
  }

  // ---- who has it ----

  /** Gives a connection to a bot (its routine id) or to Amb, or takes it away. */
  async grant(owner: Owner, id: string, to: { routineId: string } | { amb: true }, on: boolean): Promise<McpConnection> {
    const c = await this.need(owner, id);
    const next: Stored =
      "amb" in to
        ? { ...c, amb: on }
        : { ...c, bots: on ? [...new Set([...c.bots, to.routineId])] : c.bots.filter((b) => b !== to.routineId) };
    await this.write(owner, next);
    return view(next);
  }

  /** What a bot's run gets: each connection it has, by the name its tools carry and its id. */
  async forBot(owner: Owner, routineId: string): Promise<{ name: string; id: string }[]> {
    return (await this.all(owner)).filter((c) => c.bots.includes(routineId)).map((c) => ({ name: c.slug, id: c.id }));
  }

  async forAmb(uid: string): Promise<{ name: string; id: string; title: string }[]> {
    return (await this.all({ kind: "user", uid })).filter((c) => c.amb).map((c) => ({ name: c.slug, id: c.id, title: c.name }));
  }

  // ---- the relay: a run's calls, with the grant checked each time ----

  /** The connection, when this bot (or Amb) has it now; null otherwise. */
  async granted(owner: Owner, id: string, who: { routineId: string } | { amb: true }): Promise<{ name: string; tools: McpTool[] } | null> {
    const c = /^[0-9a-f]{16}$/.test(id) ? await this.read(owner, id) : null;
    if (!c?.id) return null;
    if ("amb" in who ? !c.amb : !c.bots.includes(who.routineId)) return null;
    return { name: c.name, tools: c.tools };
  }

  /** Calls one of the server's tools with the connection's key; the server's own result goes back. */
  async call(owner: Owner, id: string, who: { routineId: string } | { amb: true }, tool: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean; structuredContent?: unknown }> {
    const c = /^[0-9a-f]{16}$/.test(id) ? await this.read(owner, id) : null;
    if (!c?.id || ("amb" in who ? !c.amb : !c.bots.includes(who.routineId))) throw new McpConnectionError("not_granted", "This connection isn't given to you anymore.", 403);
    if (!c.tools.some((t) => t.name === tool)) throw new McpConnectionError("no_such_tool", `${c.name} has no tool called ${tool}.`, 404);
    return this.withSignIn(owner, c, async () => {
      // A renewed sign-in is kept at once, so the next call (and the next run) starts with it.
      const client = await this.client(c, () => this.write(owner, c));
      try {
        const out = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
        return { content: (out.content as unknown[]) ?? [], ...(out.isError ? { isError: true } : {}), ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}) };
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  }

  /**
   * Runs something that talks to a signed-in service. When the sign-in ran out and couldn't be
   * renewed, the connection is marked so (the app shows "Sign in again") and the caller is told.
   */
  private async withSignIn<T>(owner: Owner, c: Stored, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      const ranOut = c.oauth && (err instanceof McpConnectionError ? err.code === "signin_required" || err.code === "refused" : unauthorized(err));
      if (!ranOut) throw err;
      if (!c.needsSignIn) await this.write(owner, { ...c, needsSignIn: true }).catch(() => undefined);
      throw new McpConnectionError("signin_required", `The sign-in at ${c.name} ran out. Its owner signs in again under Connections.`, 409);
    }
  }
}
