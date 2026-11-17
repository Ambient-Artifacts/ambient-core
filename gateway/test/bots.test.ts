// Bots end to end (docs/bots.md): the gate, a bot's settings and state, its thread, a run that asks
// its owner and gets the answer (live, or in the next run that resumes the session), Ambient's chat
// against a fake Anthropic, the MCP tools, and the real runner script with a stand-in claude.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botQuestionPush } from "../src/channels/channel.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.6.0", claude: "2.1.300 (Claude Code)" };

type Bot = { state: string; face: string; isolation: string; secrets: string[] | null; report: string; openQuestion: { id: string; text: string; choices: string[] | null } | null; lastMessage: { text: string } | null };
type R = { id: string; name: string; enabled: boolean; runRequested: boolean; bot: Bot | null };
type Msg = { role: string; kind: string; text: string; choices: string[] | null; author: string | null; answered: boolean | null };

// Fake Anthropic: the first turn calls list_routines, the next answers with what it saw.
const anthropicCalls: { tools: string[]; system: string; messages: unknown[] }[] = [];
const fakeAnthropic: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("https://api.anthropic.com/")) return fetch(input, init);
  const body = JSON.parse(String(init?.body)) as { tools: { name: string }[]; system: string; messages: { role: string; content: unknown }[] };
  anthropicCalls.push({ tools: body.tools.map((t) => t.name), system: body.system, messages: body.messages });
  const last = body.messages[body.messages.length - 1]!;
  const toolResult = Array.isArray(last.content) && (last.content as { type: string }[])[0]?.type === "tool_result";
  const reply = toolResult
    ? { content: [{ type: "text", text: `Your bots: ${JSON.stringify((last.content as { content: string }[])[0]!.content).includes("Release notes") ? "Release notes is there." : "none found."}` }], stop_reason: "end_turn" }
    : { content: [{ type: "tool_use", id: "t1", name: "list_routines", input: {} }], stop_reason: "tool_use" };
  return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
};

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let host: string;
let computerId: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const routine = async (id: string) => (await appCall(s, lena.access_token, "GET", "/v1/app/routines")).json.routines as R[];
const one = async (id: string) => (await routine(id)).find((r) => r.id === id)!;
const thread = async (id: string) => (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/thread`)).json as { messages: Msg[]; openQuestion: Msg | null };

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] }, ambient: { apiKey: "sk-test", fetchImpl: fakeAnthropic } });
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  ben = await signIn(s, "apple-ben", "Ben Weiss");
  s.config.bots!.users.push(lena.user.uid);
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "Build server" })).json.code);
  const setup = await hostCall("", "POST", "/v1/host/setup", { code, info });
  host = String(setup.json.token);
  computerId = (setup.json.computer as { id: string }).id;
  await appCall(s, lena.access_token, "PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "ghp_bot" });
  await appCall(s, lena.access_token, "PUT", "/v1/app/routines/secrets/STRIPE_KEY", { value: "sk_live_x" });
});
afterAll(() => s.close());

describe("the gate", () => {
  it("shows bots only to accounts and teams in BRAIN_BOTS", async () => {
    expect((await appCall(s, lena.access_token, "GET", "/v1/app/features")).json).toEqual({ bots: true });
    expect((await appCall(s, ben.access_token, "GET", "/v1/app/features")).json).toEqual({ bots: false });
    const refused = await appCall(s, ben.access_token, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: daily, bot: {} });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe("bots_not_enabled");
    expect((await appCall(s, ben.access_token, "GET", "/v1/app/ambient/chat")).status).toBe(403);
  });

  it("leaves plain loops as they are", async () => {
    const plain = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Plain", prompt: "y", schedule: daily });
    expect((plain.json.routine as R).bot).toBeNull();
    const start = await hostCall(host, "POST", `/v1/host/routines/${(plain.json.routine as R).id}/runs`);
    expect(start.json).toMatchObject({ bot: null, resume: null, runToken: null });
    expect(Object.keys(start.json.env as object).sort()).toEqual(["GH_TOKEN", "STRIPE_KEY"]);
    await appCall(s, lena.access_token, "DELETE", `/v1/app/routines/${(plain.json.routine as R).id}`);
  });
});

describe("the gate by team", () => {
  it("gives a team's people bots of their own too", async () => {
    const owner = await signIn(s, "apple-tina", "Tina Roth");
    const made = await appCall(s, owner.access_token, "POST", "/v1/app/teams", { name: "Bots Lab" });
    const slug = (made.json.team as { slug: string }).slug;
    expect((await appCall(s, owner.access_token, "GET", "/v1/app/features")).json).toEqual({ bots: false });
    s.config.bots!.teams.push(slug);
    expect((await appCall(s, owner.access_token, "GET", "/v1/app/features")).json).toEqual({ bots: true });
    const own = await appCall(s, owner.access_token, "POST", "/v1/app/routines", { name: "Mine", prompt: "y", schedule: daily, bot: {} });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    expect((own.json.routine as R).bot).not.toBeNull();
  });
});

describe("a bot", () => {
  let id: string;
  let runToken: string;
  let runId: string;
  let questionId: string;

  it("is a loop with a face, defaults and a state", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Release notes", prompt: "Write the release notes.", schedule: daily, bot: { face: "round", secrets: ["GH_TOKEN"] } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const r = made.json.routine as R;
    id = r.id;
    expect(r.bot).toMatchObject({ face: "round", isolation: "container", secrets: ["GH_TOKEN"], report: "news", state: "asleep", openQuestion: null, lastMessage: null });
    expect((await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: daily, bot: { runtime: "codex" } })).status).toBe(400);
  });

  it("gets only its granted secrets and a run token", async () => {
    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    expect(start.json.env).toEqual({ GH_TOKEN: "ghp_bot" });
    expect(start.json.bot).toMatchObject({ face: "round", runtime: "claude-code", isolation: "container" });
    expect(start.json.resume).toBeNull();
    runToken = String(start.json.runToken);
    expect(runToken).toMatch(/^ambient_run_/);
    runId = (start.json.run as { id: string }).id;
    expect((await one(id)).bot?.state).toBe("working");
  });

  it("asks its owner while it runs and takes the answer itself", async () => {
    const asked = await hostCall(runToken, "POST", "/v1/bot/ask", { question: "Which repo?", choices: ["ambient-core", "ambient-ios"] });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    questionId = String(asked.json.id);
    const r = await one(id);
    // Still running: working wins over needs_you, but the question shows.
    expect(r.bot?.openQuestion).toMatchObject({ text: "Which repo?", choices: ["ambient-core", "ambient-ios"] });
    expect((await hostCall(runToken, "GET", `/v1/bot/questions/${questionId}`)).json).toEqual({ answer: null, author: null });

    const answered = await appCall(s, lena.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "ambient-core" });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    expect(answered.json.message).toMatchObject({ role: "user", kind: "answer", text: "ambient-core", author: "Lena Vogel" });
    expect((await hostCall(runToken, "GET", `/v1/bot/questions/${questionId}`)).json).toEqual({ answer: "ambient-core", author: "Lena Vogel" });
    // The live run took it: no second run waits for it.
    expect((await one(id)).runRequested).toBe(false);
  });

  it("reports into its thread, sealed in Convex", async () => {
    await hostCall(host, "POST", `/v1/host/runs/${runId}`, { status: "succeeded", summary: "Opened PR #41 with the release notes.", sessionId: "sess-1" });
    const t = await thread(id);
    expect(t.messages.map((m) => [m.kind, m.text])).toEqual([
      ["question", "Which repo?"],
      ["answer", "ambient-core"],
      ["result", "Opened PR #41 with the release notes."],
    ]);
    expect(t.messages[0]!.answered).toBe(true);
    expect(t.openQuestion).toBeNull();
    const r = await one(id);
    expect(r.bot).toMatchObject({ state: "done", lastMessage: { text: "Opened PR #41 with the release notes." } });
    const raw = JSON.stringify(await s.t.run(async (ctx) => ctx.db.query("botMessages").collect()));
    expect(raw).not.toContain("ambient-core");
    expect(raw).not.toContain("PR #41");
    // The run is over: its token asks nothing anymore.
    expect((await hostCall(runToken, "POST", "/v1/bot/ask", { question: "Still there?" })).status).toBe(409);
  });

  it("starts a run that resumes its session when someone writes to it", async () => {
    const sent = await appCall(s, lena.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "Also link the changelog." });
    expect(sent.json.message).toMatchObject({ kind: "message" });
    expect((sent.json.routine as R).runRequested).toBe(true);
    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    expect(start.json.resume).toEqual({ sessionId: "sess-1", message: "Lena Vogel wrote to you in the Ambient app: Also link the changelog." });
    expect((start.json.run as { trigger: string }).trigger).toBe("manual");
    // The same result again isn't news.
    await hostCall(host, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Opened PR #41 with the release notes.", sessionId: "sess-1" });
    expect((await thread(id)).messages.filter((m) => m.kind === "result")).toHaveLength(1);
  });

  it("is stuck after a failure, and starts afresh when the session is gone", async () => {
    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    await hostCall(host, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "failed", summary: "No conversation found with session ID sess-1." });
    expect((await one(id)).bot?.state).toBe("stuck");
    expect((await thread(id)).messages.at(-1)).toMatchObject({ kind: "failure" });
    await appCall(s, lena.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "Try again." });
    const again = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    expect((again.json.resume as { sessionId: string | null }).sessionId).toBeNull();
    await hostCall(host, "POST", `/v1/host/runs/${(again.json.run as { id: string }).id}`, { status: "succeeded", summary: "Done this time.", sessionId: "sess-2" });
  });

  it("can't be written to by someone who can't change it", async () => {
    expect((await appCall(s, ben.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "hi" })).status).toBe(404);
    expect((await appCall(s, ben.access_token, "GET", `/v1/app/routines/${id}/thread`)).status).toBe(404);
  });

  it("changes settings and becomes a plain loop again", async () => {
    const changed = (await appCall(s, lena.access_token, "PATCH", `/v1/app/routines/${id}`, { bot: { report: "every_run", secrets: null } })).json.routine as R;
    expect(changed.bot).toMatchObject({ face: "round", report: "every_run", secrets: null });
    const plain = (await appCall(s, lena.access_token, "PATCH", `/v1/app/routines/${id}`, { bot: null })).json.routine as R;
    expect(plain.bot).toBeNull();
    expect((await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/thread`)).status).toBe(404);
  });

  it("asks with a push that opens its thread", () => {
    expect(botQuestionPush({ botId: "abc", name: "Dev", team: null, question: "Merge #41?" })).toEqual({
      title: "Dev needs you",
      body: "Merge #41?",
      url: "ambient://routine/abc?thread=1",
      thread: "routines",
      collapseId: "bot-question-abc",
    });
  });
});

