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
  s = await startStack({});
  lena = await signIn(s, "apple-lena-botbrain", "Lena Vogel");
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
    // post_to_teams only where Teams is set up (this server has no setup app).
    expect(tools).toEqual([...BOT_TOOLS].filter((t) => t !== "post_to_teams").sort());
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

    // Its own files: told in its thread that its goal or tone changed, it updates them itself.
    const goal = text(await mcp.callTool({ name: "update_my_file", arguments: { path: "GOAL.md", content: "Every open PR reviewed within a day.\n", why: "Lena asked me to own review speed." } }));
    expect(goal).toContain("Saved your GOAL.md");
    const soul = text(await mcp.callTool({ name: "update_my_file", arguments: { path: "SOUL.md", content: "Short, casual, English.\n", why: "Lena wants shorter answers." } }));
    expect(soul).toContain("Saved your SOUL.md");
    // It reads its files as they are now before it changes or offers one.
    const mine = text(await mcp.callTool({ name: "read_my_files", arguments: {} }));
    expect(mine).toContain("## GOAL.md (version 1, changed by Reviewer)");
    expect(mine).toContain("Every open PR reviewed within a day.");
    expect(mine).toContain("Review the open pull requests.");
    expect(mine).not.toContain("## memory.md");
    const read = await appCall(s, lena.access_token, "GET", `/v1/app/routines/${botId}/files/content?path=GOAL.md`);
    expect(JSON.stringify(read.json)).toContain("Every open PR reviewed within a day.");
    expect(JSON.stringify(read.json)).toContain("Reviewer");
    // Memory stays the run's own file, and the job can't be emptied.
    expect(text(await mcp.callTool({ name: "update_my_file", arguments: { path: "memory.md", content: "x", why: "y" } }))).toContain("out folder");
    expect(text(await mcp.callTool({ name: "update_my_file", arguments: { path: "AGENTS.md", content: " ", why: "y" } }))).toContain("can't be empty");
    const job = text(await mcp.callTool({ name: "update_my_file", arguments: { path: "AGENTS.md", content: "Review the open pull requests, and watch how merged ones do.\n", why: "Lena added watching merged PRs." } }));
    expect(job).toContain("Saved your AGENTS.md");
    const agents = await appCall(s, lena.access_token, "GET", `/v1/app/routines/${botId}/files/content?path=AGENTS.md`);
    expect(JSON.stringify(agents.json)).toContain("watch how merged ones do");

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

