#!/usr/bin/env node
// ambient-runner: runs the Ambient routines of one computer (Linux with systemd and Claude Code).
//
//   sudo node ambient-runner.mjs setup <code>   connect this computer (code from the Ambient app)
//   ambient-runner sync                          every minute (ambient-runner.timer): one systemd
//                                                timer per routine, "Run now" requests started
//   ambient-runner run <routine-id>              what each routine's timer starts: claude -p (a bot
//                                                with isolation "container": in its own Podman container)
//   ambient-runner bot-mcp                       the ask_owner tool a bot's run gets (MCP over stdio)
//   ambient-runner image                         build the bots' container image now
//   ambient-runner ambient                       Ambient on this computer: one Claude Code session that
//                                                stays open, answering the person's chat (a service)
//   ambient-runner claude-status                 "signed-in" or "missing": can Claude Code run here
//   ambient-runner claude-token                  a Claude plan's token on stdin (from `claude setup-token`),
//                                                stored in Ambient as this computer's sign-in
//   ambient-runner status | uninstall
//
// install.sh (served next to this file at /install.sh) installs what's missing and runs setup.
//
// One file, no dependencies, Node 18 or newer. The gateway serves it at /runner/ambient-runner.mjs
// and `sync` replaces it when the gateway has a newer one.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { chmodSync, chownSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, release, tmpdir, type } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.16.0";
const DEFAULT_SERVER = "https://mcp.ambientartifacts.si";

// Tests point it elsewhere, so a runner installed on the same machine never leaks into them.
const CONFIG_DIR = process.env.AMBIENT_CONFIG_DIR || "/etc/ambient-runner";
const CONFIG = join(CONFIG_DIR, "runner.env");
/** Optional, written by whoever runs the computer: variables every run gets (a team server's ANTHROPIC_API_KEY). */
const EXTRA = join(CONFIG_DIR, "extra.env");
/** The Claude sign-in chosen in Ambient (a plan's token or an API key), fetched by sync. Wins over extra.env. */
const CLAUDE_ENV = process.env.AMBIENT_CLAUDE_ENV || join(CONFIG_DIR, "claude.env");
/** The OpenAI key chosen in Ambient for Codex bots (docs/bots.md, "Codex next to Claude Code"). */
const OPENAI_ENV = process.env.AMBIENT_OPENAI_ENV || join(CONFIG_DIR, "openai.env");
const INSTALL_DIR = process.env.AMBIENT_INSTALL_DIR || "/opt/ambient-runner";
const INSTALLED = join(INSTALL_DIR, "ambient-runner.mjs");
const STATE_DIR = process.env.AMBIENT_STATE_DIR || "/var/lib/ambient-runner";
const STATE = join(STATE_DIR, "state.json");
const UNIT_DIR = process.env.AMBIENT_UNIT_DIR || "/etc/systemd/system";
const PREFIX = "ambient-routine-";
/** A run is stopped after this long (systemd TimeoutStartSec). */
const RUN_LIMIT = "3h";
/** How often a bot's run asks for messages that came in while it works, and how many it takes in. */
const INBOX_EVERY_MS = Number(process.env.AMBIENT_INBOX_EVERY_S || 2) * 1000;
const INBOX_MAX = 20;
/** How long a bot's session waits after a turn for one more message before it closes. */
const STAY_MS = Number(process.env.AMBIENT_BOT_STAY_S || 3) * 1000;
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
    /** Codex for Codex bots: this path, or found in the routine user's PATH when it runs. */
    codex: env.AMBIENT_CODEX || "",
    claudeArgs: (env.AMBIENT_CLAUDE_ARGS ?? "--permission-mode auto").split(/\s+/).filter(Boolean),
    folder: env.AMBIENT_FOLDER || "",
    node: env.AMBIENT_NODE || process.execPath,
    /** "own": Ambient's sessions use the user's own Claude Code settings (~/.claude) even with a sign-in from Ambient. */
    claudeConfig: env.AMBIENT_CLAUDE_CONFIG === "own" ? "own" : "isolated",
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

/**
 * Whether Claude Code can run here: a sign-in from Ambient or the computer's own token or key, or
 * else Claude Code's own login for the routine user (`claude auth status`).
 */
function claudeLogin(cfg) {
  const env = runEnv(cfg);
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return true;
  try {
    const as = asUser(cfg.user);
    // In a folder of the runner's, with nothing on stdin: it only reads its own settings.
    const cwd = existsSync(STATE_DIR) ? STATE_DIR : tmpdir();
    const r = spawnSync(cfg.claude, ["auth", "status"], { cwd, input: "", encoding: "utf8", timeout: 30_000, env: runEnv(cfg, as ? { HOME: as.home } : {}), ...(as ? { uid: as.uid, gid: as.gid } : {}) });
    return JSON.parse(r.stdout).loggedIn === true;
  } catch {
    return false;
  }
}

/** What the app shows about this computer. Claude Code's and Codex's versions (and Claude's own login) are checked once an hour. */
function info(cfg, state) {
  if (!state.claude || Date.now() - state.claude.at > 3600_000 || state.claude.login === undefined) state.claude = { at: Date.now(), version: claudeVersion(cfg), login: claudeLogin(cfg) };
  // A sign-in from Ambient counts at once (claude.env changes with sync); Claude Code's own login as last checked.
  const env = runEnv(cfg);
  const claudeSignedIn = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) || state.claude.login === true;
  return { hostname: hostname().slice(0, 120), os: `${type()} ${release()}`.slice(0, 120), runner: VERSION, claude: state.claude.version, claudeSignedIn, ...codexInfo(cfg, state), ...(state.teamBrain ? { teamBrain: { version: String(state.teamBrain.version).slice(0, 40), ok: state.teamBrain.ok === true } } : {}) };
}

// ---- Codex (docs/bots.md, "Codex next to Claude Code") ----

/** Where Codex is for the routine user: AMBIENT_CODEX, or the usual places (npm's global bin). */
function codexPath(cfg) {
  if (cfg.codex) return existsSync(cfg.codex) ? cfg.codex : null;
  const h = home(cfg.user);
  const dirs = [...(process.env.PATH ?? "").split(":"), join(h, ".local/bin"), join(h, ".npm-global/bin"), "/usr/local/bin", "/usr/bin"];
  for (const d of dirs) if (d && existsSync(join(d, "codex"))) return join(d, "codex");
  return null;
}

/** Codex as the routine user (its sign-in lives in their ~/.codex). */
function codexAs(cfg, codex, args, opts = {}) {
  const as = asUser(cfg.user);
  return spawnSync(codex, args, { encoding: "utf8", timeout: 30_000, env: runEnv(cfg, as ? { HOME: as.home } : {}), ...(as ? { uid: as.uid, gid: as.gid } : {}), ...opts });
}

/** How Codex is signed in here: a ChatGPT plan, an API key, or not. */
function codexLoginStatus(cfg, codex) {
  const r = codexAs(cfg, codex, ["login", "status"]);
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.status !== 0) return "none";
  return /chatgpt/i.test(out) ? "chatgpt" : /api key/i.test(out) ? "api_key" : "none";
}

/** Codex's version (hourly) and sign-in (every few minutes, at once after a sign-in here). */
function codexInfo(cfg, state) {
  const codex = codexPath(cfg);
  if (!codex) return { codex: "not found", codexLogin: "none" };
  if (!state.codex || state.codex.path !== codex || Date.now() - state.codex.at > 3600_000) {
    const r = codexAs(cfg, codex, ["--version"]);
    state.codex = { at: Date.now(), path: codex, version: r.status === 0 ? String(r.stdout).trim().split("\n").pop().slice(0, 80) : "not found" };
  }
  if (!state.codexLogin || Date.now() - state.codexLogin.at > 300_000) state.codexLogin = { at: Date.now(), value: codexLoginStatus(cfg, codex) };
  return { codex: state.codex.version, codexLogin: state.codexLogin.value };
}

/** The OpenAI key chosen in Ambient (openai.env): Codex bots use it instead of the computer's own sign-in. */
function chosenOpenAI() {
  const c = readEnvFile(OPENAI_ENV);
  return c.CODEX_API_KEY ? { CODEX_API_KEY: c.CODEX_API_KEY } : {};
}

/** Fetch the OpenAI key chosen in Ambient when its version changed (null: the computer's own sign-in). */
async function openaiSync(cfg, state, version) {
  if ((state.openaiVersion ?? null) === version) return;
  if (version === null) rmSync(OPENAI_ENV, { force: true });
  else {
    let out;
    try {
      out = await call(cfg, "GET", "/v1/host/openai");
    } catch (err) {
      log(`Couldn't fetch the OpenAI key chosen in Ambient: ${err.message}`);
      return;
    }
    const key = String(out.env?.CODEX_API_KEY ?? "");
    mkdirSync(dirname(OPENAI_ENV), { recursive: true, mode: 0o700 });
    writeFileSync(OPENAI_ENV, /^sk-[A-Za-z0-9_-]+$/.test(key) ? `CODEX_API_KEY=${key}\n` : "", { mode: 0o600 });
    chmodSync(OPENAI_ENV, 0o600);
  }
  state.openaiVersion = version;
  log(version ? "Codex bots: an OpenAI key from Ambient" : "Codex bots: this computer's own Codex sign-in");
}

/** Strip a terminal's colours and cursor moves. */
const plain = (t) => String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

/** The link and one-time code from `codex login --device-auth`'s output, once both are there. */
function deviceCode(text) {
  const t = plain(text);
  const url = /https:\/\/[^\s"'<>]+/.exec(t)?.[0]?.replace(/[).,]+$/, "");
  const after = t.split("\n");
  const at = after.findIndex((l) => /one-time code/i.test(l));
  if (!url || at < 0) return null;
  const inline = /code[^:]*:\s*([A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})+)/i.exec(after[at])?.[1];
  const next = after.slice(at + 1).map((l) => l.trim()).find((l) => /^[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})*$/.test(l) && l.length <= 24);
  const code = inline ?? next;
  return code ? { url, code } : null;
}

/**
 * Sign Codex in here with a ChatGPT plan (a message from Ambient): `codex login --device-auth` as
 * the routine user; the link and one-time code go back to the app, the person finishes in their
 * browser, and the next sync tells Ambient Codex is signed in.
 */
