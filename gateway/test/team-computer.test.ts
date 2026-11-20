// A team on its own computer (docs/architecture.md, "A team on its own computer"). Creating a team
// never waits for Ambient's pool: it starts without a server, and its owner connects a computer.
// Sync tells that computer to run the team's brain; once it answers there, the team's address is
// computer://<host>, and the gateway reaches it through the computer's runner (here the real
// runner's ambient service, relaying to a team server on 127.0.0.1).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamApp, Deliverer, graphFor, GraphTokens, TeamRemote, TeamSettingsStore, TeamWiki, TranscriptOutbox } from "@brain/team";
import { publicJwks } from "../src/auth/bearer.ts";
import { computerHost, relayingFetch, serverKind } from "../src/relay.ts";
import { checkHealth } from "../src/worker/health.ts";
import { appCall, FIXTURES, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const info = { hostname: "club-box", os: "Linux 6.8", runner: "0.11.0", claude: "2.1.326 (Claude Code)" };
const bundle = Buffer.from("// the team's brain\n");
const sha256 = createHash("sha256").update(bundle).digest("hex");

let s: Stack;
let lena: AppSession;
let mia: AppSession;
let slug: string;
let teamId: string;
let host: string;
let hostId: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const myTeam = async (who: AppSession) => ((await appCall(s, who.access_token, "GET", "/v1/app/me")).json.teams as { slug: string; server: string }[]).find((t) => t.slug === slug);

beforeAll(async () => {
  delete process.env.BRAIN_TEAM_POOL;
  s = await startStack({ teamBundle: async () => ({ source: bundle, version: "test-1", sha256 }) });
  lena = await signIn(s, "apple-lena-club", "Lena Vogel");
  mia = await signIn(s, "apple-mia-club", "Mia Berg");
});
afterAll(() => s.close());

describe("creating a team", () => {
  it("never waits for the pool: the team starts without a server, and the app says so", async () => {
    const res = await appCall(s, lena.access_token, "POST", "/v1/app/teams", { name: "Rowing Club" });
    expect(res.status).toBe(200);
    expect(res.json.team).toMatchObject({ name: "Rowing Club", role: "owner", server: "none" });
    slug = String((res.json.team as { slug: string }).slug);
    expect(await myTeam(lena)).toMatchObject({ server: "none" });
    // An empty pool isn't a problem while new teams don't take from it.
    const health = await checkHealth({ control: s.control, gatewayUrl: s.origin, poolInUse: false });
    expect(health.problems.map((p) => p.key)).not.toContain("pool:empty");
  });

  it("lets only the team's owners and admins connect its computer", async () => {
    const invite = String((await appCall(s, lena.access_token, "POST", `/v1/app/teams/${slug}/invites`, {})).json.code);
    expect((await appCall(s, mia.access_token, "POST", "/v1/app/teams/join", { code: invite })).status).toBe(200);
    expect((await appCall(s, mia.access_token, "POST", "/v1/app/computers", { name: "Club box", team: slug })).status).toBe(403);
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "Club box", team: slug });
    expect(made.status).toBe(200);
    expect(String(made.json.commands)).toContain("/install.sh");
    const setup = await hostCall("", "POST", "/v1/host/setup", { code: String(made.json.code), info });
    host = String(setup.json.token);
    expect(setup.json.computer).toMatchObject({ team: true });
  });
});

describe("the team's brain on its computer", () => {
  it("goes to the team's computer with its sync, and moves there once it answers", async () => {
    const first = (await hostCall(host, "POST", "/v1/host/sync", { info })).json;
    expect(first.ambient).toBe(true);
    expect(first.teamBrain).toMatchObject({ teamName: "Rowing Club", slug, version: "test-1", sha256 });
    teamId = String((first.teamBrain as { teamId: string }).teamId);
    hostId = String((first.computer as { id: string }).id);
    expect(await myTeam(lena)).toMatchObject({ server: "none" });
    // The bundle the sync names is the one served.
    const got = await fetch(`${s.origin}/runner/ambient-team.mjs`);
    expect(createHash("sha256").update(Buffer.from(await got.arrayBuffer())).digest("hex")).toBe(sha256);

    await hostCall(host, "POST", "/v1/host/sync", { info: { ...info, teamBrain: { version: "test-1", ok: true } } });
    expect(await myTeam(lena)).toMatchObject({ server: "computer" });
    expect(await myTeam(mia)).toMatchObject({ server: "computer" });
  });

  it("never takes a hosted team's server", async () => {
    const acme = await signIn(s, "apple-acme-owner", "Ada Admin");
    await appCall(s, acme.access_token, "POST", "/v1/app/teams/join", { code: "ACME-2026" });
    const out = await s.control.m(s.api.teams.setComputerServer, { teamId: s.teamId as never, hostId: hostId as never });
    expect(out.ok).toBe(false);
  });
});