describe("a team bot's own files", () => {
  it("are its to change, even when its maker is a plain member of the team", async () => {
    // The real case: Loopie's GOAL.md was refused with "Only the team's owners and admins…".
    const ben = await signIn(s, "apple-ben-botbrain", "Ben Kraus");
    await appCall(s, ben.access_token, "POST", "/v1/app/teams/join", { code: INVITE });
    await s.t.run(async (ctx) => {
      for (const m of await ctx.db.query("members").collect()) await ctx.db.patch(m._id, { role: "admin" });
    });
    const code = String((await appCall(s, ben.access_token, "POST", "/v1/app/computers", { name: "Team server", team: "acme" })).json.code);
    const teamHost = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
    const made = await appCall(s, ben.access_token, "POST", "/v1/app/routines", { name: "Follow-ups", prompt: "Build the follow-ups.", schedule: daily, team: "acme", bot: {} });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = (made.json.routine as { id: string }).id;
    // Ben is a member again: the bot still keeps its own files.
    await s.t.run(async (ctx) => {
      for (const m of await ctx.db.query("members").collect()) await ctx.db.patch(m._id, { role: "member" });
    });
    const start = await hostCall(teamHost, "POST", `/v1/host/routines/${id}/runs`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const mcp = await mcpClient(`${s.origin}/mcp`, String(start.json.runToken));
    const goal = text(await mcp.callTool({ name: "update_my_file", arguments: { path: "GOAL.md", content: "Useful follow-ups, never annoying.\n", why: "Ben gave me the goal." } }));
    expect(goal).toContain("Saved your GOAL.md");
    const job = text(await mcp.callTool({ name: "update_my_file", arguments: { path: "AGENTS.md", content: "Build the follow-ups and watch how they land.\n", why: "Ben added monitoring." } }));
    expect(job).toContain("Saved your AGENTS.md");
    expect(text(await mcp.callTool({ name: "read_my_files", arguments: {} }))).toContain("Build the follow-ups and watch how they land.");
    const read = await appCall(s, ben.access_token, "GET", `/v1/app/routines/${id}/files/content?path=GOAL.md`);
    expect(JSON.stringify(read.json)).toContain("Useful follow-ups, never annoying.");
    await hostCall(teamHost, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Kept my files." });
  });
});

describe("a bot's offer to change its own files", () => {
  it("is saved exactly as offered when its owner says Update, and not at all on Not now", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Watcher", prompt: "Watch the costs.", schedule: daily, bot: {} });
    const id = (made.json.routine as { id: string }).id;
    const goalOf = async () => JSON.stringify((await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/files/content?path=GOAL.md`)).json);

    // Run 1: the owner said "from now on also keep an eye on answer quality"; the bot offers.
    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    const mcp = await mcpClient(`${s.origin}/mcp`, String(start.json.runToken));
    const offered = text(
      await mcp.callTool({
        name: "propose_my_change",
        arguments: {
          question: "Add answer quality to my job and goal?",
          why: "Lena asked me to keep an eye on answer quality from now on.",
          files: [
            { path: "GOAL.md", content: "Costs and answer quality hold after the switch.\n" },
            { path: "AGENTS.md", content: "Watch the costs and sample answers for quality.\n" },
          ],
        },
      }),
    );
    expect(offered).toContain("Offered GOAL.md and AGENTS.md");
    // Nothing changes before the answer; the question carries both files in full.
    expect(await goalOf()).not.toContain("answer quality");
    const thread = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/thread?seen=0`)).json as { openQuestion: { id: string; choices: string[]; details?: string } | null };
    expect(thread.openQuestion?.choices).toEqual(["Update", "Not now"]);
    expect(thread.openQuestion?.details).toContain("The new AGENTS.md:");
    // Refused before it's asked: memory.md isn't offered.
    expect(text(await mcp.callTool({ name: "propose_my_change", arguments: { question: "q", why: "w", files: [{ path: "memory.md", content: "x" }] } }))).toContain("out folder");
    await hostCall(host, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Offered." });

    // The owner taps Update on the card: saved as offered, as theirs, and the thread says so.
    const answered = await appCall(s, lena.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "Update", question: thread.openQuestion!.id });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    expect(await goalOf()).toContain("Costs and answer quality hold after the switch.");
    const agents = JSON.stringify((await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/files/content?path=AGENTS.md`)).json);
    expect(agents).toContain("sample answers for quality");
    const after = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/thread?seen=0`)).json as { messages: { text: string }[] };
    expect(after.messages.map((m) => m.text).join("\n")).toMatch(/Saved GOAL\.md \(version \d+\) and AGENTS\.md/);

    // Run 2 offers a SOUL.md; the owner says Not now (typed): nothing is saved.
    const run2 = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    const mcp2 = await mcpClient(`${s.origin}/mcp`, String(run2.json.runToken));
    await mcp2.callTool({ name: "propose_my_change", arguments: { question: "Write shorter from now on?", why: "Lena said my reports are long.", files: [{ path: "SOUL.md", content: "Short.\n" }] } });
    await appCall(s, lena.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "Not now" });
    const soul = JSON.stringify((await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/files/content?path=SOUL.md`)).json);
    expect(soul).not.toContain("Short.");
    await hostCall(host, "POST", `/v1/host/runs/${(run2.json.run as { id: string }).id}`, { status: "succeeded", summary: "Asked." });
  });
});
