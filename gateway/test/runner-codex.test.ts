// The runner's Codex adapter (docs/bots.md, "Codex next to Claude Code"): the real runner script
// against a stand-in gateway, a stand-in codex (a run on the computer itself, its JSON events, a
// resume, a failure, the device-code sign-in) and a stand-in podman (a container run that copies
// the computer's ChatGPT sign-in in and keeps the refreshed one).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const HOST_TOKEN = "host-token-test";
const RUN_TOKEN = "run-token-test";

let start: Record<string, unknown> = {};
let finished: Record<string, unknown> | null = null;
let jobs: Record<string, unknown>[] = [];
let replies: Record<string, unknown>[] = [];
let server: Server;
let origin = "";
let dir = "";
let bin = "";
let work = "";

const EVENTS = [
  '{"type":"thread.started","thread_id":"thr-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"thinking"}}',
  '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"git status","aggregated_output":"","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Opened the PR."}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}',
];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (code: number, v: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (req.method === "POST" && /^\/v1\/host\/routines\/[a-z0-9]+\/runs$/.test(url.pathname)) json(200, start);
      else if (req.method === "POST" && url.pathname.startsWith("/v1/host/runs/")) {
        finished = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(204).end();
      } else if (req.method === "PATCH" && url.pathname.startsWith("/v1/host/runs/")) res.writeHead(204).end();
      else if (req.method === "GET" && url.pathname === "/v1/host/ambient/next") {
        const job = jobs.shift();
        if (job) json(200, job);
        else setTimeout(() => res.writeHead(204).end(), 200);
      } else if (req.method === "POST" && url.pathname.startsWith("/v1/host/ambient/")) {
        replies.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(204).end();
      } else json(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dir = mkdtempSync(join(tmpdir(), "ambient-runner-codex-"));
  bin = join(dir, "bin");
  work = join(dir, "work");
  mkdirSync(bin);
  mkdirSync(work);
  // Codex: its version, its sign-in, the device-code sign-in, and a run that records what it got,
  // updates memory.md and the handoff in the out folder named in its instructions, and prints events.
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  printf 'Welcome to Codex\\n\\nFollow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n\\n2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94mABCD-12345\\033[0m\\n'
  sleep 2
  exit 1
fi
printf '%s\\n' "$@" > codex-args.txt
cat > codex-prompt.txt
env | grep -E '^(AMBIENT_RUN_TOKEN|AMBIENT_SERVER|CODEX_API_KEY)=' | sort > codex-env.txt
for a in "$@"; do case "$a" in developer_instructions=*) printf '%s' "$a" > codex-dev.txt ;; esac; done
out=$(sed -n 's/.*OUTDIR=\\([^"]*\\)".*/\\1/p' codex-dev.txt 2>/dev/null)
if [ -n "$out" ]; then
  cat "$out/memory.md" > codex-seen-memory.txt
  printf 'learned\\n' >> "$out/memory.md"
  printf 'Status: done\\nAll good.\\n' > "$out/handoff.md"
fi
if [ -f fail ]; then
  echo '{"type":"thread.started","thread_id":"thr-9"}'
  echo '{"type":"error","message":"Reconnecting... 1/5"}'
  echo '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Incorrect API key provided, auth error code: invalid_api_key"}}'
  exit 1
fi
${EVENTS.map((e) => `echo '${e}'`).join("\n")}
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  // A container run: records podman's arguments; "refreshes" the sign-in it was given; prints Codex's events.
  writeFileSync(
    join(bin, "podman"),
    `#!/bin/sh
if [ "$1" = "image" ]; then exit 0; fi
printf '%s\\n' "$@" > "${join(dir, "podman-args.txt")}"
cat > /dev/null
prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then case "$a" in *:/opt/ambient/codex-auth) d="\${a%%:*}"; printf '{"tokens":{"refresh_token":"new"}}' > "$d/auth.json" ;; esac; fi
  prev="$a"
done
${EVENTS.map((e) => `echo '${e}'`).join("\n")}
`,
  );
  chmodSync(join(bin, "podman"), 0o755);
  // The loops' user, with a home of its own here (the runner looks it up like any account).
  mkdirSync(join(dir, "tester", ".codex"), { recursive: true });
  writeFileSync(join(bin, "getent"), `#!/bin/sh\necho "tester:x:0:0::${join(dir, "tester")}:/bin/sh"\n`);
  chmodSync(join(bin, "getent"), 0o755);
});

afterAll(() => server.close());

