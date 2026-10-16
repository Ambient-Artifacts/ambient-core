// Routines end to end: a computer set up with a one-time code from the app, routines made in
// the app and over MCP, and the real runner script syncing systemd units (a stand-in
// systemctl) and running a routine (a stand-in claude that speaks stream-json).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, mcpClient, signIn, startStack, text, type Stack } from "./helpers.ts";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const vienna = { every: "week", days: ["wed"], time: "08:52", timezone: "Europe/Vienna" };

let s: Stack;
let lena: string;
let ben: string;
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
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.1.0", claude: "2.1.293 (Claude Code)" };

type R = { id: string; name: string; prompt: string; scheduleText: string; nextRunAt: number | null; enabled: boolean; runRequested: boolean; computer: { id: string } | null; lastRun: { status: string } | null };

beforeAll(async () => {
  s = await startStack();
  lena = (await signIn(s, "apple-lena", "Lena Vogel")).access_token;
  ben = (await signIn(s, "apple-ben", "Ben Weiss")).access_token;
});
afterAll(() => s.close());

describe("computers", () => {
  it("are set up with a one-time code that only works once", async () => {
    const added = await appCall(s, lena, "POST", "/v1/app/computers", { name: "Build server" });
    expect(added.status).toBe(200);
    const code = String(added.json.code);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(String(added.json.commands)).toContain(`curl -fsSL ${s.origin}/runner/ambient-runner.mjs`);
    expect(String(added.json.commands)).toContain(`setup ${code}`);
    expect((added.json.computer as { ready: boolean }).ready).toBe(false);

    const setup = await hostCall("", "POST", "/v1/host/setup", { code: code.toLowerCase(), info });
    expect(setup.status).toBe(200);
    host = String(setup.json.token);
    expect(host).toMatch(/^ambient_host_/);
    computerId = (setup.json.computer as { id: string }).id;

    expect((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.error).toBe("invalid_code");
    const list = await appCall(s, lena, "GET", "/v1/app/routines");
    const c = (list.json.computers as { id: string; ready: boolean; online: boolean; hostname: string }[])[0]!;
    expect(c).toMatchObject({ id: computerId, ready: true, online: true, hostname: "srv-test" });
  });

  it("can also get a code from staff (ops/new-computer.mjs)", async () => {
    const codeHash = createHash("sha256").update("host-setup:STAF-F123").digest("hex");
    await s.t.mutation(s.internal.routines.staffAddHost, { email: "APPLE-BEN@example.com", name: "Ben's server", codeHash, expiresAt: Date.now() + 60_000 });
    const setup = await hostCall("", "POST", "/v1/host/setup", { code: "STAF-F123", info });
    expect(setup.json.computer).toMatchObject({ name: "Ben's server" });
    await expect(s.t.mutation(s.internal.routines.staffAddHost, { email: "nobody@example.com", name: "x", codeHash: "y", expiresAt: 0 })).rejects.toThrow("no user");
  });

  it("serve the runner, pointed at this gateway", async () => {
    const res = await fetch(`${s.origin}/runner/ambient-runner.mjs`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`const DEFAULT_SERVER = "${s.origin}";`);
  });

  it("refuse unknown tokens", async () => {
    expect((await hostCall("ambient_host_nope", "POST", "/v1/host/sync", {})).status).toBe(401);
    expect((await hostCall(lena, "POST", "/v1/host/sync", {})).status).toBe(401);
  });
});

describe("routines from the app", () => {
  let id: string;

  it("are created on the only computer and reach it as a calendar expression", async () => {
    const made = await appCall(s, lena, "POST", "/v1/app/routines", { name: "Blog draft", prompt: "Draft next Monday's post.", schedule: vienna, folder: "~/git/blog" });
    expect(made.status).toBe(200);
    const r = made.json.routine as R;
    id = r.id;
    expect(r).toMatchObject({ name: "Blog draft", prompt: "Draft next Monday's post.", scheduleText: "Wednesdays at 08:52", enabled: true, computer: { id: computerId } });
    expect(r.nextRunAt).toBeGreaterThan(Date.now());

    const sync = await hostCall(host, "POST", "/v1/host/sync", { info });
    expect(sync.json.routines).toEqual([{ id, name: "Blog draft", onCalendar: "Wed *-*-* 08:52:00 Europe/Vienna", enabled: true, runRequested: false }]);
    expect((sync.json.runner as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keep the prompt out of Convex in readable form", async () => {
    const rows = await s.t.run(async (ctx) => ctx.db.query("routines").collect());
    expect(JSON.stringify(rows)).not.toContain("Draft next Monday");
  });

  it("validate what they're given", async () => {
    const bad = await appCall(s, lena, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: { ...vienna, days: [] } });
    expect(bad.status).toBe(400);
    expect(String(bad.json.message)).toContain("schedule.days");
    expect((await appCall(s, lena, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: { ...vienna, timezone: "Nowhere/Land" } })).status).toBe(400);
    expect((await appCall(s, lena, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: vienna, folder: "relative/path" })).status).toBe(400);
    expect((await appCall(s, lena, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: vienna, computer: "nope" })).json.error).toBe("no_such_computer");
  });

  it("run now: the computer sees the request, the run is manual, and its summary comes back", async () => {
    expect((await appCall(s, lena, "POST", `/v1/app/routines/${id}/run`)).status).toBe(200);
    expect((await hostCall(host, "POST", "/v1/host/sync", {})).json.routines).toMatchObject([{ id, runRequested: true }]);

    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    expect(start.json).toMatchObject({ run: { trigger: "manual" }, routine: { id, prompt: "Draft next Monday's post.", folder: "~/git/blog" } });
    const runId = (start.json.run as { id: string }).id;
    expect((await hostCall(host, "POST", "/v1/host/sync", {})).json.routines).toMatchObject([{ id, runRequested: false }]);

    const done = await hostCall(host, "POST", `/v1/host/runs/${runId}`, { status: "succeeded", exitCode: 0, summary: "Opened PR #2.", costUsd: 0.81, turns: 12 });
    expect(done.status).toBe(204);
    const runs = (await appCall(s, lena, "GET", `/v1/app/routines/${id}/runs`)).json.runs as { status: string; trigger: string; summary: string; costUsd: number; durationMs: number }[];
    expect(runs[0]).toMatchObject({ status: "succeeded", trigger: "manual", summary: "Opened PR #2.", costUsd: 0.81 });
    expect((await appCall(s, lena, "GET", "/v1/app/routines")).json.routines).toMatchObject([{ id, lastRun: { status: "succeeded" } }]);
  });

  it("a run cut off by a reboot is closed when the next one starts", async () => {
    const first = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    expect((first.json.run as { trigger: string }).trigger).toBe("schedule");
    await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    const runs = (await appCall(s, lena, "GET", `/v1/app/routines/${id}/runs`)).json.runs as { status: string }[];
    expect(runs.map((r) => r.status).slice(0, 3)).toEqual(["running", "failed", "succeeded"]);
  });

  it("lists as many runs as the app asks for, newest first", async () => {
    const runs = async (query: string) => ((await appCall(s, lena, "GET", `/v1/app/routines/${id}/runs${query}`)).json.runs as { status: string }[]).map((r) => r.status);
    expect(await runs("?limit=2")).toEqual(["running", "failed"]);
    expect(await runs("?limit=0")).toEqual(["running"]);
    expect(await runs("?limit=500")).toEqual(await runs(""));
    expect(await runs("?limit=lots")).toEqual(await runs(""));
  });

  it("belong to their owner and their computer", async () => {
    expect((await appCall(s, ben, "PATCH", `/v1/app/routines/${id}`, { enabled: false })).status).toBe(404);
    expect((await appCall(s, ben, "GET", `/v1/app/routines/${id}/runs`)).status).toBe(404);
    expect((await appCall(s, ben, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: vienna, computer: computerId })).json.error).toBe("no_such_computer");
    const benCode = String((await appCall(s, ben, "POST", "/v1/app/computers", { name: "Ben's box" })).json.code);
    const benHost = String((await hostCall("", "POST", "/v1/host/setup", { code: benCode, info })).json.token);
    expect((await hostCall(benHost, "POST", `/v1/host/routines/${id}/runs`)).status).toBe(404);
    expect((await hostCall(benHost, "POST", "/v1/host/sync", {})).json.routines).toEqual([]);
  });

  it("pause, change and delete", async () => {
    const paused = (await appCall(s, lena, "PATCH", `/v1/app/routines/${id}`, { enabled: false, schedule: { ...vienna, every: "weekday", time: "07:30" } })).json.routine as R;
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null, scheduleText: "Weekdays at 07:30" });
    expect((await hostCall(host, "POST", "/v1/host/sync", {})).json.routines).toMatchObject([{ enabled: false, onCalendar: "Mon..Fri *-*-* 07:30:00 Europe/Vienna" }]);
    expect((await appCall(s, lena, "DELETE", `/v1/app/routines/${id}`)).status).toBe(204);
    expect((await hostCall(host, "POST", "/v1/host/sync", {})).json.routines).toEqual([]);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("routineRuns").collect()).length)).toBe(0);
  });
});

