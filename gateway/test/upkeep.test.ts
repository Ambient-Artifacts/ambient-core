// Upkeep on your computer (docs/architecture.md): the brain's model calls go to Claude Code on the
// person's own computer, never a key of Ambient's. Without a connected computer the notes wait,
// once recorded and visible in the app; once it connects they're caught up. Then the real runner
// answering one upkeep request with a stand-in claude.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicUpdater, toWire, type OverviewWriter, type PageUpdateInput, type PageUpdater } from "@brain/team";
import { ComputerUnavailable } from "../src/bots/computer.ts";
import { computerLlm, GatewayUpkeep, upkeepState, type UpkeepComputer } from "../src/upkeep.ts";
import { runPersonalWorker, type Writers } from "../src/worker/personal.ts";
import { appCall, fixturePersonalOps, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const info = { hostname: "vps", os: "Linux 6.8", runner: "0.9.4", claude: "2.1.326 (Claude Code)" };

let s: Stack;
let lena: AppSession;
let host: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const upkeep = async () => (await appCall(s, lena.access_token, "GET", "/v1/app/me/upkeep")).json;

class FakeUpdater implements PageUpdater {
  model = "claude-haiku-4-5";
  seen: string[] = [];
  async update(input: PageUpdateInput) {
    this.seen.push(input.ref);
    return {
      update: { title: input.existing?.title ?? input.ref, summary: `About ${input.ref}`, aliases: [], currentTruth: [`True of ${input.ref}.`], openQuestions: [], timeline: [] },
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 },
    };
  }
}
const overview: OverviewWriter = {
  model: "claude-haiku-4-5",
  async write() {
    return { overview: { headline: "Pricing.", now: [], activeProjects: [], keyPeople: [], openLoops: [], recentDecisions: [] }, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 } };
  },
};

beforeAll(async () => {
  s = await startStack({ ambient: { apiKey: undefined } });
  lena = await signIn(s, "apple-lena-upkeep", "Lena Vogel");
});
afterAll(() => s.close());

describe("the app's view of upkeep", () => {
  it("is off until the person turns it on, then waits for a computer", async () => {
    expect(await upkeep()).toEqual({ state: "off", pending: 0, lastRunAt: null, computer: null, message: null });
    await appCall(s, lena.access_token, "POST", "/v1/app/me/prefs", { consolidate: true });
    expect((await upkeep()).state).toBe("no_computer");
  });

  it("follows the run's state", () => {
    const c: UpkeepComputer = { id: "h", name: "VPS", connected: true };
    expect(upkeepState({ on: true, work: null, seq: 3, computer: c }).state).toBe("pending");
    expect(upkeepState({ on: true, work: { lastSeq: 3, lastRunAt: 5, lastStatus: "ok" }, seq: 3, computer: c })).toEqual({ state: "current", pending: 0, lastRunAt: 5, computer: "VPS", message: null });
    expect(upkeepState({ on: true, work: { lastSeq: 3, lastRunAt: 5, lastStatus: "failed", lastResult: JSON.stringify({ error: "boom" }) }, seq: 3, computer: c }).message).toBe("Updating your pages failed: boom");
    const waited = { lastSeq: 0, lastRunAt: 9, lastStatus: "waiting", lastResult: JSON.stringify({ waiting: "offline", computer: "VPS", pending: 4, seq: 3, lastOkAt: 2 }) };
    expect(upkeepState({ on: true, work: waited, seq: 3, computer: { ...c, connected: false } })).toEqual({ state: "offline", pending: 4, lastRunAt: 2, computer: "VPS", message: null });
    expect(upkeepState({ on: true, work: waited, seq: 3, computer: c }).state).toBe("pending");
  });
});

