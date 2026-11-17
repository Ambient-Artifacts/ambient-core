// A bot's folder, how it wakes up, the full history and Amb's memory (docs/bots.md, "A bot's
// folder", "History", "Amb's memory"): files with versions and undo, AGENTS.md as the prompt,
// handoffs and memory from a run, the wake-up message and the 6-hour continue rule, history kept
// past the old cut-off and found again, and the MCP tools Amb uses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.8.0", claude: "2.1.300 (Claude Code)" };

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let host: string;
let computerId: string;
let bot: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const call = (method: string, path: string, body?: unknown, who = lena) => appCall(s, who.access_token, method, path, body);
const enc = encodeURIComponent;

type Start = { run: { id: string }; routine: { prompt: string }; resume: { sessionId: string | null; message: string } | null; runToken: string; workspace?: { system: string; skills: { path: string; content: string }[]; memory: string } };

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] }, ambient: {} });
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  ben = await signIn(s, "apple-ben", "Ben Weiss");
  s.config.bots!.users.push(lena.user.uid);
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  const setup = await hostCall("", "POST", "/v1/host/setup", { code, info });
  host = String(setup.json.token);
  computerId = (setup.json.computer as { id: string }).id;
  const made = await call("POST", "/v1/app/routines", { name: "Blog", prompt: "Write the weekly post.", schedule: daily, computer: computerId, bot: { isolation: "container" } });
  bot = (made.json.routine as { id: string }).id;
});
afterAll(() => s.close());

describe("a bot's files", () => {
  it("lists AGENTS.md (the prompt) and memory.md from the start", async () => {
    const list = (await call("GET", `/v1/app/routines/${bot}/files`)).json.files as { path: string; version: number; size: number }[];
    expect(list.map((f) => f.path)).toEqual(["AGENTS.md", "memory.md"]);
    expect(list[0]).toMatchObject({ version: 0, size: "Write the weekly post.".length });
    const agents = (await call("GET", `/v1/app/routines/${bot}/files/content?path=AGENTS.md`)).json;
    expect(agents.content).toBe("Write the weekly post.");
  });

  it("keeps a version per change, with who and why, and restores an earlier one", async () => {
    const p = `/v1/app/routines/${bot}/files/content?path=${enc("skills/tone/SKILL.md")}`;
    expect((await call("PUT", p, { content: "Short sentences.", why: "first try" })).json).toMatchObject({ version: 1, by: { kind: "user", name: "Lena Vogel" } });
    expect((await call("PUT", p, { content: "Short sentences. No emojis." })).json).toMatchObject({ version: 2 });
    const history = (await call("GET", `/v1/app/routines/${bot}/files/history?path=${enc("skills/tone/SKILL.md")}`)).json.versions as { version: number; why: string | null }[];
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    expect(history[1]!.why).toBe("first try");
    const restored = await call("POST", `/v1/app/routines/${bot}/files/revert`, { path: "skills/tone/SKILL.md", version: 1 });
    expect(restored.json).toMatchObject({ version: 3, content: "Short sentences.", why: "restored version 1" });
    expect((await call("GET", `${p}&version=2`)).json.content).toBe("Short sentences. No emojis.");
  });

  it("makes AGENTS.md the prompt, with the old prompt kept as the first version", async () => {
    await call("PUT", `/v1/app/routines/${bot}/files/content?path=AGENTS.md`, { content: "Write the weekly post. In German.", why: "German readers" });
    const r = (await call("GET", "/v1/app/routines")).json.routines as { id: string; prompt: string }[];
    expect(r.find((x) => x.id === bot)!.prompt).toBe("Write the weekly post. In German.");
    const history = (await call("GET", `/v1/app/routines/${bot}/files/history?path=AGENTS.md`)).json.versions as { version: number; why: string | null }[];
    expect(history.map((v) => [v.version, v.why])).toEqual([
      [2, "German readers"],
      [1, "as it was before"],
    ]);
    // Editing the loop's prompt is a version too.
    await call("PATCH", `/v1/app/routines/${bot}`, { prompt: "Write the weekly post. In German, short." });
    expect(((await call("GET", `/v1/app/routines/${bot}/files/history?path=AGENTS.md`)).json.versions as unknown[]).length).toBe(3);
  });

  it("refuses bad paths, oversize files and deleting AGENTS.md; deletes a skill", async () => {
    expect((await call("PUT", `/v1/app/routines/${bot}/files/content?path=${enc("../etc/passwd")}`, { content: "x" })).json.error).toBe("bad_path");
    expect((await call("PUT", `/v1/app/routines/${bot}/files/content?path=${enc("skills/a/../b")}`, { content: "x" })).json.error).toBe("bad_path");
    expect((await call("PUT", `/v1/app/routines/${bot}/files/content?path=memory.md`, { content: "x".repeat(17 * 1024) })).json.error).toBe("too_big");
    expect((await call("DELETE", `/v1/app/routines/${bot}/files/content?path=AGENTS.md`)).json.error).toBe("bad_path");
    await call("PUT", `/v1/app/routines/${bot}/files/content?path=${enc("skills/old/SKILL.md")}`, { content: "x" });
    expect((await call("DELETE", `/v1/app/routines/${bot}/files/content?path=${enc("skills/old/SKILL.md")}`)).status).toBe(204);
    const list = (await call("GET", `/v1/app/routines/${bot}/files`)).json.files as { path: string }[];
    expect(list.map((f) => f.path)).toEqual(["AGENTS.md", "memory.md", "skills/tone/SKILL.md"]);
  });

  it("is only for who may see the bot, and written only by who may change it", async () => {
    expect((await call("GET", `/v1/app/routines/${bot}/files`, undefined, ben)).status).toBe(404);
    expect((await call("PUT", `/v1/app/routines/${bot}/files/content?path=memory.md`, { content: "x" }, ben)).status).toBe(404);
  });
});

