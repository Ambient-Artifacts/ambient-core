// The runner's side of a bot's folder (docs/bots.md, "A bot's folder, its memory and its
// handoffs"): the real runner script against a stand-in gateway, with a stand-in claude (a run on
// the computer itself) and a stand-in podman (a run in a container). The runner carries files: the
// run's instructions, memory.md and handoff.md in an out folder, skills in the container, and what
// the bot left in memory.md and handoff.md back with the result. Plus bot-mcp's search_history.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const HOST_TOKEN = "host-token-test";
const RUN_TOKEN = "run-token-test";

type Start = Record<string, unknown>;
let start: Start = {};
let finished: Record<string, unknown> | null = null;
let history: { query: string; auth: string | undefined } | null = null;
let server: Server;
let origin = "";
let dir = "";
let bin = "";

const result = (text: string) => `echo '{"type":"result","subtype":"success","is_error":false,"result":"${text}","total_cost_usd":0.1,"num_turns":2,"session_id":"sess-1"}'`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST" && /^\/v1\/host\/routines\/[a-z0-9]+\/runs$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(start));
      } else if (req.method === "POST" && url.pathname.startsWith("/v1/host/runs/")) {
        finished = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(204).end();
      } else if (req.method === "PATCH" && url.pathname.startsWith("/v1/host/runs/")) {
        res.writeHead(204).end();
      } else if (req.method === "GET" && url.pathname === "/v1/bot/history") {
        history = { query: url.search, auth: req.headers.authorization };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ results: [{ at: Date.UTC(2026, 10, 10, 9, 30), who: "Lena", where: "thread", text: "Never  publish\non Fridays." }] }),
        );
      } else {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dir = mkdtempSync(join(tmpdir(), "ambient-runner-folder-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "work"));
  // A run on the computer itself: finds its out folder in the system text, reads memory.md, adds a
  // line to it and writes a handoff.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
printf '%s\\n' "$@" > args.txt
cat > prompt.txt
out=""
for a in "$@"; do case "$a" in OUTDIR=*) out="\${a#OUTDIR=}" ;; esac; done
if [ -n "$out" ]; then
  cat "$out/memory.md" > seen-memory.txt
  printf 'Lena wants short PR titles.\\n' >> "$out/memory.md"
  printf 'Status: continue\\nNext: open the PR.\\n' > "$out/handoff.md"
fi
${result("Did it.")}
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  // A container run: records podman's arguments, one per line.
  writeFileSync(
    join(bin, "podman"),
    `#!/bin/sh
if [ "$1" = "image" ]; then exit 0; fi
printf '%s\\n' "$@" > "${join(dir, "podman-args.txt")}"
cat > /dev/null
${result("Boxed run done.")}
`,
  );
  chmodSync(join(bin, "podman"), 0o755);
});

afterAll(() => server.close());

beforeEach(() => {
  finished = null;
  history = null;
});

const runner = (args: string[]): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, ...args], {
      cwd: join(dir, "work"),
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        AMBIENT_SYSTEM_PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        AMBIENT_SERVER: origin,
        AMBIENT_HOST_TOKEN: HOST_TOKEN,
        AMBIENT_CLAUDE: join(bin, "claude"),
        AMBIENT_STATE_DIR: join(dir, "state"),
        AMBIENT_FOLDER: join(dir, "work"),
      },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });

const lines = (file: string) => readFileSync(file, "utf8").split("\n");
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("a bot's folder on the computer", () => {
  it("gives the run its instructions and memory, and sends back memory and handoff", async () => {
    start = {
      run: { id: "run00000001", trigger: "schedule" },
      routine: { id: "bot00000001", name: "Release notes", prompt: "Wake up: write the release notes.", folder: join(dir, "work") },
      env: {},
      bot: { face: "classic", runtime: "claude-code", isolation: "host", report: "news" },
      resume: null,
      runToken: RUN_TOKEN,
      workspace: { system: "OUTDIR={{OUT}}", skills: [{ path: "release/SKILL.md", content: "never on the computer" }], memory: "Lena likes bullet points.\n" },
    };
    const out = await runner(["run", "bot00000001"]);
    expect(out.code, out.out).toBe(0);
    const args = lines(join(dir, "work", "args.txt"));
    // The gateway's text replaces the runner's own, with the real out folder for {{OUT}}.
    const system = after(args, "--append-system-prompt")!;
    expect(system).toMatch(/^OUTDIR=\/.+\/runs\/run00000001\/out$/);
    expect(args.join(" ")).not.toContain("one of your owner's bots in Ambient");
    expect(after(args, "--allowedTools")).toBe("mcp__ambient-bot__ask_owner,mcp__ambient-bot__search_history");
    expect(readFileSync(join(dir, "work", "prompt.txt"), "utf8")).toBe("Wake up: write the release notes.");
    expect(readFileSync(join(dir, "work", "seen-memory.txt"), "utf8")).toBe("Lena likes bullet points.\n");
    expect(finished).toMatchObject({
      status: "succeeded",
      summary: "Did it.",
      memory: "Lena likes bullet points.\nLena wants short PR titles.\n",
      handoff: "Status: continue\nNext: open the PR.\n",
    });
    // Skills never go into the user's own ~/.claude, and the run's folder is gone afterwards.
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, "state", "runs", "run00000001"))).toBe(false);
  });

  it("runs as before when the gateway sends no workspace", async () => {
    start = {
      run: { id: "run00000002", trigger: "schedule" },
      routine: { id: "bot00000002", name: "Old gateway", prompt: "Just the prompt.", folder: join(dir, "work") },
      env: {},
      bot: { face: "classic", runtime: "claude-code", isolation: "host", report: "news" },
      resume: null,
      runToken: RUN_TOKEN,
    };
    const out = await runner(["run", "bot00000002"]);
    expect(out.code, out.out).toBe(0);
    expect(lines(join(dir, "work", "args.txt")).join(" ")).toContain("one of your owner's bots in Ambient");
    expect(finished).toMatchObject({ status: "succeeded", summary: "Did it." });
    expect(finished).not.toHaveProperty("memory");
    expect(finished).not.toHaveProperty("handoff");
  });
});