async function codexLoginJob(cfg, job) {
  const reply = (body) => call(cfg, "POST", `/v1/host/ambient/${job.id}`, body).catch((err) => log(`Couldn't report Codex's sign-in: ${err.message}`));
  const codex = codexPath(cfg);
  if (!codex) return reply({ error: `Codex isn't installed on ${hostname()} (npm install -g @openai/codex)` });
  const as = asUser(cfg.user);
  log("Codex sign-in with a ChatGPT plan: waiting for the code to be entered…");
  const p = spawn(codex, ["login", "--device-auth"], { env: runEnv(cfg, as ? { HOME: as.home } : {}), stdio: ["ignore", "pipe", "pipe"], ...(as ? { uid: as.uid, gid: as.gid } : {}) });
  let text = "";
  let sent = false;
  const give = setTimeout(() => {
    if (sent) return;
    sent = true;
    p.kill("SIGTERM");
    void reply({ error: `Codex didn't show a sign-in code: ${plain(text).trim().split("\n").slice(-2).join(" ").slice(0, 300) || "no output"}` });
  }, 60_000);
  const stop = setTimeout(() => p.kill("SIGTERM"), 16 * 60_000);
  const seen = (d) => {
    text = (text + d).slice(-8000);
    const found = !sent && deviceCode(text);
    if (found) {
      sent = true;
      clearTimeout(give);
      void reply({ text: JSON.stringify({ ...found, expiresAt: Date.now() + 15 * 60_000 }) });
    }
  };
  p.stdout.on("data", seen);
  p.stderr.on("data", seen);
  p.on("error", (err) => {
    if (!sent) {
      sent = true;
      clearTimeout(give);
      void reply({ error: err.message });
    }
  });
  p.on("close", (code) => {
    clearTimeout(give);
    clearTimeout(stop);
    log(code === 0 ? "Codex is signed in with a ChatGPT plan." : `Codex's sign-in ended without signing in (exit ${code}).`);
    // Ambient learns at once: the sign-in is checked anew and the computer syncs.
    const st = readState();
    delete st.codexLogin;
    writeState(st);
    if (code === 0) spawn(process.execPath, [fileURLToPath(import.meta.url), "sync"], { stdio: "ignore", detached: true }).unref();
  });
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
  // onCalendar "": a bot without a schedule ("When it needs to"): a service to start, no timer.
  const routines = (out.routines ?? []).filter((r) => /^[a-z0-9]{8,64}$/.test(r.id) && (r.onCalendar === "" || /^[A-Za-z0-9*.,:/ _+-]+$/.test(r.onCalendar)));
  const wanted = new Set(routines.map((r) => r.id));
  let reload = false;
  const changed = new Set();

  for (const r of routines) {
    const svc = writeIfChanged(join(UNIT_DIR, `${PREFIX}${r.id}.service`), serviceUnit(cfg, r));
    const timerPath = join(UNIT_DIR, `${PREFIX}${r.id}.timer`);
    let tmr = false;
    if (r.onCalendar) tmr = writeIfChanged(timerPath, timerUnit(r));
    else if (existsSync(timerPath)) {
      // Its schedule was taken away: the timer goes.
      systemctl("disable", "--now", `${PREFIX}${r.id}.timer`);
      rmSync(timerPath, { force: true });
      log(`"${r.name}" runs when it needs to (no schedule)`);
      tmr = true;
    }
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
    if (!r.onCalendar) {
      // No timer to keep; only requested runs (messages, events, wake-ups).
    } else if (r.enabled && (!enabled.has(r.id) || changed.has(r.id))) {
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
  ambientUnit(cfg, out.ambient === true);
  await claudeSync(cfg, state, out.claude ?? null);
  await openaiSync(cfg, state, out.openai ?? null);
  await teamBrainSync(cfg, state, out.teamBrain ?? null);
  const model = out.model ?? null;
  if (JSON.stringify(state.model ?? null) !== JSON.stringify(model)) {
    state.model = model;
    log(model ? `Default model: ${model.model}${model.effort ? ` (${model.effort})` : ""}` : "Default model: Claude Code's own");
    if (existsSync(join(UNIT_DIR, AMBIENT_UNIT))) systemctl("restart", AMBIENT_UNIT);
  }
  writeState(state);
  if (out.runner?.sha256 && (await selfUpdate(cfg, out.runner)) && out.ambient === true) systemctl("restart", AMBIENT_UNIT);
}

// ---- A team's brain on the team's computer ----
//
// A team without a server of its own runs its brain here (docs/architecture.md, "A team on its own
// computer"): the team server as one file from the gateway (checked against the sha256 sync gives),
// on 127.0.0.1 only, as the routine user, with its data in /var/lib/ambient-team, and its nightly
// upkeep on this computer's Claude. Nothing listens outside: the gateway's requests for it come over
// the long poll (http jobs) and go back the same way. Sync stops it when the team no longer runs here
// (its data stays).

const TEAM_UNIT = "ambient-team.service";
const TEAM_UPKEEP = "ambient-team-upkeep";
const TEAM_PORT = Number(process.env.AMBIENT_TEAM_PORT || 18790);
const TEAM_BUNDLE = join(INSTALL_DIR, "ambient-team.mjs");
const TEAM_ENV = join(CONFIG_DIR, "team.env");
const TEAM_DATA = process.env.AMBIENT_TEAM_DATA || "/var/lib/ambient-team";

/** Node's own SQLite (the team brain's search index) needs Node 22.13 or newer. */
function nodeForTeamBrain() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

async function teamBrainHealthy() {
  try {
    return (await fetch(`http://127.0.0.1:${TEAM_PORT}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function teamBrainSync(cfg, state, spec) {
  const units = [TEAM_UNIT, `${TEAM_UPKEEP}.service`, `${TEAM_UPKEEP}.timer`];
  if (!spec) {
    if (existsSync(join(UNIT_DIR, TEAM_UNIT))) {
      systemctl("disable", "--now", `${TEAM_UPKEEP}.timer`);
      systemctl("disable", "--now", TEAM_UNIT);
      for (const u of units) rmSync(join(UNIT_DIR, u), { force: true });
      systemctl("daemon-reload");
      log(`Stopped the team's brain here (its data stays in ${TEAM_DATA})`);
    }
    delete state.teamBrain;
    return;
  }
  if (!nodeForTeamBrain()) {
    if (state.teamBrain?.error !== "node") log(`The team's brain needs Node 22.13 or newer here (this is ${process.versions.node}). Install a newer Node, then run setup again.`);
    state.teamBrain = { version: spec.version, ok: false, error: "node" };
    return;
  }
  let changed = false;
  const have = existsSync(TEAM_BUNDLE) ? createHash("sha256").update(readFileSync(TEAM_BUNDLE)).digest("hex") : null;
  if (have !== spec.sha256) {
    let buf;
    try {
      const res = await fetch(`${cfg.server}/runner/ambient-team.mjs`, { headers: { authorization: `Bearer ${cfg.token}`, "user-agent": `ambient-runner/${VERSION}` }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      log(`Couldn't fetch the team's brain: ${err.message}`);
      state.teamBrain = { version: spec.version, ok: await teamBrainHealthy() };
      return;
    }
    if (createHash("sha256").update(buf).digest("hex") !== spec.sha256) {
      log("The team's brain from the gateway didn't match its checksum; not installed.");
      state.teamBrain = { version: spec.version, ok: await teamBrainHealthy() };
      return;
    }
    mkdirSync(INSTALL_DIR, { recursive: true });
    writeFileSync(`${TEAM_BUNDLE}.new`, buf, { mode: 0o644 });
    renameSync(`${TEAM_BUNDLE}.new`, TEAM_BUNDLE);
    changed = true;
    log(`Installed the team's brain ${spec.version} for ${spec.teamName}`);
  }
  const clean = (v) => String(v).replace(/[\r\n]/g, " ").slice(0, 200);
  const secret = readEnvFile(TEAM_ENV).BRAIN_TEAM_SECRET || randomBytes(32).toString("base64url");
  const env = {
    BRAIN_TEAM_ID: clean(spec.teamId),
    BRAIN_TEAM_NAME: clean(spec.teamName),
    BRAIN_DATA_DIR: TEAM_DATA,
    BRAIN_GATEWAY_ISSUER: cfg.server,
    BRAIN_LISTEN_HOST: "127.0.0.1",
    PORT: String(TEAM_PORT),
    BRAIN_TEAM_SECRET: secret,
    BRAIN_VERSION: clean(spec.version),
  };
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  if (writeIfChanged(TEAM_ENV, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n")) {
    chmodSync(TEAM_ENV, 0o600);
    changed = true;
  }
  const as = cfg.user && cfg.user !== "root" ? asUser(cfg.user) : null;
  mkdirSync(TEAM_DATA, { recursive: true, mode: 0o750 });
  if (as) chownSync(TEAM_DATA, as.uid, as.gid);
  const runAs = as ? `User=${cfg.user}\nGroup=${as.gid}\n` : "";
  const path = process.env.PATH || SYSTEM_PATH.join(":");
  const claudeConfig = runEnv(cfg).CLAUDE_CONFIG_DIR;
  const serve = `# Written by ambient-runner; changes here are overwritten.
[Unit]
Description=Ambient: the team's brain for ${env.BRAIN_TEAM_NAME} (127.0.0.1:${TEAM_PORT} only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${runAs}EnvironmentFile=${TEAM_ENV}
Environment=PATH=${path}
ExecStart=${cfg.node} ${TEAM_BUNDLE} serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
  const upkeep = `# Written by ambient-runner; changes here are overwritten.
[Unit]
Description=Ambient: the team's nightly upkeep, with this computer's Claude

[Service]
Type=oneshot
${runAs}EnvironmentFile=${TEAM_ENV}
EnvironmentFile=-${CLAUDE_ENV}
Environment=PATH=${path}
Environment=HOME=${as ? home(cfg.user) : "/root"}
Environment=BRAIN_CLAUDE=${cfg.claude}
${claudeConfig ? `Environment=CLAUDE_CONFIG_DIR=${claudeConfig}\n` : ""}ExecStart=${cfg.node} ${TEAM_BUNDLE} consolidate
TimeoutStartSec=2h
`;
  const timer = `# Written by ambient-runner; changes here are overwritten.
[Unit]
Description=Ambient: the team's upkeep, nightly

[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
`;
  const unitsChanged = [writeIfChanged(join(UNIT_DIR, TEAM_UNIT), serve), writeIfChanged(join(UNIT_DIR, `${TEAM_UPKEEP}.service`), upkeep), writeIfChanged(join(UNIT_DIR, `${TEAM_UPKEEP}.timer`), timer)].some(Boolean);
  if (unitsChanged) systemctl("daemon-reload");
  if (unitsChanged || changed) {
    systemctl("enable", TEAM_UNIT);
    systemctl("restart", TEAM_UNIT);
    systemctl("enable", "--now", `${TEAM_UPKEEP}.timer`);
  } else if (systemctl("is-active", TEAM_UNIT).stdout.trim() !== "active") {
    systemctl("start", TEAM_UNIT);
  }
  let ok = await teamBrainHealthy();
  for (let i = 0; !ok && (unitsChanged || changed) && i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ok = await teamBrainHealthy();
  }
  if (ok && !state.teamBrain?.ok) log(`The team's brain for ${spec.teamName} answers here`);
  state.teamBrain = { version: spec.version, ok };
}

/** A request for the team's brain from the gateway (relay.ts): passed to 127.0.0.1, answered as is. */
async function relayJob(cfg, job) {
  let status = 502;
  let headers = {};
  let body = Buffer.alloc(0);
  let error = null;
  try {
    const path = String(job.path ?? "");
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("not a path on the team's brain");
    const method = String(job.method ?? "GET").toUpperCase();
    const res = await fetch(`http://127.0.0.1:${TEAM_PORT}${path}`, {
      method,
      headers: job.headers && typeof job.headers === "object" ? job.headers : {},
      body: job.body && method !== "GET" && method !== "HEAD" ? Buffer.from(String(job.body), "base64") : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(280_000),
    });
    status = res.status;
    for (const [k, v] of res.headers) if (!["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"].includes(k)) headers[k] = v;
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    error = `The team's brain on this computer didn't answer: ${err.message}`;
  }
  await fetch(`${cfg.server}/v1/host/relay/${job.id}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "user-agent": `ambient-runner/${VERSION}`,
      "content-type": "application/octet-stream",
      "x-ambient-status": String(status),
      "x-ambient-headers": Buffer.from(JSON.stringify(headers)).toString("base64"),
      ...(error ? { "x-ambient-error": Buffer.from(error.slice(0, 400)).toString("base64") } : {}),
    },
    body,
    signal: AbortSignal.timeout(120_000),
  }).catch((err) => log(`Couldn't send the team brain's answer back: ${err.message}`));
}

// ---- Ambient on this computer ----
//
// On a person's own computer, or a team's server, when Ambient is on there, sync installs a service
// that keeps a Claude Code session open per person and asks the gateway for the next chat message
// (a long poll): no start-up wait per message. It runs as the routine user, in ~/ambient/<person>,
// with Ambient's tools (that person's token, renewed daily by the gateway, in an MCP config only
// this user reads) and the machine's own, so Ambient can work there. Its Claude sign-in: the
// machine's (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in extra.env), or a plan of its own in
// ambient.env (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`), which then wins over a key.

const AMBIENT_UNIT = "ambient-runner-ambient.service";
/** How long one of Ambient's own turns (a bot's question, the heartbeat) may take. */
const INTERNAL_LIMIT_MS = 5 * 60_000;
/** Upkeep's answers: at most this many at once, each stopped after this long. */
const COMPLETE_AT_ONCE = 2;
const COMPLETE_LIMIT_MS = 4 * 60_000;
const AMBIENT_ENV = join(CONFIG_DIR, "ambient.env");

function ambientUnit(cfg, wanted) {
  const path = join(UNIT_DIR, AMBIENT_UNIT);
  if (!wanted) {
    if (existsSync(path)) {
      systemctl("disable", "--now", AMBIENT_UNIT);
      rmSync(path, { force: true });
      systemctl("daemon-reload");
      log("Stopped Ambient on this computer");
    }
    return;
  }
  const unit = `# Written by ambient-runner; changes here are overwritten.
[Unit]
Description=Ambient on this computer: the chat's Claude Code sessions
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${CONFIG}
EnvironmentFile=-${EXTRA}
EnvironmentFile=-${AMBIENT_ENV}
ExecStart=${cfg.node} ${INSTALLED} ambient
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
  if (writeIfChanged(path, unit)) {
    systemctl("daemon-reload");
    systemctl("enable", AMBIENT_UNIT);
    systemctl("restart", AMBIENT_UNIT);
    log("Started Ambient on this computer");
  } else if (systemctl("is-active", AMBIENT_UNIT).stdout.trim() !== "active") {
    systemctl("start", AMBIENT_UNIT);
  }
}

/** The gateway's long poll: the next chat message, or null after ~25 s of nothing. */
async function nextMessage(cfg) {
  const res = await fetch(`${cfg.server}/v1/host/ambient/next`, {
    headers: { authorization: `Bearer ${cfg.token}`, "user-agent": `ambient-runner/${VERSION}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function ambientService() {
  const cfg = config();
  const user = cfg.user;
  const drop = process.getuid?.() === 0 && user !== "root";
  const as = drop ? account(user) : null;
  const base = join(as?.home ?? (process.env.AMBIENT_AMBIENT_HOME || home(user)), "ambient");
  const confDir = join(STATE_DIR, "ambient");
  mkdirSync(confDir, { recursive: true, mode: 0o700 });
  if (as) chownSync(confDir, as.uid, as.gid);
  const own = (path) => {
    if (as) chownSync(path, as.uid, as.gid);
  };

  /** One open Claude Code session per person: uid → { child, session, token, waiting }. */
  const people = new Map();
  const sessions = readState().ambientSessions ?? {};

  const safe = (uid) => uid.replace(/[^A-Za-z0-9_-]/g, "_");
  /** The person's folder here (their files, Claude Code's working directory). */
  const folderOf = (uid) => {
    const dir = join(base, safe(uid));
    mkdirSync(dir, { recursive: true });
    own(base);
    own(dir);
    return dir;
  };
  /**
   * Amb's skills (docs/bots.md, "One folder for every bot, Amb included") as Claude Code project
   * skills in the person's folder: <dir>/.claude/skills/<name>/…. The ones Ambient put there last
   * time go first (.ambient-managed lists them); skills made there by hand stay. Nothing is
   * touched when the job carries none (an older gateway, or no skills).
   */
  const placeSkills = (dir, skills) => {
    if (!Array.isArray(skills)) return;
    const root = join(dir, ".claude", "skills");
    mkdirSync(root, { recursive: true });
    own(join(dir, ".claude"));
    own(root);
    const managed = join(root, ".ambient-managed");
    if (existsSync(managed)) {
      for (const name of readFileSync(managed, "utf8").split("\n")) {
        if (/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) rmSync(join(root, name), { recursive: true, force: true });
      }
    }
    const names = new Set();
    for (const sk of skills) {
      const path = skillPath(sk?.path);
      if (!path || typeof sk.content !== "string") continue;
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, sk.content, { mode: 0o644 });
      names.add(path.split("/")[0]);
    }
    writeFileSync(managed, [...names].join("\n"), { mode: 0o644 });
    if (as) for (const n of names) spawnSync(sys("chown"), ["-R", `${as.uid}:${as.gid}`, join(root, n)]);
    own(managed);
  };
  /** Ambient's tools for the person: an MCP config with their token, readable by the session only. */
  const mcpConfig = (name, token, granted = []) => {
    const file = join(confDir, `${name}.json`);
    const servers = { ambient: { type: "http", url: `${cfg.server}/mcp`, headers: { Authorization: `Bearer ${token}` } } };
    // The services the person gave Ambient, through the gateway with the same token.
    for (const c of granted) servers[c.name] = { type: "http", url: `${cfg.server}${c.path}`, headers: { Authorization: `Bearer ${token}` } };
    writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    own(file);
    return file;
  };
  /** What every Ambient session gets: the computer's model, Ambient's tools, and its instructions. */
  const sessionArgs = (mcpFile, instructions, granted = []) => [
    ...withModel(cfg.claudeArgs, readState().model),
    ...settingArgs(cfg),
    // Only Ambient's tools and the services given to it: never the MCP servers the user set up for their own Claude Code.
    "--mcp-config", mcpFile, "--strict-mcp-config", "--allowedTools", ["mcp__ambient", ...granted.map((c) => `mcp__${c.name}`)].join(","),
    // Secrets go in through the app, never through a chat.
    "--disallowedTools", "mcp__ambient__set_routine_secret",
    "--append-system-prompt", instructions,
  ];
  /** Claude Code as the person's user (the routine user), in their folder. */
  const claudeProc = (args, cwd) =>
    spawn(drop ? sys("setpriv") : cfg.claude, drop ? ["--reuid", String(as.uid), "--regid", String(as.gid), "--init-groups", "--", cfg.claude, ...args] : args, {
      cwd,
      env: runEnv(cfg, { ...(drop ? { HOME: as.home, USER: user, LOGNAME: user } : {}) }),
      stdio: ["pipe", "pipe", "pipe"],
    });

  const start = (uid, p, instructions) => {
    const dir = folderOf(uid);
    // A session kept in another settings folder (before the runner had its own) can't be resumed: start afresh.
    const configDir = runEnv(cfg).CLAUDE_CONFIG_DIR;
    if (p.session && configDir && !sessionKnown(configDir, p.session)) {
      log(`Ambient's session for ${uid} was kept in another settings folder: starting a new one`);
      p.session = null;
    }
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      ...sessionArgs(mcpConfig(safe(uid), p.token, p.mcp ?? []), instructions, p.mcp ?? []),
      ...(p.session ? ["--resume", p.session] : []),
    ];
    const proc = claudeProc(args, dir);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    createInterface({ input: proc.stdout }).on("line", (line) => {
      for (const e of ADAPTERS["claude-code"].events(line)) {
        if (e.type === "result") {
          if (e.session && e.session !== p.session) {
            p.session = e.session;
            const st = readState();
            st.ambientSessions = { ...(st.ambientSessions ?? {}), [uid]: e.session };
            writeState(st);
          }
          p.waiting?.resolve(e);
          p.waiting = null;
        } else journalLine(e);
      }
    });
    proc.on("close", (code) => {
      if (p.child === proc) p.child = null;
      // A session that can't be resumed (gone, or another account's): the next message starts afresh.
      if (code !== 0 && /No conversation found|session/i.test(stderr)) p.session = null;
      p.waiting?.reject(new Error(`Claude Code stopped (exit ${code}). ${stderr.trim().split("\n").slice(-2).join(" ")}`.trim()));
      p.waiting = null;
    });
    p.child = proc;
    log(`Ambient's session for ${uid} ${p.session ? `resumed (${p.session.slice(0, 8)})` : "started"}`);
  };

  const handle = async (job) => {
    const uid = job.uid;
    const p = people.get(uid) ?? { child: null, session: sessions[uid] ?? null, token: null, waiting: null };
    people.set(uid, p);
    const stop = () => {
      p.child?.kill("SIGTERM");
      p.child = null;
    };
    if (job.fresh) {
      stop();
      p.session = null;
    }
    if (job.token !== p.token) {
      p.token = job.token;
      stop();
    }
    // Given another service, or one taken away: the session starts again with them (and carries on where it was).
    const granted = grantedMcp(job.mcp);
    if (JSON.stringify(granted) !== JSON.stringify(p.mcp ?? [])) {
      p.mcp = granted;
      stop();
    }
    if (!p.child) {
      placeSkills(folderOf(uid), job.skills);
      start(uid, p, job.instructions);
    }
    const history = job.fresh && job.history?.length ? `Earlier in this chat:\n${job.history.map((t) => `${t.role === "user" ? job.name : "You"}: ${t.text}`).join("\n")}\n\n` : "";
    // Files that came with the message go in the person's folder here; Claude Code reads them.
    const saved = [];
    if (job.attachments?.length) {
      const into = join(base, uid.replace(/[^A-Za-z0-9_-]/g, "_"), "attachments");
      mkdirSync(into, { recursive: true });
      own(into);
      for (const f of job.attachments) {
        const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(f.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(-120)}`;
        const path = join(into, name);
        writeFileSync(path, Buffer.from(String(f.data), "base64"), { mode: 0o600 });
        own(path);
        saved.push(path);
      }
    }
    const files = saved.length ? `\n\nFiles that came with this message (open them with the Read tool):\n${saved.map((x) => `- ${x}`).join("\n")}` : "";
    const result = new Promise((resolve, reject) => (p.waiting = { resolve, reject }));
    p.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `${history}${job.text || "(See the attached files.)"}${files}` }] } })}\n`);
    try {
      const r = await result;
      // What Ambient put in its outbox for the person: with the reply, then moved to outbox/sent.
      const sent = r.ok ? outbox(folderOf(uid)) : { files: [], moved: () => {} };
      await call(cfg, "POST", `/v1/host/ambient/${job.id}`, r.ok ? { text: r.text, ...(sent.files.length ? { files: sent.files } : {}) } : { error: r.text || "Claude Code couldn't answer" });
      sent.moved();
      log(`Answered ${uid} (${r.turns ?? "?"} turns${r.costUsd !== undefined ? `, $${r.costUsd.toFixed(2)}` : ""})`);
    } catch (err) {
      await call(cfg, "POST", `/v1/host/ambient/${job.id}`, { error: err.message.slice(0, 1900) }).catch(() => {});
    }
  };

  /**
   * A turn that isn't the person's (a bot's question to look at, the heartbeat): a short session of
   * its own, never the chat's. It doesn't wait behind the chat (or the chat behind it), and its
   * prompts stay out of the conversation the person has with Ambient. What Ambient then writes to
   * them reaches the chat's session with their next message (the gateway adds it).
   */
  const internal = async (job) => {
    const dir = folderOf(job.uid);
    placeSkills(dir, job.skills);
    const args = ["-p", "--output-format", "stream-json", "--verbose", ...sessionArgs(mcpConfig(`${safe(job.uid)}-internal`, job.token, grantedMcp(job.mcp)), job.instructions, grantedMcp(job.mcp))];
    const proc = claudeProc(args, dir);
    let result = null;
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    createInterface({ input: proc.stdout }).on("line", (line) => {
      for (const e of ADAPTERS["claude-code"].events(line)) if (e.type === "result") result = e;
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), INTERNAL_LIMIT_MS);
    timer.unref();
    proc.stdin.on("error", () => {});
    proc.stdin.end(job.text);
    const code = await new Promise((resolve) => {
      proc.on("error", (err) => {
        stderr += `\n${err.message}`;
        resolve(127);
      });
      proc.on("close", (c) => resolve(c ?? 1));
    });
    clearTimeout(timer);
    const body = result?.ok ? { text: result.text } : { error: (result?.text || `Claude Code stopped (exit ${code}). ${stderr.trim().split("\n").slice(-2).join(" ")}`).slice(0, 1900) };
    await call(cfg, "POST", `/v1/host/ambient/${job.id}`, body).catch(() => {});
    log(`Looked at something for ${job.uid} in its own session (${result?.turns ?? "?"} turns${result?.costUsd !== undefined ? `, $${result.costUsd.toFixed(2)}` : ""})`);
  };

  /**
   * The brain's upkeep (docs/architecture.md, "Upkeep on your computer"): one structured answer
   * from Claude Code with this computer's Claude sign-in, for a page update, an overview or a work
   * session's note. No tools, no MCP servers, no settings (nobody's hooks or plugins) and no saved
   * session, in an empty folder; with a Claude plan or key from Ambient, in a Claude config folder
   * of its own, so the machine's ~/.claude is never read or written. The gateway keeps the prompts
   * and checks the answer. At most COMPLETE_AT_ONCE at a time, so upkeep never crowds the chat.
   */
  let completing = 0;
  const completeQueue = [];
  const completeRun = async (job) => {
    const model = /^[A-Za-z0-9._\[\]-]{1,80}$/.test(String(job.model)) ? String(job.model) : "haiku";
    const wire = { model, system: String(job.system ?? ""), schema: job.schema && typeof job.schema === "object" ? job.schema : {} };
    const work = join(base, ".upkeep");
    mkdirSync(work, { recursive: true });
    own(base);
    own(work);
    const dir = mkdtempSync(join(work, "run-"));
    own(dir);
    const env = runEnv(cfg, { ...(drop ? { HOME: as.home, USER: user, LOGNAME: user } : {}) });
    if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) {
      const conf = join(work, "claude-config");
      mkdirSync(conf, { recursive: true, mode: 0o700 });
      own(conf);
      env.CLAUDE_CONFIG_DIR = conf;
    }
    const args = [
      "-p", "--output-format", "json", "--model", wire.model, "--system-prompt", wire.system,
      "--json-schema", JSON.stringify(wire.schema), "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
    ];
    try {
      const { code, stdout, stderr } = await new Promise((resolve) => {
        const p = spawn(drop ? sys("setpriv") : cfg.claude, drop ? ["--reuid", String(as.uid), "--regid", String(as.gid), "--init-groups", "--", cfg.claude, ...args] : args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out = (out + d).slice(-400_000)));
        p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
        const timer = setTimeout(() => p.kill("SIGKILL"), COMPLETE_LIMIT_MS);
        timer.unref();
        p.on("error", (e) => resolve({ code: 127, stdout: "", stderr: e.message }));
        p.on("close", (c) => {
          clearTimeout(timer);
          resolve({ code: c ?? 1, stdout: out, stderr: err });
        });
        p.stdin.on("error", () => {});
        p.stdin.end(String(job.user ?? ""));
      });
      let r = null;
      try {
        r = JSON.parse(stdout.trim().split("\n").pop() || "null");
      } catch {}
      if (!r || r.is_error || r.structured_output === undefined) {
        return { error: `Claude Code couldn't write the ${String(job.what || "answer").slice(0, 40)}: ${String(r?.result ?? r?.subtype ?? `exit ${code}. ${stderr.trim().split("\n").slice(-2).join(" ")}`).slice(0, 1500)}` };
      }
      const u = r.usage ?? {};
      return { text: JSON.stringify({ output: r.structured_output, usage: { input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output_tokens: u.output_tokens ?? 0, cache_read_tokens: u.cache_read_input_tokens ?? 0 } }) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const complete = async (job) => {
    if (completing >= COMPLETE_AT_ONCE) await new Promise((resolve) => completeQueue.push(resolve));
    completing++;
    let body;
    try {
      body = await completeRun(job);
    } catch (err) {
      body = { error: `Upkeep couldn't run here: ${err.message}`.slice(0, 1900) };
    } finally {
      completing--;
      completeQueue.shift()?.();
    }
    await call(cfg, "POST", `/v1/host/ambient/${job.id}`, body).catch(() => {});
    log(body.error ? `Upkeep: ${body.error.slice(0, 200)}` : `Upkeep: wrote the ${String(job.what || "answer").slice(0, 40)}`);
  };

  /**
   * Ambient's outbox (its instructions say so): files it saved in ./outbox/ of the person's
   * folder go with its reply and are shown in the chat; once sent they move to outbox/sent/.
   * At most what a message takes; what doesn't fit waits for the next reply.
   */
  const outbox = (dir) => {
    const box = join(dir, "outbox");
    const none = { files: [], moved: () => {} };
    if (!existsSync(box)) {
      mkdirSync(box, { recursive: true });
      own(box);
      return none;
    }
    const names = readdirSync(box).filter((n) => !n.startsWith(".") && n !== "sent" && statSync(join(box, n)).isFile()).sort().slice(0, SHARE_MAX_FILES);
    if (!names.length) return none;
    const picked = [];
    let total = 0;
    for (const n of names) {
      const size = statSync(join(box, n)).size;
      if (!SHARE_TYPES[(n.split(".").pop() || "").toLowerCase()] || total + size > SHARE_MAX_BYTES) continue;
      total += size;
      picked.push(n);
    }
    const out = picked.length ? shareable(picked.map((n) => join(box, n))) : { files: [] };
    if (out.error || !out.files.length) return none;
    return {
      files: out.files,
      moved: () => {
        const sentDir = join(box, "sent");
        mkdirSync(sentDir, { recursive: true });
        own(sentDir);
        for (const n of picked) renameSync(join(box, n), join(sentDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${n}`));
        log(`Sent ${picked.length} file(s) from the outbox with the reply`);
      },
    };
  };

  /** Each person's turns in order (a promise chain per uid): one chain for the chat, one for the rest. */
  const queues = new Map();

  log(`Ambient on this computer: waiting for messages from ${cfg.server}`);
  for (;;) {
    let job;
    try {
      job = await nextMessage(cfg);
    } catch (err) {
      if (err.status === 401 || err.status === 403) die(`Ambient stops here: ${err.message}`, 3);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    // Each person's message is answered in their own session; the next long poll doesn't wait for it.
    if (job?.kind === "exec") void execJob(cfg, job);
    else if (job?.kind === "codex-login") void codexLoginJob(cfg, job);
    else if (job?.kind === "start") startJob(job);
    else if (job?.kind === "complete") void complete(job);
    else if (job?.kind === "http") void relayJob(cfg, job);
    else if (job?.uid && job.token) {
      // One person's messages one after another in their session; Ambient's own turns (a bot's
      // question, the heartbeat) one after another in short sessions of their own, beside it.
      const key = job.mode === "internal" ? `${job.uid}:internal` : job.uid;
      const prev = queues.get(key) ?? Promise.resolve();
      const next = prev.then(() => (job.mode === "internal" ? internal(job) : handle(job)));
      queues.set(key, next.catch(() => {}));
    }
  }
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
  // Ends in .mjs: Node refuses to check a file with another extension (".new" made every update
  // fail its check, so runners up to 0.5.0 never replaced themselves).
  const tmp = join(INSTALL_DIR, "ambient-runner.next.mjs");
  writeFileSync(tmp, source, { mode: 0o755 });
  if (spawnSync(process.execPath, ["--check", tmp]).status !== 0) {
    log(`Not updating to ${theirs}: it doesn't pass node --check here.`);
    return rmSync(tmp, { force: true });
  }
  renameSync(tmp, INSTALLED);
  log(`Updated the runner to ${latest.version}`);
  return true;
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

/**
 * The environment Claude Code runs in: the runner's, without the computer's token. With a sign-in
 * of its own (a token or key), Claude Code gets a settings folder of the runner's too (claudeHome).
 */
function runEnv(cfg, extra = {}, secrets = {}) {
  const allowed = Object.fromEntries(Object.entries(secrets).filter(([k]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && !RESERVED_ENV.test(k)));
  const env = { ...process.env, ...allowed, ...extra };
  delete env.AMBIENT_HOST_TOKEN;
  // A Claude Code session's own variables stay out (when the runner itself is started from one); the
  // computer's sign-in (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, in extra.env) stays in.
  for (const k of Object.keys(env)) if ((k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN") || k === "CLAUDECODE") delete env[k];
  const out = signInEnv(chosenClaude(env));
  if (isolated(cfg, out)) out.CLAUDE_CONFIG_DIR = claudeHome(cfg);
  return out;
}

// ---- Claude Code's settings for Ambient's runs ----
//
// A computer that already runs Claude Code (Remote Control, other jobs) keeps its own setup: with a
// sign-in of their own (a token or key), Ambient's sessions and bots use a settings folder of the
// runner's (CLAUDE_CONFIG_DIR), so the user's ~/.claude (hooks, plugins, MCP servers, settings,
// CLAUDE.md, history) never reaches them, and their sessions never show up in the user's. Without
// one they need Claude Code's own login, and so its folder: then only project and local settings
// count (--setting-sources), never the user's. AMBIENT_CLAUDE_CONFIG=own in runner.env keeps the
// user's settings for everything (docs/self-hosting.md, "What the setup leaves alone").

/** Runs use a settings folder of the runner's: a sign-in of their own, and not turned off. */
function isolated(cfg, env) {
  return cfg.claudeConfig !== "own" && Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
}

/** The routine user's settings folder for Ambient's runs: <state>/claude/<user>, theirs alone. */
function claudeHome(cfg) {
  const user = String(cfg.user || "root").replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = join(STATE_DIR, "claude", user);
  if (!existsSync(dir)) {
    mkdirSync(join(STATE_DIR, "claude"), { recursive: true, mode: 0o755 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const as = asUser(cfg.user);
      if (as) chownSync(dir, as.uid, as.gid);
    } catch {
      // No such user (yet): Claude Code says so when it starts.
    }
  }
  return dir;
}

/** Flags every Claude Code run here gets: only project and local settings when it must use the user's folder. */
function settingArgs(cfg) {
  return isolated(cfg, runEnv(cfg)) || cfg.claudeConfig === "own" ? [] : ["--setting-sources", "project,local"];
}

/**
 * Whether a session can be resumed from a settings folder: its transcript is there. A session from
 * before the runner had a folder of its own isn't, and then a run starts fresh instead of failing.
 */
function sessionKnown(configDir, id) {
  const projects = join(configDir, "projects");
  try {
    return readdirSync(projects).some((d) => existsSync(join(projects, d, `${id}.jsonl`)));
  } catch {
    return false;
  }
}

/**
 * The sign-in chosen in Ambient (claude.env), over whatever the computer has: a stored plan's token
 * replaces the computer's key and token, a stored key replaces both too. Nothing chosen: unchanged.
 */
function chosenClaude(env) {
  const c = readEnvFile(CLAUDE_ENV);
  if (c.CLAUDE_CODE_OAUTH_TOKEN) {
    const { ANTHROPIC_API_KEY: _key, ...rest } = env;
    return { ...rest, CLAUDE_CODE_OAUTH_TOKEN: c.CLAUDE_CODE_OAUTH_TOKEN };
  }
  if (c.ANTHROPIC_API_KEY) {
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...rest } = env;
    return { ...rest, ANTHROPIC_API_KEY: c.ANTHROPIC_API_KEY };
  }
  return env;
}

/** Fetch the chosen Claude sign-in when its version changed; Ambient's sessions restart with it. */
async function claudeSync(cfg, state, version) {
  if ((state.claudeVersion ?? null) === version) return;
  if (version === null) {
    rmSync(CLAUDE_ENV, { force: true });
  } else {
    let out;
    try {
      out = await call(cfg, "GET", "/v1/host/claude");
    } catch (err) {
      log(`Couldn't fetch the Claude sign-in chosen in Ambient: ${err.message}`);
      return;
    }
    const lines = Object.entries(out.env ?? {})
      .filter(([k, v]) => (k === "CLAUDE_CODE_OAUTH_TOKEN" || k === "ANTHROPIC_API_KEY") && /^[A-Za-z0-9_-]+$/.test(String(v)))
      .map(([k, v]) => `${k}=${v}`);
    mkdirSync(dirname(CLAUDE_ENV), { recursive: true, mode: 0o700 });
    writeFileSync(CLAUDE_ENV, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
    chmodSync(CLAUDE_ENV, 0o600);
  }
  state.claudeVersion = version;
  log(version ? `Claude sign-in from Ambient: ${version.split(":")[0] === "plan" ? "a Claude plan" : "an API key"}` : "Claude sign-in: this computer's own");
  if (existsSync(join(UNIT_DIR, AMBIENT_UNIT))) systemctl("restart", AMBIENT_UNIT);
}

/**
 * Claude Code's flags with `choice` (a bot's model, or the computer's default) in place of any
 * --model, --effort or --fallback-model the computer's own arguments have; unchanged without one.
 */
function withModel(args, choice) {
  if (!choice?.model) return args;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (["--model", "--effort", "--fallback-model"].includes(args[i])) {
      i++;
      continue;
    }
    if (/^--(model|effort|fallback-model)=/.test(args[i])) continue;
    out.push(args[i]);
  }
  out.push("--model", choice.model);
  if (choice.effort) out.push("--effort", choice.effort);
  if (choice.fallback && choice.fallback !== choice.model) out.push("--fallback-model", choice.fallback);
  return out;
}

/** A root command Ambient was allowed to run here: bash as root, its output (the end of it) back. */
async function execJob(cfg, job) {
  const timeout = Math.min(Math.max(Number(job.timeoutS) || 120, 5), 600) * 1000;
  log(`Root command (allowed in Ambient): ${String(job.command).replace(/\s+/g, " ").slice(0, 200)}`);
  const result = await new Promise((resolve) => {
    const p = spawn(sys("bash"), ["-lc", String(job.command)], { env: { PATH: SYSTEM_PATH.join(":") + ":/usr/local/bin", HOME: "/root", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (d) => (output = (output + d).slice(-40_000));
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output += `\n(stopped after ${timeout / 1000} s)`;
      p.kill("SIGKILL");
    }, timeout);
    p.on("error", (err) => resolve({ code: 127, output: err.message }));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
  await call(cfg, "POST", `/v1/host/ambient/${job.id}`, { text: JSON.stringify(result) }).catch((err) => log(`Couldn't report a root command: ${err.message}`));
}

/** A message reached a bot: start its run now instead of at the next check. */
function startJob(job) {
  if (!/^[a-z0-9]{8,64}$/.test(String(job.routineId))) return;
  const unit = `${PREFIX}${job.routineId}.service`;
  if (["active", "activating"].includes(systemctl("is-active", unit).stdout.trim())) return;
  systemctl("start", "--no-block", unit);
  log(`Started ${unit} (a message came)`);
}

function systemPrompt(routine, trigger, bot) {
  const how = trigger === "manual" ? 'started with "Run now" in the Ambient app' : "started by its schedule";
  if (bot) {
    return [
      `You're "${routine.name}", one of your owner's bots in Ambient, running on ${hostname()}, ${how}.`,
      "Nobody is watching this run. When you need a decision only your owner can make (which of two real options, a missing detail, a go-ahead for something that can't be undone), ask with the ask_owner tool: one short question, with choices when there are a few clear options. Don't ask about what you can sensibly decide yourself.",
      "If ask_owner comes back without an answer, finish the run: say in a sentence or two where you are and what you're waiting for. You'll be started again with the answer, in this same conversation.",
      "When a run starts with a message from your owner (they wrote to you in your thread), it's a conversation: answer it, or do what it asks, and put your answer in your last message. Don't answer through ask_owner; use it only when you need their decision before you can go on.",
      "Your VERY LAST message becomes what your owner reads in your thread in the Ambient app: a short, useful summary of what you did and anything they need to look at. Nothing after it.",
    ].join(" ");
  }
  return [
    `You're running the Ambient routine "${routine.name}" on ${hostname()}, ${how}.`,
    "Nobody is watching this run and nobody can answer questions: make reasonable choices and say what you assumed.",
    "Your VERY LAST message becomes the run result shown in the Ambient app — make it a short, useful summary of what you did and anything a person needs to look at. Do not add anything after it (no 'all done', no 'finished').",
  ].join(" ");
}

// ---- runtimes ----
//
// A bot names its runtime; each has an adapter that knows how to start it and turns its output into
// Ambient's run events (RunEvent in spec/src/bots.ts): status, tool, text, asked, result. Nothing
// past the adapter reads a runtime's own format, so another runtime is another adapter.

const ADAPTERS = {
  "claude-code": {
    label: "Claude Code",
    /** Takes more messages while it works (stream-json input): a bot's run with a run token. */
    streams: true,
    /** The command line after the binary, and what goes to stdin. */
    start(cfg, routine, runInfo, bot, resume, mcpConfig, system, opts = {}) {
      // `system`: the bot's instructions for this run from the gateway (runner 0.8.0 on); older
      // gateways send none, and the runner's own text stays.
      // --include-partial-messages: the text as it's written (stream_event deltas), for the live
      // text in the app (docs/bots.md, "Live text").
      const args = ["-p", ...(opts.streaming ? ["--input-format", "stream-json"] : []), "--output-format", "stream-json", "--include-partial-messages", "--verbose", ...cfg.claudeArgs, "--append-system-prompt", system || systemPrompt(routine, runInfo.trigger, bot)];
      if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", ["mcp__ambient-bot__ask_owner", "mcp__ambient-bot__send_file", "mcp__ambient-bot__search_history", "mcp__ambient-bot__wake_me", "mcp__ambient-bot__cancel_wake_up", "mcp__ambient", ...(opts.granted ?? []).map((c) => `mcp__${c.name}`)].join(","));
      if (resume?.sessionId) args.push("--resume", resume.sessionId);
      const stdin = resume ? (resume.sessionId ? resume.message : `${routine.prompt}\n\n${resume.message}`) : routine.prompt;
      return { args, stdin };
    },
    /** One stream-json line as run events. */
    events(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return [{ type: "status", text: line }];
      }
      if (event.type === "result") {
        return [
          {
            type: "result",
            ok: !event.is_error,
            text: typeof event.result === "string" ? event.result : "",
            subtype: event.subtype,
            costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
            turns: typeof event.num_turns === "number" ? event.num_turns : undefined,
            session: typeof event.session_id === "string" ? event.session_id : undefined,
            usage: event.usage ? { input: event.usage.input_tokens, cacheRead: event.usage.cache_read_input_tokens, cacheWrite: event.usage.cache_creation_input_tokens, output: event.usage.output_tokens } : undefined,
          },
        ];
      }
      if (event.type === "system" && event.subtype === "init") return [{ type: "ready" }];
      // The text as it's written: a new block starts, words arrive, a tool starts. A subagent's
      // (parent_tool_use_id) isn't the bot's answer.
      if (event.type === "stream_event") {
        const ev = event.event ?? {};
        if (event.parent_tool_use_id) return [];
        if (ev.type === "content_block_start" && ev.content_block?.type === "text") return [{ type: "live_block" }];
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) return [{ type: "live_delta", text: ev.delta.text }];
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") return [{ type: "live_tool", name: String(ev.content_block.name ?? "") }];
        return [];
      }
      if (event.type !== "assistant") return [];
      const out = [];
      for (const c of event.message?.content ?? []) {
        if (c.type === "text" && c.text.trim()) out.push({ type: "text", text: c.text.trim() });
        if (c.type === "tool_use") {
          const input = c.input ?? {};
          const what = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.description ?? input.question ?? "";
          out.push({ type: "tool", name: c.name, detail: what ? String(what).replace(/\s+/g, " ").slice(0, 200) : undefined });
        }
      }
      return out;
    },
  },

  // OpenAI's Codex CLI (docs/bots.md, "Codex next to Claude Code"): `codex exec --json`, the prompt on
  // stdin, the bot's instructions as Codex's developer instructions, ask_owner and search_history
  // as an MCP server given with -c. In a container the container is the sandbox; on the computer
  // itself Codex's own sandbox keeps it to the workspace (network on, so git and gh work).
  codex: {
    label: "Codex",
    start(cfg, routine, runInfo, bot, resume, mcp, system, opts = {}) {
      const toml = (v) => JSON.stringify(v);
      const flags = ["--json", "--skip-git-repo-check"];
      if (opts.contained) flags.push("--dangerously-bypass-approvals-and-sandbox");
      else {
        flags.push("-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true", "-c", 'approval_policy="never"');
        // Its memory.md and handoff.md are outside the workspace: writable too.
        if (opts.outDir) flags.push("-c", `sandbox_workspace_write.writable_roots=${toml([opts.outDir])}`);
      }
      flags.push("-c", `developer_instructions=${toml(system || systemPrompt(routine, runInfo.trigger, bot))}`);
      // The bot's secrets reach its commands (gh needs GH_TOKEN, say); the run's own token and the sign-ins don't.
      flags.push(
        "-c", 'shell_environment_policy.inherit="all"',
        "-c", "shell_environment_policy.ignore_default_excludes=true",
        "-c", `shell_environment_policy.exclude=${toml(["AMBIENT_RUN_TOKEN", "AMBIENT_HOST_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"])}`,
      );
      const m = codexModel(bot?.model);
      if (m) {
        flags.push("-m", m.model);
        if (m.effort) flags.push("-c", `model_reasoning_effort=${toml(m.effort)}`);
      }
      if (mcp) {
        flags.push(
          "-c", `mcp_servers.ambient-bot.command=${toml(mcp.command)}`,
          "-c", `mcp_servers.ambient-bot.args=${toml(mcp.args)}`,
          // The run's token goes from Codex's environment to the server, never on a command line.
          "-c", 'mcp_servers.ambient-bot.env_vars=["AMBIENT_SERVER","AMBIENT_RUN_TOKEN"]',
          // ask_owner waits up to three minutes for an answer.
          "-c", "mcp_servers.ambient-bot.tool_timeout_sec=600",
          // The brain over HTTP, with the run's token from Codex's environment.
          "-c", `mcp_servers.ambient.url=${toml(`${cfg.server}/mcp`)}`,
          "-c", 'mcp_servers.ambient.bearer_token_env_var="AMBIENT_RUN_TOKEN"',
        );
        // The services this bot was given, at the gateway, with the run's token as well.
        for (const c of opts.granted ?? []) {
          flags.push("-c", `mcp_servers.${c.name}.url=${toml(c.url)}`, "-c", `mcp_servers.${c.name}.bearer_token_env_var="AMBIENT_RUN_TOKEN"`, "-c", `mcp_servers.${c.name}.tool_timeout_sec=180`);
        }
      }
      if (resume?.sessionId) return { args: ["exec", "resume", ...flags, resume.sessionId, "-"], stdin: resume.message };
      return { args: ["exec", ...flags, "-"], stdin: resume ? `${routine.prompt}\n\n${resume.message}` : routine.prompt };
    },
    /** One `codex exec --json` line as run events; `ctx` keeps the thread and its last message. */
    events(line, ctx = {}) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return line.trim() ? [{ type: "status", text: line }] : [];
      }
      if (e.type === "thread.started" && typeof e.thread_id === "string") {
        ctx.session = e.thread_id;
        return [];
      }
      if (e.type === "turn.completed") return [{ type: "result", ok: true, text: ctx.last ?? "", turns: 1, session: ctx.session }];
      if (e.type === "turn.failed") return [{ type: "result", ok: false, text: String(e.error?.message ?? "Codex's turn failed"), session: ctx.session }];
      if (e.type === "error") return [{ type: "status", text: String(e.message ?? "").slice(0, 300) }];
      if (e.type !== "item.completed" || !e.item) return [];
      const it = e.item;
      const short = (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 200) || undefined;
      switch (it.type) {
        case "agent_message":
          if (typeof it.text !== "string" || !it.text.trim()) return [];
          ctx.last = it.text.trim();
          return [{ type: "text", text: ctx.last }];
        case "command_execution":
          return [{ type: "tool", name: "Bash", detail: short(it.command) }];
        case "file_change":
          return [{ type: "tool", name: "Edit", detail: short((it.changes ?? []).map((c) => c.path).join(", ")) }];
        case "mcp_tool_call":
          return [{ type: "tool", name: `${it.server ?? "mcp"}__${it.tool ?? "tool"}`, detail: undefined }];
        case "web_search":
          return [{ type: "tool", name: "WebSearch", detail: short(it.query) }];
        case "error":
          return [{ type: "status", text: String(it.message ?? "").slice(0, 300) }];
        default:
          return [];
      }
    },
  },
};

/** A bot's own OpenAI model for Codex, with Codex's reasoning effort; none: Codex's default. */
function codexModel(choice) {
  if (!choice?.model || !/^(gpt-|o[1-9]|codex-)/.test(choice.model)) return null;
  return { model: choice.model, effort: choice.effort === "max" ? "xhigh" : choice.effort };
}

/** One line per event for the journal (journalctl -u ambient-routine-<id>). */
function journalLine(e) {
  if (e.type === "text") log(`› ${e.text.replace(/\s+/g, " ").slice(0, 300)}`);
  else if (e.type === "tool") log(`· ${e.name}${e.detail ? `: ${e.detail}` : ""}`);
  else if (e.type === "status") log(e.text);
}

// ---- containers ----
//
// A bot with isolation "container" runs in its own Podman container: its volume is its workspace
// and HOME (repos it cloned, Claude Code's sessions to resume), it gets only its granted secrets,
// and it can't use more than its share of the machine. The image is built here from this file's
// Containerfile, once per image version.

const IMAGE_VERSION = "3";

/**
 * The MCP servers a bot or Ambient was given (docs/bots.md, "MCP connections"), as the gateway
 * names them: only names that can't shadow the run's own servers, and only addresses at the
 * gateway's relay. The service's key stays at the gateway; a run reaches it with its own token.
 */
function grantedMcp(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.name === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(c.name) && c.name !== "ambient" && c.name !== "ambient-bot" && typeof c.path === "string" && /^\/v1\/bot\/mcp\/[0-9a-f]{16}$/.test(c.path))
    .slice(0, 50)
    .map((c) => ({ name: c.name, path: c.path }));
}
const IMAGE = `localhost/ambient-bot:${IMAGE_VERSION}`;
const CONTAINERFILE = `FROM docker.io/library/node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gh jq ripgrep python3 python3-pil webp openssh-client less procps \\
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force
# The image is the version; a run never updates Claude Code or Codex in place (it'd be lost with the container).
ENV DISABLE_AUTOUPDATER=1 HOME=/home/bot
WORKDIR /home/bot
USER node
`;
/**
 * A team's server keeps the team's wiki here (owned by its brain user, readable by its group): a
 * team's bots read it, read-only, at the same path as on the server.
 */
const TEAM_WIKI = process.env.AMBIENT_TEAM_WIKI || "/srv/brain/wiki";

function teamWikiMount() {
  try {
    const st = statSync(TEAM_WIKI);
    return st.isDirectory() ? ["-v", `${TEAM_WIKI}:${TEAM_WIKI}:ro`, "--group-add", String(st.gid)] : [];
  } catch {
    return [];
  }
}

/** What every bot's container gets at most. */
const LIMITS = ["--memory", process.env.AMBIENT_BOT_MEMORY || "4g", "--cpus", process.env.AMBIENT_BOT_CPUS || "2", "--pids-limit", "1024"];

function podman() {
  const p = sys("podman");
  return existsSync(p) ? p : null;
}

/** Build the bots' image unless it's there. */
function ensureImage(p) {
  if (spawnSync(p, ["image", "exists", IMAGE]).status === 0) return null;
  log(`Building the bots' image ${IMAGE} (once, a few minutes)…`);
  const dir = join(STATE_DIR, "image");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Containerfile"), CONTAINERFILE);
  const r = spawnSync(p, ["build", "-t", IMAGE, "-f", join(dir, "Containerfile"), dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return `Couldn't build the bots' image: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-6).join("\n")}`;
  return null;
}

/** Variables a bot's Claude Code signs in with: the computer's own (extra.env), never a secret's. */
const AUTH_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_MODEL"];

/**
 * One way to sign in: a Claude plan's token (CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`)
 * wins over an API key when a computer has both. Claude Code itself would take the key, so a team
 * server whose owner added their plan would keep spending the key (or fail when it ran dry).
 */
function signInEnv(env) {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) return env;
  const { ANTHROPIC_API_KEY: _key, ...rest } = env;
  return rest;
}

// ---- ask_owner: a small MCP server for a bot's run ----
//
// `ambient-runner bot-mcp` speaks MCP over stdio (one JSON message per line) with two tools,
// ask_owner and search_history. Claude Code starts it from the run's MCP config, inside the bot's container when it
// has one. It holds the run's token, which only asks while this run goes.

/** What can go to the person as a file (the gateway takes the same): its type, by extension. */
const SHARE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html" };
const SHARE_MAX_FILES = 4;
const SHARE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Files a bot or Ambient made, read to go to the person: `{ files }` (name, type, base64), or
 * `{ error }` saying what's wrong (a path that isn't there, a type or size the chat doesn't take).
 */
function shareable(paths, base = process.cwd()) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === "string" && p.trim()).slice(0, SHARE_MAX_FILES + 1);
  if (!list.length) return { error: "Pass the path of a file." };
  if (list.length > SHARE_MAX_FILES) return { error: `Up to ${SHARE_MAX_FILES} files at a time.` };
  const files = [];
  let total = 0;
  for (const raw of list) {
    const path = raw.startsWith("/") ? raw : join(base, raw);
    let st;
    try {
      st = statSync(path);
    } catch {
      return { error: `There's no file at ${raw}.` };
    }
    if (!st.isFile()) return { error: `${raw} isn't a file.` };
    const name = path.split("/").pop();
    const type = SHARE_TYPES[(name.split(".").pop() || "").toLowerCase()];
    if (!type) return { error: `${name}: only pictures (PNG, JPEG, GIF, WebP), PDFs and text files (txt, md, csv, json, html) can go to your owner.` };
    total += st.size;
    if (total > SHARE_MAX_BYTES) return { error: "Up to 10 MB together." };
    files.push({ name, type, data: readFileSync(path).toString("base64") });
  }
  return { files };
}

const SEND_FILE_TOOL = {
  name: "send_file",
  description:
    "Send your owner files you made (a picture, a chart, a PDF, a document): they show in your thread in the Ambient app, where your owner opens them. Paths in your container or working folder. Up to 4 files, 10 MB together; pictures, PDFs and text files. For a question about them, pass them to ask_owner as files instead.",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4, description: "The files to send." },
      caption: { type: "string", description: "A line about them, shown with them." },
    },
    required: ["paths"],
  },
};

const ASK_TOOL = {
  name: "ask_owner",
  description:
    "Ask your owner (the person this bot works for) a question; by default wait a few minutes for the answer in the Ambient app. Use it for decisions only they can make. Give choices when there are a few clear options. Put what they decide on in details: the draft itself (the whole text), the pull request's link, the file's link or path, the numbers and where they come from. They decide from the question alone, so never write \"see my last message\". wait: false hands it over without waiting (something ready for them: a pull request to merge, a post to publish): it reaches them as a decision, and their answer starts your next run.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "One short question." },
      choices: { type: "array", items: { type: "string" }, maxItems: 6, description: "Answers to pick from, if there are a few clear options." },
      details: { type: "string", maxLength: 20000, description: "What the question is about, shown with it (markdown): the draft, the pull request's link, the file, the numbers and their sources." },
      files: { type: "array", items: { type: "string" }, maxItems: 4, description: "Paths of files the question is about (a picture for a post, a PDF), shown with it." },
      wait: { type: "boolean", description: "false: don't wait for the answer (default true)." },
    },
    required: ["question"],
  },
};

const SEARCH_TOOL = {
  name: "search_history",
  description:
    "Search what happened before: your thread with your owner (their messages, your results, questions and answers) and your earlier runs' handoffs. Newest first. Use it when you need something older than what this run started with.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for." },
      from: { type: "string", description: "Only from this date on (ISO, e.g. 2026-11-01)." },
      to: { type: "string", description: "Only up to this date (ISO)." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "How many results; default 20." },
    },
    required: ["query"],
  },
};

const WAKE_TOOL = {
  name: "wake_me",
  description:
    "Book a wake-up: at that time you're started again, and your note is your first message then. For a next step on a date (draft on Tuesday so your owner can review before Thursday's post; check the numbers a week after a launch). Plan backwards from deadlines. 10 minutes to 30 days ahead, at most 5 booked, an hour apart (one wake-up can do several things). Your first message shows the time now and what's booked.",
  inputSchema: {
    type: "object",
    properties: {
      at: { type: "string", description: "When, in your owner's time zone: 2026-11-24 09:00 (or ISO with an offset, 2026-11-24T09:00:00+01:00)." },
      note: { type: "string", maxLength: 2000, description: "What to do then, so your next run knows without searching: the step, where things are (the draft's path, the PR), and the deadline." },
    },
    required: ["at", "note"],
  },
};

const CANCEL_WAKE_TOOL = {
  name: "cancel_wake_up",
  description: "Cancel one of your booked wake-ups (its id is in your first message, or in wake_me's answer): when the step is done already or the plan changed.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

/** A result's time as "2026-11-17 09:30" (UTC). */
function when(at) {
  const d = typeof at === "number" || /^\d+$/.test(String(at ?? "")) ? new Date(Number(at)) : new Date(String(at));
  return Number.isNaN(d.getTime()) ? String(at ?? "") : d.toISOString().slice(0, 16).replace("T", " ");
}

async function botMcp() {
  const server = (process.env.AMBIENT_SERVER || DEFAULT_SERVER).replace(/\/+$/, "");
  const token = process.env.AMBIENT_RUN_TOKEN || "";
  const waitMs = Math.min(Number(process.env.AMBIENT_ASK_WAIT_S || 180), 600) * 1000;
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const api = async (method, path, body) => {
    const res = await fetch(`${server}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
    return json;
  };
  const ask = async ({ question, choices, wait, details, files }) => {
    if (typeof question !== "string" || !question.trim()) return { text: "Pass a question.", error: true };
    const attached = Array.isArray(files) && files.length ? shareable(files) : { files: [] };
    if (attached.error) return { text: `Couldn't attach the files: ${attached.error}`, error: true };
    const { id } = await api("POST", "/v1/bot/ask", {
      question,
      ...(attached.files.length ? { files: attached.files } : {}),
      ...(Array.isArray(choices) && choices.length ? { choices: choices.map(String).slice(0, 6) } : {}),
      ...(typeof details === "string" && details.trim() ? { details: details.slice(0, 20000) } : {}),
    });
    if (wait === false) {
      return { text: "Handed to your owner: it reaches them as a decision (Ambient looks at it first), and their answer starts your next run, in this same conversation. Finish this run now with your summary." };
    }
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 5000));
      const a = await api("GET", `/v1/bot/questions/${id}`).catch(() => ({ answer: null }));
      if (typeof a.answer === "string") return { text: `${a.author ?? "Your owner"} answered: ${a.answer}` };
    }
    return {
      text: "No answer yet; they'll see the question in the Ambient app. Finish this run now: say in a sentence or two where you are and what you're waiting for. You'll be started again with the answer, in this same conversation.",
    };
  };
  const sendFile = async ({ paths, caption }) => {
    const out = shareable(paths);
    if (out.error) return { text: out.error, error: true };
    await api("POST", "/v1/bot/reply", { text: typeof caption === "string" ? caption.slice(0, 2000) : "", files: out.files });
    return { text: `Sent ${out.files.map((f) => f.name).join(", ")}: they're in your thread for your owner.` };
  };
  const search = async ({ query, from, to, limit }) => {
    if (typeof query !== "string" || !query.trim()) return { text: "Pass what to search for.", error: true };
    const q = new URLSearchParams({ q: query.trim().slice(0, 200) });
    if (typeof from === "string" && from.trim()) q.set("from", from.trim());
    if (typeof to === "string" && to.trim()) q.set("to", to.trim());
    if (Number.isFinite(Number(limit)) && limit !== undefined && limit !== null) q.set("limit", String(Math.min(Math.max(Math.trunc(Number(limit)), 1), 50)));
    const { results = [] } = await api("GET", `/v1/bot/history?${q}`);
    if (!Array.isArray(results) || !results.length) return { text: "Nothing found." };
    return { text: results.map((r) => `${when(r.at)} ${r.who ?? "?"} (${r.where ?? "thread"}): ${String(r.text ?? "").replace(/\s+/g, " ").trim()}`).join("\n") };
  };
  const bookedLines = (list) => (list.length ? list.map((w) => `- ${w.when} (${w.id}): ${String(w.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200)}`).join("\n") : "(none)");
  const wakeMe = async ({ at, note }) => {
    if (typeof at !== "string" || !at.trim() || typeof note !== "string" || !note.trim()) return { text: "Pass at (when) and note (what to do then).", error: true };
    const out = await api("POST", "/v1/bot/wakes", { at: at.trim().slice(0, 64), note: note.trim().slice(0, 2000) });
    return { text: `Booked: ${out.wake.when} (${out.wake.id}). Booked now:\n${bookedLines(out.booked ?? [])}` };
  };
  const cancelWake = async ({ id }) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { text: "Pass the wake-up's id.", error: true };
    await api("DELETE", `/v1/bot/wakes/${id}`);
    const { wakes = [] } = await api("GET", "/v1/bot/wakes").catch(() => ({ wakes: [] }));
    return { text: `Cancelled. Booked now:\n${bookedLines(wakes)}` };
  };
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined) return; // a notification
    try {
      if (m.method === "initialize") {
        send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ambient-bot", version: VERSION } } });
      } else if (m.method === "tools/list") {
        send({ jsonrpc: "2.0", id: m.id, result: { tools: [ASK_TOOL, SEND_FILE_TOOL, SEARCH_TOOL, WAKE_TOOL, CANCEL_WAKE_TOOL] } });
      } else if (m.method === "tools/call" && m.params?.name === "ask_owner") {
        const out = await ask(m.params.arguments ?? {}).catch((err) => ({ text: `Couldn't ask: ${err.message}. Decide yourself if you can, and say so in your summary.`, error: true }));
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: out.text }], ...(out.error ? { isError: true } : {}) } });
      } else if (m.method === "tools/call" && m.params?.name === "send_file") {
        const out = await sendFile(m.params.arguments ?? {}).catch((err) => ({ text: `Couldn't send it: ${err.message}`, error: true }));
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: out.text }], ...(out.error ? { isError: true } : {}) } });
      } else if (m.method === "tools/call" && m.params?.name === "search_history") {
        const out = await search(m.params.arguments ?? {}).catch((err) => ({ text: `Couldn't search: ${err.message}`, error: true }));
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: out.text }], ...(out.error ? { isError: true } : {}) } });
      } else if (m.method === "tools/call" && m.params?.name === "wake_me") {
        const out = await wakeMe(m.params.arguments ?? {}).catch((err) => ({ text: `Couldn't book it: ${err.message}`, error: true }));
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: out.text }], ...(out.error ? { isError: true } : {}) } });
      } else if (m.method === "tools/call" && m.params?.name === "cancel_wake_up") {
        const out = await cancelWake(m.params.arguments ?? {}).catch((err) => ({ text: `Couldn't cancel it: ${err.message}`, error: true }));
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: out.text }], ...(out.error ? { isError: true } : {}) } });
      } else if (m.method === "ping") {
        send({ jsonrpc: "2.0", id: m.id, result: {} });
      } else {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
      }
    } catch (err) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: err.message } });
    }
  });
}