describe("how a bot wakes up", () => {
  let first: Start;

  it("starts fresh with AGENTS.md, its memory and its skills, and keeps its handoff and memory", async () => {
    await call("PUT", `/v1/app/routines/${bot}/files/content?path=memory.md`, { content: "- Lena wants German posts." });
    first = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    expect(first.routine.prompt.startsWith("Write the weekly post. In German, short.")).toBe(true);
    expect(first.routine.prompt).toContain("- Lena wants German posts.");
    expect(first.routine.prompt).toContain("This is your first run with a handoff");
    expect(first.resume).toBeNull();
    expect(first.workspace!.memory).toBe("- Lena wants German posts.");
    expect(first.workspace!.skills).toEqual([{ path: "tone/SKILL.md", content: "Short sentences." }]);
    expect(first.workspace!.system).toContain("{{OUT}}/handoff.md");
    const done = await hostCall(host, "POST", `/v1/host/runs/${first.run.id}`, {
      status: "succeeded",
      summary: "Drafted the post.",
      sessionId: "sess-1",
      memory: "- Lena wants German posts.\n- The blog repo needs Node 24.",
      handoff: "Status: continue\nDrafted half the post; images next.",
    });
    expect(done.status).toBe(204);
    const handoffs = (await call("GET", `/v1/app/routines/${bot}/handoffs`)).json.handoffs as { status: string; text: string; runId: string }[];
    expect(handoffs[0]).toMatchObject({ status: "continue", text: "Drafted half the post; images next.", runId: first.run.id });
    const memory = (await call("GET", `/v1/app/routines/${bot}/files/content?path=memory.md`)).json;
    expect(memory).toMatchObject({ content: "- Lena wants German posts.\n- The blog repo needs Node 24.", by: { kind: "bot", name: "Blog" } });
  });

  it("continues its session when its handoff said continue and it ended less than 6 hours ago", async () => {
    await call("POST", `/v1/app/routines/${bot}/thread`, { text: "Use the photo from Monday." });
    const next = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    // Her message starts the run (it resumes as before); the continue rule is for runs without one.
    expect(next.resume?.sessionId).toBe("sess-1");
    await hostCall(host, "POST", `/v1/host/runs/${next.run.id}`, { status: "succeeded", summary: "Added the photo.", sessionId: "sess-2", handoff: "Status: continue\nPhoto in; the ending is left." });
    const third = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    expect(third.resume).toMatchObject({ sessionId: "sess-2" });
    expect(third.resume!.message).toContain("Photo in; the ending is left.");
    await hostCall(host, "POST", `/v1/host/runs/${third.run.id}`, { status: "succeeded", summary: "Finished.", sessionId: "sess-3", handoff: "Status: done\nPublished." });
  });

  it("starts fresh after a done handoff, with its last handoffs and what's new in its thread", async () => {
    await call("POST", `/v1/app/routines/${bot}/thread`, { text: "Next week: the release." });
    // That message started a run (it resumes); finish it, then a scheduled run wakes up fresh.
    const resumed = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    expect(resumed.resume?.message).toContain("Next week: the release.");
    await hostCall(host, "POST", `/v1/host/runs/${resumed.run.id}`, { status: "succeeded", summary: "Noted.", sessionId: "sess-4", handoff: "Status: done\nNoted the release for next week." });
    await call("POST", `/v1/app/routines/${bot}/thread`, { text: "And keep it under 600 words." });
    const fresh = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    // A message always resumes; the wake-up prompt is still what a run without a session gets.
    expect(fresh.routine.prompt).toContain("Your last runs, newest first");
    expect(fresh.routine.prompt).toContain("Noted the release for next week.");
    expect(fresh.routine.prompt).toContain("Published.");
    expect(fresh.routine.prompt).not.toContain("Drafted half the post");
    await hostCall(host, "POST", `/v1/host/runs/${fresh.run.id}`, { status: "succeeded", summary: "Ok.", handoff: "Status: done\nOk." });
  });

  it("writes the summary as the handoff when a run wrote none", async () => {
    const run = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    await hostCall(host, "POST", `/v1/host/runs/${run.run.id}`, { status: "failed", summary: "Podman wasn't there." });
    const h = ((await call("GET", `/v1/app/routines/${bot}/handoffs?limit=1`)).json.handoffs as { status: string; text: string }[])[0]!;
    expect(h).toMatchObject({ status: "continue", text: "Podman wasn't there." });
  });
});

