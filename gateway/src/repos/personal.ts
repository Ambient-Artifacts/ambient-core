// Personal wikis in the user's own git repo. The encrypted copy in Convex stays the
// server's working store (MCP, upkeep, the phone's sync); the repo is kept in step with it
// in both directions by a three-way sync against what both sides last agreed on:
//   only Ambient changed a file → write it to the repo
//   only the repo changed it    → import it (the phone pulls it like any server write)
//   both changed it             → living pages merge (mergeLiving), other files: Ambient wins
// Generated files (index.md, _index.md, AGENTS.md) are rebuilt on every sync, never imported.
// Every sync works in a throwaway shallow clone; nothing stays on disk.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { mergeLiving } from "@brain/spec";
import { agentsDoc, attention, checkRepoUrl, checkout, commitAndPush, git, GitError, HasContent, remoteInfo, indexFilesIn, renderIndexFiles, WikiStore, type GitOptions, type RemoteRepo } from "@brain/wiki";
import { api, type Control } from "../control.ts";
import { PERSONAL_PATH, type PersonalStore } from "../personal.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const LIVING = /^wiki\/(people|orgs|projects|topics)\//;
/** Marker that tells us a non-empty repo is an Ambient wiki (safe to write into). */
const MARKER = "This wiki is written by Ambient";

interface SyncState {
  /** path → hash both sides last agreed on. */
  base: Record<string, string>;
  commit: string | null;
  /** The repo's own AGENTS.md or wiki/index.md, there before it was connected: never written. */
  keep?: string[];
}

export interface RepoStatus {
  url: string;
  branch: string;
  status: "ok" | "error";
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface RepoSyncResult {
  exported: number;
  imported: number;
  merged: number;
  commit: string | null;
}

export class PersonalRepos {
  constructor(
    private control: Control,
    private personal: PersonalStore,
    private opts: GitOptions = {},
  ) {}

  async status(uid: string): Promise<RepoStatus | null> {
    const r = await this.control.q(api.repos.get, { uid: uid as never });
    return r ? { url: r.url, branch: r.branch, status: r.status, lastSyncAt: r.lastSyncAt ?? null, lastError: r.lastError ?? null } : null;
  }

  /**
   * Check the repo and token, store them, and push the wiki for the first time. A repo with files
   * of its own (not an Ambient wiki already) is connected only with `existing`, once the person
   * has seen what's in it; Ambient then keeps `wiki/` and `raw/` there, and never writes the
   * repo's own AGENTS.md or wiki/index.md.
   */
  async connect(uid: string, rawUrl: string, token: string, opts: { existing?: boolean } = {}): Promise<RepoStatus> {
    const url = await checkRepoUrl(rawUrl, this.opts);
    if (!token.trim()) throw new GitError("Add an access token for the repo.", "auth");
    const remote: RemoteRepo = { url, token: token.trim() };
    const info = await remoteInfo(remote, this.opts);
    const keep = info.empty ? [] : await this.whatsThere(remote, opts.existing === true);
    const sealed = await this.personal.seal(uid, "repo:token", remote.token);
    await this.control.m(api.repos.connect, { uid: uid as never, url, branch: info.branch, tokenIv: sealed.iv, tokenCt: sealed.ciphertext, now: Date.now() });
    if (keep.length) {
      const state = await this.personal.seal(uid, "repo:state", JSON.stringify({ base: {}, commit: null, keep } satisfies SyncState));
      await this.control.m(api.repos.record, { uid: uid as never, ok: true, stateIv: state.iv, stateCt: state.ciphertext, now: Date.now() });
    }
    await this.sync(uid);
    return (await this.status(uid))!;
  }

  async disconnect(uid: string): Promise<void> {
    await this.control.m(api.repos.disconnect, { uid: uid as never });
  }

  /** Sync every connected user (the worker, every 15 minutes). One failure doesn't stop the rest. */
  async syncAll(): Promise<{ uid: string; ok: boolean; result?: RepoSyncResult; error?: string }[]> {
    const out = [];
    for (const r of await this.control.q(api.repos.connected, {})) {
      try {
        out.push({ uid: r.uid, ok: true, result: await this.sync(r.uid) });
      } catch (err) {
        out.push({ uid: r.uid, ok: false, error: (err as Error).message });
      }
    }
    return out;
  }

