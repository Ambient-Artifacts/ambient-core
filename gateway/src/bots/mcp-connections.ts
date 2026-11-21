// Connections to MCP servers (docs/bots.md, "MCP connections"): a person or a team connects a
// service's MCP server once (its address and, when it needs one, a key), and then gives it to
// individual bots, or to Amb. A bot starts with none.
//
//   the app or an AI app ──▶ add(owner, { name, url, key }) ──▶ the server is asked for its tools
//        ──▶ kept sealed: the address, the key, the tools, and who has it
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
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isPrivateAddress } from "@brain/wiki";
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";

const KIND = "mcp:connection";
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
}

/** A connection as the app and AI apps see it: never its key. */
export interface McpConnection {
  id: string;
  name: string;
  slug: string;
  /** The service's host ("mcp.notion.com"), not the whole address. */
  host: string;
  hasKey: boolean;
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
  return { id: c.id, name: c.name, slug: c.slug, host, hasKey: !!c.key, tools: c.tools.map((t) => ({ name: t.name, description: t.description })), bots: c.bots, amb: c.amb, addedAt: c.addedAt };
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

export class McpConnections {
  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      fetchImpl?: typeof fetch;
      /** Tests: a stand-in server on 127.0.0.1 over http. */
      allowLocal?: boolean;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

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
    if (u.protocol !== "https:") throw new McpConnectionError("bad_url", "Use the server's https:// address.");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addrs.length) throw new McpConnectionError("bad_url", `Can't find ${host}.`);
    if (addrs.some(isPrivateAddress)) throw new McpConnectionError("bad_url", "That address isn't reachable from Ambient.");
    return u;
  }

  /**
   * Fetch for the service's server: the address is checked again before every request (a name
   * can change where it points), and a redirect is refused, so the key only ever goes to the
   * host it was given for.
   */
  private guarded(): typeof fetch {
    const inner = this.d.fetchImpl ?? fetch;
    return async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      await this.checkUrl(url);
      const res = await inner(input, { ...init, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) throw new McpConnectionError("redirected", "The server redirected elsewhere; use its final address.", 400);
      return res;
    };
  }

  private async client(c: Pick<Stored, "url" | "key" | "header">): Promise<Client> {
    const url = await this.checkUrl(c.url);
    const headers: Record<string, string> = c.key ? (c.header ? { [c.header]: c.key } : { authorization: `Bearer ${c.key}` }) : {};
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: this.guarded() });
    const client = new Client({ name: "ambient", version: "1.0.0" });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
  }

  /** The server's tools, as kept for the runs (cut to what a model should have to read). */
  private async fetchTools(c: Pick<Stored, "url" | "key" | "header">): Promise<McpTool[]> {
    let client: Client;
    try {
      client = await this.client(c);
    } catch (err) {
      if (err instanceof McpConnectionError) throw err;
      const text = (err as Error).message ?? "";
      if (/401|403|unauthori[sz]ed|forbidden/i.test(text)) throw new McpConnectionError("refused", "The server didn't accept that key. Check it, or whether the server needs a sign-in instead.", 400);
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

  /** Connects a server: its address is checked, it's asked for its tools, and it's kept. Nobody has it yet. */
  async add(owner: Owner, input: { name: string; url: string; key?: string; header?: string }): Promise<McpConnection> {
    const name = input.name.trim().slice(0, NAME_MAX);
    if (!name) throw new McpConnectionError("bad_request", "Give it a name.");
    const url = (await this.checkUrl(input.url)).toString();
    const key = input.key?.trim() || undefined;
    const header = input.header?.trim() || undefined;
    if (header && !/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new McpConnectionError("bad_request", "That isn't a header's name.");
    const existing = await this.all(owner);
    if (existing.length >= 50) throw new McpConnectionError("too_many", "That's 50 connections; remove one first.");
    let slug = slugOf(name);
    if (RESERVED.has(slug)) slug = `${slug}-server`;
    const taken = new Set(existing.map((c) => c.slug));
    for (let i = 2; taken.has(slug); i++) slug = `${slugOf(name).slice(0, 28)}-${i}`;
    const tools = await this.fetchTools({ url, key, header });
    const now = this.now();
    const stored: Stored = { id: randomBytes(8).toString("hex"), name, slug, url, ...(key ? { key } : {}), ...(header ? { header } : {}), tools, bots: [], amb: false, addedAt: now, checkedAt: now };
    await this.write(owner, stored);
    return view(stored);
  }

  /** Asks the server for its tools again (it may have gained some). */
  async refresh(owner: Owner, id: string): Promise<McpConnection> {
    const c = await this.need(owner, id);
    const next = { ...c, tools: await this.fetchTools(c), checkedAt: this.now() };
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
    const client = await this.client(c);
    try {
      const out = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      return { content: (out.content as unknown[]) ?? [], ...(out.isError ? { isError: true } : {}), ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}) };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
