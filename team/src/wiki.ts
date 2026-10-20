// The team wiki on disk plus its in-memory search index. Writes go to disk,
// the index and git together, one at a time (simple in-process lock).
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attention, LocalReader, indexFilesIn, normalizeIgnore, renderIndexFiles, WikiStore } from "@brain/wiki";
import type { TeamRemote } from "./remote.ts";
import { Repo } from "./repo.ts";

/** Write a file in the wiki; `index: false` keeps it out of the page index (raw transcripts). */
export type Put = (path: string, text: string, opts?: { index?: boolean }) => Promise<void>;

/** What Ambient wrote into .gitignore before transcripts were committed to raw/. */
const LEGACY_GITIGNORE = "raw/\nout/\n.brain/\n";

/** A write to a team wiki whose repo another tool keeps (read-only): refused, never queued. */
export class ReadOnlyWiki extends Error {
  constructor() {
    super("Another tool keeps this team's brain. Ambient only reads it, so nothing can be added here.");
  }
}

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
  /** Folders and files of the repo that aren't knowledge (templates, a README) and stay out of the brain. */
  private ignore: string[];
  /** The team's own repo, when an admin connected one. */
  remote?: TeamRemote;

  constructor(
    readonly dir: string,
    readonly teamId: string,
    readonly teamName = "Team",
    ignore: readonly string[] = [],
  ) {
    this.repo = new Repo(dir);
    this.ignore = normalizeIgnore(ignore);
    this.store = WikiStore.fromDirectory(dir, "team", teamId, { ignore: this.ignore });
  }

  /** The team changed what stays out: read the repo again without it (or with it again). */
  setIgnore(list: readonly string[]): void {
    const next = normalizeIgnore(list);
    if (next.join("\n") === this.ignore.join("\n")) return;
    this.ignore = next;
    this.reload();
  }

  get reader(): LocalReader {
    return new LocalReader(this.store);
  }

  static async open(dir: string, teamId: string, teamName: string, remote?: TeamRemote, ignore: readonly string[] = []): Promise<TeamWiki> {
    await new Repo(dir).ensure(teamName);
    const wiki = new TeamWiki(dir, teamId, teamName, ignore);
    if (remote) {
      await remote.load();
      wiki.remote = remote;
    }
    wiki.knownHead = await wiki.repo.head();
    // Repos from before index pages existed (or edited by hand) get them now; a read-only
    // wiki is the repo's, as it is.
    if (!remote?.readOnly) {
      await wiki.write(async () => ({ message: "index: rebuild", result: {} }));
      await wiki.trackRaw();
    }
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

  /**
   * Wikis Ambient created before transcript destinations ignored raw/; transcripts are committed
   * there now (product/sources.md), so drop that line once. A .gitignore anyone else wrote stays
   * as it is (the commit adds the transcripts anyway).
   */
  private async trackRaw(): Promise<void> {
    const file = join(this.dir, ".gitignore");
    if (!existsSync(file) || readFileSync(file, "utf8") !== LEGACY_GITIGNORE) return;
    await this.write(async (put) => {
      await put(".gitignore", "out/\n.brain/\n", { index: false });
      return { message: "chore: track raw/ for meeting transcripts", result: {} };
    });
  }

  /** Re-read everything from disk (after another process, e.g. the nightly job, committed). */
  reload(): void {
    this.store = WikiStore.fromDirectory(this.dir, "team", this.teamId, { ignore: this.ignore });
  }

  read(path: string): string {
    return readFileSync(inside(this.dir, path), "utf8");
  }

  /** Serialize writers: each callback runs alone and its files land in one commit. */
  write<T>(
    fn: (put: Put, remove: (path: string) => Promise<void>) => Promise<{ message: string; result: T }>,
  ): Promise<T & { commit: string | null }> {
    if (this.remote?.readOnly) return Promise.reject(new ReadOnlyWiki());
    const next = this.chain.then(async () => {
      // Start from the repo's latest state, so edits made there aren't overwritten.
      if (this.remote?.connected && (await this.remote.pull())) this.reload();
      const touched: string[] = [];
      const put: Put = async (path, text, opts = {}) => {
        const file = inside(this.dir, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
        // Raw transcripts are committed but aren't pages: no index entry, no search, no findById.
        if (opts.index !== false) this.store.upsert(path, text);
        touched.push(path);
      };
      const remove = async (path: string) => {
        await rm(inside(this.dir, path), { force: true });
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
    const file = inside(this.dir, "log.md");
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
    const rendered = renderIndexFiles(this.store.entries(), `${this.teamName} wiki`, attention(this.store.lint()), this.store.folderNotes);
    const keep = new Set(this.remote?.keep ?? []);
    for (const [path, text] of rendered) {
      // The repo's own index.md (it had one when it was connected) stays as its people wrote it.
      if (keep.has(path)) continue;
      // A folder from the repo that can't be written to (a link on the way, say) gets no index,
      // rather than every write failing, and the server with it (it writes at startup).
      const file = insideOrNull(this.dir, path);
      if (!file) continue;
      if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
      changed.push(path);
    }
    // A folder whose pages all moved or went keeps no index of nothing.
    for (const path of await indexFilesIn(this.dir)) {
      const file = rendered.has(path) ? null : insideOrNull(this.dir, path);
      if (!file) continue;
      await rm(file, { force: true });
      changed.push(path);
    }
    return changed;
  }
}

/**
 * `path` inside the wiki at `dir`, or an error: not absolute, no "..", and no symlink on the way.
 * A connected repo could commit a link pointing anywhere on the server (git checks links out as
 * plain files, core.symlinks false, but a checkout from before that may still hold one).
 */
function inside(dir: string, path: string): string {
  const parts = path.split("/");
  // ".." as a part of the path, not inside a name: a folder "v1..v2" from the repo is fine.
  if (!path || parts.some((p) => p === "" || p === "." || p === "..") || path.includes("\\") || path.includes("\0")) throw new Error(`bad path ${path}`);
  let at = dir;
  for (const part of parts) {
    at = join(at, part);
    let link: boolean;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      break; // Not there yet, so nothing below it can be a link.
    }
    if (link) throw new Error(`bad path ${path}`);
  }
  return join(dir, path);
}

function insideOrNull(dir: string, path: string): string | null {
  try {
    return inside(dir, path);
  } catch {
    return null;
  }
}
