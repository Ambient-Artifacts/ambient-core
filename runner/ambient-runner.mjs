#!/usr/bin/env node
// ambient-runner: runs the Ambient routines of one computer (Linux with systemd and Claude Code).
//
//   sudo node ambient-runner.mjs setup <code>   connect this computer (code from the Ambient app)
//   ambient-runner sync                          every minute (ambient-runner.timer): one systemd
//                                                timer per routine, "Run now" requests started
//   ambient-runner run <routine-id>              what each routine's timer starts: claude -p
//   ambient-runner status | uninstall
//
// One file, no dependencies, Node 18 or newer. The gateway serves it at /runner/ambient-runner.mjs
// and `sync` replaces it when the gateway has a newer one.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, release, type } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.5.0";
const DEFAULT_SERVER = "https://mcp.ambientartifacts.si";

const CONFIG_DIR = "/etc/ambient-runner";
const CONFIG = join(CONFIG_DIR, "runner.env");
/** Optional, written by whoever runs the computer: variables every run gets (a team server's ANTHROPIC_API_KEY). */
const EXTRA = join(CONFIG_DIR, "extra.env");
const INSTALL_DIR = "/opt/ambient-runner";
const INSTALLED = join(INSTALL_DIR, "ambient-runner.mjs");
const STATE_DIR = process.env.AMBIENT_STATE_DIR || "/var/lib/ambient-runner";
const STATE = join(STATE_DIR, "state.json");
const UNIT_DIR = process.env.AMBIENT_UNIT_DIR || "/etc/systemd/system";
const PREFIX = "ambient-routine-";
/** A run is stopped after this long (systemd TimeoutStartSec). */
const RUN_LIMIT = "3h";
// Ed25519 public keys (SPKI, base64) whose signature an update must carry. The runner replaces
// itself as root, so the gateway's word (its hash) isn't enough: whoever controlled the gateway
// could otherwise run code as root on every connected computer. Updates are signed where the
// runner is released (ops/sign-runner.mjs), with a key that never goes to the gateway.
const RUNNER_KEYS = ["MCowBQYDK2VwAyEAuyLm3reOo6pWuKDgpQjUFRRVXx4FIZOc6peGpeT2WGU="];
const SUMMARY_MAX = 4000;
/**
 * Where the runner finds systemctl, getent and setpriv. It runs as root, so never on runner.env's
 * PATH: that one puts the routine user's own folders first and is for Claude Code's runs, and a
 * program the user (or a run) put there would run as root.
 */
const SYSTEM_PATH = (process.env.AMBIENT_SYSTEM_PATH || "/usr/sbin:/usr/bin:/sbin:/bin").split(":").filter(Boolean);
/**
 * Secret names a run never gets, whatever the gateway sends (the gateway refuses them too, as
 * RESERVED_ENV in gateway/src/routines/service.ts): what the computer sets itself, and variables
 * that change how Claude Code, git, a shell, a runtime or the network behave. setpriv starts as
 * root with the run's environment, so LD_PRELOAD and the like matter there as well.
 */
const RESERVED_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TMP|TEMP|TERM|LANG|LANGUAGE|LC_.*|IFS|ENV|BASH_ENV|BASH_FUNC_.*|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|EDITOR|VISUAL|PAGER|MANPAGER|GIT_.*|SSH_.*|GNUPGHOME|ANTHROPIC_.*|CLAUDE.*|AMBIENT_.*|LD_.*|DYLD_.*|NODE_.*|NPM_CONFIG_.*|YARN_.*|PYTHON.*|PIP_.*|PERL.*|RUBY.*|GEM_.*|BUNDLE_.*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|.*_PROXY|SSL_.*|CURL_.*|OPENSSL_.*|REQUESTS_CA_BUNDLE|XDG_.*|DOCKER_HOST)$/;

const log = (...a) => console.log(...a);

/** A system program by its full path (SYSTEM_PATH). */
function sys(name) {
  for (const d of SYSTEM_PATH) if (existsSync(join(d, name))) return join(d, name);
  return join(SYSTEM_PATH[0] ?? "/usr/bin", name);
}
const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// ---- config ----

