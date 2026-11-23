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
  it("lists every tool (bots are everyone's: their tools too); the ones that change something are marked so", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, lenaAll);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ambient_settings",
      "answer_decision",
      "bot_files",
      "bot_learning",
      "bot_templates",
      "bot_thread",
      "bot_wake_ups",
      "brief",
      "change_preferences",
      "change_team_settings",
      "command_status",
      "connect_computer",
      "connect_github",
      "connect_microsoft",
      "connect_slack",
      "create_automation",
      "create_bot_from_template",
      "create_routine",
      "create_team",
      "delete_automation",
      "delete_routine",
      "fetch",
      "forget_my_voice",
      "get_entity",
      "get_settings",
      "github_app_for_bot",
      "github_webhook",
      "grant_mcp_connection",
      "index",
      "join_team",
      "list_action_items",
      "list_automations",
      "list_decisions",
      "list_recent",
      "list_routines",
      "log_work",
      "mcp_connections",
      "message_bot",
      "needs_you",
      "open_decisions",
      "propose_bot_change",
      "read_amb_file",
      "read_bot_file",
      "remove_computer",
      "run_automation",
      "run_on_computer",
      "run_routine",
      "save_note",
      "search",
      "search_history",
      "set_aside_decision",
      "set_computer_access",
      "set_computer_model",
      "set_routine_secret",
      "set_session_rules",
      "sign_in_chatgpt",
      "slack_for_bot",
      "team_people",
      "transcript",
      "update_automation",
      "update_profile",
      "update_routine",
      "use_claude_account",
      "use_openai_account",
      "watch_github",
      "write_amb_file",
      "write_bot_file",
    ]);
    const writers = ["ambient_settings", "answer_decision", "bot_learning", "bot_thread", "bot_wake_ups", "change_preferences", "change_team_settings", "command_status", "connect_computer", "connect_github", "connect_microsoft", "connect_slack", "create_automation", "create_bot_from_template", "create_routine", "create_team", "delete_automation", "delete_routine", "forget_my_voice", "github_app_for_bot", "grant_mcp_connection", "join_team", "log_work", "mcp_connections", "message_bot", "propose_bot_change", "remove_computer", "run_automation", "run_on_computer", "run_routine", "save_note", "set_aside_decision", "set_computer_access", "set_computer_model", "set_routine_secret", "set_session_rules", "sign_in_chatgpt", "slack_for_bot", "team_people", "update_automation", "update_profile", "update_routine", "use_claude_account", "use_openai_account", "watch_github", "write_amb_file", "write_bot_file"];
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

  it("a team-only token saves notes to the team wiki, right away", async () => {
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, lenaTeam);
    const r = await client.callTool({ name: "save_note", arguments: { title: "Hosting notes", content: "The website runs behind a CDN.", related: ["team:acme:orgs/bergmann-logistik"], project: "none" } });
    expect(r.isError).toBeFalsy();
    const saved = r.structuredContent as { id: string; path: string; team: string };
    expect(saved).toMatchObject({ team: "acme", path: expect.stringMatching(/notes\/.*hosting-notes.*\.md$/) });
    const back = (await client.callTool({ name: "fetch", arguments: { id: saved.id } })).structuredContent as { text: string; metadata: { frontmatter: Record<string, unknown> } };
    expect(back.text).toContain("The website runs behind a CDN.");
    expect(back.metadata.frontmatter).toMatchObject({ kind: "memo", orgs: ["orgs/bergmann-logistik"] });
    await client.close();
  });

  it("a team token sends a correction to the team wiki right away, for whoever keeps the page", async () => {
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, lenaTeam);
    const r = await client.callTool({
      name: "suggest_correction",
      arguments: { wrong: "Bergmann Logistik is based in Hamburg.", right: "Bergmann Logistik moved to Bremen.", pages: ["team:acme:orgs/bergmann-logistik"], app: "Copilot", project: "none" },
    });
    expect(text(r)).toContain("The page isn't changed yet");
    const { id, path } = r.structuredContent as { id: string; path: string };
    expect(path).toMatch(/^corrections\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}-correction-bergmann-logistik-[0-9a-z]{6}\.md$/);
    const page = (await client.callTool({ name: "fetch", arguments: { id } })).structuredContent as { text: string; metadata: { frontmatter: Record<string, unknown> } };
    expect(page.metadata.frontmatter).toMatchObject({ kind: "correction", orgs: ["orgs/bergmann-logistik"], scope: "team" });
    expect(page.text).toContain("Suggested by Lena Vogel on");
    // The org page itself is as it was.
    expect(text(await client.callTool({ name: "fetch", arguments: { id: "team:acme:orgs/bergmann-logistik" } }))).not.toContain("Bremen");
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

