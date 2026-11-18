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

const VERSION = "0.7.6";
const DEFAULT_SERVER = "https://mcp.ambientartifacts.si";

const CONFIG_DIR = "/etc/ambient-runner";
const CONFIG = join(CONFIG_DIR, "runner.env");
/** Optional, written by whoever runs the computer: variables every run gets (a team server's ANTHROPIC_API_KEY). */
const EXTRA = join(CONFIG_DIR, "extra.env");
/** The Claude sign-in chosen in Ambient (a plan's token or an API key), fetched by sync. Wins over extra.env. */
const CLAUDE_ENV = process.env.AMBIENT_CLAUDE_ENV || join(CONFIG_DIR, "claude.env");
const INSTALL_DIR = process.env.AMBIENT_INSTALL_DIR || "/opt/ambient-runner";
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
  ambientUnit(cfg, out.ambient === true);
  await claudeSync(cfg, state, out.claude ?? null);
  const model = out.model ?? null;
  if (JSON.stringify(state.model ?? null) !== JSON.stringify(model)) {
    state.model = model;
    log(model ? `Default model: ${model.model}${model.effort ? ` (${model.effort})` : ""}` : "Default model: Claude Code's own");
    if (existsSync(join(UNIT_DIR, AMBIENT_UNIT))) systemctl("restart", AMBIENT_UNIT);
  }
  writeState(state);
  if (out.runner?.sha256 && (await selfUpdate(cfg, out.runner)) && out.ambient === true) systemctl("restart", AMBIENT_UNIT);
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

  const start = (uid, p, instructions) => {
    const dir = join(base, uid.replace(/[^A-Za-z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    own(base);
    own(dir);
    const mcpFile = join(confDir, `${uid.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { ambient: { type: "http", url: `${cfg.server}/mcp`, headers: { Authorization: `Bearer ${p.token}` } } } }), { mode: 0o600 });
    own(mcpFile);
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...withModel(cfg.claudeArgs, readState().model),
      "--mcp-config", mcpFile, "--allowedTools", "mcp__ambient",
      // Secrets go in through the app, never through a chat.
      "--disallowedTools", "mcp__ambient__set_routine_secret",
      "--append-system-prompt", instructions,
      ...(p.session ? ["--resume", p.session] : []),
    ];
    const env = runEnv(cfg, { ...(drop ? { HOME: as.home, USER: user, LOGNAME: user } : {}) });
    const proc = spawn(drop ? sys("setpriv") : cfg.claude, drop ? ["--reuid", String(as.uid), "--regid", String(as.gid), "--init-groups", "--", cfg.claude, ...args] : args, {
      cwd: dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    if (!p.child) start(uid, p, job.instructions);
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
      await call(cfg, "POST", `/v1/host/ambient/${job.id}`, r.ok ? { text: r.text } : { error: r.text || "Claude Code couldn't answer" });
      log(`Answered ${uid} (${r.turns ?? "?"} turns${r.costUsd !== undefined ? `, $${r.costUsd.toFixed(2)}` : ""})`);
    } catch (err) {
      await call(cfg, "POST", `/v1/host/ambient/${job.id}`, { error: err.message.slice(0, 1900) }).catch(() => {});
    }
  };

  /** Each person's turns in order (a promise chain per uid). */
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
    else if (job?.kind === "start") startJob(job);
    else if (job?.uid && job.token) {
      // One person's turns one after another: their message, a bot's question Ambient looks at,
      // the heartbeat all go to the same session, which answers one at a time.
      const prev = queues.get(job.uid) ?? Promise.resolve();
      const next = prev.then(() => handle(job));
      queues.set(job.uid, next.catch(() => {}));
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

/** The environment Claude Code runs in: the runner's, without the computer's token. */
function runEnv(cfg, extra = {}, secrets = {}) {
  const allowed = Object.fromEntries(Object.entries(secrets).filter(([k]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && !RESERVED_ENV.test(k)));
  const env = { ...process.env, ...allowed, ...extra };
  delete env.AMBIENT_HOST_TOKEN;
  // A Claude Code session's own variables stay out (when the runner itself is started from one); the
  // computer's sign-in (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, in extra.env) stays in.
  for (const k of Object.keys(env)) if ((k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN") || k === "CLAUDECODE") delete env[k];
  return signInEnv(chosenClaude(env));
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
    /** The command line after the binary, and what goes to stdin. */
    start(cfg, routine, runInfo, bot, resume, mcpConfig) {
      const args = ["-p", "--output-format", "stream-json", "--verbose", ...cfg.claudeArgs, "--append-system-prompt", systemPrompt(routine, runInfo.trigger, bot)];
      if (mcpConfig) args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__ambient-bot__ask_owner");
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
          },
        ];
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
};

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

const IMAGE_VERSION = "2";
const IMAGE = `localhost/ambient-bot:${IMAGE_VERSION}`;
const CONTAINERFILE = `FROM docker.io/library/node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gh jq ripgrep python3 python3-pil webp openssh-client less procps \\
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
# The image is the version; a run never updates Claude Code in place (it'd be lost with the container).
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
// `ambient-runner bot-mcp` speaks MCP over stdio (one JSON message per line) with one tool,
// ask_owner. Claude Code starts it from the run's MCP config, inside the bot's container when it
// has one. It holds the run's token, which only asks while this run goes.

const ASK_TOOL = {
  name: "ask_owner",
  description:
    "Ask your owner (the person this bot works for) a question and wait a few minutes for the answer in the Ambient app. Use it for decisions only they can make. Give choices when there are a few clear options.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "One short question." },
      choices: { type: "array", items: { type: "string" }, maxItems: 6, description: "Answers to pick from, if there are a few clear options." },
    },
    required: ["question"],
  },
};

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
  const ask = async ({ question, choices }) => {
    if (typeof question !== "string" || !question.trim()) return { text: "Pass a question.", error: true };
    const { id } = await api("POST", "/v1/bot/ask", { question, ...(Array.isArray(choices) && choices.length ? { choices: choices.map(String).slice(0, 6) } : {}) });
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
        send({ jsonrpc: "2.0", id: m.id, result: { tools: [ASK_TOOL] } });
      } else if (m.method === "tools/call" && m.params?.name === "ask_owner") {
        const out = await ask(m.params.arguments ?? {}).catch((err) => ({ text: `Couldn't ask: ${err.message}. Decide yourself if you can, and say so in your summary.`, error: true }));
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
  // `env`: the owner's secrets (a bot: only those granted to it). They go to the run only.
  const { run: runInfo, routine, env: secrets = {}, bot = null, resume = null, runToken = null } = start;
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
  if (!contained && (!existsSync(folder) || !statSync(folder).isDirectory())) await fail(`The folder ${folder} doesn't exist on ${hostname()}.`);

  // A bot's run gets the ask_owner tool: its MCP config, readable by the run (and only it).
  const drop = process.getuid?.() === 0 && user !== "root";
  const as = drop ? account(user) : null;
  if (!contained && drop && (!Number.isInteger(as.uid) || !Number.isInteger(as.gid) || spawnSync(sys("setpriv"), ["--version"]).status !== 0)) {
    await fail(`Can't run as ${user} on ${hostname()}: the account or setpriv (util-linux) is missing.`);
  }
  const runDir = join(STATE_DIR, "runs", runInfo.id);
  let mcpFile = null;
  if (bot && runToken) {
    // The routine's user passes through runs/ (no listing) into its own run's folder.
    mkdirSync(join(STATE_DIR, "runs"), { recursive: true, mode: 0o711 });
    chmodSync(join(STATE_DIR, "runs"), 0o711);
    mkdirSync(runDir, { mode: 0o700 });
    mcpFile = join(runDir, "mcp.json");
    const runnerPath = contained ? "/opt/ambient/ambient-runner.mjs" : fileURLToPath(import.meta.url);
    const node = contained ? "node" : cfg.node;
    writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { "ambient-bot": { command: node, args: [runnerPath, "bot-mcp"], env: { AMBIENT_SERVER: cfg.server, AMBIENT_RUN_TOKEN: runToken } } } }),
      { mode: 0o600 },
    );
    // The container's user (node, uid 1000) or the routine's user reads it.
    const owner = contained ? { uid: 1000, gid: 1000 } : as;
    if (owner && process.getuid?.() === 0) {
      chownSync(runDir, owner.uid, owner.gid);
      chownSync(mcpFile, owner.uid, owner.gid);
    }
  }
  const cleanup = () => rmSync(runDir, { recursive: true, force: true });

  const runCfg = { ...cfg, claudeArgs: withModel(cfg.claudeArgs, bot?.model ?? readState().model) };
  const { args, stdin } = adapter.start(runCfg, routine, runInfo, bot, resume, mcpFile && (contained ? "/opt/ambient/mcp.json" : mcpFile));
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
    const pass = { ...signInEnv(chosenClaude(pick(process.env, new RegExp(`^(${AUTH_ENV.join("|")})$`)))), ...Object.fromEntries(Object.entries(secrets).filter(([k]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && !RESERVED_ENV.test(k))) };
    const podArgs = [
      "run", "--rm", "-i", "--name", containerName, "--user", "node", "--security-opt", "no-new-privileges", "--cap-drop", "all", ...LIMITS,
      "-v", `ambient-bot-${routine.id}:/home/bot:U`,
      "-v", `${fileURLToPath(import.meta.url)}:/opt/ambient/ambient-runner.mjs:ro`,
      ...(mcpFile ? ["-v", `${mcpFile}:/opt/ambient/mcp.json:ro`] : []),
      // A team's bot reads the team's wiki (the brain), never writes it.
      ...teamWikiMount(),
      "-w", "/home/bot",
      "-e", `AMBIENT_ROUTINE_ID=${routine.id}`, "-e", `AMBIENT_ROUTINE_NAME=${routine.name.replace(/[\r\n]/g, " ")}`, "-e", `AMBIENT_RUN_ID=${runInfo.id}`,
      ...Object.keys(pass).flatMap((k) => ["-e", k]),
      IMAGE, "claude", ...args,
    ];
    child = spawn(p, podArgs, { env: { PATH: SYSTEM_PATH.join(":"), HOME: "/root", ...pass }, stdio: ["pipe", "pipe", "pipe"] });
  } else {
    child = spawn(drop ? sys("setpriv") : cfg.claude, drop ? ["--reuid", String(as.uid), "--regid", String(as.gid), "--init-groups", "--", cfg.claude, ...args] : args, {
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
  }
  child.stdin.end(stdin);

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

  createInterface({ input: child.stdout }).on("line", (line) => {
    for (const e of adapter.events(line)) {
      if (e.type === "result") {
        result = e;
        continue;
      }
      journalLine(e);
      if (e.type === "tool") {
        progressLines.push(`· ${e.name}${e.detail ? `: ${e.detail.slice(0, 120)}` : ""}`);
        progressDirty = true;
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
          : `Claude Code wasn't found at ${cfg.claude}.`
        : // "success" is Claude Code's word for a run that ended normally, also with an error.
          `Claude Code ended with exit code ${code}${result?.subtype && result.subtype !== "success" ? ` (${result.subtype})` : ""}.`;
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
  });
  log(`Run ${ok ? "succeeded" : "failed"} (exit ${code}${result?.costUsd !== undefined ? `, $${Number(result.costUsd).toFixed(2)}` : ""})`);
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
  case "uninstall":
    uninstall();
    break;
  case "--version":
  case "version":
    log(VERSION);
    break;
  default:
    die("usage: ambient-runner setup <code> | sync | run <routine-id> | image | status | uninstall", 2);
}
