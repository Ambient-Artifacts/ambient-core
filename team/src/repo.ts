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

/** Who a change is by: the commit's author. Ambient stays the committer. */
export interface Author {
  name: string;
  email: string;
}

/**
 * The person a note, recording or saved page is from, as a commit author: their name as the
 * gateway sends it (from their account, never from the device) and their page in the team
 * (`people/lena-vogel`) as the address, so `git log` and the history in GitHub or Azure DevOps say
 * who changed what. Undefined without a name: Ambient's own work stays the bot's.
 */
export function personAuthor(name: string | null | undefined, ref?: string | null): Author | undefined {
  const clean = (name ?? "").replace(/[<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) return undefined;
  const slug = ref?.startsWith("people/") ? ref.slice("people/".length) : "";
  return { name: clean, email: `${/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) ? slug : "member"}@people.ambient.invalid` };
}

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
    await writeFile(join(this.dir, ".gitignore"), "out/\n.brain/\n");
    // Adopt pages already in the folder (e.g. a wiki moved onto this server), not just AGENTS.md.
    await this.git("add", "-A");
    await this.git("commit", "-q", "-m", "init: team wiki");
  }

  async commit(paths: string[], message: string, author?: Author): Promise<string | null> {
    if (paths.length === 0) return null;
    // -f: only files Ambient just wrote are listed, and a team's own .gitignore may name raw/.
    await this.git("add", "-f", "--", ...paths);
    const { stdout: staged } = await this.git("diff", "--cached", "--name-only");
    if (!staged.trim()) return null;
    await this.git("commit", "-q", "-m", message, ...(author ? [`--author=${author.name} <${author.email}>`] : []));
    return this.head();
  }

  async head(): Promise<string> {
    const { stdout } = await this.git("rev-parse", "HEAD");
    return stdout.trim();
  }
}
