// The brain for bots (docs/bots.md, "The brain for bots"): a bot's run signs in to Ambient's MCP
// with its run token and gets the brain the way an employee's AI app has it: everything to read
// that its owner may read, and only corrections and its work log to write. Over when the run is.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botPrincipal, BOT_TOOLS } from "../src/mcp/bot-principal.ts";
import { appCall, INVITE, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-brain", os: "Linux 6.8", runner: "0.12.0", claude: "2.1.326 (Claude Code)" };

let s: Stack;
let lena: AppSession;
let host: string;
let botId: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] } });
  lena = await signIn(s, "apple-lena-botbrain", "Lena Vogel");
  s.config.bots!.users.push(lena.user.uid);
  await appCall(s, lena.access_token, "POST", "/v1/app/teams/join", { code: INVITE });
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
  const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Reviewer", prompt: "Review the open pull requests.", schedule: daily, bot: {} });
  botId = (made.json.routine as { id: string }).id;
});
afterAll(() => s.close());

describe("a bot's run", () => {
  it("reads the brain, writes only corrections and its work log, and stops when the run does", async () => {
    const start = await hostCall(host, "POST", `/v1/host/routines/${botId}/runs`);
    const runToken = String(start.json.runToken);
    const runId = (start.json.run as { id: string }).id;
    // Its instructions say where the brain is and what it may do there.
    expect(JSON.stringify(start.json)).toContain("The brain is in Ambient");

    const mcp = await mcpClient(`${s.origin}/mcp`, runToken);
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([...BOT_TOOLS].sort());
    expect(tools).not.toContain("save_note");
    expect(tools).not.toContain("change_team_settings");
    expect(tools).not.toContain("write_bot_file");

    // The owner's team brain, as they see it.
    const found = text(await mcp.callTool({ name: "search", arguments: { query: "Bergmann" } }));
    expect(found).toContain("bergmann-logistik");
    const page = text(await mcp.callTool({ name: "fetch", arguments: { id: "team:acme:orgs/bergmann-logistik" } }));
    expect(page).toContain("Bergmann");

    // A correction: sent to the team's wiki as one from the bot, the page itself untouched.
    const corrected = text(
      await mcp.callTool({ name: "suggest_correction", arguments: { wrong: "Bergmann has 12 seats.", right: "Bergmann has 25 seats.", how_known: "The signed order.", pages: ["team:acme:orgs/bergmann-logistik"], team: "acme" } }),
    );
    expect(corrected).toContain("Sent the correction");
    const note = s.teamWiki.store.ofType("note").find((n) => n.body.includes("Bergmann has 25 seats"));
    expect(note?.body ?? JSON.stringify(s.teamWiki.store.ofType("note").map((n) => n.ref))).toContain("the bot Reviewer");

    // Its work log says it's the bot's.
    const logged = text(await mcp.callTool({ name: "log_work", arguments: { title: "Reviewed PR 12", summary: "Reviewed the login retry change and asked for a test.", project: "none" } }));
    expect(logged).not.toMatch(/can't/);

    await hostCall(host, "POST", `/v1/host/runs/${runId}`, { status: "succeeded", summary: "Reviewed PR 12." });
    await expect(mcpClient(`${s.origin}/mcp`, runToken)).rejects.toThrow();
  });
});

describe("a team bot", () => {
  it("sees only its team's brain, never a member's personal wiki", async () => {
    const team = { id: "team1", slug: "acme", name: "Acme", status: "active" as const, serverUrl: "https://t-acme" };
    // The run's owner first, then its team.
    const control = { q: async (_fn: unknown, args: Record<string, unknown>) => ("teamId" in args ? team : { routineId: "r1", name: "Wiki keeper", createdBy: "u1", teamId: "team1" }) };
    const directory = { teamsOf: async () => [team, { ...team, id: "team2", slug: "other", name: "Other" }] };
    const p = await botPrincipal({ control: control as never, directory: directory as never }, "Bearer ambient_run_x", { url: "https://x/mcp", teamSlug: null });
    expect(p).toMatchObject({ uid: "u1", personal: false, teams: [{ slug: "acme" }], bot: { name: "Wiki keeper" } });
    expect([...p!.scopes].sort()).toEqual(["team:read", "team:write"]);
    await expect(botPrincipal({ control: control as never, directory: directory as never }, "Bearer ambient_run_x", { url: "https://x/t/other/mcp", teamSlug: "other" })).rejects.toThrow("belongs to the team Acme");
    expect(await botPrincipal({ control: control as never, directory: directory as never }, "Bearer ambient_pat_x", { url: "https://x/mcp", teamSlug: null })).toBeNull();
  });
});