describe("Ambient's chat", () => {
  it("answers with Claude over the person's own tools, and keeps the history sealed", async () => {
    await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Release notes", prompt: "Write the release notes.", schedule: daily, bot: {} });
    const sent = await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "How are my bots?" });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json).toMatchObject({ message: { role: "user", text: "How are my bots?" }, pending: true });
    let chat = { messages: [] as { role: string; text: string }[], pending: true };
    for (let i = 0; i < 50 && chat.pending; i++) {
      await new Promise((r) => setTimeout(r, 100));
      chat = (await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json as typeof chat;
    }
    expect(chat.pending).toBe(false);
    expect(chat.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "How are my bots?"],
      ["ambient", "Your bots: Release notes is there."],
    ]);
    const tools = anthropicCalls[0]!.tools;
    expect(tools).toEqual(expect.arrayContaining(["search", "list_routines", "message_bot", "bot_thread"]));
    expect(tools).not.toContain("set_routine_secret");
    expect(anthropicCalls[0]!.system).toContain("You are Ambient, the master bot");
    expect(JSON.stringify(await s.t.run(async (ctx) => ctx.db.query("ambientChat").collect()))).not.toContain("How are my bots");
    expect((await appCall(s, lena.access_token, "DELETE", "/v1/app/ambient/chat")).status).toBe(204);
    expect(((await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json as typeof chat).messages).toEqual([]);
  });
});