describe("the relay", () => {
  let runner: ChildProcess | undefined;
  let brain: Server | undefined;
  afterAll(() => {
    runner?.kill();
    brain?.close();
  });

  it("reaches the team's brain on 127.0.0.1 through the computer's runner", async () => {
    // The team's brain, as the runner runs it there: a team server for this team on a local port.
    const dataDir = mkdtempSync(join(tmpdir(), "brain-club-"));
    cpSync(join(FIXTURES, "wiki-team"), join(dataDir, "wiki"), { recursive: true });
    const wiki = await TeamWiki.open(join(dataDir, "wiki"), teamId, "Rowing Club", new TeamRemote(join(dataDir, "remote.json"), join(dataDir, "wiki"), { allowFile: true }));
    const settings = new TeamSettingsStore(join(dataDir, "settings.json"));
    const graphTokens = new GraphTokens();
    const deliverer = new Deliverer(new TranscriptOutbox(join(dataDir, "outbox")), settings, wiki, (c) => graphFor(c, graphTokens));
    brain = createServer(createTeamApp(wiki, { teamId, gatewayIssuer: s.origin, gatewayJwks: publicJwks(s.config.signingKeys), rawDir: join(dataDir, "raw"), version: "test-1", settings, deliverer, graphTokens, graphFor: (c) => graphFor(c, graphTokens) }));
    await new Promise<void>((r) => brain!.listen(0, "127.0.0.1", () => r()));
    const port = (brain.address() as AddressInfo).port;

    const dir = mkdtempSync(join(tmpdir(), "ambient-club-"));
    mkdirSync(join(dir, "state"));
    runner = spawn(process.execPath, [RUNNER, "ambient"], {
      env: {
        AMBIENT_CLAUDE_ENV: "/nonexistent/claude.env",
        AMBIENT_CONFIG_DIR: "/nonexistent/ambient-runner",
        PATH: process.env.PATH ?? "",
        HOME: dir,
        AMBIENT_SERVER: s.origin,
        AMBIENT_HOST_TOKEN: host,
        AMBIENT_STATE_DIR: join(dir, "state"),
        AMBIENT_AMBIENT_HOME: dir,
        AMBIENT_TEAM_PORT: String(port),
      },
    });
    let out = "";
    runner.stdout?.on("data", (d) => (out += d));
    runner.stderr?.on("data", (d) => (out += d));

    // The app asks the team's brain: the answer comes from the team server on the computer.
    let res = await appCall(s, lena.access_token, "POST", `/v1/app/teams/${slug}/query`, { op: "getByRef", ref: "orgs/bergmann-logistik" });
    for (let i = 0; i < 40 && res.status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 100));
      res = await appCall(s, lena.access_token, "POST", `/v1/app/teams/${slug}/query`, { op: "getByRef", ref: "orgs/bergmann-logistik" });
    }
    expect(res.status, `${JSON.stringify(res.json)}\n${out}`).toBe(200);
    expect((res.json.result as { title: string }).title).toContain("Bergmann");
    // Members read it the same way; the computer opened no port of its own to the world.
    expect((await appCall(s, mia.access_token, "POST", `/v1/app/teams/${slug}/query`, { op: "entries" })).status).toBe(200);
  }, 30_000);

  it("says plainly when the team's computer isn't connected", async () => {
    runner?.kill();
    await new Promise((r) => setTimeout(r, 300));
    const fetchVia = relayingFetch(async () => Promise.reject(new Error("the computer isn't connected")));
    await expect(fetchVia(`computer://${hostId}/health`)).rejects.toThrow("isn't connected");
  });
});