beforeEach(() => {
  finished = null;
  replies = [];
  rmSync(join(work, "fail"), { force: true });
  rmSync(join(dir, "openai.env"), { force: true });
});

const runner = (args: string[], timeoutMs?: number): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, ...args], {
      cwd: work,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        AMBIENT_SYSTEM_PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        AMBIENT_SERVER: origin,
        AMBIENT_HOST_TOKEN: HOST_TOKEN,
        AMBIENT_CODEX: join(bin, "codex"),
        AMBIENT_USER: "tester",
        AMBIENT_STATE_DIR: join(dir, "state"),
        AMBIENT_FOLDER: work,
        AMBIENT_OPENAI_ENV: join(dir, "openai.env"),
      },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = timeoutMs ? setTimeout(() => p.kill("SIGKILL"), timeoutMs) : undefined;
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out });
    });
  });

const lines = (file: string) => readFileSync(file, "utf8").split("\n");
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));

const bot = (isolation: "host" | "container") => ({ face: "classic", runtime: "codex", isolation, report: "news", model: { model: "gpt-5.5", effort: "max" } });

describe("a Codex bot on the computer itself", () => {
  it("runs codex exec with its instructions, model, sandbox and MCP server, and reports its events", async () => {
    start = {
      run: { id: "run00000001", trigger: "schedule" },
      routine: { id: "bot00000001", name: "Codex dev", prompt: "Wake up: fix the test.", folder: work },
      env: { GH_TOKEN: "ghp_x" },
      bot: bot("host"),
      resume: null,
      runToken: RUN_TOKEN,
      workspace: { system: "OUTDIR={{OUT}}", skills: [{ path: "release/SKILL.md", content: "not on the computer" }], memory: "Lena likes short PRs.\n" },
    };
    const out = await runner(["run", "bot00000001"]);
    expect(out.code, out.out).toBe(0);
    const args = lines(join(work, "codex-args.txt"));
    expect(args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(args.at(-2)).toBe("-");
    expect(after(args, "-m")).toBe("gpt-5.5");
    const c = configs(args);
    expect(c).toContain('model_reasoning_effort="xhigh"');
    expect(c).toContain('sandbox_mode="workspace-write"');
    expect(c).toContain("sandbox_workspace_write.network_access=true");
    expect(c.find((x) => x.startsWith("sandbox_workspace_write.writable_roots="))).toMatch(/\/runs\/run00000001\/out"\]$/);
    expect(c.find((x) => x.startsWith("developer_instructions="))).toMatch(/^developer_instructions="OUTDIR=\/.+\/runs\/run00000001\/out"$/);
    expect(c).toContain(`mcp_servers.ambient-bot.args=${JSON.stringify([RUNNER, "bot-mcp"])}`);
    expect(c).toContain('mcp_servers.ambient-bot.env_vars=["AMBIENT_SERVER","AMBIENT_RUN_TOKEN"]');
    expect(c.find((x) => x.startsWith("shell_environment_policy.exclude="))).toContain("AMBIENT_RUN_TOKEN");
    // The run's token is in Codex's environment, never on its command line.
    expect(args.join(" ")).not.toContain(RUN_TOKEN);
    expect(readFileSync(join(work, "codex-env.txt"), "utf8")).toBe(`AMBIENT_RUN_TOKEN=${RUN_TOKEN}\nAMBIENT_SERVER=${origin}\n`);
    expect(readFileSync(join(work, "codex-prompt.txt"), "utf8")).toBe("Wake up: fix the test.");
    expect(readFileSync(join(work, "codex-seen-memory.txt"), "utf8")).toBe("Lena likes short PRs.\n");
    expect(finished).toMatchObject({ status: "succeeded", summary: "Opened the PR.", sessionId: "thr-1", turns: 1, memory: "Lena likes short PRs.\nlearned\n", handoff: "Status: done\nAll good.\n" });
    expect(out.out).toContain("· Bash: git status");
    expect(out.out).toContain("· Edit: src/a.ts");
    // Host bots get no skills: nothing in the user's own Codex home.
    expect(existsSync(join(dir, "tester", ".codex", "skills"))).toBe(false);
  });

  it("resumes its thread with the message, and uses the OpenAI key chosen in Ambient", async () => {
    writeFileSync(join(dir, "openai.env"), "CODEX_API_KEY=sk-proj-test\n");
    start = {
      run: { id: "run00000002", trigger: "manual" },
      routine: { id: "bot00000001", name: "Codex dev", prompt: "Wake up.", folder: work },
      env: {},
      bot: bot("host"),
      resume: { sessionId: "thr-1", message: "Lena answered your question: yes" },
      runToken: RUN_TOKEN,
    };
    const out = await runner(["run", "bot00000001"]);
    expect(out.code, out.out).toBe(0);
    const args = lines(join(work, "codex-args.txt"));
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args.slice(-3, -1)).toEqual(["thr-1", "-"]);
    expect(readFileSync(join(work, "codex-prompt.txt"), "utf8")).toBe("Lena answered your question: yes");
    expect(readFileSync(join(work, "codex-env.txt"), "utf8")).toContain("CODEX_API_KEY=sk-proj-test");
    // No workspace from the gateway: the runner's own instructions, and no memory or handoff back.
    expect(configs(args).find((x) => x.startsWith("developer_instructions="))).toContain("one of your owner's bots in Ambient");
    expect(finished).not.toHaveProperty("memory");
  });

  it("fails with Codex's own words when it can't sign in", async () => {
    writeFileSync(join(work, "fail"), "");
    start = { run: { id: "run00000003", trigger: "schedule" }, routine: { id: "bot00000001", name: "Codex dev", prompt: "x", folder: work }, env: {}, bot: bot("host"), resume: null, runToken: RUN_TOKEN };
    const out = await runner(["run", "bot00000001"]);
    expect(out.code).toBe(1);
    expect(finished).toMatchObject({ status: "failed", sessionId: "thr-9" });
    expect(String(finished!.summary)).toMatch(/^Codex ended with exit code 1\./);
    expect(String(finished!.summary)).toContain("invalid_api_key");
  });
});

describe("a Codex bot in its container", () => {
  it("copies the computer's ChatGPT sign-in in, runs Codex through the shell, and keeps the refreshed sign-in", async () => {
    writeFileSync(join(dir, "tester", ".codex", "auth.json"), '{"tokens":{"refresh_token":"old"}}');
    start = {
      run: { id: "run00000004", trigger: "manual" },
      routine: { id: "bot00000004", name: "Boxed codex", prompt: "Wake up.", folder: null },
      env: { GH_TOKEN: "ghp_x" },
      bot: bot("container"),
      resume: null,
      runToken: RUN_TOKEN,
      workspace: { system: "Memory at {{OUT}}/memory.md", skills: [{ path: "release/SKILL.md", content: "# Release" }], memory: "" },
    };
    const out = await runner(["run", "bot00000004"]);
    expect(out.code, out.out).toBe(0);
    const args = lines(join(dir, "podman-args.txt"));
    const mounts = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));
    expect(mounts).toContainEqual(expect.stringMatching(/\/runs\/run00000004\/codex-auth:\/opt\/ambient\/codex-auth$/));
    expect(mounts).toContainEqual(expect.stringMatching(/\/runs\/run00000004\/skills:\/opt\/ambient\/skills:ro$/));
    const image = args.indexOf("localhost/ambient-bot:3");
    expect(args.slice(image + 1, image + 3)).toEqual(["sh", "-c"]);
    const script = args.slice(image + 3).join("\n");
    expect(script).toContain('codex "$@"');
    expect(script).toContain("$HOME/.codex/skills");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(configs(args)).toContain('developer_instructions="Memory at /opt/ambient/out/memory.md"');
    expect(configs(args)).toContain(`mcp_servers.ambient-bot.command="node"`);
    // The container gets its secrets and the run's token for its MCP server, no Claude sign-in.
    const envs = args.flatMap((a, i) => (args[i - 1] === "-e" ? [a] : []));
    expect(envs).toEqual(expect.arrayContaining(["GH_TOKEN", "AMBIENT_SERVER", "AMBIENT_RUN_TOKEN"]));
    expect(envs).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(finished).toMatchObject({ status: "succeeded", summary: "Opened the PR.", sessionId: "thr-1" });
    expect(readFileSync(join(dir, "tester", ".codex", "auth.json"), "utf8")).toBe('{"tokens":{"refresh_token":"new"}}');
  });
});

describe("Codex's sign-in with a ChatGPT plan", () => {
  it("sends the link and the one-time code back for a codex-login job", async () => {
    jobs = [{ id: "job-login-1", kind: "codex-login" }];
    const run = runner(["ambient"], 8000);
    for (let i = 0; i < 100 && !replies.length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(replies[0]).toBeDefined();
    const sent = JSON.parse(String(replies[0]!.text)) as { url: string; code: string; expiresAt: number };
    expect(sent).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "ABCD-12345" });
    expect(sent.expiresAt).toBeGreaterThan(Date.now());
    await run;
  }, 15_000);
});