describe("private projects and sharing a personal note later", () => {
  // Runs before "scoping and membership", which removes Lena from the team.
  // A connection like Claude's: the personal wiki and the user's teams, allowed to write to both.
  const claude = async () =>
    String((await s.pats.create({ uid: lenaUid, scopes: ["personal:read", "personal:write", "team:read", "team:write"], resource: { kind: "personal" }, label: "Claude" })).token);
  const NOTE = "personal:notes/2026/10/2026-10-01-preisgespraech-mit-anna-1xq7zk";

  it("nothing from a project with privat in its name goes to a team, in any spelling", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, await claude());
    for (const project of ["Privat", "HR - Privat", "private: Verrechnung", "PRIVATE notes"]) {
      const shared = await client.callTool({ name: "share_with_team", arguments: { id: NOTE, team: "acme", project } });
      expect(shared.isError, project).toBe(true);
      expect(text(shared)).toContain("is a private project: nothing from it goes to a team");
      const logged = await client.callTool({ name: "log_work", arguments: { title: "Payroll", summary: "Checked the payroll.", share_with_team: "acme", project } });
      expect(logged.isError, project).toBe(true);
      const corrected = await client.callTool({ name: "suggest_correction", arguments: { wrong: "x", right: "y", team: "acme", project } });
      expect(corrected.isError, project).toBe(true);
    }
    // Personal work in a private project is fine.
    const personal = await client.callTool({ name: "log_work", arguments: { title: "Payroll", summary: "Checked the payroll.", project: "HR - Privat" } });
    expect(personal.isError).toBeFalsy();
    // Without saying which project, nothing goes to a team either.
    expect(text(await client.callTool({ name: "share_with_team", arguments: { id: NOTE, team: "acme" } }))).toContain("Say which Claude project");
    await client.close();
  });

  it("a team-only connection refuses a note from a private project too", async () => {
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, lenaTeam);
    const r = await client.callTool({ name: "save_note", arguments: { title: "Salaries", content: "x", project: "Privat" } });
    expect(r.isError).toBe(true);
    await client.close();
  });

  it("shares a personal note with the team on request: the summary, at once, attributed", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, await claude());
    const r = await client.callTool({ name: "share_with_team", arguments: { id: NOTE, team: "acme", project: "Vertrieb" } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/^Shared "Preisgespräch mit Anna" with the Acme team wiki as .*; it can be found there now/);
    const { id } = r.structuredContent as { id: string };
    const page = (await client.callTool({ name: "fetch", arguments: { id } })).structuredContent as { text: string; metadata: { frontmatter: Record<string, unknown> } };
    expect(page.text).toContain("Shared from Lena Vogel's personal wiki on");
    expect(page.metadata.frontmatter).toMatchObject({ kind: "call", scope: "team" });
    // The personal note stays where it was.
    expect((await client.callTool({ name: "fetch", arguments: { id: NOTE } })).isError).toBeFalsy();
    await client.close();
  });

  it("shares only notes, and only from the personal wiki", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, await claude());
    expect(text(await client.callTool({ name: "share_with_team", arguments: { id: "personal:people/anna-mueller", team: "acme", project: "none" } }))).toContain("Only notes can be shared");
    expect(text(await client.callTool({ name: "share_with_team", arguments: { id: "team:acme:people/anna-mueller", team: "acme", project: "none" } }))).toContain("Only notes from the personal wiki");
    await client.close();
  });

  it("isn't offered where nothing personal can be read or nothing can go to a team", async () => {
    const team = await mcpClient(`${s.origin}/t/acme/mcp`, lenaTeam);
    expect((await team.listTools()).tools.map((t) => t.name)).not.toContain("share_with_team");
    await team.close();
    const readOnlyTeams = await mcpClient(`${s.origin}/mcp`, lenaAll);
    expect((await readOnlyTeams.listTools()).tools.map((t) => t.name)).not.toContain("share_with_team");
    await readOnlyTeams.close();
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
