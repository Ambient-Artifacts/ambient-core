// One folder for every bot, Amb included (docs/bots.md): a bot's SOUL.md in its system text (only
// when it has one), its limits and that it isn't written while Amb reviews the bot; the templates'
// SOULs; Amb's own folder through the app (SOUL.md, AGENTS.md, memory.md, skills) with versions,
// undo and delete rules, its learning, the old memory endpoints, and its instructions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ambientInstructions } from "../src/bots/ambient.ts";
import { BOT_TEMPLATES } from "../src/bots/bot-templates.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.9.3", claude: "2.1.300 (Claude Code)" };

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let host: string;
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
type Start = { run: { id: string }; workspace?: { system: string } };

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] }, ambient: {} });
  lena = await signIn(s, "apple-lena-soul", "Lena Vogel");
  ben = await signIn(s, "apple-ben-soul", "Ben Weiss");
  s.config.bots!.users.push(lena.user.uid);
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  const setup = await hostCall("", "POST", "/v1/host/setup", { code, info });
  host = String(setup.json.token);
  const computer = (setup.json.computer as { id: string }).id;
  const made = await call("POST", "/v1/app/routines", { name: "Blog", prompt: "Write the weekly post.", schedule: daily, computer, bot: { isolation: "container" } });
  bot = (made.json.routine as { id: string }).id;
});
afterAll(() => s.close());

describe("a bot's SOUL.md", () => {
  it("is listed first and goes into its system text only once it has one", async () => {
    const files = (await call("GET", `/v1/app/routines/${bot}/files`)).json.files as { path: string; version: number }[];
    expect(files.map((f) => f.path)).toEqual(["SOUL.md", "AGENTS.md", "GOAL.md", "memory.md"]);
    expect(files[0]!.version).toBe(0);
    const before = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    expect(before.workspace!.system).not.toContain("SOUL.md");
    await hostCall(host, "POST", `/v1/host/runs/${before.run.id}`, { status: "succeeded", summary: "ok" });

    await call("PUT", `/v1/app/routines/${bot}/files/content?path=SOUL.md`, { content: "Warm, short, no emojis.", why: "her taste" });
    const after = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as unknown as Start;
    expect(after.workspace!.system).toContain("How you talk and behave (SOUL.md): Warm, short, no emojis.");
    await hostCall(host, "POST", `/v1/host/runs/${after.run.id}`, { status: "succeeded", summary: "ok" });
  });

  it("can be emptied but not deleted, and is at most 8 KB", async () => {
    expect((await call("DELETE", `/v1/app/routines/${bot}/files/content?path=SOUL.md`)).json.error).toBe("bad_path");
    expect((await call("PUT", `/v1/app/routines/${bot}/files/content?path=SOUL.md`, { content: "x".repeat(9 * 1024) })).json.error).toBe("too_big");
    expect((await call("PUT", `/v1/app/routines/${bot}/files/content?path=SOUL.md`, { content: "" })).json).toMatchObject({ content: "" });
  });

  it("is only proposed while Amb improves the bot on its own", () => {
    const guard = s.folders.files.guard!;
    const learning = s.folders.learning as unknown as { reviewing: Map<string, string> };
    learning.reviewing.set(bot, "auto");
    try {
      const actor = { uid: lena.user.uid, teams: [], personal: true, canWritePersonal: true, canWriteTeams: true };
      expect(guard(actor, bot, "SOUL.md", { kind: "amb", name: "Ambient" })).toContain("doesn't change its SOUL.md");
      expect(guard(actor, bot, "memory.md", { kind: "amb", name: "Ambient" })).toBeNull();
    } finally {
      learning.reviewing.delete(bot);
    }
  });

  it("comes with every template", () => {
    for (const t of BOT_TEMPLATES) expect(t.soul.trim().length, t.id).toBeGreaterThan(20);
    expect(BOT_TEMPLATES.find((t) => t.id === "review_bot")!.soul).toContain("No nitpicks");
  });
});

