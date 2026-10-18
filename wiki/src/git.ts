// Git plumbing for wikis that live in a user's or team's own repo (GitHub, GitLab, Azure
// DevOps, Bitbucket, any git server over HTTPS). Shared by the gateway (personal repos) and
// the team server (team repos).
// - Only https:// URLs to public hosts (no SSRF into our own network); file:// only in tests.
//   The host is checked again on every git call that talks to it, and git is pinned to the
//   address that passed (http.curloptResolve), so DNS that answers differently the second time
//   can't send it into the network; redirects aren't followed.
// - The token never appears in the process list or in .git/config: it is passed to git as an
//   Authorization header through GIT_CONFIG_* environment variables.
// - Symlinks in a repo are checked out as plain files holding the link's target (core.symlinks
//   false): a link committed to someone's repo must never make the gateway or a team server read
//   or write a file outside the wiki (/etc/brain/*.env, for one).
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { lstat, readdir } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";


/**
 * git in a process group of its own (spawn's `detached`; execFile doesn't take it): `stop` kills
 * the whole group. stdout is kept up to `maxBuffer`; past it the run fails.
 */
function run(args: string[], opts: { env: NodeJS.ProcessEnv; maxBuffer: number }): { done: Promise<{ stdout: string }>; stop: () => void } {
  const child = spawn("git", args, { env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => {
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  const done = new Promise<{ stdout: string }>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > opts.maxBuffer) stop();
      else out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.reduce((n, x) => n + x.length, 0) < 64 * 1024) err.push(b);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0 && size <= opts.maxBuffer) resolve({ stdout });
      else reject(Object.assign(new Error(`git exited with ${signal ?? code}${size > opts.maxBuffer ? " (output too large)" : ""}`), { stderr }));
    });
  });
  return { done, stop };
}

export interface RemoteRepo {
  url: string;
  /** Access token with read/write to this one repo (GitHub fine-grained, GitLab, ADO PAT, Bitbucket). */
  token: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: "bad_url" | "auth" | "not_found" | "not_empty" | "has_content" | "conflict" | "too_large" | "failed" = "failed",
  ) {
    super(message);
  }
}

/**
 * A repo that already has files of its own, and wasn't written by Ambient: connected only once
 * someone has seen what's in it and said so (`existing`). `files` and `sample` are for that
 * question.
 */
export class HasContent extends GitError {
  constructor(
    readonly files: number,
    readonly sample: string[],
  ) {
    super(`This repo already has ${files} ${files === 1 ? "file" : "files"} of its own.`, "has_content");
  }

  /** From the repo's file list, with a sample that shows what's in it (see sampleFiles). */
  static of(files: string[]): HasContent {
    return new HasContent(files.length, sampleFiles(files));
  }
}

/**
 * A few file names that show what a repo holds, for the "connect it anyway?" question. Git lists
 * files sorted, which puts hidden folders (`.azuredevops/`, `.claude/`) first; people recognise a
 * repo by its pages. So: Markdown pages in folders first, one per folder, then pages at the top,
 * then other files, hidden ones last; then more of the same order to fill up.
 */