describe("the worker", () => {
  let gw: GatewayUpkeep;
  const writers = new Map<string, Writers>();
  const run = (computerFor: (uid: string) => Promise<UpkeepComputer | null>) =>
    runPersonalWorker(
      {
        control: s.control,
        personal: s.personal,
        version: "test",
        quietMs: 0,
        computers: {
          computerFor,
          writers: (uid) => {
            const w = { updater: new FakeUpdater(), overview };
            writers.set(uid, w);
            return w;
          },
        },
      },
      Date.now() + 1000,
    );

  beforeAll(async () => {
    gw = new GatewayUpkeep(s.origin, s.config.serviceSecret);
    await appCall(s, lena.access_token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps(), since_seq: 0 });
  });

  it("only lets the service secret through to the computers", async () => {
    expect((await fetch(`${s.origin}/v1/internal/upkeep/computer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: lena.user.uid }) })).status).toBe(401);
    expect(await gw.computerFor(lena.user.uid)).toBeNull();
    await expect(gw.complete(lena.user.uid, toWire({ model: "haiku", maxTokens: 10, system: "s", user: "u", schema: z.object({ a: z.string() }), what: "test" }))).rejects.toBeInstanceOf(ComputerUnavailable);
  });

  it("records the wait once, with how many notes wait, and catches up when the computer connects", async () => {
    const first = await run((uid) => gw.computerFor(uid));
    expect(first).toEqual([expect.objectContaining({ uid: lena.user.uid, status: "waiting", notes: 3 })]);
    const work = await s.control.q(s.api.work.get, { uid: lena.user.uid as never });
    expect(work?.lastStatus).toBe("waiting");
    expect(JSON.parse(String(work?.lastResult))).toMatchObject({ waiting: "no_computer", computer: null, pending: 3 });
    expect(await upkeep()).toMatchObject({ state: "no_computer", pending: 3 });
    // The same wait isn't written again.
    await run((uid) => gw.computerFor(uid));
    expect((await s.control.q(s.api.work.get, { uid: lena.user.uid as never }))?.lastRunAt).toBe(work?.lastRunAt);

    // The computer comes: its writers do the work, and the pages are current.
    const done = await run(async () => ({ id: "h1", name: "VPS", connected: true }));
    expect(done).toEqual([expect.objectContaining({ status: "ok", notes: 3 })]);
    expect((writers.get(lena.user.uid)!.updater as FakeUpdater).seen).toContain("people/anna-mueller");
    expect(await run(async () => ({ id: "h1", name: "VPS", connected: true }))).toEqual([]);
  });
});

describe("the runner's upkeep job", () => {
  let p: ChildProcess | undefined;
  afterAll(() => p?.kill());

  it("answers on the computer's Claude, with no tools, MCP or settings, in a config of its own", async () => {
    const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "VPS" })).json.code);
    host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
    // A personal computer keeps its connection for upkeep, bots or not.
    expect((await hostCall(host, "POST", "/v1/host/sync", { info })).json.ambient).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "ambient-upkeep-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // claude: one structured answer; it notes its flags, its stdin and its config folder.
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/upkeep-args.txt"
cat > "$HOME/upkeep-stdin.txt"
echo "\${CLAUDE_CONFIG_DIR:-none}" > "$HOME/upkeep-config.txt"
pwd > "$HOME/upkeep-cwd.txt"
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"structured_output":{"title":"Anna Müller","summary":"Leads pricing.","aliases":[],"currentTruth":["Leads pricing."],"openQuestions":[],"timeline":[]},"usage":{"input_tokens":2,"cache_creation_input_tokens":900,"cache_read_input_tokens":0,"output_tokens":100}}'
`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    const claudeEnv = join(dir, "claude.env");
    writeFileSync(claudeEnv, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test\n");
    p = spawn(process.execPath, [RUNNER, "ambient"], {
      env: {
        AMBIENT_CLAUDE_ENV: claudeEnv,
        AMBIENT_CONFIG_DIR: "/nonexistent/ambient-runner",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        AMBIENT_SYSTEM_PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        AMBIENT_SERVER: s.origin,
        AMBIENT_HOST_TOKEN: host,
        AMBIENT_CLAUDE: join(bin, "claude"),
        AMBIENT_STATE_DIR: join(dir, "state"),
        AMBIENT_AMBIENT_HOME: dir,
      },
    });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (out += d));
    const gw = new GatewayUpkeep(s.origin, s.config.serviceSecret);
    for (let i = 0; i < 50 && !(await gw.computerFor(lena.user.uid))?.connected; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await gw.computerFor(lena.user.uid), out).toEqual({ id: expect.any(String), name: "VPS", connected: true });

    // A page update written on the computer, checked against its shape at the gateway's end.
    const updater = new AnthropicUpdater(computerLlm(gw, lena.user.uid), "claude-haiku-4-5", "personal");
    const res = await updater.update({ ref: "topics/pricing", type: "topic", existing: null, evidence: [{ note: "n1", date: "2026-11-19", title: "Pricing", summary: "Anna leads pricing.", body: "Anna Müller leads pricing." }] } as never);
    expect(res.update).toMatchObject({ title: "Anna Müller", currentTruth: ["Leads pricing."] });
    expect(res.usage).toEqual({ input_tokens: 902, output_tokens: 100, cache_read_tokens: 0 });

    const args = readFileSync(join(dir, "upkeep-args.txt"), "utf8").split("\n");
    for (const [flag, value] of [["--model", "claude-haiku-4-5"], ["--tools", ""], ["--setting-sources", ""], ["--output-format", "json"]] as const) expect(args[args.indexOf(flag) + 1], flag).toBe(value);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!).properties).toHaveProperty("currentTruth");
    expect(args[args.indexOf("--system-prompt") + 1]).toContain("private wiki");
    expect(readFileSync(join(dir, "upkeep-stdin.txt"), "utf8")).toContain("Anna Müller leads pricing.");
    // With a Claude plan from Ambient: its own config folder, never ~/.claude; an empty folder to run in, removed after.
    expect(readFileSync(join(dir, "upkeep-config.txt"), "utf8").trim()).toBe(join(dir, "ambient", ".upkeep", "claude-config"));
    expect(existsSync(readFileSync(join(dir, "upkeep-cwd.txt"), "utf8").trim())).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  }, 30_000);
});
