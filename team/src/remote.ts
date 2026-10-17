// The team wiki's own repo (GitHub, GitLab, Azure DevOps, Bitbucket, any git over HTTPS),
// set by a team admin in the app. The team server keeps its local git repo as the working
// copy: it pulls (rebase) before every write and every few minutes, and pushes after every
// commit. The token lives only on this server, in a file only the service user can read, and
// sealed there with BRAIN_TEAM_SECRET (from the env file, not the data directory) when it's set,
// so a backup or copy of the data alone doesn't hand out push access to the team's repo.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { checkRepoUrl, git, GitError, remoteInfo, type GitOptions, type RemoteRepo } from "@brain/wiki";

interface RemoteConfig {
  url: string;
  token: string;
  branch: string;
  status: "ok" | "error";
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
}

export type RemoteStatus = Omit<RemoteConfig, "token">;

export class TeamRemote {
  private config: RemoteConfig | null = null;

  private key: Buffer | null;

  constructor(
    private file: string,
    private wikiDir: string,
    private opts: GitOptions = {},
    secret?: string | null,
  ) {
    this.key = secret ? Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "ambient team repo token", 32)) : null;
  }

  async load(): Promise<void> {
    let stored: RemoteConfig & { tokenSealed?: string };
    try {
      stored = JSON.parse(await readFile(this.file, "utf8")) as RemoteConfig & { tokenSealed?: string };
    } catch {
      this.config = null;
      return;
    }
    if (stored.tokenSealed) {
      if (!this.key) {
        console.error("[team] the repo token is sealed but BRAIN_TEAM_SECRET isn't set: repo sync is off until it is");
        this.config = null;
        return;
      }
      const { tokenSealed, ...rest } = stored;
      try {
        this.config = { ...rest, token: this.open(tokenSealed) };
      } catch {
        // Sealed with another secret (changed, or mistyped): the server still starts.
        console.error("[team] the repo token doesn't open with this BRAIN_TEAM_SECRET (changed since it was sealed?): repo sync is off until the secret is right or the repo is connected again");
        this.config = null;
      }
      return;
    }
    this.config = stored;
    // Written before the secret was set: seal it now.
    if (this.key && this.config.token) await this.save();
  }

  private seal(token: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key!, iv);
    const body = Buffer.concat([c.update(token, "utf8"), c.final(), c.getAuthTag()]);
    return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
  }

  private open(sealed: string): string {
    const [, iv, body] = sealed.split(".");
    const raw = Buffer.from(body ?? "", "base64url");
    const d = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(iv ?? "", "base64url"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8");
  }

  get connected(): boolean {
    return this.config !== null;
  }

  status(): RemoteStatus | null {
    if (!this.config) return null;
    const { token: _token, ...rest } = this.config;
    return rest;
  }

  private get remote(): RemoteRepo {
    return { url: this.config!.url, token: this.config!.token };
  }

  private async save(): Promise<void> {
    if (!this.config) return;
    const { token, ...rest } = this.config;
    const stored = this.key ? { ...rest, tokenSealed: this.seal(token) } : this.config;
    await writeFile(this.file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  private async record(ok: boolean, what: "push" | "pull" | "connect", error?: string): Promise<void> {
    if (!this.config) return;
    const now = new Date().toISOString();
    this.config.status = ok ? "ok" : "error";
    this.config.lastError = ok ? null : (error ?? "failed").slice(0, 300);
    if (ok && what === "push") this.config.lastPushAt = now;
    if (ok && what === "pull") this.config.lastPullAt = now;
    await this.save();
  }

  /**
   * Point the wiki at the team's repo and push its history. A non-empty repo is accepted only
   * if it shares history with this wiki (reconnecting); we never write into an unrelated repo.
   */
  async connect(rawUrl: string, token: string): Promise<RemoteStatus> {
    const url = await checkRepoUrl(rawUrl, this.opts);
    if (!token.trim()) throw new GitError("Add an access token for the repo.", "auth");
    const remote: RemoteRepo = { url, token: token.trim() };
    const info = await remoteInfo(remote, this.opts);
    const g = (args: string[], withAuth = false) => git(args, { cwd: this.wikiDir, ...(withAuth ? { remote } : {}), ...this.opts });
    await g(["remote", "remove", "origin"]).catch(() => undefined);
    await g(["remote", "add", "origin", url]);
    if (!info.empty) {
      await g(["fetch", "-q", "origin", info.branch], true);
      const shared = await g(["merge-base", "HEAD", "FETCH_HEAD"]).then(() => true, () => false);
      if (!shared) {
        await g(["remote", "remove", "origin"]).catch(() => undefined);
        throw new GitError("This repo already has other content. Use a new, empty repo.", "not_empty");
      }
      await g(["rebase", "-q", "FETCH_HEAD"]).catch(async (err) => {
        await g(["rebase", "--abort"]).catch(() => undefined);
        throw err;
      });
    }
    await g(["push", "-q", "origin", `HEAD:refs/heads/${info.branch}`], true);
    const now = new Date().toISOString();
    this.config = { url, token: remote.token, branch: info.branch, status: "ok", lastPushAt: now, lastPullAt: now, lastError: null };
    await this.save();
    return this.status()!;
  }

  async disconnect(): Promise<void> {
    await git(["remote", "remove", "origin"], { cwd: this.wikiDir, ...this.opts }).catch(() => undefined);
    await rm(this.file, { force: true });
    this.config = null;
  }

  /** Bring in commits made in the repo (people, Claude Code, Obsidian). True when HEAD moved. */
  async pull(): Promise<boolean> {
    if (!this.config) return false;
    const before = (await git(["rev-parse", "HEAD"], { cwd: this.wikiDir, ...this.opts })).trim();
    try {
      await git(["pull", "-q", "--rebase", "origin", this.config.branch], { cwd: this.wikiDir, remote: this.remote, ...this.opts });
      await this.record(true, "pull");
    } catch (err) {
      await git(["rebase", "--abort"], { cwd: this.wikiDir, ...this.opts }).catch(() => undefined);
      await this.record(false, "pull", (err as Error).message);
      return false;
    }
    return (await git(["rev-parse", "HEAD"], { cwd: this.wikiDir, ...this.opts })).trim() !== before;
  }

  /** Push the wiki's commits; if the repo moved meanwhile, rebase once and retry. */
  async push(): Promise<void> {
    if (!this.config) return;
    const push = () => git(["push", "-q", "origin", `HEAD:refs/heads/${this.config!.branch}`], { cwd: this.wikiDir, remote: this.remote, ...this.opts });
    try {
      await push().catch(async (err) => {
        if (!(err instanceof GitError) || err.code !== "conflict") throw err;
        if (!(await this.pull()) && this.config?.status === "error") throw err;
        await push();
      });
      await this.record(true, "push");
    } catch (err) {
      await this.record(false, "push", (err as Error).message);
    }
  }
}
