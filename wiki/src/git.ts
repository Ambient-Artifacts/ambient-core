// Git plumbing for wikis that live in a user's or team's own repo (GitHub, GitLab, Azure
// DevOps, Bitbucket, any git server over HTTPS). Shared by the gateway (personal repos) and
// the team server (team repos).
// - Only https:// URLs to public hosts (no SSRF into our own network); file:// only in tests.
// - The token never appears in the process list or in .git/config: it is passed to git as an
//   Authorization header through GIT_CONFIG_* environment variables.
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RemoteRepo {
  url: string;
  /** Access token with read/write to this one repo (GitHub fine-grained, GitLab, ADO PAT, Bitbucket). */
  token: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: "bad_url" | "auth" | "not_found" | "not_empty" | "conflict" | "failed" = "failed",
  ) {
    super(message);
  }
}

export interface GitOptions {
  /** Tests use local bare repos (file://). Never set in production. */
  allowFile?: boolean;
}

export const BOT_AUTHOR = { name: "Ambient Bot", email: "bot@ambient.invalid" };

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];
const isPrivate = (ip: string) =>
  isIP(ip) === 4 ? PRIVATE_V4.some((r) => r.test(ip)) : /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip) || ip === "::";

/** A clean https URL to a public host (or file:// in tests); credentials in the URL are refused. */
export async function checkRepoUrl(raw: string, opts: GitOptions = {}): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new GitError("That isn't a valid URL.", "bad_url");
  }
  if (u.protocol === "file:" && opts.allowFile) return u.toString();
  if (u.protocol !== "https:") throw new GitError("Use the repo's https:// address.", "bad_url");
  if (u.username || u.password) throw new GitError("Put the token in the token field, not in the URL.", "bad_url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new GitError(`Can't find ${host}.`, "bad_url");
  if (addrs.some(isPrivate)) throw new GitError("That address isn't reachable from Ambient.", "bad_url");
  return u.toString();
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

function env(remote?: RemoteRepo, opts: GitOptions = {}): NodeJS.ProcessEnv {
  const cfg: [string, string][] = [
    ["credential.helper", ""],
    ["protocol.file.allow", opts.allowFile ? "always" : "never"],
    ["user.name", BOT_AUTHOR.name],
    ["user.email", BOT_AUTHOR.email],
    ["init.defaultBranch", "main"],
  ];
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

/** Run git. Errors are mapped to plain-language GitErrors; the token never appears in them. */
export async function git(args: string[], o: { cwd?: string; remote?: RemoteRepo; timeoutMs?: number } & GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await run("git", o.cwd ? ["-C", o.cwd, ...args] : args, {
      env: env(o.remote, o),
      timeout: o.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string; killed?: boolean };
    const text = `${e.stderr ?? ""} ${e.message}`.replace(/Authorization: Basic \S+/g, "Authorization: …");
    if (e.killed) throw new GitError("The repo took too long to answer.");
    if (/Authentication failed|could not read Username|403|401|Invalid username or password|access denied|not authorized/i.test(text)) {
      throw new GitError("The token was refused. Check that it can read and write this repo.", "auth");
    }
    if (/not found|does not exist|Repository not found|404/i.test(text)) throw new GitError("Repo not found. Check the URL and that the token can see it.", "not_found");
    if (/non-fast-forward|\[rejected\]|fetch first|conflict/i.test(text)) throw new GitError("The repo changed at the same time; will retry.", "conflict");
    throw new GitError(`git failed: ${text.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
  }
}

/** The remote's default branch, and whether it has any commits yet. */
export async function remoteInfo(remote: RemoteRepo, opts: GitOptions = {}): Promise<{ empty: boolean; branch: string }> {
  const out = await git(["ls-remote", "--symref", remote.url, "HEAD"], { remote, timeoutMs: 30_000, ...opts });
  const sym = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out);
  if (sym) return { empty: false, branch: sym[1]! };
  const any = await git(["ls-remote", "--heads", remote.url], { remote, timeoutMs: 30_000, ...opts });
  const first = /refs\/heads\/(\S+)/.exec(any);
  return first ? { empty: false, branch: first[1]! } : { empty: true, branch: "main" };
}

/** A shallow working copy in `dir` (created), ready to commit on `branch`. Works for empty repos. */
export async function checkout(remote: RemoteRepo, dir: string, opts: GitOptions = {}): Promise<{ branch: string; empty: boolean }> {
  const info = await remoteInfo(remote, opts);
  if (info.empty) {
    await git(["init", "-q", "-b", info.branch, dir], opts);
    await git(["remote", "add", "origin", remote.url], { cwd: dir, ...opts });
  } else {
    await git(["clone", "-q", "--depth", "1", "--branch", info.branch, remote.url, dir], { remote, ...opts });
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