/** KEY=value lines (systemd EnvironmentFile syntax, values unquoted). */
function readEnvFile(path) {
  const out = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Missing, or root's alone: a routine's run gets the same values from systemd (EnvironmentFile).
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function config() {
  const env = { ...readEnvFile(CONFIG), ...pick(process.env, /^AMBIENT_/) };
  if (!env.AMBIENT_HOST_TOKEN) die(`This computer isn't set up. Run: sudo node ambient-runner.mjs setup <code from the Ambient app>`);
  return {
    server: (env.AMBIENT_SERVER || DEFAULT_SERVER).replace(/\/+$/, ""),
    token: env.AMBIENT_HOST_TOKEN,
    user: env.AMBIENT_USER || "root",
    claude: env.AMBIENT_CLAUDE || "claude",
    claudeArgs: (env.AMBIENT_CLAUDE_ARGS ?? "--permission-mode auto").split(/\s+/).filter(Boolean),
    folder: env.AMBIENT_FOLDER || "",
    node: env.AMBIENT_NODE || process.execPath,
  };
}

function pick(obj, re) {
  return Object.fromEntries(Object.entries(obj).filter(([k, v]) => re.test(k) && v !== undefined));
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

// ---- the gateway ----

async function call(cfg, method, path, body, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${cfg.server}${path}`, {
        method,
        headers: { authorization: `Bearer ${cfg.token}`, "user-agent": `ambient-runner/${VERSION}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (res.ok) return json;
      const err = new Error(json.message || json.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    } catch (err) {
      const retryable = !err.status || err.status >= 500 || err.status === 429;
      if (!retryable || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

/** Run as the routine's user: the claude binary is theirs to change (the native installer puts it in their home). */
function claudeVersion(cfg) {
  try {
    const as = asUser(cfg.user);
    const out = execFileSync(cfg.claude, ["--version"], { encoding: "utf8", timeout: 20_000, env: runEnv(cfg, as ? { HOME: as.home } : {}), ...(as ? { uid: as.uid, gid: as.gid } : {}) });
    return out.trim().split("\n")[0].slice(0, 80);
  } catch {
    return "not found";
  }
}

/** What the app shows about this computer. Claude Code's version is checked once an hour. */
function info(cfg, state) {
  if (!state.claude || Date.now() - state.claude.at > 3600_000) state.claude = { at: Date.now(), version: claudeVersion(cfg) };
  return { hostname: hostname().slice(0, 120), os: `${type()} ${release()}`.slice(0, 120), runner: VERSION, claude: state.claude.version };
}

// ---- systemd ----

function systemctl(...args) {
  return spawnSync(sys("systemctl"), args, { encoding: "utf8" });
}

/** Characters a unit's Description can hold without systemd specifiers or line breaks. */
function label(name) {
  return name.replace(/[^\p{L}\p{N} _.,:'()&+-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "routine";
}

function serviceUnit(cfg, r) {
  return `# Written by ambient-runner from the Ambient app; changes here are overwritten.
[Unit]
Description=Ambient routine: ${label(r.name)}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# The runner itself runs as root and holds the computer's token; it starts Claude Code as
# ${cfg.user} (setpriv), who then can't read the token from the runner's process.
EnvironmentFile=${CONFIG}
EnvironmentFile=-${EXTRA}
ExecStart=${cfg.node} ${INSTALLED} run ${r.id}
TimeoutStartSec=${RUN_LIMIT}
`;
}

function timerUnit(r) {
  return `# Written by ambient-runner from the Ambient app; changes here are overwritten.
[Unit]
Description=Ambient routine: ${label(r.name)} (schedule)

[Timer]
OnCalendar=${r.onCalendar}
# Not caught up after downtime: a catch-up would also fire right after a schedule change.
Persistent=false
Unit=${PREFIX}${r.id}.service

[Install]
WantedBy=timers.target
`;
}

function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeFileSync(path, content);
  return true;
}

/** Bring this computer's systemd timers in line with its routines, and start requested runs. */
async function sync() {
  const cfg = config();
  const state = readState();
  const me = info(cfg, state);
  let out;
  try {
    out = await call(cfg, "POST", "/v1/host/sync", { info: me });
  } catch (err) {
    die(`Couldn't reach Ambient (${cfg.server}): ${err.message}`, err.status === 401 ? 3 : 1);
  }
  const routines = (out.routines ?? []).filter((r) => /^[a-z0-9]{8,64}$/.test(r.id) && /^[A-Za-z0-9*.,:/ _+-]+$/.test(r.onCalendar));
  const wanted = new Set(routines.map((r) => r.id));
  let reload = false;
  const changed = new Set();

  for (const r of routines) {
    const svc = writeIfChanged(join(UNIT_DIR, `${PREFIX}${r.id}.service`), serviceUnit(cfg, r));
    const tmr = writeIfChanged(join(UNIT_DIR, `${PREFIX}${r.id}.timer`), timerUnit(r));
    if (svc || tmr) {
      reload = true;
      changed.add(r.id);
    }
  }
  const gone = readdirSync(UNIT_DIR)
    .map((f) => new RegExp(`^${PREFIX}([a-z0-9]+)\\.(service|timer)$`).exec(f))
    .filter((m) => m && !wanted.has(m[1]));
  for (const id of new Set(gone.map((m) => m[1]))) {
    systemctl("disable", "--now", `${PREFIX}${id}.timer`);
    log(`Removed routine ${id}`);
  }
  for (const m of gone) {
    rmSync(join(UNIT_DIR, m[0]), { force: true });
    reload = true;
  }
  if (reload) systemctl("daemon-reload");

  const enabled = new Set(
    systemctl("list-unit-files", `${PREFIX}*.timer`, "--no-legend", "--plain")
      .stdout.split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[1] === "enabled")
      .map((p) => p[0].slice(PREFIX.length, -".timer".length)),
  );
  for (const r of routines) {
    const timer = `${PREFIX}${r.id}.timer`;
    if (r.enabled && (!enabled.has(r.id) || changed.has(r.id))) {
      systemctl("enable", timer);
      systemctl("restart", timer);
      log(`Scheduled "${r.name}": ${r.onCalendar}`);
    } else if (!r.enabled && enabled.has(r.id)) {
      systemctl("disable", "--now", timer);
      log(`Paused "${r.name}"`);
    }
    // A run already going: the requested one starts once it's done.
    if (r.runRequested && !["active", "activating"].includes(systemctl("is-active", `${PREFIX}${r.id}.service`).stdout.trim())) {
      systemctl("start", "--no-block", `${PREFIX}${r.id}.service`);
      log(`Started "${r.name}" (run now)`);
    }
  }
  writeState(state);
  if (out.runner?.sha256) await selfUpdate(cfg, out.runner);
}

/** The source as signed: the server line blanked, since each gateway writes its own address there. */
function canonicalSource(source) {
  return source.replace(/const DEFAULT_SERVER = "[^"]*";/, 'const DEFAULT_SERVER = "";');
}

/** Whether `signature` (base64) is one of RUNNER_KEYS' over the source. */
function signedRelease(source, signature, keys = RUNNER_KEYS) {
  if (typeof signature !== "string" || !signature) return false;
  const data = Buffer.from(canonicalSource(source), "utf8");
  return keys.some((k) => {
    try {
      return verify(null, data, createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  });
}

/** Replace the installed runner with the gateway's when it changed: only a signed release. */
async function selfUpdate(cfg, latest) {
  if (!existsSync(INSTALLED)) return;
  const mine = createHash("sha256").update(readFileSync(INSTALLED)).digest("hex");
  if (mine === latest.sha256) return;
  const res = await fetch(`${cfg.server}/runner/ambient-runner.mjs`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res?.ok) return;
  const source = await res.text();
  if (createHash("sha256").update(source).digest("hex") !== latest.sha256) return;
  // Signed without the server line, which only names the server for `setup`: an installed runner
  // talks to the one in its runner.env.
  if (!signedRelease(source, latest.signature)) {
    log(`Not updating to ${latest.version}: it isn't signed with Ambient's release key.`);
    return;
  }
  // Only forward: an older release is signed too, and going back to it would bring back what a
  // newer one fixed. The version is read from the signed source, not from what the gateway says.
  const theirs = /const VERSION = "([0-9.]+)";/.exec(source)?.[1];
  if (!theirs || !newer(theirs, VERSION)) {
    log(`Not updating to ${theirs ?? "a release without a version"}: this runner is ${VERSION}.`);
    return;
  }
  const tmp = `${INSTALLED}.new`;
  writeFileSync(tmp, source, { mode: 0o755 });
  if (spawnSync(process.execPath, ["--check", tmp]).status !== 0) return rmSync(tmp, { force: true });
  renameSync(tmp, INSTALLED);
  log(`Updated the runner to ${latest.version}`);
}

/** Is version `a` (1.2.3) after `b`? */
function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Who other than root could change `file`: its owner, or anyone through group or other write on it or its folders. */
function changeableByOthers(file) {
  for (let p = file; ; p = dirname(p)) {
    const st = statSync(p);
    if (st.uid !== 0) return `its owner (uid ${st.uid}${p === file ? "" : `, of ${p}`})`;
    // A folder with the sticky bit (/tmp) is fine for what root owns in it.
    if (st.mode & 0o022 && !(st.isDirectory() && st.mode & 0o1000)) return `others (group or world write on ${p})`;
    if (p === dirname(p)) return null;
  }
}

// ---- one run ----

function home(user) {
  return account(user).home;
}

/** A local account's uid, gid and home, from passwd. */
function account(user) {
  const f = (spawnSync(sys("getent"), ["passwd", user], { encoding: "utf8" }).stdout ?? "").trim().split(":");
  return { uid: Number(f[2] ?? NaN), gid: Number(f[3] ?? NaN), home: f[5] || (user === "root" ? "/root" : `/home/${user}`) };
}

/** As root, the routine's user (to run their programs as them); otherwise null (already them). */
function asUser(user) {
  if (process.getuid?.() !== 0 || !user || user === "root") return null;
  const a = account(user);
  if (!Number.isInteger(a.uid) || !Number.isInteger(a.gid)) throw new Error(`no user ${user}`);
  return a;
}

function expand(folder, user) {
  if (folder === "~") return home(user);
  return folder.startsWith("~/") ? join(home(user), folder.slice(2)) : folder;
}

/** The environment Claude Code runs in: the runner's, without the computer's token. */
function runEnv(cfg, extra = {}, secrets = {}) {
  const allowed = Object.fromEntries(Object.entries(secrets).filter(([k]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && !RESERVED_ENV.test(k)));
  const env = { ...process.env, ...allowed, ...extra };
  delete env.AMBIENT_HOST_TOKEN;
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") delete env[k];
  return env;
}

function systemPrompt(routine, trigger) {
  const how = trigger === "manual" ? 'started with "Run now" in the Ambient app' : "started by its schedule";
  return [
    `You're running the Ambient routine "${routine.name}" on ${hostname()}, ${how}.`,
    "Nobody is watching this run and nobody can answer questions: make reasonable choices and say what you assumed.",
    "Your VERY LAST message becomes the run result shown in the Ambient app — make it a short, useful summary of what you did and anything a person needs to look at. Do not add anything after it (no 'all done', no 'finished').",
  ].join(" ");
}

/** One line per step for the journal (journalctl -u ambient-routine-<id>). */
function journalLine(event) {
  if (event.type === "assistant") {
    for (const c of event.message?.content ?? []) {
      if (c.type === "text" && c.text.trim()) log(`› ${c.text.trim().replace(/\s+/g, " ").slice(0, 300)}`);
      if (c.type === "tool_use") {
        const input = c.input ?? {};
        const what = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.description ?? "";
        log(`· ${c.name}${what ? `: ${String(what).replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
      }
    }
  }
}

async function run(id) {
  const cfg = config();
  if (!/^[a-z0-9]{8,64}$/.test(id ?? "")) die("usage: ambient-runner run <routine-id>", 2);
  let start;
  try {
    start = await call(cfg, "POST", `/v1/host/routines/${id}/runs`, undefined, { retries: 4 });
  } catch (err) {
    if (err.status === 404) {
      log("This routine no longer exists; the next sync removes its timer.");
      return;
    }
    die(`Couldn't start the run: ${err.message}`);
  }
  // `env`: the owner's secrets (a GitHub token, say). They go to Claude Code's environment only.
  const { run: runInfo, routine, env: secrets = {} } = start;
  const user = cfg.user;
  const folder = routine.folder ? expand(routine.folder, user) : cfg.folder || home(user);
  log(`Run ${runInfo.id} of "${routine.name}" (${runInfo.trigger}) in ${folder}`);

  const finish = async (result) => {
    try {
      await call(cfg, "POST", `/v1/host/runs/${runInfo.id}`, result, { retries: 4 });
    } catch (err) {
      console.error(`Couldn't report the run: ${err.message}`);
    }
  };

  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    await finish({ status: "failed", summary: `The folder ${folder} doesn't exist on ${hostname()}.` });
    process.exit(1);
  }

  const args = ["-p", "--output-format", "stream-json", "--verbose", ...cfg.claudeArgs, "--append-system-prompt", systemPrompt(routine, runInfo.trigger)];
  // As root (the runner's own units), Claude Code runs as the routine's user, with that user's
  // groups: the token stays in this process, which that user can't read.
  const drop = process.getuid?.() === 0 && user !== "root";
  const as = drop ? account(user) : null;
  if (drop && (!Number.isInteger(as.uid) || !Number.isInteger(as.gid) || spawnSync(sys("setpriv"), ["--version"]).status !== 0)) {
    await finish({ status: "failed", summary: `Can't run as ${user} on ${hostname()}: the account or setpriv (util-linux) is missing.` });
    process.exit(1);
  }
  const child = spawn(drop ? sys("setpriv") : cfg.claude, drop ? ["--reuid", String(as.uid), "--regid", String(as.gid), "--init-groups", "--", cfg.claude, ...args] : args, {
    cwd: folder,
    env: runEnv(
      cfg,
      {
        AMBIENT_ROUTINE_ID: routine.id,
        AMBIENT_ROUTINE_NAME: routine.name,
        AMBIENT_RUN_ID: runInfo.id,
        ...(drop ? { HOME: as.home, USER: user, LOGNAME: user } : {}),
      },
      secrets,
    ),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(routine.prompt);

  let result = null;
  let stderr = "";
  let stopped = false;
  // Progress: tool uses and status lines the app shows while the run is going.
  const progressLines = [];
  let progressDirty = false;
  let bestText = "";  // longest text block seen — fallback if the result text is generic
  const reportProgress = async () => {
    if (!progressDirty) return;
    progressDirty = false;
    try {
      await call(cfg, "PATCH", `/v1/host/runs/${runInfo.id}`, {
        summary: progressLines.join("\n").slice(0, SUMMARY_MAX),
      }, { retries: 0 });
    } catch {
      // Best effort; the final result always goes through.
    }
  };
  const progressTimer = setInterval(reportProgress, 5_000);
  progressTimer.unref();

  createInterface({ input: child.stdout }).on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return log(line);
    }
    if (event.type === "result") result = event;
    else {
      journalLine(event);
      if (event.type === "assistant") {
        for (const c of event.message?.content ?? []) {
          if (c.type === "tool_use") {
            const input = c.input ?? {};
            const what = input.command ?? input.file_path ?? input.description ?? "";
            progressLines.push(`· ${c.name}${what ? `: ${String(what).replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
            progressDirty = true;
          } else if (c.type === "text" && c.text.trim()) {
            const trimmed = c.text.trim();
            if (trimmed.length > bestText.length) bestText = trimmed;
            // The latest text replaces the previous one (it's the current status, not a log).
            if (progressLines.length && progressLines[progressLines.length - 1].startsWith("› ")) progressLines.pop();
            progressLines.push(`› ${trimmed.replace(/\s+/g, " ").slice(0, 200)}`);
            progressDirty = true;
          }
        }
      }
    }
  });
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-4000);
    process.stderr.write(d);
  });
  const stop = () => {
    stopped = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const code = await new Promise((resolve) => {
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      resolve(127);
    });
    child.on("close", (c) => resolve(c ?? 1));
  });
  clearInterval(progressTimer);

  const ok = code === 0 && result && !result.is_error && !stopped;
  let summary = typeof result?.result === "string" ? result.result : "";
  // If the model's last message was a generic wrap-up, use the longest text it wrote instead.
  if (ok && summary.length < 80 && bestText.length > summary.length) summary = bestText;
  if (!ok) {
    const why = stopped
      ? `Stopped: the run reached its ${RUN_LIMIT} limit or was stopped on ${hostname()}.`
      : code === 127
        ? `Claude Code wasn't found at ${cfg.claude}.`
        : `Claude Code ended with exit code ${code}${result?.subtype ? ` (${result.subtype})` : ""}.`;
    const tail = stderr.trim().split("\n").slice(-6).join("\n");
    summary = [why, summary, tail].filter(Boolean).join("\n\n");
  }
  await finish({
    status: ok ? "succeeded" : "failed",
    exitCode: code,
    summary: summary.slice(0, SUMMARY_MAX * 2) || undefined,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    turns: typeof result?.num_turns === "number" ? result.num_turns : undefined,
    sessionId: typeof result?.session_id === "string" ? result.session_id : undefined,
  });
  log(`Run ${ok ? "succeeded" : "failed"} (exit ${code}${result?.total_cost_usd !== undefined ? `, $${Number(result.total_cost_usd).toFixed(2)}` : ""})`);
  process.exit(ok ? 0 : 1);
}

// ---- setup ----

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function findClaude(user) {
  const dirs = [...(process.env.PATH ?? "").split(":"), join(home(user), ".local/bin"), join(home(user), ".claude/local"), "/usr/local/bin", "/usr/bin"];
  for (const d of dirs) if (d && existsSync(join(d, "claude"))) return join(d, "claude");
  return undefined;
}

/** Is Claude Code signed in for `user` (or is there an API key)? */
function claudeSignedIn(claude, user, env) {
  if (env.ANTHROPIC_API_KEY) return true;
  const r = spawnSync(claude, ["auth", "status"], { encoding: "utf8", timeout: 30_000, env: { ...env, HOME: home(user) }, uid: uidOf(user), gid: gidOf(user) });
  try {
    return JSON.parse(r.stdout).loggedIn === true;
  } catch {
    return false;
  }
}

function uidOf(user) {
  const line = (spawnSync(sys("getent"), ["passwd", user], { encoding: "utf8" }).stdout ?? "").trim();
  const uid = Number(line.split(":")[2]);
  return Number.isInteger(uid) ? uid : undefined;
}

function gidOf(user) {
  const line = (spawnSync(sys("getent"), ["passwd", user], { encoding: "utf8" }).stdout ?? "").trim();
  const gid = Number(line.split(":")[3]);
  return Number.isInteger(gid) ? gid : undefined;
}

async function setup(args) {
  const code = args.find((a) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(a));
  if (!code) die("usage: sudo node ambient-runner.mjs setup <code> [--user <name>] [--path <dirs to put first on PATH>] [--server <url>]", 2);
  if (process.getuid?.() !== 0) die("Run setup with sudo: it installs systemd units.");
  if (spawnSync(sys("systemctl"), ["--version"]).status !== 0) die("This computer has no systemd. Routines need Linux with systemd for now.");
  // systemd runs this Node as root every minute: someone who can change it would get root.
  const unsafe = changeableByOthers(process.execPath);
  if (unsafe) die(`${process.execPath} can be changed by ${unsafe}, and the runner runs it as root. Install Node for the whole system (owned by root, e.g. /usr/bin/node) and run setup with that one.`);

  const user = flag(args, "user") || process.env.SUDO_USER || "root";
  const uid = uidOf(user);
  if (uid === undefined) die(`There's no user "${user}" on this computer.`);
  const userHome = home(user);
  const extraPath = flag(args, "path") ? flag(args, "path").split(":") : [];
  const claude = flag(args, "claude") || findClaude(user);
  if (!claude) die(`Claude Code isn't installed for ${user}. Install it (https://claude.com/claude-code), sign in, then run setup again.`);
  const path = [...new Set([...extraPath, dirname(process.execPath), dirname(claude), join(userHome, ".local/bin"), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"])].join(":");
  const env = { PATH: path, HOME: userHome, ...readEnvFile(EXTRA) };
  if (!claudeSignedIn(claude, user, { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "", ...env })) {
    die(`Claude Code isn't signed in for ${user}. Run "claude" as ${user} once and sign in (or put ANTHROPIC_API_KEY in ${EXTRA}), then run setup again.`);
  }

  const server = (flag(args, "server") || DEFAULT_SERVER).replace(/\/+$/, "");
  const cfg = { server, token: "", claude, user };
  const me = { hostname: hostname().slice(0, 120), os: `${type()} ${release()}`.slice(0, 120), runner: VERSION, claude: claudeVersion({ ...cfg, claude }) };
  let out;
  try {
    out = await call(cfg, "POST", "/v1/host/setup", { code: code.toUpperCase(), info: me });
  } catch (err) {
    die(err.message);
  }

  const folder = join(userHome, "ambient-routines");
  mkdirSync(folder, { recursive: true });
  if (uid !== 0) chownSync(folder, uid, gidOf(user) ?? uid);
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const lines = {
    AMBIENT_SERVER: server,
    AMBIENT_HOST_TOKEN: out.token,
    AMBIENT_USER: user,
    AMBIENT_CLAUDE: claude,
    AMBIENT_CLAUDE_ARGS: flag(args, "claude-args") ?? "--permission-mode auto",
    AMBIENT_FOLDER: folder,
    AMBIENT_NODE: process.execPath,
    HOME: userHome,
    PATH: path,
  };
  writeFileSync(CONFIG, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(CONFIG, 0o600);

  mkdirSync(INSTALL_DIR, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  if (self !== INSTALLED) copyFileSync(self, INSTALLED);
  chmodSync(INSTALLED, 0o755);

  writeFileSync(
    join(UNIT_DIR, "ambient-runner.service"),
    `[Unit]
Description=Ambient routines: check for changes and requested runs
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=${CONFIG}
ExecStart=${process.execPath} ${INSTALLED} sync
TimeoutStartSec=5min
`,
  );
  writeFileSync(
    join(UNIT_DIR, "ambient-runner.timer"),
    `[Unit]
Description=Ambient routines: check every minute

[Timer]
OnBootSec=30s
OnCalendar=*-*-* *:*:00
AccuracySec=5s

[Install]
WantedBy=timers.target
`,
  );
  systemctl("daemon-reload");
  systemctl("enable", "--now", "ambient-runner.timer");
  systemctl("start", "ambient-runner.service");
  const whose = out.computer.team ? "The team's routines" : "Routines you add in the Ambient app";
  log(`Connected as "${out.computer.name}". ${whose} run here as ${user}, in ${folder} unless a routine names its own folder.`);
  log(`Logs: journalctl -u 'ambient-routine-*' -u ambient-runner`);
}

// ---- status, uninstall ----

function status() {
  const cfg = config();
  log(`ambient-runner ${VERSION}, server ${cfg.server}, runs as ${cfg.user}`);
  const r = systemctl("list-timers", `${PREFIX}*.timer`, "--all", "--no-pager");
  log(r.stdout.trim() || "No routines on this computer yet.");
}

function uninstall() {
  if (process.getuid?.() !== 0) die("Run uninstall with sudo.");
  for (const f of existsSync(UNIT_DIR) ? readdirSync(UNIT_DIR) : []) {
    if (f.startsWith(PREFIX) && f.endsWith(".timer")) systemctl("disable", "--now", f);
  }
  systemctl("disable", "--now", "ambient-runner.timer");
  for (const f of readdirSync(UNIT_DIR)) {
    if (f.startsWith(PREFIX) || f.startsWith("ambient-runner.")) rmSync(join(UNIT_DIR, f), { force: true });
  }
  systemctl("daemon-reload");
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  log("Removed. Remove the computer in the Ambient app too.");
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "setup":
    await setup(rest);
    break;
  case "sync":
    await sync();
    break;
  case "run":
    await run(rest[0]);
    break;
  case "status":
    status();
    break;
  case "uninstall":
    uninstall();
    break;
  case "--version":
  case "version":
    log(VERSION);
    break;
  default:
    die("usage: ambient-runner setup <code> | sync | run <routine-id> | status | uninstall", 2);
}
