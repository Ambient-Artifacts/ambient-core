// Ambient on the person's own computer: the gateway hands chat messages to the computer's long
// poll with a personal token for Ambient's tools, and the reply lands in the chat. Then the real
// runner's `ambient` service with a stand-in claude that keeps one session open.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, mcpClient, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const info = { hostname: "vps", os: "Linux 6.8", runner: "0.7.0", claude: "2.1.326 (Claude Code)" };

let s: Stack;
let lena: AppSession;
let host: string;
let firstToken: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
type Chat = { messages: { role: string; text: string }[]; pending: boolean };
const chat = async () => (await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json as Chat;
const settled = async () => {
  let c = await chat();
  for (let i = 0; i < 100 && c.pending; i++) {
    await new Promise((r) => setTimeout(r, 50));
    c = await chat();
  }
  return c;
};

beforeAll(async () => {
  // No server key: Ambient answers only on the computer.
  s = await startStack({ bots: { users: [], teams: [] }, ambient: { apiKey: undefined } });
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "VPS" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
});
afterAll(() => s.close());

describe("Ambient on the person's computer", () => {
  it("is only for accounts with bots, and sync says so", async () => {
    expect((await hostCall(host, "POST", "/v1/host/sync", { info })).json.ambient).toBe(false);
    expect((await hostCall(host, "GET", "/v1/host/ambient/next")).status).toBe(403);
    s.config.bots!.users.push(lena.user.uid);
    expect((await hostCall(host, "POST", "/v1/host/sync", { info })).json.ambient).toBe(true);
  });

  it("says when no computer is connected and there's no server key", async () => {
    await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "Hello?" });
    const c = await settled();
    expect(c.messages.at(-1)?.text).toContain("isn't connected");
    await appCall(s, lena.access_token, "DELETE", "/v1/app/ambient/chat");
  });

  it("hands the message to the computer's long poll and shows its reply", async () => {
    const waiting = hostCall(host, "GET", "/v1/host/ambient/next");
    await new Promise((r) => setTimeout(r, 100));
    await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "What's on the VPS?" });
    const job = (await waiting).json as { id: string; uid: string; text: string; fresh: boolean; token: string; instructions: string; name: string };
    expect(job).toMatchObject({ text: "What's on the VPS?", fresh: true, name: "Lena Vogel", uid: lena.user.uid });
    firstToken = job.token;
    expect(job.instructions).toContain("You run as Claude Code on VPS");
    expect(job.token).toMatch(/^ambient_pat_/);
    // The token reaches Ambient's tools as Lena.
    const client = await mcpClient(`${s.origin}/mcp`, job.token);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("bot_thread");
    await client.close();

    expect((await chat()).pending).toBe(true);
    expect((await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: "Three repos and a cron." })).status).toBe(204);
    const c = await settled();
    expect(c.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "What's on the VPS?"],
      ["ambient", "Three repos and a cron."],
    ]);
    expect((await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: "again" })).status).toBe(404);
  });

  it("queues a message until the computer asks, keeps the token, and reports failures", async () => {
    await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "And now?" });
    const job = (await hostCall(host, "GET", "/v1/host/ambient/next")).json as { id: string; fresh: boolean; token: string };
    expect(job.fresh).toBe(false);
    // The same token until it's renewed.
    expect(job.token).toBe(firstToken);
    await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { error: "Claude Code stopped (exit 1)" });
    expect((await settled()).messages.at(-1)?.text).toContain("I couldn't answer on VPS: Claude Code stopped");
  });
});

