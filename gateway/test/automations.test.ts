// Automations end to end (docs/bots.md, "Automations"): templates and the app's API, the
// scheduler (due times, time zones, restarts, once per due time), events (a meeting note lands; a
// decision waits), NOTHING as silence, delivery and pushes, Amb's "notify" setting as the
// heartbeat's switch, how a bot learns (memory and skills applied, AGENTS.md only proposed and
// applied on yes; "ask" proposes everything), and the MCP tools. Amb runs against a fake Anthropic.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeTrigger, dueAt, sameQuestion, type Automations } from "../src/bots/automations.ts";
import type { PushMessage, PushSender } from "../src/push.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.8.0", claude: "2.1.300 (Claude Code)" };

const pushes: PushMessage[] = [];
const sender: PushSender = async (_device, message) => {
  pushes.push(message);
  return "sent";
};

// Fake Anthropic: answers by which automation is running; the reviewer works through tools.
const toolResults: { name: string; text: string; isError: boolean }[] = [];
const fakeAnthropic: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("https://api.anthropic.com/")) return fetch(input, init);
  const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] };
  const first = body.messages.find((m) => m.role === "user")!;
  const prompt = typeof first.content === "string" ? first.content : JSON.stringify(first.content);
  const steps = body.messages.filter((m) => m.role === "assistant") as { content: { type: string; name?: string }[] }[];
  const last = body.messages.at(-1)!;
  if (Array.isArray(last.content) && (last.content as { type: string }[])[0]?.type === "tool_result") {
    const r = (last.content as { content: string; is_error?: boolean }[])[0]!;
    const call = steps.at(-1)!.content.find((c) => c.type === "tool_use")!;
    toolResults.push({ name: call.name!, text: r.content, isError: Boolean(r.is_error) });
  }
  const say = (t: string) => new Response(JSON.stringify({ content: [{ type: "text", text: t }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
  const use = (name: string, input: unknown) => new Response(JSON.stringify({ content: [{ type: "tool_use", id: `t${steps.length}`, name, input }], stop_reason: "tool_use" }), { status: 200, headers: { "content-type": "application/json" } });
  if (prompt.includes('automation "Morning brief"')) return say("Good morning: two meetings, one decision waits.");
  if (prompt.includes('automation "Quiet one"')) return say("NOTHING");
  if (prompt.includes('automation "After every meeting"')) return say(`Decisions from the meeting: ship on Friday. (${/“([^”]+)”/.exec(prompt)?.[1] ?? "?"})`);
  if (prompt.includes('automation "Decisions that wait"')) return say("A decision has waited a while.");
  if (prompt.includes("improving the bot")) {
    if (prompt.includes("wants to see each improvement first")) {
      const id = /\(id ([a-z0-9]+)\)/.exec(prompt)?.[1] ?? "";
      if (steps.length === 0) return use("write_bot_file", { id, path: "memory.md", content: "- run (2026-11-18): use Node 24.", why: "it failed" });
      if (steps.length === 1) return use("propose_bot_change", { id, path: "memory.md", content: "- run (2026-11-18): use Node 24.", why: "It failed on Node 20." });
      return say("Proposed a lesson for its memory.");
    }
    const id = /\(id ([a-z0-9]+)\)/.exec(prompt)?.[1] ?? "";
    if (steps.length === 0) return use("write_bot_file", { id, path: "memory.md", content: "- The repo needs Node 24.", why: "it failed on Node 20" });
    if (steps.length === 1) return use("write_bot_file", { id, path: "AGENTS.md", content: "Write the post. Use Node 24.", why: "should know" });
    if (steps.length === 2) return use("propose_bot_change", { id, path: "AGENTS.md", content: "Write the weekly post. Use Node 24.", why: "It keeps failing on Node 20." });
    return say("Wrote a lesson into its memory and proposed new instructions.");
  }
  return say("NOTHING");
};

let s: Stack;
let lena: AppSession;
let host: string;
let bot: string;
let auto: Automations;
const call = (method: string, path: string, body?: unknown) => appCall(s, lena.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};
type View = { id: string; name: string; enabled: boolean; template: string | null; when: string; lastRun: { result: string; text: string; by: string } | null; nextRunAt: number | null };
const list = async () => (await call("GET", "/v1/app/automations")).json as { templates: { id: string }[]; automations: View[] };
const runsOf = async (id: string) => ((await call("GET", `/v1/app/automations/${id}/runs`)).json.runs ?? []) as { result: string; text: string; by: string; event: string | null }[];
const chat = async () => (await call("GET", "/v1/app/ambient/chat")).json.messages as { role: string; text: string; decision: { id: string; options: string[]; change: { path?: string } | null } | null }[];
const setNow = (t: number | undefined) => {
  (auto as unknown as { d: { now?: () => number } }).d.now = t === undefined ? undefined : () => t;
};

beforeAll(async () => {
  s = await startStack({ push: sender, ambient: { apiKey: "sk-test", fetchImpl: fakeAnthropic }, learningAfterMs: 20 });
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  auto = s.automations;
  await call("PUT", "/v1/app/push-device", { token: "ab".repeat(32), sandbox: true, platform: "ios", timeZone: "Europe/Vienna" });
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  const setup = await hostCall("", "POST", "/v1/host/setup", { code, info });
  host = String(setup.json.token);
  const computerId = (setup.json.computer as { id: string }).id;
  const made = await call("POST", "/v1/app/routines", { name: "Blog", prompt: "Write the weekly post.", schedule: daily, computer: computerId, bot: { isolation: "container" } });
  bot = (made.json.routine as { id: string }).id;
});
afterAll(() => s.close());

describe("when an automation is due", () => {
  const weekdays = { every: "weekday", time: "08:00", timezone: "Europe/Vienna" } as const;
  // Monday 2026-11-16: 08:00 in Vienna is 07:00 UTC.
  const monday0800 = Date.parse("2026-11-16T07:00:00Z");

  it("is due at its time in its time zone, once", () => {
    const made = monday0800 - 3600_000;
    expect(dueAt(weekdays, monday0800 - 60_000, null, made)).toBeNull();
    expect(dueAt(weekdays, monday0800 + 30_000, null, made)).toBe(monday0800);
    // Handled: not again until the next day.
    expect(dueAt(weekdays, monday0800 + 10 * 60_000, monday0800, made)).toBeNull();
    expect(dueAt({ ...weekdays, timezone: "America/New_York" }, monday0800 + 60_000, null, made)).toBeNull();
  });

  it("runs only the latest of missed times, and none that are too old (a restart)", () => {
    const friday = Date.parse("2026-11-13T07:00:00Z");
    // Down from Friday to Monday 08:30: Monday's run, once; not Friday's.
    expect(dueAt(weekdays, monday0800 + 30 * 60_000, friday, friday - 1)).toBe(monday0800);
    // Down until Monday 11:00: too late for the morning's.
    expect(dueAt(weekdays, monday0800 + 3 * 3600_000, friday, friday - 1)).toBeNull();
  });

  it("says when in words", () => {
    expect(describeTrigger({ kind: "event", events: ["bot_failed", "bot_corrected"] })).toBe("When a bot fails or you correct a bot");
    expect(sameQuestion("Which repo should I use for the post?", "Which repo should I use for this post?")).toBe(true);
    expect(sameQuestion("Which repo?", "Publish it now?")).toBe(false);
  });
});

describe("the app's API", () => {
  it("lists the templates for the person only: watching and improving bots aren't automations", async () => {
    const l = await list();
    expect(l.templates.map((t) => t.id)).toEqual(["morning_brief", "waiting_on_me", "after_meeting", "weekly_review", "new_in_brain", "nightly_idea"]);
    expect(l.automations).toEqual([]);
    const retired = await call("POST", "/v1/app/automations", { template: "improve_bots" });
    expect(retired.json.error).toBe("no_such_template");
    expect(String(retired.json.message)).toContain("every bot learns on its own");
  });

  it("creates from a template or from scratch, changes, and deletes", async () => {
    const brief = (await call("POST", "/v1/app/automations", { template: "morning_brief" })).json.automation as View;
    expect(brief).toMatchObject({ name: "Morning brief", enabled: true, when: "Weekdays at 08:00 (Europe/Vienna)" });
    expect(brief.nextRunAt).toBeGreaterThan(Date.now());
    const bad = await call("POST", "/v1/app/automations", { name: "x" });
    expect(bad.json.error).toBe("bad_request");
    const quiet = (await call("POST", "/v1/app/automations", { name: "Quiet one", trigger: { kind: "time", schedule: daily }, instructions: "Say nothing.", delivery: "chat" })).json.automation as View;
    const off = (await call("PATCH", `/v1/app/automations/${quiet.id}`, { enabled: false })).json.automation as View;
    expect(off.enabled).toBe(false);
    expect((await call("DELETE", `/v1/app/automations/${quiet.id}`)).status).toBe(204);
    expect((await list()).automations.map((a) => a.name)).toEqual(["Morning brief"]);
  });
});

describe("the scheduler", () => {
  it("runs a due automation once, delivers it with a push, and logs it", async () => {
    const brief = (await list()).automations.find((a) => a.name === "Morning brief")!;
    // A weekday 10:00 in Vienna, after it was made: due once.
    const next = brief.nextRunAt!;
    setNow(next + 60_000);
    pushes.length = 0;
    await auto.tickFor(lena.user.uid);
    await auto.tickFor(lena.user.uid);
    const runs = await waitFor(async () => {
      const r = await runsOf(brief.id);
      return r.length ? r : undefined;
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ by: "schedule", result: "sent", text: "Good morning: two meetings, one decision waits." });
    expect((await chat()).at(-1)?.text).toBe("Good morning: two meetings, one decision waits.");
    expect(pushes.find((p) => p.title === "Morning brief")).toMatchObject({ collapseId: `automation-${brief.id}` });
    setNow(undefined);
  });

  it("stays silent on NOTHING", async () => {
    const quiet = (await call("POST", "/v1/app/automations", { name: "Quiet one", trigger: { kind: "time", schedule: daily }, instructions: "Say nothing.", delivery: "chat" })).json.automation as View;
    const before = (await chat()).length;
    const run = await auto.runNow(lena.user.uid, quiet.id);
    expect(run).toMatchObject({ by: "manual", result: "silent", text: "" });
    expect((await chat()).length).toBe(before);
    await call("DELETE", `/v1/app/automations/${quiet.id}`);
  });
});

describe("Amb's settings", () => {
  it("say whether Amb tells them about their bots (the heartbeat)", async () => {
    expect((await call("GET", "/v1/app/ambient/settings")).json).toEqual({ notify: "important", reach: "app" });
    expect((await call("PUT", "/v1/app/ambient/settings", { notify: "never" })).json).toEqual({ notify: "never", reach: "app" });
    expect(await s.heartbeat.beat(lena.user.uid, { force: true })).toBe("skipped");
    await call("PUT", "/v1/app/ambient/settings", { notify: "important" });
    expect(await s.heartbeat.beat(lena.user.uid, { force: true })).not.toBe("skipped");
    expect((await call("PUT", "/v1/app/ambient/settings", { notify: "sometimes" })).status).toBe(400);
  });
});

describe("events", () => {
  it("a meeting note in the brain runs After every meeting, once", async () => {
    const after = (await call("POST", "/v1/app/automations", { template: "after_meeting" })).json.automation as View;
    const content = "---\ntitle: Launch sync\nkind: meeting\n---\nWe ship Friday.\n";
    const op = { op: "upsert", path: "wiki/notes/2026/11/launch-sync.md", hash: createHash("sha256").update(content).digest("hex"), content, updated: "2026-11-17" };
    await call("POST", "/v1/app/personal/sync", { device_id: "phone", ops: [op] });
    await call("POST", "/v1/app/personal/sync", { device_id: "phone", ops: [op] });
    const runs = await waitFor(async () => {
      const r = await runsOf(after.id);
      return r.length ? r : undefined;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await runsOf(after.id)).toHaveLength(1);
    expect(runs[0]).toMatchObject({ by: "event", event: "meeting note", result: "sent", text: "Decisions from the meeting: ship on Friday. (Launch sync)" });
  });

  it("a decision waiting too long runs one listening for it", async () => {
    const waits = (await call("POST", "/v1/app/automations", { name: "Decisions that wait", trigger: { kind: "event", events: ["decision_waiting"], hours: 2 }, instructions: "Remind them." })).json.automation as View;
    await s.decisions.propose(lena.user.uid, { routineId: bot, bot: "Blog", settings: { enabled: false }, why: "It's noisy." }, { push: false });
    setNow(Date.now() + 3 * 3600_000);
    await auto.tickFor(lena.user.uid);
    await auto.tickFor(lena.user.uid);
    setNow(undefined);
    const runs = await waitFor(async () => {
      const r = await runsOf(waits.id);
      return r.length ? r : undefined;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await runsOf(waits.id)).toHaveLength(1);
    expect(runs[0]).toMatchObject({ result: "sent", event: "a decision waits" });
    for (const d of (await call("GET", "/v1/app/decisions")).json.decisions as { id: string }[]) await call("POST", `/v1/app/decisions/${d.id}`, { option: "Not now" });
    await call("DELETE", `/v1/app/automations/${waits.id}`);
  });
});

describe("how a bot learns", () => {
  const learning = () => s.folders.learning!;
  const learnOf = async () => (await call("GET", `/v1/app/routines/${bot}/learning`)).json as { learn: string; signals: { kind: string; text: string }[]; lessons: { text: string; source: string | null }[]; changes: { path: string; by: { kind: string } }[] };

  it("improves a failed bot's memory on its own, and only proposes its instructions", async () => {
    toolResults.length = 0;
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "failed", summary: "npm ci failed: Node 20 is too old." });
    await waitFor(async () => (await learnOf()).signals.some((x) => x.kind === "run_failed") || undefined);
    await waitFor(async () => toolResults.length >= 3 || undefined);
    await learning().idle();
    expect(toolResults.map((t) => [t.name, t.isError])).toEqual([
      ["write_bot_file", false],
      ["write_bot_file", true],
      ["propose_bot_change", false],
    ]);
    expect(toolResults[1]!.text).toContain("propose_bot_change");
    const memory = (await call("GET", `/v1/app/routines/${bot}/files/content?path=memory.md`)).json;
    expect(memory).toMatchObject({ content: "- The repo needs Node 24.", by: { kind: "amb" } });
    expect((await call("GET", `/v1/app/routines/${bot}/files/content?path=AGENTS.md`)).json.content).toBe("Write the weekly post.");
    const l = await learnOf();
    expect(l.learn).toBe("auto");
    expect(l.lessons).toEqual([{ text: "The repo needs Node 24.", source: null, date: null }]);
    expect(l.changes[0]).toMatchObject({ path: "memory.md", by: { kind: "amb" } });
  });

  it("applies the proposed instructions when they say yes", async () => {
    const decision = (await chat()).reverse().find((m) => m.decision?.change?.path === "AGENTS.md")!.decision!;
    expect(decision.options).toEqual(["Apply", "Not now"]);
    const answered = await call("POST", `/v1/app/decisions/${decision.id}`, { option: "Apply" });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    expect((answered.json.decision as { answer: { text: string } }).answer.text).toContain("AGENTS.md changed");
    expect((await call("GET", `/v1/app/routines/${bot}/files/content?path=AGENTS.md`)).json.content).toBe("Write the weekly post. Use Node 24.");
    const r = ((await call("GET", "/v1/app/routines")).json.routines as { id: string; prompt: string }[]).find((x) => x.id === bot)!;
    expect(r.prompt).toBe("Write the weekly post. Use Node 24.");
  });

  it("counts corrections and the same question twice", async () => {
    await call("POST", `/v1/app/routines/${bot}/thread`, { text: "No, the post goes out on Fridays." });
    await waitFor(async () => (await learnOf()).signals.some((x) => x.kind === "corrected") || undefined);
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; runToken: string };
    await hostCall(start.runToken, "POST", "/v1/bot/ask", { question: "Which repo should I use for the post?" });
    await hostCall(start.runToken, "POST", "/v1/bot/ask", { question: "Which repo should I use for this post?" });
    await waitFor(async () => (await learnOf()).signals.some((x) => x.kind === "asked_twice") || undefined);
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "ok" });
    await learning().idle();
  });

  it("with learn: ask, proposes even a lesson instead of writing it", async () => {
    expect((await call("PUT", `/v1/app/routines/${bot}/learning`, { learn: "ask" })).json.learn).toBe("ask");
    toolResults.length = 0;
    const before = (await call("GET", `/v1/app/routines/${bot}/files/content?path=memory.md`)).json.version as number;
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "failed", summary: "Node 20 again." });
    await waitFor(async () => toolResults.length >= 2 || undefined);
    await learning().idle();
    expect(toolResults.map((t) => [t.name, t.isError])).toEqual([
      ["write_bot_file", true],
      ["propose_bot_change", false],
    ]);
    expect((await call("GET", `/v1/app/routines/${bot}/files/content?path=memory.md`)).json.version).toBe(before);
    expect((await chat()).reverse().find((m) => m.decision?.change?.path === "memory.md")).toBeTruthy();
    await call("PUT", `/v1/app/routines/${bot}/learning`, { learn: "auto" });
    for (const d of (await call("GET", "/v1/app/decisions")).json.decisions as { id: string }[]) await call("POST", `/v1/app/decisions/${d.id}`, { option: "Not now" });
  });
});

