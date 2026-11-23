// A computer's default model, Ambient's access there and root commands with approval cards
// (docs/bots.md), and a message to a bot starting its run at once over the computer's long poll.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "vps", os: "Linux 6.8", runner: "0.7.5", claude: "2.1.326 (Claude Code)" };

let s: Stack;
let lena: AppSession;
let host: string;
let computerId: string;
let client: Awaited<ReturnType<typeof mcpClient>>;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
type Approval = { id: string; command: string; reason: string; computer: { id: string } };
const approvals = async () => (await appCall(s, lena.access_token, "GET", "/v1/app/approvals")).json.approvals as Approval[];

/** Plays the computer: takes one root command from the long poll and answers it. */
async function computerRuns(answer: { code: number; output: string }) {
  for (let i = 0; i < 20; i++) {
    const job = (await hostCall(host, "GET", "/v1/host/ambient/next")).json as { id?: string; kind?: string; command?: string };
    if (job.kind === "exec") {
      await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: JSON.stringify(answer) });
      return job.command;
    }
  }
  throw new Error("no root command came");
}

beforeAll(async () => {
  s = await startStack({});
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "VPS" })).json.code);
  const setup = await hostCall("", "POST", "/v1/host/setup", { code, info });
  host = String(setup.json.token);
  computerId = (setup.json.computer as { id: string }).id;
  const pat = String((await appCall(s, lena.access_token, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
  client = await mcpClient(`${s.origin}/mcp`, pat);
});
afterAll(async () => {
  await client.close();
  await s.close();
});

describe("a computer's model", () => {
  it("is set in the app or by Ambient, reaches the computer, and a bot's own wins", async () => {
    const set = await appCall(s, lena.access_token, "PUT", `/v1/app/computers/${computerId}/model`, { model: "claude-opus-5-5", effort: "medium", fallback: "claude-opus-4-6" });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect((set.json.computer as { model: unknown }).model).toEqual({ model: "claude-opus-5-5", effort: "medium", fallback: "claude-opus-4-6" });
    expect((await hostCall(host, "POST", "/v1/host/sync", { info })).json.model).toEqual({ model: "claude-opus-5-5", effort: "medium", fallback: "claude-opus-4-6" });
    expect((await appCall(s, lena.access_token, "PUT", `/v1/app/computers/${computerId}/model`, { model: "gpt-6" })).status).toBe(400);

    const viaMcp = await client.callTool({ name: "set_computer_model", arguments: { computer: computerId, model: { model: "claude-sonnet-5-5", effort: "high" } } });
    expect(text(viaMcp)).toContain("claude-sonnet-5-5, high effort");

    const bot = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Haiku bot", prompt: "x", schedule: daily, bot: { isolation: "host", model: { model: "claude-haiku-5-5" } } });
    const r = bot.json.routine as { id: string; bot: { model: unknown } };
    expect(r.bot.model).toEqual({ model: "claude-haiku-5-5", effort: null, fallback: null });
    expect(((await hostCall(host, "POST", `/v1/host/routines/${r.id}/runs`)).json.bot as { model: unknown }).model).toEqual({ model: "claude-haiku-5-5" });
    // A bare null clears a computer's model (the app sends that).
    const cleared = await fetch(`${s.origin}/v1/app/computers/${computerId}/model`, { method: "PUT", headers: { ...(await import("./helpers.ts").then((h) => h.appHeaders(lena.access_token, "PUT", `${s.origin}/v1/app/computers/${computerId}/model`))), "content-type": "application/json" }, body: "null" });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { computer: { model: unknown } }).computer.model).toBeNull();
    await client.callTool({ name: "set_computer_model", arguments: { computer: computerId, model: { model: "claude-sonnet-5-5", effort: "high" } } });
    const back = await appCall(s, lena.access_token, "PATCH", `/v1/app/routines/${r.id}`, { bot: { model: null } });
    expect((back.json.routine as { bot: { model: unknown } }).bot.model).toBeNull();
  });

  it("goes to Claude Code in place of the computer's own --model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ambient-model-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "work"));
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
echo "$@" > args.txt
if echo "$@" | grep -q -- "--input-format"; then head -n 1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).message.content[0].text)}catch{process.stdout.write(s)}})' > /dev/null; else cat > /dev/null; fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"m1"}'
`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AMBIENT_SYSTEM_PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      AMBIENT_SERVER: s.origin,
      AMBIENT_HOST_TOKEN: host,
      AMBIENT_CLAUDE: join(bin, "claude"),
      AMBIENT_CLAUDE_ARGS: "--model claude-opus-4-6 --permission-mode auto",
      AMBIENT_STATE_DIR: join(dir, "state"),
      AMBIENT_UNIT_DIR: dir,
      AMBIENT_CLAUDE_ENV: join(dir, "claude.env"),
      AMBIENT_CONFIG_DIR: join(dir, "etc"),
    };
    const runner = (args: string[]) =>
      new Promise<number | null>((resolve) => {
        const p = spawn(process.execPath, [RUNNER, ...args], { env });
        p.on("close", resolve);
      });
    await runner(["sync"]);
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Default model", prompt: "x", schedule: daily, folder: join(dir, "work"), bot: { isolation: "host" } });
    await runner(["run", (made.json.routine as { id: string }).id]);
    const args = readFileSync(join(dir, "work", "args.txt"), "utf8");
    expect(args).toContain("--model claude-sonnet-5-5 --effort high");
    expect(args).not.toContain("claude-opus-4-6");
    expect(args).toContain("--permission-mode auto");
  });
});

describe("Ambient's access and approval cards", () => {
  it("can't run root commands on Standard, and an AI app can't raise it", async () => {
    const no = await client.callTool({ name: "run_on_computer", arguments: { computer: computerId, command: "id", reason: "test" } });
    expect(no.isError).toBe(true);
    expect(text(no)).toContain("its access is Standard");
    const raise = await client.callTool({ name: "set_computer_access", arguments: { computer: computerId, access: "admin" } });
    expect(raise.isError).toBe(true);
    expect(text(raise)).toContain("raise it in the Ambient app");
  });

  it("on Admin asks with a card; once, then always", async () => {
    const set = await appCall(s, lena.access_token, "PUT", `/v1/app/computers/${computerId}/access`, { access: "admin" });
    expect((set.json.computer as { access: string }).access).toBe("admin");

    const call = client.callTool({ name: "run_on_computer", arguments: { computer: computerId, command: "apt-get install -y ffmpeg", reason: "To cut the demo video." } });
    let pending: Approval[] = [];
    for (let i = 0; i < 50 && !pending.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pending = await approvals();
    }
    expect(pending[0]).toMatchObject({ command: "apt-get install -y ffmpeg", reason: "To cut the demo video.", computer: { id: computerId } });
    expect(JSON.stringify(await s.t.run(async (ctx) => ctx.db.query("approvals").collect()))).not.toContain("ffmpeg");

    const runs = computerRuns({ code: 0, output: "ffmpeg is already the newest version." });
    expect((await appCall(s, lena.access_token, "POST", `/v1/app/approvals/${pending[0]!.id}`, { decision: "once" })).status).toBe(200);
    expect(await runs).toBe("apt-get install -y ffmpeg");
    expect(text(await call)).toContain("ffmpeg is already the newest version.");
    expect(await approvals()).toEqual([]);

    // Always: the next time it runs without a card.
    const again = client.callTool({ name: "run_on_computer", arguments: { computer: computerId, command: "systemctl restart caddy", reason: "Pick up the new config." } });
    let card: Approval[] = [];
    for (let i = 0; i < 50 && !card.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      card = await approvals();
    }
    const runs2 = computerRuns({ code: 0, output: "" });
    await appCall(s, lena.access_token, "POST", `/v1/app/approvals/${card[0]!.id}`, { decision: "always" });
    await runs2;
    expect(text(await again)).toContain("Ran as root (exit 0)");
    const list = (await appCall(s, lena.access_token, "GET", "/v1/app/routines")).json.computers as { id: string; allowed: string[] }[];
    expect(list.find((c) => c.id === computerId)?.allowed).toEqual(["systemctl restart caddy"]);
    const third = client.callTool({ name: "run_on_computer", arguments: { computer: computerId, command: "systemctl restart caddy", reason: "Again." } });
    await computerRuns({ code: 0, output: "restarted" });
    expect(text(await third)).toContain("restarted");
    expect(await approvals()).toEqual([]);
  });

  it("denied means it doesn't run", async () => {
    const call = client.callTool({ name: "run_on_computer", arguments: { computer: computerId, command: "rm -rf /srv/old", reason: "Clean up." } });
    let card: Approval[] = [];
    for (let i = 0; i < 50 && !card.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      card = await approvals();
    }
    await appCall(s, lena.access_token, "POST", `/v1/app/approvals/${card[0]!.id}`, { decision: "deny" });
    expect(text(await call)).toContain("They said no");
  });
});

describe("a message to a bot", () => {
  it("starts its run at once over the computer's long poll", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Quick bot", prompt: "x", schedule: daily, bot: { isolation: "host" } });
    const id = (made.json.routine as { id: string }).id;
    const waiting = hostCall(host, "GET", "/v1/host/ambient/next");
    await new Promise((r) => setTimeout(r, 100));
    await appCall(s, lena.access_token, "POST", `/v1/app/routines/${id}/thread`, { text: "Hello?" });
    expect((await waiting).json).toMatchObject({ kind: "start", routineId: id });
  });
});