describe("Ambient's own turns", () => {
  it("go to the computer as internal jobs, and what Ambient said reaches the chat's session with the next message", async () => {
    // A bot's question or the heartbeat: an internal job, never the chat's session.
    const asked = s.ambient.internalTurn(lena.user.uid, "Lena", "[Heartbeat] Blog draft failed.");
    const job = (await hostCall(host, "GET", "/v1/host/ambient/next")).json as { id: string; mode: string; text: string; history: unknown[] };
    expect(job.mode).toBe("internal");
    expect(job.text).toContain("Blog draft failed");
    expect(job.history).toEqual([]);
    await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: "NOTHING" });
    expect(await asked).toBe("NOTHING");
    expect((await chat()).messages.map((m) => m.text)).not.toContain("[Heartbeat] Blog draft failed.");

    // Ambient writes on its own; the person's next message carries it to the chat's session, once.
    await s.ambient.say(lena.user.uid, "Blog draft failed twice: the repo token expired.");
    await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "Why?" });
    const next = (await hostCall(host, "GET", "/v1/host/ambient/next")).json as { id: string; mode: string; text: string };
    expect(next.mode).toBe("chat");
    expect(next.text).toMatch(/^\[Since Lena Vogel's last message you wrote to them yourself:\n- Blog draft failed twice: the repo token expired\.\]\n\nWhy\?$/);
    await hostCall(host, "POST", `/v1/host/ambient/${next.id}`, { text: "Its token expired." });
    await settled();
    await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "Thanks" });
    const after = (await hostCall(host, "GET", "/v1/host/ambient/next")).json as { id: string; text: string };
    expect(after.text).toBe("Thanks");
    await hostCall(host, "POST", `/v1/host/ambient/${after.id}`, { text: "Sure." });
    await settled();
  });

  it("start a new session once the chat was cleared, even when Ambient wrote in it since", async () => {
    await appCall(s, lena.access_token, "DELETE", "/v1/app/ambient/chat");
    await s.ambient.say(lena.user.uid, "A decision waits for you.");
    await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "Which?" });
    // A new chat first gives Amb a background turn to keep what matters in its memory.
    let job = (await hostCall(host, "GET", "/v1/host/ambient/next")).json as { id: string; fresh: boolean; text: string; mode?: string };
    while (job.mode === "internal") {
      expect(job.text).toContain("started a new chat");
      await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: "NOTHING" });
      job = (await hostCall(host, "GET", "/v1/host/ambient/next")).json as typeof job;
    }
    expect(job.fresh).toBe(true);
    expect(job.text).toContain("A decision waits for you.");
    await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: "The blog one." });
    await settled();
  });
});

describe("files in the chat", () => {
  it("reach the computer's job, and the history keeps only their names", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const waiting = hostCall(host, "GET", "/v1/host/ambient/next");
    await new Promise((r) => setTimeout(r, 100));
    const sent = await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "What's in this?", attachments: [{ name: "shot.png", type: "image/png", data: png }] });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const job = (await waiting).json as { id: string; attachments: { name: string; type: string; data: string }[] };
    expect(job.attachments).toEqual([{ name: "shot.png", type: "image/png", data: png }]);
    await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: "A tiny PNG." });
    const c = await settled();
    expect(c.messages.at(-2)?.text).toBe("What's in this?\n\n📎 shot.png");
  });

  it("refuses what can't go with a message", async () => {
    const bad = await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "x", attachments: [{ name: "a.exe", type: "application/x-msdownload", data: "AAAA" }] });
    expect(bad.json).toMatchObject({ error: "bad_attachment" });
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `${i}.txt`, type: "text/plain", data: "aGk=" }));
    expect((await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "x", attachments: five })).status).toBe(400);
  });
});

describe("Ambient on the team's server", () => {
  it("answers a member of a team with bots when they have no computer of their own connected", async () => {
    const ben = await signIn(s, "apple-ben", "Ben Weiss");
    const made = await appCall(s, ben.access_token, "POST", "/v1/app/teams", { name: "Ops" });
    const slug = (made.json.team as { slug: string }).slug;
    const codeHash = createHash("sha256").update("host-setup:TEAM-AMB1").digest("hex");
    await s.t.mutation(s.internal.routines.staffAddHost, { team: slug, name: "Team server", codeHash, expiresAt: Date.now() + 60_000 });
    const teamHost = String((await hostCall("", "POST", "/v1/host/setup", { code: "TEAM-AMB1", info })).json.token);
    expect((await hostCall(teamHost, "POST", "/v1/host/sync", { info })).json.ambient).toBe(false);
    s.config.bots!.teams.push(slug);
    expect((await hostCall(teamHost, "POST", "/v1/host/sync", { info })).json.ambient).toBe(true);

    const waiting = hostCall(teamHost, "GET", "/v1/host/ambient/next");
    await new Promise((r) => setTimeout(r, 100));
    await appCall(s, ben.access_token, "POST", "/v1/app/ambient/chat", { text: "Status?" });
    const job = (await waiting).json as { id: string; uid: string; instructions: string };
    expect(job.uid).toBe(ben.user.uid);
    expect(job.instructions).toContain("on Ops's server, Ambient's machine for the team");
    await hostCall(teamHost, "POST", `/v1/host/ambient/${job.id}`, { text: "All quiet." });
    let c = (await appCall(s, ben.access_token, "GET", "/v1/app/ambient/chat")).json as Chat;
    for (let i = 0; i < 100 && c.pending; i++) {
      await new Promise((r) => setTimeout(r, 50));
      c = (await appCall(s, ben.access_token, "GET", "/v1/app/ambient/chat")).json as Chat;
    }
    expect(c.messages.at(-1)?.text).toBe("All quiet.");
  });
});