describe("over MCP", () => {
  it("lists, creates, changes, runs and deletes automations", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_automations", "create_automation", "update_automation", "delete_automation", "run_automation", "propose_bot_change", "bot_templates", "create_bot_from_template", "bot_learning", "ambient_settings"]));
    expect(text(await client.callTool({ name: "list_automations", arguments: {} }))).toContain("Templates:\n- morning_brief: Morning brief.");
    const made = await client.callTool({ name: "create_automation", arguments: { template: "weekly_review", delivery: "chat_silent" } });
    const id = (made.structuredContent as { automation: { id: string } }).automation.id;
    expect(text(made)).toContain("Weekly review");
    expect(text(await client.callTool({ name: "update_automation", arguments: { id, enabled: false } }))).toContain(": off,");
    const brief = (await list()).automations.find((a) => a.name === "Morning brief")!;
    expect(text(await client.callTool({ name: "run_automation", arguments: { id: brief.id } }))).toBe("Ran and sent: Good morning: two meetings, one decision waits.");
    expect(text(await client.callTool({ name: "delete_automation", arguments: { id } }))).toBe("Deleted.");
    const both = await client.callTool({ name: "propose_bot_change", arguments: { id: bot, why: "x" } });
    expect(both.isError).toBe(true);
  });
});
