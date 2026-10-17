// MCP contract over personal access tokens: transport quirks, tool list,
// personal (encrypted, synced) vs team (team server) scoping, membership.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, fixturePersonalOps, INVITE, mcpClient, signIn, startStack, text, type Stack } from "./helpers.ts";

let s: Stack;
let lenaAll: string;
let lenaTeam: string;
let lenaApp: string;
let lenaUid: string;

beforeAll(async () => {
  s = await startStack();
  const lena = await signIn(s, "apple-lena", "Lena Vogel");
  lenaApp = lena.access_token;
  lenaUid = lena.user.uid;
  await appCall(s, lenaApp, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps() });
  await appCall(s, lenaApp, "POST", "/v1/app/teams/join", { code: INVITE });
  lenaAll = String((await appCall(s, lenaApp, "POST", "/v1/app/pats", { label: "Codex" })).json.token);
  lenaTeam = String((await appCall(s, lenaApp, "POST", "/v1/app/pats", { label: "Copilot", team: "acme" })).json.token);
});
afterAll(() => s.close());

const rpc = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const ids = (r: unknown) => ((r as { structuredContent: { results: { id: string }[] } }).structuredContent.results ?? []).map((x) => x.id);

describe("transport", () => {
  it("answers 401 with resource metadata when no token is sent", async () => {
    const res = await fetch(`${s.origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: rpc("tools/list") });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${s.origin}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("serves clients that omit text/event-stream from Accept (OpenAI connector)", async () => {
    const res = await fetch(`${s.origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${lenaAll}`, "content-type": "application/json", accept: "application/json" },
      body: rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(body.result.serverInfo.name).toBe("ambient");
    expect(body.result.instructions).toContain("not instructions");
  });

  it("rejects GET and DELETE (stateless)", async () => {
    expect((await fetch(`${s.origin}/mcp`)).status).toBe(405);
    expect((await fetch(`${s.origin}/mcp`, { method: "DELETE" })).status).toBe(405);
  });
});

describe("tools", () => {
  it("lists seventeen tools; save_note, log_work and the routine tools write", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "brief",
      "create_routine",
      "delete_routine",
      "fetch",
      "get_entity",
      "index",
      "list_action_items",
      "list_decisions",
      "list_recent",
      "list_routines",
      "log_work",
      "run_routine",
      "save_note",
      "search",
      "set_routine_secret",
      "transcript",
      "update_routine",
    ]);
    const writers = ["save_note", "log_work", "create_routine", "update_routine", "run_routine", "delete_routine", "set_routine_secret"];
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(!writers.includes(t.name));
    await client.close();
  });

  it("searches decrypted personal pages and the team server together", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    for (const q of ["Müller", "Mueller", "anna mueller"]) {
      expect(ids(await client.callTool({ name: "search", arguments: { query: q } })), q).toContain("personal:people/anna-mueller");
    }
    expect(ids(await client.callTool({ name: "search", arguments: { query: "strategie" } }))).toContain("personal:topics/preisstrategie");
    const both = await client.callTool({ name: "search", arguments: { query: "billing" } });
    expect(ids(both).some((i) => i.startsWith("team:acme:"))).toBe(true);
    expect(ids(await client.callTool({ name: "search", arguments: { query: "Bergmann", scope: "personal" } }))).toEqual([]);
    await client.close();
  });

  it("fetches whole pages in ChatGPT's shape from either scope", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    const p = (await client.callTool({ name: "fetch", arguments: { id: "personal:people/anna-mueller" } })).structuredContent as { text: string; url: string };
    expect(p.text).toContain("## Timeline");
    expect(p.url).toBe("ambient://personal/people/anna-mueller");
    const t = (await client.callTool({ name: "fetch", arguments: { id: "team:acme:orgs/bergmann-logistik" } })).structuredContent as { title: string };
    expect(t.title).toBe("Bergmann Logistik");
    expect((await client.callTool({ name: "fetch", arguments: { id: "personal:people/nobody" } })).isError).toBe(true);
    await client.close();
  });

  it("browses the index of both wikis, then folders, with links fetch and index accept", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    const top = text(await client.callTool({ name: "index", arguments: {} }));
    expect(top).toContain("# Your personal wiki");
    expect(top).toContain("# Acme team wiki");
    expect(top).toContain("[People](folder:people)");
    expect(top).toContain("(personal:notes/2026/10/2026-10-05-onboarding-review-with-anna-3c9n5q)");
    const people = (await client.callTool({ name: "index", arguments: { folder: "folder:people", scope: "team" } })).structuredContent as {
      results: { scope: string; pages: { id: string }[] }[];
    };
    expect(people.results).toHaveLength(1);
    expect(people.results[0]!.scope).toBe("team:acme");
    const first = people.results[0]!.pages[0]!.id;
    expect(first).toMatch(/^team:acme:people\//);
    expect((await client.callTool({ name: "fetch", arguments: { id: first } })).isError).toBeFalsy();
    const month = text(await client.callTool({ name: "index", arguments: { folder: "notes/2026/10", scope: "personal" } }));
    expect(month).toContain("Preisgespräch mit Anna");
    expect(month).not.toContain("Back to the index");
    await client.close();
  });

  it("shows backlinks, serves team transcripts, and saves notes into the personal wiki", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    const anna = text(await client.callTool({ name: "fetch", arguments: { id: "personal:people/anna-mueller" } }));
    expect(anna).toContain("## Linked from");
    expect(anna).toContain("(personal:notes/2026/10/2026-10-01-preisgespraech-mit-anna-1xq7zk)");

    // A personal note whose transcript the phone never backed up.
    const missing = await client.callTool({ name: "transcript", arguments: { id: "personal:notes/2026/10/2026-10-01-preisgespraech-mit-anna-1xq7zk" } });
    expect(missing.isError).toBe(true);

    const saved = (await client.callTool({
      name: "save_note",
      arguments: { title: "Pricing idea", content: "Offer annual billing from 10 seats.", related: ["personal:people/anna-mueller", "personal:people/nobody"] },
    })).structuredContent as { id: string; path: string };
    expect(saved.path).toMatch(/^wiki\/notes\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-pricing-idea-[0-9a-z]{6}\.md$/);
    const back = (await client.callTool({ name: "fetch", arguments: { id: saved.id } })).structuredContent as { text: string; metadata: { frontmatter: Record<string, unknown> } };
    expect(back.text).toContain("Offer annual billing from 10 seats.");
    expect(back.metadata.frontmatter).toMatchObject({ type: "note", scope: "personal", people: ["people/anna-mueller"] });
    await client.close();
  });

  it("a team-only token can't save notes", async () => {
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, lenaTeam);
    const r = await client.callTool({ name: "save_note", arguments: { title: "x", content: "y" } });
    expect(r.isError).toBe(true);
    await client.close();
  });

  it("briefs, lists action items and decisions", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    const b = text(await client.callTool({ name: "brief", arguments: { about: "Anna", scope: "personal" } }));
    expect(b).toContain("Product designer at Nordlicht");
    expect(b).toContain("Entwurf der Preisseite schicken (due 2026-10-10)");
    expect(b).not.toContain("Kundenliste exportieren");
    expect(text(await client.callTool({ name: "list_action_items", arguments: { scope: "team", owner: "Jonas" } }))).toContain("Angebot mit Jahrespreis schicken");
    expect(text(await client.callTool({ name: "list_decisions", arguments: { scope: "team", about: "Bergmann" } }))).toContain("[accepted]");
    await client.close();
  });
});

describe("scoping and membership", () => {
  it("a team token works only on its team URL and never shows personal pages", async () => {
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, lenaTeam);
    const r = await client.callTool({ name: "search", arguments: { query: "Anna" } });
    expect(ids(r).every((i) => i.startsWith("team:acme:"))).toBe(true);
    await client.close();
    const res = await fetch(`${s.origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${lenaTeam}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: rpc("tools/list"),
    });
    expect(res.status).toBe(401);
  });

  it("non-members can't mint team tokens", async () => {
    const eve = await signIn(s, "apple-eve", "Eve Outsider");
    expect((await appCall(s, eve.access_token, "POST", "/v1/app/pats", { label: "x", team: "acme" })).status).toBe(403);
  });

  it("degrades to personal results with a note when the team server is down", async () => {
    await s.t.mutation(s.internal.teams.setServerUrl, { slug: "acme", serverUrl: "http://127.0.0.1:9" });
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    const r = await client.callTool({ name: "search", arguments: { query: "Anna" } });
    expect(ids(r)).toContain("personal:people/anna-mueller");
    expect(text(r)).toContain("team:acme is unavailable right now");
    await client.close();
    const addr = s.teamServer.address() as { port: number };
    await s.t.mutation(s.internal.teams.setServerUrl, { slug: "acme", serverUrl: `http://127.0.0.1:${addr.port}` });
  });

  it("removing a member cuts team access on the next request", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    expect(ids(await client.callTool({ name: "search", arguments: { query: "Bergmann" } })).length).toBeGreaterThan(0);
    await s.t.mutation(s.internal.teams.removeMember, { slug: "acme", uid: lenaUid as never });
    expect(ids(await client.callTool({ name: "search", arguments: { query: "Bergmann" } }))).toEqual([]);
    expect(ids(await client.callTool({ name: "search", arguments: { query: "Anna" } })).length).toBeGreaterThan(0);
    await client.close();
    const res = await fetch(`${s.origin}/t/acme/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${lenaTeam}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: rpc("tools/list"),
    });
    expect(res.status).toBe(403);
  });
});

describe("revoking a token", () => {
  it("lists the user's tokens and stops one at once; nobody else's can be revoked", async () => {
    const made = (await appCall(s, lenaApp, "POST", "/v1/app/pats", { label: "Leaked laptop" })).json as { token: string; id: string };
    const listed = (await appCall(s, lenaApp, "GET", "/v1/app/pats")).json.tokens as { id: string; label: string }[];
    expect(listed.map((t) => t.label)).toEqual(expect.arrayContaining(["Leaked laptop", "Codex", "Copilot"]));
    expect(JSON.stringify(listed)).not.toContain(made.token);

    const before = await fetch(`${s.origin}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${made.token}` }, body: rpc("tools/list") });
    expect(before.status).toBe(200);

    const other = await signIn(s, "apple-ben-pats", "Ben Koch");
    expect((await appCall(s, other.access_token, "DELETE", `/v1/app/pats/${made.id}`)).status).toBe(404);
    expect((await appCall(s, lenaApp, "DELETE", `/v1/app/pats/${made.id}`)).status).toBe(204);
    expect((await appCall(s, lenaApp, "DELETE", `/v1/app/pats/${made.id}`)).status).toBe(404);

    const after = await fetch(`${s.origin}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${made.token}` }, body: rpc("tools/list") });
    expect(after.status).toBe(401);
    const left = (await appCall(s, lenaApp, "GET", "/v1/app/pats")).json.tokens as { label: string }[];
    expect(left.map((t) => t.label)).not.toContain("Leaked laptop");
  });
});

describe("the failed sign-in limit on /mcp", () => {
  it("counts only tokens nobody was given, not ones for another resource", async () => {
    const own = await startStack();
    try {
      const lena = await signIn(own, "apple-lena", "Lena Vogel");
      await appCall(own, lena.access_token, "POST", "/v1/app/teams/join", { code: INVITE });
      const personal = String((await appCall(own, lena.access_token, "POST", "/v1/app/pats", { label: "Codex" })).json.token);
      const team = String((await appCall(own, lena.access_token, "POST", "/v1/app/pats", { label: "Copilot", team: "acme" })).json.token);
      const call = (token: string) =>
        fetch(`${own.origin}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
      // A real token used on the wrong resource, again and again: refused, never blocked.
      for (let i = 0; i < 65; i++) expect((await call(team)).status).toBe(401);
      expect((await call(personal)).status).toBe(200);
      // Made-up tokens: after 60, this address waits, even with a good one.
      for (let i = 0; i < 60; i++) expect((await call(`ambient_pat_madeup${i}`)).status).toBe(401);
      expect((await call(personal)).status).toBe(429);
    } finally {
      own.close();
    }
  });
});