describe("routines over MCP", () => {
  it("create, list, change, run and delete", async () => {
    const pat = String((await appCall(s, lena, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const made = await client.callTool({
      name: "create_routine",
      arguments: { name: "Inbox sweep", prompt: "Sort the inbox.", schedule: { every: "weekday", time: "07:00", timezone: "Europe/Vienna" }, computer: "build server" },
    });
    expect(made.isError).toBeFalsy();
    const r = (made.structuredContent as { routine: R }).routine;
    expect(text(made)).toContain("Weekdays at 07:00 (Europe/Vienna)");

    const listed = text(await client.callTool({ name: "list_routines", arguments: {} }));
    expect(listed).toContain(`Inbox sweep (id: ${r.id}, personal)`);
    expect(listed).toContain("Build server (srv-test): online");
    expect(text(await client.callTool({ name: "list_routines", arguments: { id: r.id } }))).toContain("Prompt:\nSort the inbox.");

    const changed = await client.callTool({ name: "update_routine", arguments: { id: r.id, prompt: "Sort and archive the inbox.", enabled: false } });
    expect(text(changed)).toContain("paused");
    expect((await client.callTool({ name: "run_routine", arguments: { id: r.id } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "update_routine", arguments: { id: r.id, schedule: { every: "week", time: "07:00", timezone: "Europe/Vienna" } } })).isError).toBe(true);

    const row = await s.t.run(async (ctx) => (await ctx.db.query("routines").collect()).find((x) => x.name === "Inbox sweep"));
    expect(row?.source).toMatch(/^mcp/);
    expect(text(await client.callTool({ name: "delete_routine", arguments: { id: r.id } }))).toContain('Deleted "Inbox sweep"');
    expect((await client.callTool({ name: "delete_routine", arguments: { id: r.id } })).isError).toBe(true);
    await client.close();
  });

});

describe("team routines", () => {
  let slug: string;
  let teamHost: string;
  let id: string;

  beforeAll(async () => {
    // Lena owns a new team (on the pool's server); Ben joins it as a member.
    const made = await appCall(s, lena, "POST", "/v1/app/teams", { name: "Lab" });
    slug = (made.json.team as { slug: string }).slug;
    const invite = String((await appCall(s, lena, "POST", `/v1/app/teams/${slug}/invites`, { role: "member" })).json.code);
    expect((await appCall(s, ben, "POST", "/v1/app/teams/join", { code: invite })).status).toBe(200);
    // Staff connects the team's server (ops/routines-team-server.sh).
    const codeHash = createHash("sha256").update("host-setup:TEAM-SRV1").digest("hex");
    await s.t.mutation(s.internal.routines.staffAddHost, { team: slug, name: "Team server", codeHash, expiresAt: Date.now() + 60_000 });
    const setup = await hostCall("", "POST", "/v1/host/setup", { code: "TEAM-SRV1", info: { ...info, hostname: "brain-team-lab" } });
    expect(setup.json.computer).toMatchObject({ name: "Team server", team: true });
    teamHost = String(setup.json.token);
  });

  it("owners and admins create them; they run on the team's server", async () => {
    const made = await appCall(s, lena, "POST", "/v1/app/routines", { name: "Weekly digest", prompt: "Write the weekly digest.", schedule: vienna, team: slug, folder: "~/digest" });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const r = made.json.routine as R & { team: { slug: string }; canEdit: boolean };
    id = r.id;
    expect(r).toMatchObject({ team: { slug }, canEdit: true, computer: { name: "Team server" } });
    expect(r.nextRunAt).toBeGreaterThan(Date.now());
    expect((await appCall(s, lena, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: vienna, team: slug, computer: computerId })).json.error).toBe("team_routine_computer");
    expect((await appCall(s, ben, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: vienna, team: slug })).json.error).toBe("admins_only");
    expect((await appCall(s, ben, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: vienna, team: "acme" })).json.error).toBe("not_a_member");
  });

  it("members see them and their runs, but can't change them", async () => {
    const mine = (await appCall(s, ben, "GET", "/v1/app/routines")).json as { routines: (R & { canEdit: boolean })[]; computers: { team: { slug: string } | null; online: boolean }[] };
    expect(mine.routines.find((r) => r.id === id)).toMatchObject({ name: "Weekly digest", canEdit: false, prompt: "Write the weekly digest." });
    expect(mine.computers.find((c) => c.team?.slug === slug)).toMatchObject({ online: true });
    expect((await appCall(s, ben, "PATCH", `/v1/app/routines/${id}`, { enabled: false })).status).toBe(403);
    expect((await appCall(s, ben, "POST", `/v1/app/routines/${id}/run`)).status).toBe(403);
    expect((await appCall(s, ben, "DELETE", `/v1/app/routines/${id}`)).status).toBe(403);
    expect((await appCall(s, ben, "GET", `/v1/app/routines/${id}/runs`)).status).toBe(200);
  });

  it("the team's server gets only the team's routines; nobody else's computer gets them", async () => {
    expect(((await hostCall(teamHost, "POST", "/v1/host/sync", {})).json.routines as { id: string }[]).map((r) => r.id)).toEqual([id]);
    expect(((await hostCall(host, "POST", "/v1/host/sync", {})).json.routines as { id: string }[]).map((r) => r.id)).not.toContain(id);
    expect((await hostCall(host, "POST", `/v1/host/routines/${id}/runs`)).status).toBe(404);
  });

  it("secrets: admins set them, runs get them, nobody reads them back", async () => {
    expect((await appCall(s, lena, "PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "ghp_team_secret_1", team: slug })).status).toBe(204);
    expect((await appCall(s, ben, "PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "mine", team: slug })).status).toBe(403);
    expect((await appCall(s, lena, "PUT", "/v1/app/routines/secrets/PATH", { value: "/tmp", team: slug })).status).toBe(400);
    expect((await appCall(s, lena, "PUT", "/v1/app/routines/secrets/lower_case", { value: "x" })).status).toBe(400);
    const names = (await appCall(s, ben, "GET", `/v1/app/routines/secrets?team=${slug}`)).json.secrets as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(["GH_TOKEN"]);
    expect(JSON.stringify(names)).not.toContain("ghp_team_secret_1");
    expect((await appCall(s, lena, "GET", "/v1/app/routines/secrets")).json.secrets).toEqual([]);

    await appCall(s, lena, "POST", `/v1/app/routines/${id}/run`);
    const start = await hostCall(teamHost, "POST", `/v1/host/routines/${id}/runs`);
    expect(start.json).toMatchObject({ run: { trigger: "manual" }, routine: { prompt: "Write the weekly digest.", folder: "~/digest" }, env: { GH_TOKEN: "ghp_team_secret_1" } });
    await hostCall(teamHost, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Posted the digest.", costUsd: 1.2 });
    expect((await appCall(s, ben, "GET", `/v1/app/routines/${id}/runs`)).json.runs).toMatchObject([{ status: "succeeded", summary: "Posted the digest." }]);

    const rows = JSON.stringify(await s.t.run(async (ctx) => [await ctx.db.query("routines").collect(), await ctx.db.query("routineSecrets").collect(), await ctx.db.query("routineRuns").collect()]));
    for (const plain of ["ghp_team_secret_1", "Write the weekly digest", "Posted the digest"]) expect(rows).not.toContain(plain);

    expect((await appCall(s, lena, "DELETE", `/v1/app/routines/secrets/GH_TOKEN?team=${slug}`)).status).toBe(204);
    expect((await appCall(s, ben, "GET", `/v1/app/routines/secrets?team=${slug}`)).json.secrets).toEqual([]);
  });

  it("over MCP: a team connection works on the team's routines only; members get a clear no", async () => {
    await appCall(s, lena, "POST", "/v1/app/routines", { name: "Lena's own", prompt: "Mine.", schedule: vienna });
    const teamPat = String((await appCall(s, lena, "POST", "/v1/app/pats", { label: "Copilot", team: slug })).json.token);
    const client = await mcpClient(`${s.origin}/t/${slug}/mcp`, teamPat);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_routines", "create_routine", "set_routine_secret"]));
    const made = await client.callTool({ name: "create_routine", arguments: { name: "Standup notes", prompt: "Summarize yesterday.", schedule: { every: "weekday", time: "08:00", timezone: "Europe/Vienna" } } });
    expect(text(made)).toContain(`team ${slug}`);
    const listed = text(await client.callTool({ name: "list_routines", arguments: {} }));
    expect(listed).toContain("Standup notes");
    expect(listed).toContain("Weekly digest");
    expect(listed).not.toContain("Lena's own");
    expect(text(await client.callTool({ name: "set_routine_secret", arguments: { name: "SLACK_TOKEN", value: "xoxb-1" } }))).toContain(`Stored SLACK_TOKEN for team ${slug}`);
    await client.close();

    const benPat = String((await appCall(s, ben, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const benClient = await mcpClient(`${s.origin}/mcp`, benPat);
    const no = await benClient.callTool({ name: "create_routine", arguments: { name: "x", prompt: "y", schedule: { every: "day", time: "08:00", timezone: "UTC" }, team: slug } });
    expect(no.isError).toBe(true);
    expect(text(no)).toContain("owners and admins");
    expect(text(await benClient.callTool({ name: "list_routines", arguments: {} }))).toContain("read-only for you");
    await benClient.close();
  });

  it("a member who leaves stops seeing them", async () => {
    expect((await appCall(s, ben, "POST", `/v1/app/teams/${slug}/leave`)).status).toBe(204);
    const mine = (await appCall(s, ben, "GET", "/v1/app/routines")).json as { routines: { id: string }[] };
    expect(mine.routines.map((r) => r.id)).not.toContain(id);
    expect((await appCall(s, ben, "GET", `/v1/app/routines/${id}/runs`)).status).toBe(404);
  });
});

describe("the runner on a computer", () => {
  let dir: string;
  let env: Record<string, string>;
  let routineId: string;

  /** Run the real runner script with a stand-in systemctl and claude. */
  const runner = (args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [RUNNER, ...args], { env: { ...env, ...extra } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ambient-runner-"));
    const bin = join(dir, "bin");
    mkdirSync(join(dir, "units"));
    mkdirSync(join(dir, "work"));
    mkdirSync(bin);
    // systemctl: log calls; "is-active" says inactive; list-unit-files lists nothing enabled.
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> "${join(dir, "systemctl.log")}"\n[ "$1" = "is-active" ] && echo inactive\nexit 0\n`);
    // claude: read the prompt from stdin, write it to a file, speak stream-json.
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
cat > prompt.txt
echo "$@" > args.txt
env > env.txt
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Drafted the post and opened PR #3.","total_cost_usd":0.42,"num_turns":7,"session_id":"sess-1"}'
`,
    );
    chmodSync(join(bin, "systemctl"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
    env = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      USER: "root",
      AMBIENT_SERVER: s.origin,
      AMBIENT_HOST_TOKEN: host,
      AMBIENT_CLAUDE: join(bin, "claude"),
      AMBIENT_UNIT_DIR: join(dir, "units"),
      AMBIENT_STATE_DIR: join(dir, "state"),
      AMBIENT_FOLDER: join(dir, "work"),
    };
    const made = await appCall(s, lena, "POST", "/v1/app/routines", { name: "Blog draft", prompt: "Draft next Monday's post.", schedule: vienna, folder: join(dir, "work"), computer: computerId });
    routineId = (made.json.routine as R).id;
    await appCall(s, lena, "PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "ghp_personal_2" });
  });

  it("sync writes a service and a timer per routine and schedules it", async () => {
    const out = await runner(["sync"]);
    expect(out.code, out.out).toBe(0);
    const timer = readFileSync(join(dir, "units", `ambient-routine-${routineId}.timer`), "utf8");
    expect(timer).toContain("OnCalendar=Wed *-*-* 08:52:00 Europe/Vienna");
    const service = readFileSync(join(dir, "units", `ambient-routine-${routineId}.service`), "utf8");
    expect(service).toContain(`/opt/ambient-runner/ambient-runner.mjs run ${routineId}`);
    expect(service).toContain("Description=Ambient routine: Blog draft");
    const calls = readFileSync(join(dir, "systemctl.log"), "utf8");
    expect(calls).toContain("daemon-reload");
    expect(calls).toContain(`enable ambient-routine-${routineId}.timer`);
    expect(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).claude.version).toBe("9.9.9 (Claude Code)");
  });

  it("starts requested runs", async () => {
    await appCall(s, lena, "POST", `/v1/app/routines/${routineId}/run`);
    await runner(["sync"]);
    expect(readFileSync(join(dir, "systemctl.log"), "utf8")).toContain(`start --no-block ambient-routine-${routineId}.service`);
  });

  it("run feeds the prompt to claude -p in the routine's folder and reports the result", async () => {
    const out = await runner(["run", routineId]);
    expect(out.code, out.out).toBe(0);
    expect(out.out).toContain("· Bash: git status");
    expect(readFileSync(join(dir, "work", "prompt.txt"), "utf8")).toBe("Draft next Monday's post.");
    const args = readFileSync(join(dir, "work", "args.txt"), "utf8");
    expect(args).toContain("-p --output-format stream-json --verbose --permission-mode auto --append-system-prompt");
    expect(args).toContain('Ambient routine "Blog draft"');
    const env = readFileSync(join(dir, "work", "env.txt"), "utf8");
    expect(env).not.toContain("AMBIENT_HOST_TOKEN");
    expect(env).toContain("GH_TOKEN=ghp_personal_2");
    expect(out.out).not.toContain("ghp_personal_2");
    const runs = (await appCall(s, lena, "GET", `/v1/app/routines/${routineId}/runs`)).json.runs as { status: string; trigger: string; summary: string; costUsd: number }[];
    expect(runs[0]).toMatchObject({ status: "succeeded", trigger: "manual", summary: "Drafted the post and opened PR #3.", costUsd: 0.42 });
  });

  it("a missing folder fails the run with a sentence", async () => {
    await appCall(s, lena, "PATCH", `/v1/app/routines/${routineId}`, { folder: "/nowhere/blog" });
    const out = await runner(["run", routineId]);
    expect(out.code).toBe(1);
    const runs = (await appCall(s, lena, "GET", `/v1/app/routines/${routineId}/runs`)).json.runs as { status: string; summary: string }[];
    expect(runs[0]).toMatchObject({ status: "failed", summary: "The folder /nowhere/blog doesn't exist on " + (await import("node:os")).hostname() + "." });
  });

  it("sync removes deleted routines", async () => {
    await appCall(s, lena, "DELETE", `/v1/app/routines/${routineId}`);
    const out = await runner(["sync"]);
    expect(out.code, out.out).toBe(0);
    expect(readdirSync(join(dir, "units")).filter((f) => f.includes(routineId))).toEqual([]);
    expect(readFileSync(join(dir, "systemctl.log"), "utf8")).toContain(`disable --now ambient-routine-${routineId}.timer`);
    expect(existsSync(join(dir, "units", `ambient-routine-${routineId}.service`))).toBe(false);
  });
});