  /** One three-way sync. Retries once if the repo moved while we were pushing. */
  async sync(uid: string): Promise<RepoSyncResult> {
    try {
      return await this.syncOnce(uid).catch((err) => {
        if (err instanceof GitError && err.code === "conflict") return this.syncOnce(uid);
        throw err;
      });
    } catch (err) {
      await this.control.m(api.repos.record, { uid: uid as never, ok: false, error: (err as Error).message, now: Date.now() });
      throw err;
    }
  }

  private async syncOnce(uid: string): Promise<RepoSyncResult> {
    const rec = await this.control.q(api.repos.get, { uid: uid as never });
    if (!rec) throw new GitError("No repo connected.");
    const remote: RemoteRepo = { url: rec.url, token: await this.personal.open(uid, "repo:token", rec.tokenIv, rec.tokenCt) };
    const state: SyncState = rec.stateCt ? JSON.parse(await this.personal.open(uid, "repo:state", rec.stateIv!, rec.stateCt)) : { base: {}, commit: null };

    const dir = await mkdtemp(join(tmpdir(), "ambient-repo-"));
    try {
      const { branch } = await checkout(remote, dir, this.opts);
      const inRepo = await readRepo(dir);
      const store = new Map((await this.personal.pages(uid)).pages.map((p) => [p.path, p.content]));

      const imports: { path: string; content: string }[] = [];
      const writes = new Map<string, string>();
      const deletes = new Set<string>();
      const base: Record<string, string> = {};
      let merged = 0;
      const allowed = (path: string) => PERSONAL_PATH.test(path) && !path.includes("..");
      for (const path of new Set([...inRepo.keys(), ...store.keys(), ...Object.keys(state.base)])) {
        const r = inRepo.get(path);
        const s = store.get(path);
        const b = state.base[path];
        const rh = r === undefined ? undefined : sha(r);
        const shash = s === undefined ? undefined : sha(s);
        if (rh === shash) {
          if (rh !== undefined) base[path] = rh;
          continue;
        }
        const repoChanged = rh !== b;
        const storeChanged = shash !== b;
        if (!repoChanged) {
          // Only Ambient changed it: write it out, or remove it if Ambient deleted it.
          if (s === undefined) deletes.add(path);
          else {
            writes.set(path, s);
            base[path] = shash!;
          }
        } else if (!storeChanged) {
          // Only the repo changed it. Edits come in; a deletion there is undone (AGENTS.md says so).
          if (r === undefined) {
            writes.set(path, s!);
            base[path] = shash!;
          } else if (allowed(path)) {
            imports.push({ path, content: r });
            base[path] = rh!;
          }
        } else if (r !== undefined && s !== undefined) {
          // Both changed. Living pages: the repo's head plus both timelines; otherwise Ambient wins.
          const m = LIVING.test(path) ? mergeLiving(r, s) : s;
          writes.set(path, m);
          if (m !== s && allowed(path)) imports.push({ path, content: m });
          base[path] = sha(m);
          merged++;
        } else if (s !== undefined) {
          writes.set(path, s);
          base[path] = shash!;
        } else if (r !== undefined && allowed(path)) {
          imports.push({ path, content: r });
          base[path] = rh!;
        }
      }

      // Generated files: indexes over the wiki as it will be after this sync, and AGENTS.md.
      const wikiAfter = new WikiStore("personal");
      for (const [p, t] of store) if (p.startsWith("wiki/")) wikiAfter.upsert(p, t);
      for (const i of imports) if (i.path.startsWith("wiki/")) wikiAfter.upsert(i.path, i.content);
      for (const [p, t] of writes) if (p.startsWith("wiki/")) wikiAfter.upsert(p, t);
      const generated = new Map<string, string>([["AGENTS.md", agentsDoc({ kind: "personal", name: "Ambient wiki", prefix: "wiki/" })]]);
      for (const [p, t] of renderIndexFiles(wikiAfter.entries(), "Ambient wiki", attention(wikiAfter.lint()))) generated.set(`wiki/${p}`, t);
      // The repo's own AGENTS.md or index.md, there before Ambient, stay as their people wrote them.
      for (const p of state.keep ?? []) generated.delete(p);

      for (const [p, t] of [...writes, ...generated]) {
        await mkdir(dirname(join(dir, p)), { recursive: true });
        await writeFile(join(dir, p), t);
      }
      for (const p of deletes) await rm(join(dir, p), { force: true });
      // A folder whose pages all moved or went keeps no index of nothing.
      for (const p of await indexFilesIn(join(dir, "wiki"))) if (!generated.has(`wiki/${p}`)) await rm(join(dir, "wiki", p), { force: true });
      const commit = await commitAndPush(dir, remote, branch, `Ambient: sync (${writes.size + deletes.size} out, ${imports.length} in)`, this.opts);
      if (imports.length) await this.personal.serverWrite(uid, imports);

      const sealed = await this.personal.seal(uid, "repo:state", JSON.stringify({ base, commit: commit ?? state.commit, ...(state.keep?.length ? { keep: state.keep } : {}) } satisfies SyncState));
      await this.control.m(api.repos.record, { uid: uid as never, ok: true, stateIv: sealed.iv, stateCt: sealed.ciphertext, now: Date.now() });
      return { exported: writes.size + deletes.size, imported: imports.length, merged, commit };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * What a non-empty repo holds: an Ambient wiki already (reconnecting) is fine as it is; one
   * with files of its own needs `existing` (HasContent tells the app what's there, so it can
   * ask). Returns the repo's own files Ambient mustn't write.
   */
  private async whatsThere(remote: RemoteRepo, existing: boolean): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "ambient-check-"));
    try {
      await checkout(remote, dir, this.opts);
      const agents = existsSync(join(dir, "AGENTS.md")) ? await readFile(join(dir, "AGENTS.md"), "utf8") : "";
      if (agents.includes(MARKER)) return [];
      if (!existing) {
        const files = (await git(["ls-files"], { cwd: dir, ...this.opts })).split("\n").filter(Boolean);
        throw HasContent.of(files);
      }
      return ["AGENTS.md", "wiki/index.md"].filter((p) => existsSync(join(dir, p)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Files a repo's wiki/ and raw/ may hold; more and the sync stops with a sentence. */
const MAX_REPO_FILES = 50_000;
/** Larger files aren't read: no page or transcript the app writes is that big. */
const MAX_REPO_FILE_BYTES = 600_000;
/**
 * All of them together, as read into memory. A few KB of git pack can check out as hundreds of
 * MB of pages (text compresses that well), each under the size above.
 */
export const MAX_REPO_READ_BYTES = 128 * 1024 * 1024;

/**
 * The repo's wiki pages and transcripts (generated files excluded), path → text. Regular files
 * only: a symlink (git checks them out as plain files, but never trust that alone) would read a
 * file of the gateway's own into the user's wiki. A file too large to be one of ours is left out
 * (so it's never imported; one Ambient has is written back over it).
 */
export async function readRepo(dir: string, maxBytes = MAX_REPO_READ_BYTES): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) {
        const rel = relative(dir, p).split(sep).join("/");
        const generated = rel === "AGENTS.md" || rel === "wiki/index.md" || rel === "wiki/log.md" || e.name === "_index.md";
        if (generated || !(rel.startsWith("wiki/") || rel.startsWith("raw/"))) continue;
        const size = (await stat(p)).size;
        if (size > MAX_REPO_FILE_BYTES) continue;
        if (out.size >= MAX_REPO_FILES) throw new GitError(`The repo has more than ${MAX_REPO_FILES} pages. Use a repo for the wiki alone.`, "too_large");
        total += size;
        if (total > maxBytes) throw new GitError(`The repo's pages come to more than ${Math.round(maxBytes / 1024 / 1024)} MB. Use a repo for the wiki alone.`, "too_large");
        out.set(rel, await readFile(p, "utf8"));
      }
    }
  };
  await walk(dir);
  return out;
}