describe("a bot's folder in its container", () => {
  /** The shell the runner gave the container (the first test), run again in the second. */
  let shell = "";
  it("mounts the out folder and the skills, and puts the skills in place before Claude Code", async () => {
    start = {
      run: { id: "run00000003", trigger: "manual" },
      routine: { id: "bot00000003", name: "Boxed", prompt: "Wake up.", folder: null },
      env: {},
      bot: { face: "round", runtime: "claude-code", isolation: "container", report: "news" },
      resume: null,
      runToken: RUN_TOKEN,
      workspace: {
        system: "Your memory: {{OUT}}/memory.md. Your handoff: {{OUT}}/handoff.md.",
        skills: [
          { path: "release/SKILL.md", content: "# Release\nWrite notes." },
          { path: "release/templates/notes.md", content: "## Notes" },
          { path: "../escape/SKILL.md", content: "no" },
          { path: "Bad/SKILL.md", content: "no" },
        ],
        memory: "remember this",
      },
    };
    const out = await runner(["run", "bot00000003"]);
    expect(out.code, out.out).toBe(0);
    expect(out.out).toContain("Skipping a skill file");
    const args = lines(join(dir, "podman-args.txt"));
    const mounts = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));
    expect(mounts).toContainEqual(expect.stringMatching(/\/runs\/run00000003\/out:\/opt\/ambient\/out$/));
    expect(mounts).toContainEqual(expect.stringMatching(/\/runs\/run00000003\/skills:\/opt\/ambient\/skills:ro$/));
    // The image runs a small shell first, which then becomes Claude Code with the same arguments.
    const image = args.indexOf("localhost/ambient-bot:3");
    expect(args.slice(image + 1, image + 3)).toEqual(["sh", "-c"]);
    const script = args.slice(image + 3).join("\n").split("\nsh\n")[0]!;
    expect(script).toContain('exec claude "$@"');
    shell = script;
    expect(after(args, "--append-system-prompt")).toBe("Your memory: /opt/ambient/out/memory.md. Your handoff: /opt/ambient/out/handoff.md.");
    // Nothing written in the container: memory as it was, an empty handoff.
    expect(finished).toMatchObject({ status: "succeeded", memory: "remember this", handoff: "" });
  });

  it("swaps the skills it put there last time, and leaves the bot's own", () => {
    // The shell from the runner, run here with a stand-in claude and folders of our own.
    expect(shell).toContain("/opt/ambient/skills");
    const script = shell.replaceAll("/opt/ambient/skills", join(dir, "skills-in"));
    const home = join(dir, "bot-home");
    const skills = join(home, ".claude", "skills");
    mkdirSync(join(skills, "old"), { recursive: true });
    mkdirSync(join(skills, "mine"), { recursive: true });
    writeFileSync(join(skills, "old", "SKILL.md"), "old");
    writeFileSync(join(skills, "mine", "SKILL.md"), "the bot's own");
    writeFileSync(join(skills, ".ambient-managed"), "old\n");
    mkdirSync(join(dir, "skills-in", "release", "templates"), { recursive: true });
    writeFileSync(join(dir, "skills-in", "release", "SKILL.md"), "# Release");
    writeFileSync(join(dir, "skills-in", "release", "templates", "notes.md"), "## Notes");
    const r = spawnSync("sh", ["-c", script, "sh", "--model", "x"], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, cwd: home, encoding: "utf8", input: "" });
    expect(r.status, r.stderr).toBe(0);
    expect(lines(join(home, "args.txt"))).toEqual(["--model", "x", ""]);
    expect(existsSync(join(skills, "old"))).toBe(false);
    expect(readFileSync(join(skills, "mine", "SKILL.md"), "utf8")).toBe("the bot's own");
    expect(readFileSync(join(skills, "release", "templates", "notes.md"), "utf8")).toBe("## Notes");
    expect(readFileSync(join(skills, ".ambient-managed"), "utf8")).toBe("release\n");
  });
});

describe("bot-mcp", () => {
  it("serves search_history with the run token", async () => {
    const p = spawn(process.execPath, [RUNNER, "bot-mcp"], { env: { PATH: process.env.PATH ?? "", AMBIENT_SERVER: origin, AMBIENT_RUN_TOKEN: RUN_TOKEN } });
    const replies = new Map<number, Record<string, unknown>>();
    createInterface({ input: p.stdout }).on("line", (l) => {
      const m = JSON.parse(l) as { id: number; result: Record<string, unknown> };
      replies.set(m.id, m.result);
    });
    const send = (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`);
    const reply = async (id: number) => {
      for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 25));
      return replies.get(id)!;
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await reply(1);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(((await reply(2)).tools as { name: string }[]).map((t) => t.name)).toEqual(["ask_owner", "search_history"]);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_history", arguments: { query: "fridays", from: "2026-11-01", limit: 99 } } });
    const out = await reply(3);
    expect((out.content as { text: string }[])[0]!.text).toBe("2026-11-10 09:30 Lena (thread): Never publish on Fridays.");
    expect(history).toEqual({ query: "?q=fridays&from=2026-11-01&limit=50", auth: `Bearer ${RUN_TOKEN}` });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_history", arguments: {} } });
    expect(await reply(4)).toMatchObject({ isError: true });
    p.kill();
  });
});