// ---- a bot's folder (docs/bots.md, "A bot's folder, its memory and its handoffs") ----
//
// The gateway sends the run's workspace: its instructions (`system`, with {{OUT}} for the out
// folder), its skills, and its memory.md. The run gets an out folder with memory.md (as it is now)
// and an empty handoff.md; what the bot leaves in them goes back with the result. The gateway
// decides what's a new version: the runner only carries files.

const OUT_MAX = 64 * 1024;
const CONTAINER_OUT = "/opt/ambient/out";
const CONTAINER_SKILLS = "/opt/ambient/skills";

/** A skill's path as the gateway sends it: `<name>/<file>` or `<name>/<folder>/<file>`, nothing else. */
function skillPath(path) {
  if (typeof path !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}\/([A-Za-z0-9._-]{1,64}\/)?[A-Za-z0-9._-]{1,64}$/.test(path)) return null;
  return path.split("/").some((part) => part === "." || part === "..") ? null : path;
}

/**
 * Before Claude Code starts in the container: the skills Ambient put there last time go, this
 * run's come in (as ~/.claude/skills/<name>), and .ambient-managed lists them for next time. The
 * bot's own skills (folders it made itself) stay.
 */
function skillsLines(dir) {
  return `d="${dir}"
mkdir -p "$d"
if [ -f "$d/.ambient-managed" ]; then
  while IFS= read -r n; do case "$n" in ""|*/*|.*) ;; *) rm -rf "\${d:?}/$n" ;; esac; done < "$d/.ambient-managed"
fi
: > "$d/.ambient-managed.new"
for s in ${CONTAINER_SKILLS}/*/; do
  [ -d "$s" ] || continue
  n=$(basename "$s")
  rm -rf "\${d:?}/$n"
  cp -R "$s" "$d/$n"
  echo "$n" >> "$d/.ambient-managed.new"
done
mv "$d/.ambient-managed.new" "$d/.ambient-managed"`;
}
const SKILLS_SCRIPT = `set -e
${skillsLines("$HOME/.claude/skills")}
set +e
exec claude "$@"`;