describe("the runner's ambient service", () => {
  let p: ChildProcess | undefined;
  afterAll(() => p?.kill());

  it("keeps one Claude Code session open and answers each message in it", async () => {
    await appCall(s, lena.access_token, "DELETE", "/v1/app/ambient/chat");
    const dir = mkdtempSync(join(tmpdir(), "ambient-service-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // claude: one process, one reply per message it reads, numbered (the same session answers both).
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
case "$*" in
  *--input-format*) ;;
  *)
    # One of Ambient's own turns: a one-shot run beside the chat's session.
    echo "$@" > internal-args.txt
    cat > internal-stdin.txt
    echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"looked\\",\\"session_id\\":\\"int-1\\",\\"num_turns\\":1}"
    exit 0 ;;
esac
echo "$@" > args.txt
n=0
while IFS= read -r line; do
  n=$((n+1))
  echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"reply $n\\",\\"session_id\\":\\"amb-1\\",\\"num_turns\\":1}"
done
`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    p = spawn(process.execPath, [RUNNER, "ambient"], {
      env: {
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
    await new Promise((r) => setTimeout(r, 300));

    for (const [text, want] of [
      ["First", "reply 1"],
      ["Second", "reply 2"],
    ]) {
      await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text });
      const c = await settled();
      expect(c.messages.at(-1)?.text, out).toBe(want);
    }
    // A file comes along: saved in the person's folder, named in the message.
    await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "Read this", attachments: [{ name: "notes.md", type: "text/markdown", data: Buffer.from("# Hi").toString("base64") }] });
    await settled();
    const saved = readdirSync(join(dir, "ambient", lena.user.uid, "attachments"));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/notes\.md$/);
    expect(readFileSync(join(dir, "ambient", lena.user.uid, "attachments", saved[0]!), "utf8")).toBe("# Hi");
    const args = readFileSync(join(dir, "ambient", lena.user.uid, "args.txt"), "utf8");
    expect(args).toContain("--input-format stream-json");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--disallowedTools mcp__ambient__set_routine_secret");
    expect(args).toContain("You run as Claude Code on VPS");
    expect(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).ambientSessions).toEqual({ [lena.user.uid]: "amb-1" });

    // Ambient's own turn: a one-shot session of its own, not the chat's (no resume, no stream input).
    expect(await s.ambient.internalTurn(lena.user.uid, "Lena", "[Heartbeat] Look at Blog draft.")).toBe("looked");
    const internalArgs = readFileSync(join(dir, "ambient", lena.user.uid, "internal-args.txt"), "utf8");
    expect(internalArgs).not.toContain("--resume");
    expect(internalArgs).not.toContain("--input-format");
    expect(internalArgs).toContain("--disallowedTools mcp__ambient__set_routine_secret");
    expect(internalArgs).toContain("a short session of your own");
    expect(readFileSync(join(dir, "ambient", lena.user.uid, "internal-stdin.txt"), "utf8")).toBe("[Heartbeat] Look at Blog draft.");
    // The chat's session goes on where it was: its next reply is its fourth.
    await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "Third" });
    expect((await settled()).messages.at(-1)?.text, out).toBe("reply 4");
    expect(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).ambientSessions).toEqual({ [lena.user.uid]: "amb-1" });
  }, 30_000);
});