describe("history", () => {
  it("keeps the whole chat, starts a new chat without losing it, and finds it again", async () => {
    for (let i = 0; i < 230; i++) await s.ambient.say(lena.user.uid, i === 3 ? "The launch is on the 4th of December." : `Note ${i}`);
    // The app shows the newest 60; message 3 of 230 is still there (search finds it below).
    expect(((await call("GET", "/v1/app/ambient/chat")).json.messages as unknown[]).length).toBe(60);
    expect((await call("DELETE", "/v1/app/ambient/chat")).status).toBe(204);
    expect(((await call("GET", "/v1/app/ambient/chat")).json.messages as unknown[]).length).toBe(0);
    const hits = await s.folders.history.forPerson({ uid: lena.user.uid, teams: [], personal: true, canWritePersonal: true, canWriteTeams: true }, { q: "launch december" });
    expect(hits.map((h) => h.text)).toEqual(["The launch is on the 4th of December."]);
    expect(hits[0]!.where).toBe("chat");
  });

  it("searches bots' threads and handoffs over MCP, and a run searches its own", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const found = text(await client.callTool({ name: "search_history", arguments: { query: "600 words" } }));
    expect(found).toContain("Lena Vogel (Blog's thread): And keep it under 600 words.");
    const handoff = text(await client.callTool({ name: "search_history", arguments: { query: "published", bot } }));
    expect(handoff).toContain("Blog's handoff (done)");
    const run = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    const mine = await hostCall(run.runToken, "GET", `/v1/bot/history?q=${enc("photo monday")}`);
    expect((mine.json.results as { text: string }[]).map((r) => r.text)).toEqual(["Use the photo from Monday."]);
    await hostCall(host, "POST", `/v1/host/runs/${run.run.id}`, { status: "succeeded", summary: "x" });
    expect((await hostCall(run.runToken, "GET", "/v1/bot/history?q=photo")).status).toBe(409);
  });

  it("forgets the whole chat when asked", async () => {
    expect((await call("DELETE", "/v1/app/ambient/chat?forget=1")).status).toBe(204);
    const hits = await s.folders.history.forPerson({ uid: lena.user.uid, teams: [], personal: true, canWritePersonal: true, canWriteTeams: true }, { q: "launch" });
    expect(hits).toEqual([]);
  });
});

describe("Amb's memory and its tools", () => {
  it("is kept with versions, and Amb changes bots' files with a note in the thread", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_history", "amb_memory", "update_amb_memory", "bot_files", "read_bot_file", "write_bot_file"]));
    expect(text(await client.callTool({ name: "amb_memory", arguments: {} }))).toBe("Empty so far.");
    expect(text(await client.callTool({ name: "update_amb_memory", arguments: { content: "- Prefers short answers.", why: "she said so" } }))).toContain("version 1");
    const mem = (await call("GET", "/v1/app/ambient/memory")).json;
    expect(mem).toMatchObject({ content: "- Prefers short answers.", version: 1, why: "she said so", by: { kind: "amb" } });
    await call("PUT", "/v1/app/ambient/memory", { content: "- Prefers short answers.\n- Works from Vienna." });
    expect((await call("POST", "/v1/app/ambient/memory/revert", { version: 1 })).json).toMatchObject({ version: 3, content: "- Prefers short answers." });
    expect((await call("GET", "/v1/app/ambient/memory?version=2")).json.content).toBe("- Prefers short answers.\n- Works from Vienna.");

    const files = text(await client.callTool({ name: "bot_files", arguments: { id: bot } }));
    expect(files).toContain("memory.md");
    expect(files).toContain("Last runs:");
    const wrote = await client.callTool({ name: "write_bot_file", arguments: { id: bot, path: "skills/release/SKILL.md", content: "Release posts: link the changelog.", why: "she asked for release posts" } });
    expect(text(wrote)).toContain("version 1");
    const t = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { role: string; text: string }[];
    expect(t.at(-1)).toMatchObject({ role: "ambient", text: "I changed skills/release/SKILL.md: she asked for release posts (version 1; you can undo it under Files.)" });
    // A note doesn't start a run.
    const r = ((await call("GET", "/v1/app/routines")).json.routines as { id: string; runRequested: boolean }[]).find((x) => x.id === bot)!;
    expect(r.runRequested).toBe(false);
    expect(text(await client.callTool({ name: "read_bot_file", arguments: { id: bot, path: "skills/release/SKILL.md", history: true } }))).toContain("she asked for release posts");
  });

  it("goes into Amb's instructions", async () => {
    const { ambientInstructions } = await import("../src/bots/ambient.ts");
    expect(ambientInstructions("Lena", "- Prefers short answers.")).toContain("Your memory of Lena (your memory.md");
    expect(ambientInstructions("Lena", "- Prefers short answers.")).toContain("- Prefers short answers.");
  });
});