describe("bots over MCP", () => {
  it("are created paused, changed with a pause when grants change, and written to", async () => {
    const pat = String((await appCall(s, lena.access_token, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["bot_thread", "message_bot"]));
    const made = await client.callTool({ name: "create_routine", arguments: { name: "Dev", prompt: "Fix the flaky test.", schedule: daily, computer: computerId, bot: { face: "tall" } } });
    expect(made.isError, text(made)).toBeFalsy();
    const r = (made.structuredContent as { routine: R }).routine;
    expect(r).toMatchObject({ enabled: false, bot: { face: "tall", isolation: "container" } });
    expect(text(made)).toContain("Bot: asleep");
    await appCall(s, lena.access_token, "PATCH", `/v1/app/routines/${r.id}`, { enabled: true });
    const face = await client.callTool({ name: "update_routine", arguments: { id: r.id, bot: { face: "wide" } } });
    expect(((face.structuredContent as { routine: R }).routine).enabled).toBe(true);
    const grant = await client.callTool({ name: "update_routine", arguments: { id: r.id, bot: { secrets: ["STRIPE_KEY"] } } });
    expect(((grant.structuredContent as { routine: R }).routine).enabled).toBe(false);
    const sent = await client.callTool({ name: "message_bot", arguments: { id: r.id, text: "Start with the parser tests." } });
    expect(text(sent)).toContain('"Dev" starts a run with it');
    expect(text(await client.callTool({ name: "bot_thread", arguments: { id: r.id } }))).toContain("wrote: Start with the parser tests.");
    await client.close();

    const benPat = String((await appCall(s, ben.access_token, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const benClient = await mcpClient(`${s.origin}/mcp`, benPat);
    expect((await benClient.listTools()).tools.map((t) => t.name)).not.toContain("bot_thread");
    await benClient.close();
  });
});

describe("the runner with a bot", () => {
  let dir: string;
  let env: Record<string, string>;

  const runner = (args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [RUNNER, ...args], { env: { ...env, ...extra } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ambient-bot-runner-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "work"));
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
cat > prompt.txt
echo "$@" > args.txt
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at the parser."}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Fixed the parser test and pushed fix/parser.","total_cost_usd":0.3,"num_turns":4,"session_id":"sess-9"}'
`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    env = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AMBIENT_SYSTEM_PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      USER: "root",
      AMBIENT_SERVER: s.origin,
      AMBIENT_HOST_TOKEN: host,
      AMBIENT_CLAUDE: join(bin, "claude"),
      AMBIENT_STATE_DIR: join(dir, "state"),
      AMBIENT_FOLDER: join(dir, "work"),
    };
  });

  it("runs a bot on the computer itself with ask_owner and resumes its session", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Parser bot", prompt: "Fix the parser test.", schedule: daily, folder: join(dir, "work"), bot: { isolation: "host" } });
    const id = (made.json.routine as R).id;
    const first = await runner(["run", id]);
    expect(first.code, first.out).toBe(0);
    const args = readFileSync(join(dir, "work", "args.txt"), "utf8");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--allowedTools mcp__ambient-bot__ask_owner");
    expect(args).toContain('one of your owner\'s bots in Ambient');
    expect(args).not.toContain("--resume");
    expect(readFileSync(join(dir, "work", "prompt.txt"), "utf8")).toBe("Fix the parser test.");
    expect((await thread(id)).messages.at(-1)).toMatchObject({ kind: "result", text: "Fixed the parser test and pushed fix/parser." });

    await appCall(s, lena.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "Open a PR for it." });
    const second = await runner(["run", id]);
    expect(second.code, second.out).toBe(0);
    expect(readFileSync(join(dir, "work", "args.txt"), "utf8")).toContain("--resume sess-9");
    expect(readFileSync(join(dir, "work", "prompt.txt"), "utf8")).toBe("Lena Vogel wrote to you in the Ambient app: Open a PR for it.");
  });

  it("fails a container bot clearly where there's no Podman", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Boxed", prompt: "x", schedule: daily, bot: {} });
    const id = (made.json.routine as R).id;
    const out = await runner(["run", id]);
    expect(out.code).toBe(1);
    expect((await thread(id)).messages.at(-1)?.text).toContain("Podman isn't installed");
  });

  it("serves ask_owner over MCP stdio and returns the owner's answer", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Asker", prompt: "x", schedule: daily, bot: { isolation: "host" } });
    const id = (made.json.routine as R).id;
    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    const p = spawn(process.execPath, [RUNNER, "bot-mcp"], { env: { PATH: process.env.PATH ?? "", AMBIENT_SERVER: s.origin, AMBIENT_RUN_TOKEN: String(start.json.runToken), AMBIENT_ASK_WAIT_S: "20" } });
    const replies = new Map<number, unknown>();
    createInterface({ input: p.stdout }).on("line", (l) => {
      const m = JSON.parse(l) as { id: number; result?: unknown };
      replies.set(m.id, m.result);
    });
    const send = (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`);
    const reply = async (rid: number) => {
      for (let i = 0; i < 300 && !replies.has(rid); i++) await new Promise((r) => setTimeout(r, 50));
      return replies.get(rid) as Record<string, unknown>;
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(await reply(1)).toMatchObject({ serverInfo: { name: "ambient-bot" }, capabilities: { tools: {} } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(((await reply(2)).tools as { name: string }[]).map((t) => t.name)).toEqual(["ask_owner"]);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_owner", arguments: { question: "Ship it?", choices: ["Yes", "Not yet"] } } });
    for (let i = 0; i < 100 && !(await one(id)).bot?.openQuestion; i++) await new Promise((r) => setTimeout(r, 50));
    await appCall(s, lena.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "Yes" });
    const out = await reply(3);
    expect((out.content as { text: string }[])[0]!.text).toBe("Lena Vogel answered: Yes");
    p.kill();
  }, 30_000);
});