describe("Amb's own folder", () => {
  it("lists SOUL.md, AGENTS.md and memory.md, then its skills", async () => {
    expect(((await call("GET", "/v1/app/ambient/files")).json.files as { path: string }[]).map((f) => f.path)).toEqual(["SOUL.md", "AGENTS.md", "memory.md"]);
    await call("PUT", `/v1/app/ambient/files/content?path=${enc("skills/brief/SKILL.md")}`, { content: "Three lines." });
    expect(((await call("GET", "/v1/app/ambient/files")).json.files as { path: string }[]).map((f) => f.path)).toEqual(["SOUL.md", "AGENTS.md", "memory.md", "skills/brief/SKILL.md"]);
    expect((await call("GET", "/v1/app/ambient/files/content?path=SOUL.md")).json).toMatchObject({ path: "SOUL.md", content: "", version: 0 });
  });

  it("keeps a version per change, restores one, and only deletes skills", async () => {
    expect((await call("PUT", "/v1/app/ambient/files/content?path=SOUL.md", { content: "Short.", why: "first" })).json).toMatchObject({ version: 1, by: { kind: "user", name: "Lena Vogel" } });
    await call("PUT", "/v1/app/ambient/files/content?path=SOUL.md", { content: "Short, Poke-style." });
    const versions = (await call("GET", "/v1/app/ambient/files/history?path=SOUL.md")).json.versions as { version: number; why: string | null }[];
    expect(versions.map((v) => [v.version, v.why])).toEqual([
      [2, null],
      [1, "first"],
    ]);
    expect((await call("GET", "/v1/app/ambient/files/content?path=SOUL.md&version=1")).json.content).toBe("Short.");
    expect((await call("POST", "/v1/app/ambient/files/revert", { path: "SOUL.md", version: 1 })).json).toMatchObject({ version: 3, content: "Short.", why: "restored version 1" });
    expect((await call("DELETE", "/v1/app/ambient/files/content?path=SOUL.md")).json.error).toBe("bad_path");
    expect((await call("DELETE", `/v1/app/ambient/files/content?path=${enc("skills/brief/SKILL.md")}`)).status).toBe(204);
    expect(((await call("GET", "/v1/app/ambient/files")).json.files as { path: string }[]).map((f) => f.path)).not.toContain("skills/brief/SKILL.md");
  });

  it("refuses GOAL.md, bad paths and oversize files", async () => {
    expect((await call("PUT", "/v1/app/ambient/files/content?path=GOAL.md", { content: "x" })).json.error).toBe("bad_path");
    expect((await call("PUT", `/v1/app/ambient/files/content?path=${enc("../x")}`, { content: "x" })).json.error).toBe("bad_path");
    expect((await call("PUT", "/v1/app/ambient/files/content?path=AGENTS.md", { content: "x".repeat(20_001) })).json.error).toBe("too_big");
    expect((await call("PUT", "/v1/app/ambient/files/content?path=SOUL.md", { content: "x".repeat(9 * 1024) })).json.error).toBe("too_big");
  });

  it("is the same memory.md the old memory endpoints show, and its learning lists lessons and changes", async () => {
    await call("PUT", "/v1/app/ambient/memory", { content: "- PR #41 (2026-11-18): she reviews on Fridays." });
    expect((await call("GET", "/v1/app/ambient/files/content?path=memory.md")).json.content).toBe("- PR #41 (2026-11-18): she reviews on Fridays.");
    await call("PUT", "/v1/app/ambient/files/content?path=memory.md", { content: "- PR #41 (2026-11-18): she reviews on Fridays.\n- Works from Vienna." });
    expect((await call("GET", "/v1/app/ambient/memory")).json.content).toContain("Works from Vienna.");
    const learning = (await call("GET", "/v1/app/ambient/learning")).json as { lessons: { text: string; source: string }[]; changes: { path: string; version: number }[] };
    expect(learning.lessons[0]).toMatchObject({ source: "PR #41", text: "she reviews on Fridays." });
    expect(learning.changes.map((c) => c.path)).toEqual(expect.arrayContaining(["SOUL.md", "memory.md"]));
  });

  it("is only for the person, and only with bots on", async () => {
    expect((await call("GET", "/v1/app/ambient/files", undefined, ben)).status).toBe(403);
    expect((await call("PUT", "/v1/app/ambient/files/content?path=SOUL.md", { content: "x" }, ben)).status).toBe(403);
  });

  it("is read and changed by Amb over MCP", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await client.callTool({ name: "read_amb_file", arguments: {} }))).toContain("- SOUL.md (");
    expect(text(await client.callTool({ name: "write_amb_file", arguments: { path: "SOUL.md", content: "Short, Poke-style. Du in German.", why: "she asked for du" } }))).toContain("Kept SOUL.md (version 4)");
    expect(text(await client.callTool({ name: "read_amb_file", arguments: { path: "SOUL.md" } }))).toContain("Du in German.");
    expect(text(await client.callTool({ name: "read_amb_file", arguments: { path: "SOUL.md", history: true } }))).toContain("she asked for du");
    expect(text(await client.callTool({ name: "write_amb_file", arguments: { path: "SOUL.md", restore_version: 3, why: "undo" } }))).toContain("Restored SOUL.md to version 3");
  });
});

describe("Amb's instructions", () => {
  it("carry its SOUL.md, the person's additions and its memory, each only when there's text", () => {
    const all = ambientInstructions("Lena", { soul: "Short, Poke-style.", agents: "Always link the PR.", memory: "- Works from Vienna." });
    expect(all).toContain("How you talk (your SOUL.md, Lena's to shape): Short, Poke-style.");
    expect(all).toContain("Lena's additions to how you work (your AGENTS.md; the rules above win if they conflict):\nAlways link the PR.");
    expect(all).toContain("- Works from Vienna.");
    expect(all).toContain("how you talk goes in SOUL.md");
    const bare = ambientInstructions("Lena", "- Works from Vienna.");
    expect(bare).not.toContain("your SOUL.md, Lena's");
    expect(bare).not.toContain("additions to how you work (your AGENTS.md");
    expect(bare).toContain("- Works from Vienna.");
  });
});
