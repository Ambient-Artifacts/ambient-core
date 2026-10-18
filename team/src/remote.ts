// The team wiki's own repo (GitHub, GitLab, Azure DevOps, Bitbucket, any git over HTTPS),
// set by a team admin in the app. Two ways to connect one:
//   two-way    Ambient keeps the wiki: the team server keeps its local git repo as the working
//              copy, pulls (rebase) before every write and every few minutes, and pushes after
//              every commit.
//   read-only  another tool keeps the wiki (a company's own pipeline, say): the team server
//              follows the repo exactly (fetch, reset) and never writes, commits or pushes.
// A repo with files of its own is connected only once someone has seen what's in it
// (`existing`). Then, two-way, Ambient never overwrites the repo's own AGENTS.md or index.md
// (`keep`). The token lives only on this server, in a file only the service user can read, and
// sealed there with BRAIN_TEAM_SECRET (from the env file, not the data directory) when it's set,
// so a backup or copy of the data alone doesn't hand out push access to the team's repo.
import { readFile, rm, writeFile } from "node:fs/promises";
import { checkRepoUrl, git, GitError, HasContent, remoteInfo, type GitOptions, type RemoteRepo } from "@brain/wiki";
import { sealer, type Sealer } from "./seal.ts";

export type RepoMode = "two-way" | "read-only";

interface RemoteConfig {
  url: string;
  token: string;
  branch: string;
  status: "ok" | "error";
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  /** Absent: two-way (connected before there was a choice). */
  mode?: RepoMode;
  /** Files the repo had of its own when it was connected, which Ambient never writes. */
  keep?: string[];
}

export type RemoteStatus = Omit<RemoteConfig, "token">;

export class TeamRemote {
  private config: RemoteConfig | null = null;

  private key: Sealer | null;

  constructor(
    private file: string,
    private wikiDir: string,
    private opts: GitOptions = {},
    secret?: string | null,
  ) {
    this.key = sealer(secret, "ambient team repo token");
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
        this.config = { ...rest, token: this.key.open(tokenSealed) };
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

  get connected(): boolean {
    return this.config !== null;
  }

  /** Another tool keeps the wiki: nothing here may write it. */
  get readOnly(): boolean {
    return this.config?.mode === "read-only";
  }

  /** Paths Ambient doesn't write in this wiki (the repo's own AGENTS.md or index.md). */
  get keep(): string[] {
    return this.config?.keep ?? [];
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
    const stored = this.key ? { ...rest, tokenSealed: this.key.seal(token) } : this.config;
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
   * Point the wiki at the team's repo. Two-way, the wiki's history goes there: into an empty repo,
   * onto one that shares history with it (reconnecting), or merged with one that has files of
   * its own once `existing` says someone has seen them (the repo's version wins where both have
   * a file, and its own AGENTS.md and index.md are never written after). Read-only, the wiki
   * becomes the repo's content, and only for a wiki that has no notes yet: they'd be lost.
   */
  async connect(rawUrl: string, token: string, opts: { mode?: RepoMode; existing?: boolean } = {}): Promise<RemoteStatus> {
    const mode = opts.mode ?? "two-way";
    const url = await checkRepoUrl(rawUrl, this.opts);
    if (!token.trim()) throw new GitError("Add an access token for the repo.", "auth");
    const remote: RemoteRepo = { url, token: token.trim() };
    const info = await remoteInfo(remote, this.opts);
    if (mode === "read-only" && info.empty) throw new GitError("This repo is empty, so there's nothing to read. Connect it as \"Ambient keeps this wiki\" instead.", "bad_url");
    const g = (args: string[], withAuth = false) => git(args, { cwd: this.wikiDir, ...(withAuth ? { remote } : {}), ...this.opts });
    const forget = () => g(["remote", "remove", "origin"]).catch(() => undefined);
    await forget();
    await g(["remote", "add", "origin", url]);
    let keep: string[] = [];
    if (!info.empty) {
      await g(["fetch", "-q", "origin", info.branch], true);
      const shared = await g(["merge-base", "HEAD", "FETCH_HEAD"]).then(() => true, () => false);
      if (!shared) {
        const files = (await g(["ls-tree", "-r", "--name-only", "FETCH_HEAD"])).split("\n").filter(Boolean);
        if (!opts.existing) {
          await forget();
          throw new HasContent(files.length, files.slice(0, 5));
        }
        if (mode === "read-only") {
          const notes = (await g(["ls-files", "--", "notes"])).trim();
          if (notes) {
            await forget();
            throw new GitError("This team's wiki already has notes, which a read-only repo would replace. Connect a read-only repo to a new team.", "not_empty");
          }
        } else {
          keep = ["AGENTS.md", "index.md"].filter((f) => files.includes(f));
          await g(["merge", "-q", "--allow-unrelated-histories", "-X", "theirs", "-m", "connect: the team's repo", "FETCH_HEAD"]).catch(async (err) => {
            await g(["merge", "--abort"]).catch(() => undefined);
            await forget();
            throw err;
          });
        }
      }
      if (mode === "read-only") {
        // The repo is the wiki: what was here (the new team's empty skeleton) gives way.
        await g(["reset", "-q", "--hard", "FETCH_HEAD"]);
      } else if (shared) {
        await g(["rebase", "-q", "FETCH_HEAD"]).catch(async (err) => {
          await g(["rebase", "--abort"]).catch(() => undefined);
          throw err;
        });
      }
    }
    if (mode === "two-way") await g(["push", "-q", "origin", `HEAD:refs/heads/${info.branch}`], true);
    const now = new Date().toISOString();
    this.config = { url, token: remote.token, branch: info.branch, status: "ok", lastPushAt: mode === "two-way" ? now : null, lastPullAt: now, lastError: null, mode, keep };
    await this.save();
    return this.status()!;
  }

  async disconnect(): Promise<void> {
    await git(["remote", "remove", "origin"], { cwd: this.wikiDir, ...this.opts }).catch(() => undefined);
    await rm(this.file, { force: true });
    this.config = null;
  }

  /**
   * Bring in commits made in the repo (people, Claude Code, Obsidian). True when HEAD moved.
   * Read-only, the wiki follows the repo exactly: nothing here is ever kept against it.
   */
  async pull(): Promise<boolean> {
    if (!this.config) return false;
    const before = (await git(["rev-parse", "HEAD"], { cwd: this.wikiDir, ...this.opts })).trim();
    try {
      if (this.readOnly) {
        await git(["fetch", "-q", "origin", this.config.branch], { cwd: this.wikiDir, remote: this.remote, ...this.opts });
        await git(["reset", "-q", "--hard", "FETCH_HEAD"], { cwd: this.wikiDir, ...this.opts });
      } else {
        await git(["pull", "-q", "--rebase", "origin", this.config.branch], { cwd: this.wikiDir, remote: this.remote, ...this.opts });
      }
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
    if (!this.config || this.readOnly) return;
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
