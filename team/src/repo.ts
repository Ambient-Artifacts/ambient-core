// Minimal git plumbing for the team wiki. The repo lives on the team server
// (hosted mode); every write is one bot commit, so git history is the undo log.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentsDoc } from "@brain/wiki";

const run = promisify(execFile);

export const BOT = { name: "Ambient Bot", email: "bot@ambient.invalid" };

export class Repo {
  constructor(readonly dir: string) {}

  private git(...args: string[]) {
    return run("git", ["-C", this.dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: BOT.name,
        GIT_AUTHOR_EMAIL: BOT.email,
        GIT_COMMITTER_NAME: BOT.name,
        GIT_COMMITTER_EMAIL: BOT.email,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  /** Create the repo with the team wiki skeleton if it doesn't exist yet. */
  async ensure(teamName: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (existsSync(join(this.dir, ".git"))) return;
    await run("git", ["init", "-q", "-b", "main", this.dir]);
    await writeFile(join(this.dir, "AGENTS.md"), agentsDoc({ kind: "team", name: `${teamName} wiki` }));
    await writeFile(join(this.dir, ".gitignore"), "raw/\nout/\n.brain/\n");
    // Adopt pages already in the folder (e.g. a wiki moved onto this server), not just AGENTS.md.
    await this.git("add", "-A");
    await this.git("commit", "-q", "-m", "init: team wiki");
  }

  async commit(paths: string[], message: string): Promise<string | null> {
    if (paths.length === 0) return null;
    await this.git("add", "--", ...paths);
    const { stdout: staged } = await this.git("diff", "--cached", "--name-only");
    if (!staged.trim()) return null;
    await this.git("commit", "-q", "-m", message);
    return this.head();
  }

  async head(): Promise<string> {
    const { stdout } = await this.git("rev-parse", "HEAD");
    return stdout.trim();
  }
}
