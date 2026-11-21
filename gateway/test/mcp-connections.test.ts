// MCP connections (docs/bots.md, "MCP connections"), against a stand-in MCP server that wants a
// key: connected once, given to one bot, reached by that bot's run through the gateway with the
// run's own token (never the key), taken away again, and nothing for anyone it wasn't given to.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { slugOf } from "../src/bots/mcp-connections.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const KEY = "svc-key-123";
const info = { hostname: "srv-mcp", os: "Linux 6.8", runner: "0.16.0", claude: "2.1.326 (Claude Code)" };
const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
/** What reached the stand-in service: the header it was called with, and each tool call. */
const seen: { auth: string | undefined; tool?: string; args?: unknown }[] = [];
let service: Server;
let serviceUrl = "";
let s: Stack;
let lena: AppSession;
let host = "";
let computer = "";

const call = (method: string, path: string, body?: unknown) => appCall(s, lena.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
type Connection = { id: string; name: string; slug: string; host: string; hasKey: boolean; tools: { name: string }[]; bots: string[]; amb: boolean };

async function bot(name: string) {
  return ((await call("POST", "/v1/app/routines", { name, prompt: "x", schedule: daily, computer, bot: { isolation: "host" } })).json.routine as { id: string }).id;
}
/** Starts a run of the bot, as its computer does: what the runner gets. */
async function startRun(id: string) {
  const out = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
  return out.json as { run: { id: string }; runToken: string; mcp?: { name: string; path: string }[] };
}
/** An MCP client on the gateway's relay, as a run's Claude Code is. */
async function relay(path: string, token: string) {
  const client = new Client({ name: "run", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.origin}${path}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

beforeAll(async () => {
  // The stand-in service: an MCP server with two tools, behind "Authorization: Bearer <KEY>".
  service = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      void (async () => {
        if (req.url === "/moved") return res.writeHead(302, { location: "/mcp" }).end();
        if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        if (req.method !== "POST") return res.writeHead(405).end();
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        const server = new McpServer({ name: "pages", version: "1.0.0" });
        server.registerTool("find_page", { description: "Finds a page by its title.", inputSchema: { title: z.string() } }, async ({ title }) => {
          seen.push({ auth: req.headers.authorization, tool: "find_page", args: { title } });
          return { content: [{ type: "text", text: `Found “${title}”: 3 paragraphs.` }] };
        });
        server.registerTool("delete_page", { description: "Deletes a page.", inputSchema: { id: z.string() } }, async () => ({ content: [{ type: "text", text: "No such page." }], isError: true }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
  });
  await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}/mcp`;
  s = await startStack({ ambient: {}, mcpLocal: true });
  lena = await signIn(s, "apple-lena-mcp", "Lena Vogel");
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
  computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string }[])[0]!.id;
});
afterAll(() => {
  s.close();
  service.close();
});

describe("connecting a server", () => {
  it("names are made safe for a run's tool names", () => {
    expect(slugOf("Notion (Miora)")).toBe("notion-miora");
    expect(slugOf("  Löwen & Co. ")).toBe("lowen-co");
    expect(slugOf("!!!")).toBe("server");
  });

  it("refuses addresses that aren't a public https server, and a key the server doesn't take", async () => {
    for (const url of ["http://example.com/mcp", "https://127.0.0.1/mcp", "https://10.0.0.5/mcp", "https://169.254.169.254/latest", "https://user:pw@example.com/mcp", "not a url at all"]) {
      const out = await call("POST", "/v1/app/mcp-connections", { name: "Bad", url });
      expect(out.status, url).toBe(400);
      expect(out.json.error, url).toBe("bad_url");
    }
    const wrong = await call("POST", "/v1/app/mcp-connections", { name: "Pages", url: serviceUrl, key: "nope" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("refused");
    // A server that sends the client elsewhere doesn't get the key carried along.
    const moved = await call("POST", "/v1/app/mcp-connections", { name: "Pages", url: serviceUrl.replace("/mcp", "/moved"), key: KEY });
    expect(moved.status).toBe(400);
    expect((await call("GET", "/v1/app/mcp-connections")).json.connections).toEqual([]);
  });

  it("asks the server for its tools and keeps the connection; the key is never shown", async () => {
    const out = await call("POST", "/v1/app/mcp-connections", { name: "Pages", url: serviceUrl, key: KEY });
    expect(out.status).toBe(201);
    const c = out.json.connection as Connection;
    expect(c).toMatchObject({ name: "Pages", slug: "pages", hasKey: true, bots: [], amb: false });
    expect(c.tools.map((t) => t.name)).toEqual(["find_page", "delete_page"]);
    expect(JSON.stringify(out.json)).not.toContain(KEY);
    const list = (await call("GET", "/v1/app/mcp-connections")).json;
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect((list.connections as Connection[]).map((x) => x.id)).toEqual([c.id]);
    // A second one with the same name gets its own tool prefix.
    const again = (await call("POST", "/v1/app/mcp-connections", { name: "Pages", url: serviceUrl, key: KEY })).json.connection as Connection;
    expect(again.slug).toBe("pages-2");
    expect((await call("DELETE", `/v1/app/mcp-connections/${again.id}`)).status).toBe(204);
  });
});

describe("who has it", () => {
  let id = "";
  let writer = "";
  let other = "";

  beforeAll(async () => {
    id = ((await call("GET", "/v1/app/mcp-connections")).json.connections as Connection[])[0]!.id;
    writer = await bot("Writer");
    other = await bot("Other");
  });

  it("a bot starts with nothing: its run gets no servers, and the relay doesn't know it", async () => {
    const run = await startRun(writer);
    expect(run.mcp).toBeUndefined();
    const res = await fetch(`${s.origin}/v1/bot/mcp/${id}`, { method: "POST", headers: { authorization: `Bearer ${run.runToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(404);
    await hostCall(host, "POST", `/v1/host/runs/${run.run.id}`, { status: "succeeded", summary: "ok" });
  });

  it("given to one bot, that bot's run reaches the service through the gateway; the key stays there", async () => {
    const granted = await call("PUT", `/v1/app/mcp-connections/${id}/grants`, { bot: writer, on: true });
    expect((granted.json.connection as Connection).bots).toEqual([writer]);
    const run = await startRun(writer);
    expect(run.mcp).toEqual([{ name: "pages", path: `/v1/bot/mcp/${id}` }]);
    // Nothing the runner gets holds the key or the service's address.
    expect(JSON.stringify(run)).not.toContain(KEY);
    expect(JSON.stringify(run)).not.toContain(serviceUrl);

    const client = await relay(run.mcp![0]!.path, run.runToken);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["find_page", "delete_page"]);
    expect(tools.tools[0]!.inputSchema).toMatchObject({ type: "object", properties: { title: { type: "string" } } });
    const before = seen.length;
    const found = await client.callTool({ name: "find_page", arguments: { title: "Roadmap" } });
    expect(text(found)).toBe("Found “Roadmap”: 3 paragraphs.");
    // The service was called with the connection's key, which the run never held.
    expect(seen.slice(before)).toEqual([{ auth: `Bearer ${KEY}`, tool: "find_page", args: { title: "Roadmap" } }]);
    // The service's own failure comes back as it is; a tool it doesn't have is said plainly.
    expect(await client.callTool({ name: "delete_page", arguments: { id: "x" } })).toMatchObject({ isError: true });
    expect(text(await client.callTool({ name: "drop_database", arguments: {} }))).toContain("has no tool called drop_database");

    // Another bot's run, and a made-up token, get nothing.
    const stranger = await startRun(other);
    expect(stranger.mcp).toBeUndefined();
    await expect(relay(`/v1/bot/mcp/${id}`, stranger.runToken)).rejects.toThrow();
    await expect(relay(`/v1/bot/mcp/${id}`, "ar_made-up-token")).rejects.toThrow();
    await hostCall(host, "POST", `/v1/host/runs/${stranger.run.id}`, { status: "succeeded", summary: "ok" });

    // Taken away while the run is still going: its very next call is refused.
    await call("PUT", `/v1/app/mcp-connections/${id}/grants`, { bot: writer, on: false });
    await expect(client.callTool({ name: "find_page", arguments: { title: "Roadmap" } })).rejects.toThrow();
    expect(seen.length).toBe(before + 1);
    await client.close().catch(() => undefined);

    // A run that's over can't use its token anymore, even when the bot has the connection again.
    await call("PUT", `/v1/app/mcp-connections/${id}/grants`, { bot: writer, on: true });
    await hostCall(host, "POST", `/v1/host/runs/${run.run.id}`, { status: "succeeded", summary: "ok" });
    await expect(relay(`/v1/bot/mcp/${id}`, run.runToken)).rejects.toThrow();
  });

  it("Amb gets a connection of the person's own, by a switch of its own", async () => {
    const out = await call("PUT", `/v1/app/mcp-connections/${id}/grants`, { amb: true, on: true });
    expect(out.json.connection).toMatchObject({ amb: true, bots: [writer] });
    expect(await s.folders.mcp!.forAmb(lena.user.uid)).toEqual([{ name: "pages", id, title: "Pages" }]);
    expect((await call("PUT", `/v1/app/mcp-connections/${id}/grants`, { amb: true, bot: writer, on: true })).status).toBe(400);
    expect((await call("PUT", `/v1/app/mcp-connections/${id}/grants`, { bot: "nonexistent", on: true })).status).toBe(404);
  });

  it("the same from an AI app, over MCP", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const mcp = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await mcp.callTool({ name: "mcp_connections", arguments: {} }))).toContain("Pages (127.0.0.1");
    expect(text(await mcp.callTool({ name: "grant_mcp_connection", arguments: { connection: id, bot: other, on: true } }))).toBe("Other has Pages from its next run.");
    expect(text(await mcp.callTool({ name: "grant_mcp_connection", arguments: { connection: id, amb: true, on: false } }))).toBe("Ambient doesn't have Pages anymore.");
    const added = text(await mcp.callTool({ name: "mcp_connections", arguments: { add: { name: "Pages again", url: serviceUrl, key: KEY } } }));
    expect(added).toContain("Connected Pages again (2 tools)");
    expect(added).not.toContain(KEY);
    await mcp.close();
    const list = (await call("GET", "/v1/app/mcp-connections")).json.connections as Connection[];
    expect(list.map((c) => c.slug)).toEqual(["pages", "pages-again"]);
    expect(list[0]!.bots.sort()).toEqual([writer, other].sort());
  });

  it("removed: gone from the list, from the runs and from the relay", async () => {
    expect((await call("DELETE", `/v1/app/mcp-connections/${id}`)).status).toBe(204);
    expect((await call("DELETE", `/v1/app/mcp-connections/${id}`)).status).toBe(404);
    const run = await startRun(writer);
    expect(run.mcp).toBeUndefined();
    await expect(relay(`/v1/bot/mcp/${id}`, run.runToken)).rejects.toThrow();
    await hostCall(host, "POST", `/v1/host/runs/${run.run.id}`, { status: "succeeded", summary: "ok" });
  });
});