export function sampleFiles(files: string[], n = 5): string[] {
  const rank = (f: string) => {
    if (f.split("/").some((part) => part.startsWith("."))) return 3;
    if (!f.toLowerCase().endsWith(".md")) return 2;
    return f.includes("/") ? 0 : 1;
  };
  const ordered = files.map((f, i) => ({ f, r: rank(f), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.f);
  const picked: string[] = [];
  const folders = new Set<string>();
  for (const f of ordered) {
    const top = f.includes("/") ? f.split("/")[0]! : f;
    if (picked.length < n && !folders.has(top)) {
      folders.add(top);
      picked.push(f);
    }
  }
  for (const f of ordered) if (picked.length < n && !picked.includes(f)) picked.push(f);
  return picked;
}

export interface GitOptions {
  /** Tests use local bare repos (file://). Never set in production. */
  allowFile?: boolean;
  /** What a clone may take on disk, and how many files; MAX_CLONE_BYTES / MAX_CLONE_FILES unless set (tests set less). */
  maxCloneBytes?: number;
  maxCloneFiles?: number;
}

export const BOT_AUTHOR = { name: "Ambient Bot", email: "bot@ambient.invalid" };

// Addresses git must never reach: private, loopback, link-local (cloud metadata), shared, reserved,
// multicast. BlockList also matches IPv4 written as IPv6 (`::ffff:7f00:1` is 127.0.0.1), which
// URL parsing produces from `[::ffff:127.0.0.1]`. The IPv6 ranges that carry IPv4 inside them on
// networks that route them (6to4, Teredo, NAT64, IPv4-translated) and old site-local go too.
const BLOCKED = (() => {
  const b = new BlockList();
  for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) b.addSubnet(net, bits, "ipv4");
  for (const [net, bits] of [["::", 96], ["::1", 128], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2001::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) b.addSubnet(net, bits, "ipv6");
  return b;
})();
const isPrivate = (ip: string) => BLOCKED.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

/** A clean https URL to a public host (or file:// in tests); credentials in the URL are refused. */
export async function checkRepoUrl(raw: string, opts: GitOptions = {}): Promise<string> {
  return (await resolveRepoUrl(raw, opts)).url;
}

/** checkRepoUrl, plus the public address git must use for it (none for file://). */
async function resolveRepoUrl(raw: string, opts: GitOptions = {}): Promise<{ url: string; pin?: string }> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new GitError("That isn't a valid URL.", "bad_url");
  }
  if (u.protocol === "file:" && opts.allowFile) return { url: u.toString() };
  if (u.protocol !== "https:") throw new GitError("Use the repo's https:// address.", "bad_url");
  if (u.username || u.password) throw new GitError("Put the token in the token field, not in the URL.", "bad_url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new GitError(`Can't find ${host}.`, "bad_url");
  if (addrs.some(isPrivate)) throw new GitError("That address isn't reachable from Ambient.", "bad_url");
  if (isIP(host)) return { url: u.toString() };
  // curl's --resolve format: HOST:PORT:ADDRESS, IPv6 in brackets; IPv4 first when there is one.
  const addr = addrs.find((a) => isIP(a) === 4) ?? addrs[0]!;
  return { url: u.toString(), pin: `${host}:${u.port || "443"}:${isIP(addr) === 6 ? `[${addr}]` : addr}` };
}

/** Username for token auth over HTTPS, by host. */
function tokenUser(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (host.endsWith("github.com")) return "x-access-token";
  if (host.includes("gitlab")) return "oauth2";
  if (host.endsWith("bitbucket.org")) return "x-token-auth";
  return "git";
}

function env(remote?: RemoteRepo, opts: GitOptions = {}, pin?: string): NodeJS.ProcessEnv {
  const cfg: [string, string][] = [
    ["credential.helper", ""],
    ["protocol.file.allow", opts.allowFile ? "always" : "never"],
    ["user.name", BOT_AUTHOR.name],
    ["user.email", BOT_AUTHOR.email],
    ["init.defaultBranch", "main"],
    ["core.symlinks", "false"],
    ["http.followRedirects", "false"],
  ];
  if (pin) cfg.push(["http.curloptResolve", pin]);
  if (remote?.token) {
    const basic = Buffer.from(`${tokenUser(remote.url)}:${remote.token}`).toString("base64");
    cfg.push(["http.extraHeader", `Authorization: Basic ${basic}`]);
  }
  const out: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? "/tmp",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_AUTHOR_NAME: BOT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: BOT_AUTHOR.email,
    GIT_COMMITTER_NAME: BOT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: BOT_AUTHOR.email,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(cfg.length),
  };
  cfg.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = k;
    out[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return out;
}

/** What a clone may take on disk (pack and working copy), checked while it runs. */
export const MAX_CLONE_BYTES = 256 * 1024 * 1024;
/** And files: a repo of empty files takes no bytes but every inode, and a long time to walk. */
export const MAX_CLONE_FILES = 60_000;

/** Bytes and number of regular files under `dir` (links not followed); stops counting past `stopAt` files. */
async function dirUsage(dir: string, stopAt = Number.POSITIVE_INFINITY, acc = { bytes: 0, files: 0 }): Promise<{ bytes: number; files: number }> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (acc.files > stopAt) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) await dirUsage(p, stopAt, acc);
    else if (e.isFile()) {
      acc.files++;
      acc.bytes += (await lstat(p).catch(() => ({ size: 0 }))).size;
    }
  }
  return acc;
}

/**
 * Run git. Errors are mapped to plain-language GitErrors; the token never appears in them.
 * `limit`: a folder git writes into and the most it may hold. The repo is someone's own, as big as
 * they like, and the gateway's disk is everyone's: past the limit, git is stopped.
 *
 * git runs in a process group of its own, and stopping it (the limit, the timeout) stops the whole
 * group: `git clone` hands the download to helpers (remote-https, fetch-pack, index-pack) that
 * keep going, and writing, when only `git` itself is killed.
 */