describe("the runner on the team's computer", () => {
  it("installs the team's brain from the gateway, checked, on 127.0.0.1, with its nightly upkeep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ambient-teamsync-"));
    const bin = join(dir, "bin");
    for (const d of ["bin", "units", "config", "install", "data", "state"]) mkdirSync(join(dir, d));
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> "${join(dir, "systemctl.log")}"\n[ "$1" = "is-active" ] && echo inactive\nexit 0\n`);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)"\nexit 0\n`);
    chmodSync(join(bin, "systemctl"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
    // The brain answers its health check, as the unit would once started.
    const health = createServer((_q, r) => r.end('{"status":"ok"}'));
    await new Promise<void>((r) => health.listen(0, "127.0.0.1", () => r()));
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AMBIENT_SYSTEM_PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      USER: "root",
      AMBIENT_SERVER: s.origin,
      AMBIENT_HOST_TOKEN: host,
      AMBIENT_CLAUDE: join(bin, "claude"),
      AMBIENT_CLAUDE_ENV: join(dir, "config", "claude.env"),
      AMBIENT_CONFIG_DIR: join(dir, "config"),
      AMBIENT_UNIT_DIR: join(dir, "units"),
      AMBIENT_INSTALL_DIR: join(dir, "install"),
      AMBIENT_STATE_DIR: join(dir, "state"),
      AMBIENT_TEAM_DATA: join(dir, "data"),
      AMBIENT_TEAM_PORT: String((health.address() as AddressInfo).port),
      AMBIENT_FOLDER: dir,
    };
    const sync = () =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn(process.execPath, [RUNNER, "sync"], { env });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        p.on("close", (code) => resolve({ code, out }));
      });
    try {
      const run = await sync();
      expect(run.code, run.out).toBe(0);
      expect(run.out).toContain("Installed the team's brain test-1 for Rowing Club");
      expect(readFileSync(join(dir, "install", "ambient-team.mjs"))).toEqual(bundle);
      const teamEnv = readFileSync(join(dir, "config", "team.env"), "utf8");
      expect(teamEnv).toContain(`BRAIN_TEAM_ID=${teamId}`);
      expect(teamEnv).toContain("BRAIN_LISTEN_HOST=127.0.0.1");
      expect(teamEnv).toMatch(/BRAIN_TEAM_SECRET=\S{40,}/);
      const serve = readFileSync(join(dir, "units", "ambient-team.service"), "utf8");
      expect(serve).toContain(`${join(dir, "install", "ambient-team.mjs")} serve`);
      expect(readFileSync(join(dir, "units", "ambient-team-upkeep.service"), "utf8")).toContain("Environment=BRAIN_CLAUDE=");
      expect(readFileSync(join(dir, "units", "ambient-team-upkeep.timer"), "utf8")).toContain("OnCalendar=");
      expect(readFileSync(join(dir, "systemctl.log"), "utf8")).toContain("restart ambient-team.service");
      expect(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).teamBrain).toEqual({ version: "test-1", ok: true });
      // Again: nothing changed, nothing restarted, and the secret stays.
      writeFileSync(join(dir, "systemctl.log"), "");
      expect((await sync()).code).toBe(0);
      expect(readFileSync(join(dir, "systemctl.log"), "utf8")).not.toContain("restart ambient-team.service");
      expect(readFileSync(join(dir, "config", "team.env"), "utf8")).toBe(teamEnv);
    } finally {
      health.close();
    }
  }, 30_000);
});

describe("addresses", () => {
  it("tell where a team's brain is", () => {
    expect(serverKind(null)).toBe("none");
    expect(serverKind("computer://abc123")).toBe("computer");
    expect(serverKind("https://t-acme.example.com")).toBe("hosted");
    expect(computerHost("computer://abc123/v1/query?x=1")).toBe("abc123");
    expect(computerHost("https://abc")).toBeNull();
  });
});
