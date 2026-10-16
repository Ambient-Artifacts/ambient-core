// The team wiki on disk plus its in-memory search index. Writes go to disk,
// the index and git together, one at a time (simple in-process lock).
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attention, LocalReader, indexFilesIn, renderIndexFiles, WikiStore } from "@brain/wiki";
import type { TeamRemote } from "./remote.ts";
import { Repo } from "./repo.ts";

export class TeamWiki {
  readonly repo: Repo;
  store: WikiStore;
  private chain: Promise<unknown> = Promise.resolve();
  private knownHead: string | null = null;

  /** The wiki's git head as last seen (health reports it; the gateway tells the apps when it moves). */
  get head(): string | null {
    return this.knownHead;
  }
  private lastCheck = 0;
  private lastPull = 0;
  /** The team's own repo, when an admin connected one. */
  remote?: TeamRemote;

  constructor(
    readonly dir: string,
    readonly teamId: string,
    readonly teamName = "Team",
  ) {
    this.repo = new Repo(dir);
    this.store = WikiStore.fromDirectory(dir, "team", teamId);
  }

  get reader(): LocalReader {
    return new LocalReader(this.store);
  }

  static async open(dir: string, teamId: string, teamName: string, remote?: TeamRemote): Promise<TeamWiki> {
    await new Repo(dir).ensure(teamName);
    const wiki = new TeamWiki(dir, teamId, teamName);
    if (remote) {
      await remote.load();
      wiki.remote = remote;
    }
    wiki.knownHead = await wiki.repo.head();
    // Repos from before index pages existed (or edited by hand) get them now.
    await wiki.write(async () => ({ message: "index: rebuild", result: {} }));
    return wiki;
  }

  /** Pick up commits made by other processes (the nightly job). Checks git at most every `everyMs`. */
  async refresh(everyMs = 30_000): Promise<void> {
    if (Date.now() - this.lastCheck < everyMs) return;
    this.lastCheck = Date.now();
    // With a connected repo, also bring in edits made there (at most every 5 minutes).
    if (this.remote?.connected && Date.now() - this.lastPull > 5 * 60_000) {
      this.lastPull = Date.now();
      await this.exclusive(async () => {
        if (await this.remote!.pull()) this.reload();
      });
    }
    await this.chain;
    const head = await this.repo.head();
    if (head !== this.knownHead) {
      this.reload();
      this.knownHead = head;
    }
  }

  /** Re-read everything from disk (after another process, e.g. the nightly job, committed). */
  reload(): void {
    this.store = WikiStore.fromDirectory(this.dir, "team", this.teamId);
  }

  read(path: string): string {
    return readFileSync(join(this.dir, path), "utf8");
  }

  /** Serialize writers: each callback runs alone and its files land in one commit. */
  write<T>(
    fn: (put: (path: string, text: string) => Promise<void>, remove: (path: string) => Promise<void>) => Promise<{ message: string; result: T }>,
  ): Promise<T & { commit: string | null }> {
    const next = this.chain.then(async () => {
      // Start from the repo's latest state, so edits made there aren't overwritten.
      if (this.remote?.connected && (await this.remote.pull())) this.reload();
      const touched: string[] = [];
      const put = async (path: string, text: string) => {
        if (path.includes("..") || path.startsWith("/")) throw new Error(`bad path ${path}`);
        await mkdir(dirname(join(this.dir, path)), { recursive: true });
        await writeFile(join(this.dir, path), text);
        this.store.upsert(path, text);
        touched.push(path);
      };
      const remove = async (path: string) => {
        if (path.includes("..") || path.startsWith("/")) throw new Error(`bad path ${path}`);
        await rm(join(this.dir, path), { force: true });
        this.store.remove(path);
        touched.push(path);
      };
      const { message, result } = await fn(put, remove);
      if (touched.length) touched.push(await this.appendLog(message));
      touched.push(...(await this.writeIndexes()));
      const commit = touched.length ? await this.repo.commit(touched, message) : null;
      if (commit) {
        this.knownHead = commit;
        await this.remote?.push();
      }
      return { ...result, commit };
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * One line per change in log.md, newest last, greppable: `## [2026-10-07] ingest | Title`.
   * The commit message's "kind: rest" becomes the line.
   */
  private async appendLog(message: string): Promise<string> {
    const file = join(this.dir, "log.md");
    const colon = message.indexOf(":");
    const kind = colon > 0 ? message.slice(0, colon).trim() : "change";
    const rest = (colon > 0 ? message.slice(colon + 1) : message).replace(/\s+/g, " ").trim();
    const head = existsSync(file) ? readFileSync(file, "utf8") : `# ${this.teamName} wiki log\n\nEvery change to this wiki, newest last.\n\n`;
    await writeFile(file, `${head.trimEnd()}\n## [${new Date().toISOString().slice(0, 10)}] ${kind} | ${rest}\n`);
    return "log.md";
  }

  /** Run alone (no write in between), e.g. to connect the repo. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Regenerate index.md and every folder's _index.md; returns the files that changed. */
  private async writeIndexes(): Promise<string[]> {
    const changed: string[] = [];
    const rendered = renderIndexFiles(this.store.entries(), `${this.teamName} wiki`, attention(this.store.lint()));
    for (const [path, text] of rendered) {
      const file = join(this.dir, path);
      if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
      changed.push(path);
    }
    // A folder whose pages all moved or went keeps no index of nothing.
    for (const path of await indexFilesIn(this.dir)) {
      if (rendered.has(path)) continue;
      await rm(join(this.dir, path), { force: true });
      changed.push(path);
    }
    return changed;
  }
}