export async function git(
  args: string[],
  o: { cwd?: string; remote?: RemoteRepo; timeoutMs?: number; limit?: { dir: string; bytes: number; files?: number } } & GitOptions = {},
): Promise<string> {
  // A call that talks to the remote checks its address again, now, and git connects only there.
  const pin = o.remote ? (await resolveRepoUrl(o.remote.url, o)).pin : undefined;
  const { done, stop } = run(o.cwd ? ["-C", o.cwd, ...args] : args, { env: env(o.remote, o, pin), maxBuffer: 64 * 1024 * 1024 });
  let tooLarge = false;
  let timedOut = false;
  const over = (u: { bytes: number; files: number }) => !!o.limit && (u.bytes > o.limit.bytes || u.files > (o.limit.files ?? MAX_CLONE_FILES));
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, o.timeoutMs ?? 120_000);
  let measuring = false;
  const watch = o.limit
    ? setInterval(() => {
        if (measuring) return;
        measuring = true;
        void dirUsage(o.limit!.dir, o.limit!.files ?? MAX_CLONE_FILES)
          .then((u) => {
            if (over(u)) {
              tooLarge = true;
              stop();
            }
          })
          .finally(() => (measuring = false));
      }, 250)
    : undefined;
  try {
    const { stdout } = await done;
    // Done before a check came round (a fast clone): measured once more.
    if (o.limit && over(await dirUsage(o.limit.dir, o.limit.files ?? MAX_CLONE_FILES))) tooLarge = true;
    if (!tooLarge) return stdout;
    throw new Error("too large");
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const text = `${e.stderr ?? ""} ${e.message}`.replace(/Authorization: Basic \S+/g, "Authorization: …");
    if (tooLarge) {
      const mb = Math.round(o.limit!.bytes / 1024 / 1024);
      throw new GitError(`This repo is too large for Ambient (more than ${mb} MB or ${o.limit!.files ?? MAX_CLONE_FILES} files). Use a repo for the wiki alone.`, "too_large");
    }
    if (timedOut) throw new GitError("The repo took too long to answer.");
    if (/Authentication failed|could not read Username|403|401|Invalid username or password|access denied|not authorized/i.test(text)) {
      throw new GitError("The token was refused. Check that it can read and write this repo.", "auth");
    }
    if (/not found|does not exist|Repository not found|404/i.test(text)) throw new GitError("Repo not found. Check the URL and that the token can see it.", "not_found");
    if (/non-fast-forward|\[rejected\]|fetch first|conflict/i.test(text)) throw new GitError("The repo changed at the same time; will retry.", "conflict");
    throw new GitError(`git failed: ${text.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }
}

/** The remote's default branch, and whether it has any commits yet. */
export async function remoteInfo(remote: RemoteRepo, opts: GitOptions = {}): Promise<{ empty: boolean; branch: string }> {
  const out = await git(["ls-remote", "--symref", remote.url, "HEAD"], { remote, timeoutMs: 30_000, ...opts });
  const sym = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out);
  if (sym) return { empty: false, branch: safeBranch(sym[1]!) };
  const any = await git(["ls-remote", "--heads", remote.url], { remote, timeoutMs: 30_000, ...opts });
  const first = /refs\/heads\/(\S+)/.exec(any);
  return first ? { empty: false, branch: safeBranch(first[1]!) } : { empty: true, branch: "main" };
}

/** The remote names its branch, and the name goes into git's arguments: a plain name only. */
function safeBranch(name: string): string {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(name) || name.includes("..")) throw new GitError("The repo's default branch has a name Ambient can't use.", "bad_url");
  return name;
}

/** A shallow working copy in `dir` (created), ready to commit on `branch`. Works for empty repos. */
export async function checkout(remote: RemoteRepo, dir: string, opts: GitOptions = {}): Promise<{ branch: string; empty: boolean }> {
  const info = await remoteInfo(remote, opts);
  if (info.empty) {
    await git(["init", "-q", "-b", info.branch, dir], opts);
    await git(["remote", "add", "origin", remote.url], { cwd: dir, ...opts });
  } else {
    await git(["clone", "-q", "--depth", "1", "--branch", info.branch, remote.url, dir], { remote, limit: { dir, bytes: opts.maxCloneBytes ?? MAX_CLONE_BYTES, files: opts.maxCloneFiles ?? MAX_CLONE_FILES }, ...opts });
  }
  return info;
}

/** Commit everything in `dir` and push; null when nothing changed. */
export async function commitAndPush(dir: string, remote: RemoteRepo, branch: string, message: string, opts: GitOptions = {}): Promise<string | null> {
  await git(["add", "-A"], { cwd: dir, ...opts });
  const status = await git(["status", "--porcelain"], { cwd: dir, ...opts });
  if (!status.trim()) return null;
  await git(["commit", "-q", "-m", message], { cwd: dir, ...opts });
  await git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, remote, ...opts });
  return (await git(["rev-parse", "HEAD"], { cwd: dir, ...opts })).trim();
}