/** Where a container's Codex gets the computer's ChatGPT sign-in, and leaves it refreshed. */
const CONTAINER_CODEX_AUTH = "/opt/ambient/codex-auth";

/**
 * Codex in the container: skills (when the run has a folder) into ~/.codex/skills like Claude
 * Code's; the computer's ChatGPT sign-in copied in, and back out after the run, since Codex
 * refreshes it while it works and the computer must keep the newest.
 */
const CODEX_SCRIPT = `set -e
if [ -d ${CONTAINER_SKILLS} ]; then
${skillsLines("$HOME/.codex/skills")}
fi
if [ -f ${CONTAINER_CODEX_AUTH}/auth.json ]; then
  mkdir -p "$HOME/.codex"
  cp ${CONTAINER_CODEX_AUTH}/auth.json "$HOME/.codex/auth.json"
  chmod 600 "$HOME/.codex/auth.json"
fi
set +e
codex "$@"
code=$?
if [ -f ${CONTAINER_CODEX_AUTH}/auth.json ] && [ -f "$HOME/.codex/auth.json" ]; then cp "$HOME/.codex/auth.json" ${CONTAINER_CODEX_AUTH}/auth.json; fi
exit $code`;

/** A file the run left in its out folder: a regular file only (never a link), at most 64 KB. */
function readOut(dir, name) {
  try {
    if (!lstatSync(dir).isDirectory()) return undefined;
    const fd = openSync(join(dir, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) return undefined;
      const buf = Buffer.alloc(OUT_MAX);
      let n = 0;
      for (let r; n < OUT_MAX && (r = readSync(fd, buf, n, OUT_MAX - n, null)) > 0; ) n += r;
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

async function run(id) {
  const cfg = config();
  if (!/^[a-z0-9]{8,64}$/.test(id ?? "")) die("usage: ambient-runner run <routine-id>", 2);
  // Where a run's time goes (docs/bots.md, "Messages while a bot works"): logged at its end.
  const t0 = Date.now();
  const marks = {};
  const mark = (name) => {
    if (marks[name] === undefined) marks[name] = Date.now() - t0;
  };
  let start;
  try {
    start = await call(cfg, "POST", `/v1/host/routines/${id}/runs`, undefined, { retries: 4 });
    mark("api");
  } catch (err) {
    if (err.status === 404) {
      log("This routine no longer exists; the next sync removes its timer.");
      return;
    }
    die(`Couldn't start the run: ${err.message}`);
  }
  // `env`: the owner's secrets (a bot: only those granted to it). They go to the run only.
  const { run: runInfo, routine, env: secrets = {}, bot = null, resume = null, runToken = null, workspace = null } = start;
  // The services this bot was given (gateway with MCP connections on): reached at the gateway with the run's token.
  const granted = bot && runToken ? grantedMcp(start.mcp) : [];
  // A bot's folder for this run (gateways from runner 0.8.0 on); without it, runs go as before.
  const ws = bot && workspace && typeof workspace === "object" ? workspace : null;
  const user = cfg.user;
  const runtime = bot?.runtime ?? "claude-code";
  const adapter = ADAPTERS[runtime];
  const contained = bot?.isolation === "container";
  const folder = contained ? "/home/bot" : routine.folder ? expand(routine.folder, user) : cfg.folder || home(user);
  log(`Run ${runInfo.id} of "${routine.name}" (${runInfo.trigger}${resume ? ", continuing" : ""}) ${contained ? "in its container" : `in ${folder}`}`);

  const finish = async (result) => {
    try {
      await call(cfg, "POST", `/v1/host/runs/${runInfo.id}`, result, { retries: 4 });
    } catch (err) {
      console.error(`Couldn't report the run: ${err.message}`);
    }
  };
  const fail = async (summary) => {
    await finish({ status: "failed", summary });
    process.exit(1);
  };

  if (!adapter) await fail(`This runner (${VERSION}) can't run "${runtime}" yet. Update the runner, or switch the bot to Claude Code.`);
  const codex = runtime === "codex";
  // Codex lives in the image for a container; on the computer itself it's the routine user's.
  const bin = codex ? (contained ? "codex" : codexPath(cfg)) : cfg.claude;
  if (codex && !bin) await fail(`Codex isn't installed on ${hostname()}. Install it (npm install -g @openai/codex), or run this bot in its own container.`);
  if (!contained && (!existsSync(folder) || !statSync(folder).isDirectory())) await fail(`The folder ${folder} doesn't exist on ${hostname()}.`);

  // A bot's run gets the ask_owner tool: its MCP config, readable by the run (and only it).
  const drop = process.getuid?.() === 0 && user !== "root";
  const as = drop ? account(user) : null;
  if (!contained && drop && (!Number.isInteger(as.uid) || !Number.isInteger(as.gid) || spawnSync(sys("setpriv"), ["--version"]).status !== 0)) {
    await fail(`Can't run as ${user} on ${hostname()}: the account or setpriv (util-linux) is missing.`);
  }
  const runDir = join(STATE_DIR, "runs", runInfo.id);
  let mcpFile = null;
  // Codex takes its MCP server on the command line (-c) and the run's token from its environment.
  let mcpServer = null;
  if (bot && runToken && codex) {
    mkdirSync(join(STATE_DIR, "runs"), { recursive: true, mode: 0o711 });
    chmodSync(join(STATE_DIR, "runs"), 0o711);
    mkdirSync(runDir, { mode: 0o700 });
    const owner = contained ? { uid: 1000, gid: 1000 } : as;
    if (owner && process.getuid?.() === 0) chownSync(runDir, owner.uid, owner.gid);
    mcpServer = { command: contained ? "node" : cfg.node, args: [contained ? "/opt/ambient/ambient-runner.mjs" : fileURLToPath(import.meta.url), "bot-mcp"] };
  } else if (bot && runToken) {
    // The routine's user passes through runs/ (no listing) into its own run's folder.
    mkdirSync(join(STATE_DIR, "runs"), { recursive: true, mode: 0o711 });
    chmodSync(join(STATE_DIR, "runs"), 0o711);
    mkdirSync(runDir, { mode: 0o700 });
    mcpFile = join(runDir, "mcp.json");
    const runnerPath = contained ? "/opt/ambient/ambient-runner.mjs" : fileURLToPath(import.meta.url);
    const node = contained ? "node" : cfg.node;
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          "ambient-bot": { command: node, args: [runnerPath, "bot-mcp"], env: { AMBIENT_SERVER: cfg.server, AMBIENT_RUN_TOKEN: runToken } },
          // The brain, with the run's token: what an employee's AI app may do there, while the run goes.
          ambient: { type: "http", url: `${cfg.server}/mcp`, headers: { Authorization: `Bearer ${runToken}` } },
          ...Object.fromEntries(granted.map((c) => [c.name, { type: "http", url: `${cfg.server}${c.path}`, headers: { Authorization: `Bearer ${runToken}` } }])),
        },
      }),
      { mode: 0o600 },
    );
    // The container's user (node, uid 1000) or the routine's user reads it.
    const owner = contained ? { uid: 1000, gid: 1000 } : as;
    if (owner && process.getuid?.() === 0) {
      chownSync(runDir, owner.uid, owner.gid);
      chownSync(mcpFile, owner.uid, owner.gid);
    }
  }
  // The run's out folder (memory.md, handoff.md) and, in a container, its skills.
  let outDir = null;
  let skillsDir = null;
  if (ws) {
    const owner = contained ? { uid: 1000, gid: 1000 } : as;
    const chown = (path) => {
      if (owner && process.getuid?.() === 0) chownSync(path, owner.uid, owner.gid);
    };
    if (!existsSync(runDir)) {
      mkdirSync(join(STATE_DIR, "runs"), { recursive: true, mode: 0o711 });
      chmodSync(join(STATE_DIR, "runs"), 0o711);
      mkdirSync(runDir, { mode: 0o700 });
      chown(runDir);
    }
    outDir = join(runDir, "out");
    mkdirSync(outDir, { mode: 0o700 });
    chown(outDir);
    for (const [name, text] of [["memory.md", typeof ws.memory === "string" ? ws.memory : ""], ["handoff.md", ""]]) {
      writeFileSync(join(outDir, name), text, { mode: 0o600 });
      chown(join(outDir, name));
    }
    // Skills only in a container: on the computer itself they'd go into the user's own ~/.claude.
    if (contained) {
      skillsDir = join(runDir, "skills");
      mkdirSync(skillsDir, { mode: 0o755 });
      chmodSync(skillsDir, 0o755);
      for (const skill of Array.isArray(ws.skills) ? ws.skills : []) {
        const path = skillPath(skill?.path);
        if (!path || typeof skill.content !== "string") {
          log(`Skipping a skill file with a path that isn't allowed: ${String(skill?.path).slice(0, 80)}`);
          continue;
        }
        const file = join(skillsDir, path);
        mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
        writeFileSync(file, skill.content, { mode: 0o644 });
      }
    }
  }
  const system = ws && typeof ws.system === "string" && ws.system.trim() ? ws.system.replaceAll("{{OUT}}", contained ? CONTAINER_OUT : outDir) : null;
  const cleanup = () => rmSync(runDir, { recursive: true, force: true });

  // Codex bots: the computer's ChatGPT sign-in goes into the container (and back out, refreshed)
  // unless an OpenAI key from Ambient is used.
  const openaiKey = codex ? chosenOpenAI() : {};
  let codexAuth = null;
  if (codex && contained && !openaiKey.CODEX_API_KEY) {
    const hostAuth = join(as?.home ?? home(user), ".codex", "auth.json");
    const text = readOut(dirname(hostAuth), "auth.json");
    if (text) {
      codexAuth = { dir: join(runDir, "codex-auth"), hostAuth, text };
      if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true, mode: 0o700 });
      mkdirSync(codexAuth.dir, { mode: 0o700 });
      writeFileSync(join(codexAuth.dir, "auth.json"), text, { mode: 0o600 });
      if (process.getuid?.() === 0) {
        chownSync(codexAuth.dir, 1000, 1000);
        chownSync(join(codexAuth.dir, "auth.json"), 1000, 1000);
      }
    }
  }
  // Codex's own run settings: its model (a bot's own OpenAI model), never Claude Code's flags.
  const runCfg = codex ? cfg : { ...cfg, claudeArgs: [...withModel(cfg.claudeArgs, bot?.model ?? readState().model), ...(contained ? [] : settingArgs(cfg))] };
  // A conversation kept in another settings folder (before the runner had its own) can't be
  // resumed: the run continues from what the bot handed over instead.
  let carryOn = resume;
  if (!codex && !contained && carryOn?.sessionId) {
    const configDir = runEnv(cfg).CLAUDE_CONFIG_DIR;
    if (configDir && !sessionKnown(configDir, carryOn.sessionId)) {
      log(`Its last session was kept in another settings folder: continuing in a new one`);
      carryOn = { ...carryOn, sessionId: null };
    }
  }
  // Files that came with the message that started this run (docs/bots.md, "Files in the chat"):
  // fetched with the run's token into its out folder, and named in the message, as on Amb's computer.
  if (carryOn && Array.isArray(carryOn.files) && carryOn.files.length && runToken && outDir) {
    const dir = join(outDir, "files");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fileOwner = contained ? { uid: 1000, gid: 1000 } : as;
    if (fileOwner && process.getuid?.() === 0) chownSync(dir, fileOwner.uid, fileOwner.gid);
    const saved = [];
    for (const f of carryOn.files.slice(0, 4)) {
      const name = String(f?.name ?? "file").replace(/[^A-Za-z0-9._ -]/g, "_").slice(-120) || "file";
      try {
        const res = await fetch(`${cfg.server}/v1/bot/files/${encodeURIComponent(String(f.id))}`, { headers: { authorization: `Bearer ${runToken}` }, signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(join(dir, name), Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
        if (fileOwner && process.getuid?.() === 0) chownSync(join(dir, name), fileOwner.uid, fileOwner.gid);
        saved.push(`${contained ? CONTAINER_OUT : outDir}/files/${name}`);
      } catch (err) {
        log(`Couldn't fetch ${name} for the run: ${err.message}`);
      }
    }
    if (saved.length) carryOn = { ...carryOn, message: `${carryOn.message}\n\nFiles that came with it (open them with your file tools):\n${saved.map((p) => `- ${p}`).join("\n")}` };
  }
  const mcpArg = codex ? mcpServer : mcpFile && (contained ? "/opt/ambient/mcp.json" : mcpFile);
  // A bot's Claude Code run stays open for messages that come in while it works (stream-json in).
  const streaming = Boolean(adapter.streams && bot && runToken);
  const { args, stdin } = adapter.start(runCfg, routine, runInfo, bot, carryOn, mcpArg, system, { contained, outDir: contained ? null : outDir, streaming, granted: granted.map((c) => ({ name: c.name, url: `${cfg.server}${c.path}` })) });
  const codexEnv = codex ? { ...openaiKey, ...(mcpServer ? { AMBIENT_SERVER: cfg.server, AMBIENT_RUN_TOKEN: runToken } : {}) } : {};
  let child;
  let containerName = null;
  if (contained) {
    const p = podman();
    if (!p) {
      cleanup();
      await fail(`Podman isn't installed on ${hostname()}, and this bot runs in its own container. Install it (apt-get install -y podman), or switch the bot to run on the computer itself.`);
    }
    const built = ensureImage(p);
    if (built) {
      cleanup();
      await fail(built);
    }
    containerName = `ambient-run-${runInfo.id}`.slice(0, 60);
    // Values reach podman through its environment (never its command line); `-e NAME` passes one on.
    const secretEnv = Object.fromEntries(Object.entries(secrets).filter(([k]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && !RESERVED_ENV.test(k)));
    // Claude Code gets its sign-in; Codex its OpenAI key (if one is chosen) and the run's token for its MCP server.
    const pass = codex ? { ...secretEnv, ...codexEnv } : { ...signInEnv(chosenClaude(pick(process.env, new RegExp(`^(${AUTH_ENV.join("|")})$`)))), ...secretEnv };
    const podArgs = [
      "run", "--rm", "-i", "--name", containerName, "--user", "node", "--security-opt", "no-new-privileges", "--cap-drop", "all", ...LIMITS,
      "-v", `ambient-bot-${routine.id}:/home/bot:U`,
      "-v", `${fileURLToPath(import.meta.url)}:/opt/ambient/ambient-runner.mjs:ro`,
      ...(mcpFile ? ["-v", `${mcpFile}:/opt/ambient/mcp.json:ro`] : []),
      // Its out folder (memory.md, handoff.md) to write, its skills to read.
      ...(outDir ? ["-v", `${outDir}:${CONTAINER_OUT}`] : []),
      ...(skillsDir ? ["-v", `${skillsDir}:${CONTAINER_SKILLS}:ro`] : []),
      ...(codexAuth ? ["-v", `${codexAuth.dir}:${CONTAINER_CODEX_AUTH}`] : []),
      // A team's bot reads the team's wiki (the brain), never writes it.
      ...teamWikiMount(),
      "-w", "/home/bot",
      "-e", `AMBIENT_ROUTINE_ID=${routine.id}`, "-e", `AMBIENT_ROUTINE_NAME=${routine.name.replace(/[\r\n]/g, " ")}`, "-e", `AMBIENT_RUN_ID=${runInfo.id}`,
      ...Object.keys(pass).flatMap((k) => ["-e", k]),
      // With a workspace, a small shell puts the skills in place first, then becomes Claude Code.
      ...(codex ? [IMAGE, "sh", "-c", CODEX_SCRIPT, "sh", ...args] : skillsDir ? [IMAGE, "sh", "-c", SKILLS_SCRIPT, "sh", ...args] : [IMAGE, "claude", ...args]),
    ];
    child = spawn(p, podArgs, { env: { PATH: SYSTEM_PATH.join(":"), HOME: "/root", ...pass }, stdio: ["pipe", "pipe", "pipe"] });
  } else {
    child = spawn(drop ? sys("setpriv") : bin, drop ? ["--reuid", String(as.uid), "--regid", String(as.gid), "--init-groups", "--", bin, ...args] : args, {
      cwd: folder,
      env: runEnv(
        cfg,
        {
          AMBIENT_ROUTINE_ID: routine.id,
          AMBIENT_ROUTINE_NAME: routine.name,
          AMBIENT_RUN_ID: runInfo.id,
          ...(drop ? { HOME: as.home, USER: user, LOGNAME: user } : {}),
          ...codexEnv,
        },
        secrets,
      ),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  mark("spawn");

  // ---- messages while it works ----
  // Every couple of seconds the run asks for what came into its thread (its run token) and writes
  // it into the session: Claude Code takes it in at its next step, in the same turn. After a turn
  // ends the run waits a moment for more; with nothing new it closes, and the session ends. An
  // answer to a message taken in after a turn ended goes to the thread at once (POST /v1/bot/reply).
  const userLine = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
  const results = [];
  const posted = new Set();
  let closing = false;
  let inboxCursor;
  let tookIn = 0;
  let wroteSinceResult = false;
  const takeInbox = async () => {
    try {
      const res = await fetch(`${cfg.server}/v1/bot/inbox${inboxCursor !== undefined ? `?after=${inboxCursor}` : ""}`, {
        headers: { authorization: `Bearer ${runToken}`, "user-agent": `ambient-runner/${VERSION}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      const j = await res.json().catch(() => ({}));
      if (typeof j.cursor === "number") inboxCursor = j.cursor;
      return Array.isArray(j.messages) ? j.messages : [];
    } catch {
      return [];
    }
  };
  const deliver = (msgs) => {
    for (const m of msgs) {
      if (closing || tookIn >= INBOX_MAX) return;
      tookIn++;
      wroteSinceResult = true;
      child.stdin.write(userLine(`${String(m.who ?? "Your owner")} wrote to you in the Ambient app: ${String(m.text ?? "")}`));
      log(`Took in a message from ${m.who ?? "the owner"} while working`);
    }
  };
  const reply = async (r) => {
    if (posted.has(r) || !r.text?.trim()) return;
    posted.add(r);
    await fetch(`${cfg.server}/v1/bot/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json", "user-agent": `ambient-runner/${VERSION}` },
      body: JSON.stringify({ text: r.text.slice(0, 20_000) }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  };
  const close = () => {
    if (closing) return;
    closing = true;
    clearInterval(inboxTimer);
    child.stdin.end();
  };
  // A turn ended: more to answer (a message came in meanwhile, or one is waiting), or done.
  const turnEnded = async (r) => {
    wroteSinceResult = false;
    await new Promise((res) => setTimeout(res, STAY_MS));
    if (closing) return;
    if (!wroteSinceResult) deliver(await takeInbox());
    if (wroteSinceResult) void reply(r);
    else close();
  };
  let inboxTimer;
  // A session that ended on its own (or failed) must not take the run down when we write to it.
  child.stdin.on("error", () => {});
  if (streaming) {
    child.stdin.write(userLine(stdin));
    inboxTimer = setInterval(() => {
      if (!closing) void takeInbox().then(deliver);
    }, INBOX_EVERY_MS);
    inboxTimer.unref();
  } else child.stdin.end(stdin);

  let result = null;
  let stderr = "";
  let stopped = false;
  // Progress: tool uses and status lines the app shows while the run is going.
  const progressLines = [];
  let progressDirty = false;
  let bestText = ""; // longest text block seen — fallback if the result text is generic
  const reportProgress = async () => {
    if (!progressDirty) return;
    progressDirty = false;
    try {
      await call(cfg, "PATCH", `/v1/host/runs/${runInfo.id}`, { summary: progressLines.join("\n").slice(0, SUMMARY_MAX) }, { retries: 0 });
    } catch {
      // Best effort; the final result always goes through.
    }
  };
  const progressTimer = setInterval(reportProgress, 5_000);
  progressTimer.unref();

  // Live text (docs/bots.md, "Live text"): the block being written and the tool in use, sent a few
  // times a second while they change; the gateway shows them to whoever reads the bot's thread. A
  // gateway without it (404) or a plain loop: nothing is sent.
  let liveText = "";
  let liveTool = null;
  let liveSeq = 0;
  let liveDirty = false;
  let liveOn = Boolean(bot);
  let liveBusy = false;
  // Refused for sending too much (429): wait, so the computer's other calls aren't held up.
  let liveHoldUntil = 0;
  const sendLive = async () => {
    if (!liveOn || !liveDirty || liveBusy || Date.now() < liveHoldUntil) return;
    liveDirty = false;
    liveBusy = true;
    try {
      await call(cfg, "POST", `/v1/host/runs/${runInfo.id}/live`, { seq: ++liveSeq, text: liveText.slice(-8_000), tool: liveTool }, { retries: 0 });
    } catch (err) {
      // Not this run's any more, or a gateway without live text: stop. Too many: wait a little.
      if (err.status === 404 || err.status === 401) liveOn = false;
      else if (err.status === 429) {
        liveHoldUntil = Date.now() + 5_000;
        liveDirty = true;
      }
    } finally {
      liveBusy = false;
    }
  };
  const liveTimer = setInterval(() => void sendLive(), 250);
  liveTimer.unref();

  const ctx = {};
  createInterface({ input: child.stdout }).on("line", (line) => {
    for (const e of adapter.events(line, ctx)) {
      if (e.type === "ready") {
        mark("ready");
        continue;
      }
      if (e.type === "result") {
        mark("result");
        result = e;
        results.push(e);
        if (streaming) void turnEnded(e);
        continue;
      }
      if (e.type === "live_block") {
        liveText = "";
        liveTool = null;
        liveDirty = true;
        continue;
      }
      if (e.type === "live_delta") {
        liveText += e.text;
        liveTool = null;
        liveDirty = true;
        continue;
      }
      if (e.type === "live_tool") {
        liveTool = e.name;
        liveDirty = true;
        continue;
      }
      if (e.type === "text") mark("text");
      journalLine(e);
      if (e.type === "tool") {
        progressLines.push(`· ${e.name}${e.detail ? `: ${e.detail.slice(0, 120)}` : ""}`);
        progressDirty = true;
        // The tool with what it's doing, once Claude Code has written its input.
        liveTool = `${e.name}${e.detail ? `: ${e.detail.slice(0, 120)}` : ""}`;
        liveDirty = true;
      } else if (e.type === "text") {
        if (e.text.length > bestText.length) bestText = e.text;
        // The latest text replaces the previous one (it's the current status, not a log).
        if (progressLines.length && progressLines[progressLines.length - 1].startsWith("› ")) progressLines.pop();
        progressLines.push(`› ${e.text.replace(/\s+/g, " ").slice(0, 200)}`);
        progressDirty = true;
      }
    }
  });
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-4000);
    process.stderr.write(d);
  });
  const stop = () => {
    stopped = true;
    if (containerName) spawnSync(podman() ?? "podman", ["stop", "-t", "20", containerName]);
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
  clearInterval(liveTimer);
  closing = true;
  clearInterval(inboxTimer);
  // Answers to messages taken in that didn't reach the thread yet (all but the last: that's the result).
  if (streaming) for (const r of results.slice(0, -1)) await reply(r);
  mark("end");
  const u = result?.usage;
  log(
    `Timing: ${["api", "spawn", "ready", "text", "result", "end"].filter((k) => marks[k] !== undefined).map((k) => `${k} ${(marks[k] / 1000).toFixed(1)}s`).join(", ")}${u ? `; tokens in ${u.input ?? 0}, cache read ${u.cacheRead ?? 0}, cache write ${u.cacheWrite ?? 0}, out ${u.output ?? 0}` : ""}${tookIn ? `; took in ${tookIn} message(s) while working` : ""}`,
  );
  // What the bot left for its next run, read before the run's folder goes.
  const files = outDir ? { memory: readOut(outDir, "memory.md"), handoff: readOut(outDir, "handoff.md") } : {};
  if (codexAuth) keepCodexAuth(codexAuth, as);
  cleanup();

  const ok = code === 0 && result && result.ok && !stopped;
  let summary = result?.text ?? "";
  // If the model's last message was a generic wrap-up, use the longest text it wrote instead.
  if (ok && summary.length < 80 && bestText.length > summary.length) summary = bestText;
  if (!ok) {
    const why = stopped
      ? `Stopped: the run reached its ${RUN_LIMIT} limit or was stopped on ${hostname()}.`
      : code === 127
        ? contained
          ? "Podman couldn't start the bot's container."
          : `${adapter.label} wasn't found at ${bin}.`
        : // "success" is Claude Code's word for a run that ended normally, also with an error.
          `${adapter.label} ended with exit code ${code}${result?.subtype && result.subtype !== "success" ? ` (${result.subtype})` : ""}.`;
    const tail = stderr.trim().split("\n").slice(-6).join("\n");
    summary = [why, summary, tail].filter(Boolean).join("\n\n");
  }
  await finish({
    status: ok ? "succeeded" : "failed",
    exitCode: code,
    summary: summary.slice(0, SUMMARY_MAX * 2) || undefined,
    costUsd: result?.costUsd,
    turns: result?.turns,
    sessionId: result?.session,
    ...files,
  });
  log(`Run ${ok ? "succeeded" : "failed"} (exit ${code}${result?.costUsd !== undefined ? `, $${Number(result.costUsd).toFixed(2)}` : ""})`);
  process.exit(ok ? 0 : 1);
}

/**
 * Codex refreshes its ChatGPT sign-in while it works: what the container left goes back to the
 * computer's, when it changed and still is a sign-in (the next run, and Codex on the computer,
 * use the newest).
 */
function keepCodexAuth(c, as) {
  const text = readOut(c.dir, "auth.json");
  if (!text || text === c.text) return;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || !(j.tokens || j.OPENAI_API_KEY)) return;
    const tmp = `${c.hostAuth}.ambient-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    if (as && process.getuid?.() === 0) chownSync(tmp, as.uid, as.gid);
    renameSync(tmp, c.hostAuth);
    log("Kept Codex's refreshed sign-in from the bot's container.");
  } catch (err) {
    log(`Couldn't keep Codex's refreshed sign-in: ${err.message}`);
  }
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
  if (!code) die("usage: sudo node ambient-runner.mjs setup <code> [--user <name>] [--path <dirs to put first on PATH>] [--server <url>] [--claude <path>]", 2);
  if (process.getuid?.() !== 0) die("Run setup with sudo: it installs systemd units.");
  if (spawnSync(sys("systemctl"), ["--version"]).status !== 0) die("This computer has no systemd. Bots need Linux with systemd for now.");
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
  // Signing in comes after: install.sh does it (claude-token), or the app does (the computer, then Claude).
  const signedIn = claudeSignedIn(claude, user, { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "", ...env });

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
  const whose = out.computer.team ? "The team's bots" : "Ambient's chat and the bots you add in the Ambient app";
  log(`Connected as "${out.computer.name}". ${whose} run here as ${user}, in ${folder} unless a bot names its own folder.`);
  if (!signedIn) log(`Claude Code isn't signed in for ${user} yet: sign in with your Claude plan (install.sh does it), or add it in the Ambient app (the computer, then Claude).`);
  log(`Logs: journalctl -u 'ambient-routine-*' -u ambient-runner`);
}

// ---- status, uninstall ----

function status() {
  const cfg = config();
  log(`ambient-runner ${VERSION}, server ${cfg.server}, runs as ${cfg.user}`);
  const env = runEnv(cfg);
  log(`Claude: ${claudeLogin(cfg) ? "signed in" : "not signed in"}${env.CLAUDE_CONFIG_DIR && isolated(cfg, env) ? `, settings in ${env.CLAUDE_CONFIG_DIR} (not ${cfg.user}'s own)` : ""}`);
  const r = systemctl("list-timers", `${PREFIX}*.timer`, "--all", "--no-pager");
  log(r.stdout.trim() || "No bots on this computer yet.");
}

/** For install.sh: whether Claude Code can run here ("signed-in", exit 0) or not ("missing", exit 1). */
function claudeStatus() {
  const ok = claudeLogin(config());
  log(ok ? "signed-in" : "missing");
  process.exit(ok ? 0 : 1);
}

/**
 * A Claude plan's token from stdin (install.sh got it from `claude setup-token`): stored in
 * Ambient, sealed, as this computer's sign-in, then fetched back by a sync into claude.env.
 */
async function claudeToken() {
  if (process.getuid?.() !== 0) die("Run it with sudo.");
  const cfg = config();
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const token = Buffer.concat(chunks).toString("utf8").trim().replace(/^CLAUDE_CODE_OAUTH_TOKEN=/, "");
  if (!/^sk-ant-oat[A-Za-z0-9_-]+$/.test(token)) die("That isn't a Claude plan's token (it starts with sk-ant-oat).");
  try {
    await call(cfg, "POST", "/v1/host/claude", { kind: "plan", token });
  } catch (err) {
    die(`Ambient didn't take it: ${err.message}`);
  }
  await sync();
  log("Claude: this computer signs in with your plan now.");
}

function uninstall() {
  if (process.getuid?.() !== 0) die("Run uninstall with sudo.");
  // A team's brain here stops too; its data stays in TEAM_DATA (the team's wiki, until it has a new home).
  for (const u of [`${TEAM_UPKEEP}.timer`, TEAM_UNIT]) systemctl("disable", "--now", u);
  for (const f of existsSync(UNIT_DIR) ? readdirSync(UNIT_DIR) : []) {
    if (f.startsWith(PREFIX) && f.endsWith(".timer")) systemctl("disable", "--now", f);
  }
  systemctl("disable", "--now", "ambient-runner.timer");
  // Ambient's chat service too (its unit is ambient-runner-ambient.service).
  systemctl("disable", "--now", AMBIENT_UNIT);
  for (const f of readdirSync(UNIT_DIR)) {
    if (f.startsWith(PREFIX) || f.startsWith("ambient-runner.") || f === AMBIENT_UNIT || f.startsWith("ambient-team")) rmSync(join(UNIT_DIR, f), { force: true });
  }
  systemctl("daemon-reload");
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  log(`Removed. Remove the computer in the Ambient app too. The user it ran as stays (an "ambient" user made by install.sh: sudo userdel -r ambient)${existsSync(TEAM_DATA) ? `, and so does the team brain's data in ${TEAM_DATA}` : ""}.`);
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
  case "bot-mcp":
    await botMcp();
    break;
  case "ambient":
    await ambientService();
    break;
  case "image": {
    const p = podman();
    if (!p) die("Podman isn't installed. Install it first (apt-get install -y podman).");
    const err = ensureImage(p);
    if (err) die(err);
    log(`The bots' image ${IMAGE} is ready.`);
    break;
  }
  case "status":
    status();
    break;
  case "claude-status":
    claudeStatus();
    break;
  case "claude-token":
    await claudeToken();
    break;
  case "uninstall":
    uninstall();
    break;
  case "--version":
  case "version":
    log(VERSION);
    break;
  default:
    die("usage: ambient-runner setup <code> | sync | run <routine-id> | image | status | claude-status | claude-token | uninstall", 2);
}
