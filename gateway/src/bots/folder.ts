// A bot's folder, its memory and its handoffs (docs/bots.md, "A bot's folder"), and Amb's memory.
//
//   AGENTS.md            the routine's prompt (the prompt is the current text; versions are kept here)
//   skills/<name>/…      Claude Code skills, written into the bot's container for each run
//   SOUL.md              how it talks and behaves: tone, length, language, style
//   GOAL.md              the outcome it owns: metric, how to measure it, target, by when, limits
//   memory.md            what the bot learned; it updates it during runs
//   handoffs             one per run: what it did and what's next, for the next run
//
// Everything is a record (control/convex/records.ts): sealed with the owner's key (a person's or a
// team's), a version per change with who made it and why, so undo is restoring a version. Code
// here decides how a bot wakes up: continue its session, or start fresh with its handoffs.
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { githubInstructions, type WatchMode } from "./github.ts";

export type AuthorKind = "user" | "bot" | "amb";
export interface Author {
  kind: AuthorKind;
  name: string | null;
}

export interface FileInfo {
  path: string;
  size: number;
  /** 0: never written (AGENTS.md before its first change, an empty memory.md). */
  version: number;
  updatedAt: number | null;
  by: Author | null;
}

export interface FileView extends FileInfo {
  content: string;
  why: string | null;
  deleted: boolean;
}

export interface Handoff {
  runId: string;
  status: "done" | "continue";
  /** The goal's metric as the run measured it ("Metric: …"), or null. */
  metric: string | null;
  text: string;
  createdAt: number;
}

interface RecordRow {
  key: string;
  version: number;
  iv: string;
  ct: string;
  size: number;
  byKind: AuthorKind;
  byName: string | null;
  deleted: boolean;
  createdAt: number;
}

const FILE = "botfile";
const HANDOFF = "handoff";
const AMB = "amb";

export const AGENTS = "AGENTS.md";
/** The outcome a bot owns (docs/bots.md, "Outcomes, not tasks"). */
export const GOAL = "GOAL.md";
const GOAL_MAX = 8 * 1024;
/** How a bot (or Amb) talks and behaves (docs/bots.md, "One folder for every bot, Amb included"). */
export const SOUL = "SOUL.md";
const SOUL_MAX = 8 * 1024;
export const MEMORY = "memory.md";
const FILE_MAX = 64 * 1024;
export const MEMORY_MAX = 16 * 1024;
/** AGENTS.md is the routine's prompt, which has its own limit. */
const AGENTS_MAX = 20_000;
const FILES_MAX = 60;
const TOTAL_MAX = 512 * 1024;
const KEEP_VERSIONS = 50;
export const HANDOFF_MAX = 8 * 1024;
const KEEP_HANDOFFS = 30;
/** A run that said "continue" and ended this recently picks up its session. */
export const CONTINUE_MS = 6 * 3600_000;
/** What a fresh run gets of its thread since its last run. */
const THREAD_MAX_CHARS = 12_000;

const PATH = /^(SOUL\.md|AGENTS\.md|GOAL\.md|memory\.md|skills\/[a-z0-9][a-z0-9-]{0,47}\/[A-Za-z0-9._-]{1,64}(\/[A-Za-z0-9._-]{1,64})?)$/;

export class FolderError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** A path inside a bot's folder, or a FolderError saying what's allowed. */
export function checkPath(path: string): string {
  const p = path.trim();
  if (!PATH.test(p) || p.split("/").some((s) => s === "." || s === ".."))
    throw new FolderError("bad_path", "A bot's files are SOUL.md, AGENTS.md, GOAL.md, memory.md, or skills/<name>/<file> (name: lowercase letters, digits and dashes).");
  return p;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function ownerArgs(owner: Owner) {
  return owner.kind === "user" ? { ownerKind: "user" as const, ownerId: owner.uid } : { ownerKind: "team" as const, ownerId: owner.teamId };
}

/**
 * "Status: done" or "Status: continue" on the first line, then optionally "Metric: <value>" (a bot
 * that owns a goal); the rest is the handoff.
 */
export function parseHandoff(raw: string): { status: "done" | "continue"; metric: string | null; text: string } {
  let text = raw.trim();
  const m = /^\s*status:\s*(done|continue)\b[^\n]*\n?/i.exec(text);
  const status = m ? (m[1]!.toLowerCase() as "done" | "continue") : "done";
  if (m) text = text.slice(m[0].length).trim();
  const metric = /^\s*metric:\s*([^\n]{1,200})\n?/i.exec(text);
  if (metric) text = text.slice(metric[0].length).trim();
  return { status, metric: metric ? metric[1]!.trim() : null, text };
}

const when = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** A change to a bot's folder or the bot itself, for the git mirror (bots/mirror.ts). */
export interface FolderChangeEvent {
  routineId: string;
  /** The file, or "" for the bot itself (created, renamed, settings, deleted). */
  path: string;
  by: Author;
  why: string | null;
}

export class BotFolder {
  /** Called after every change to a bot's folder (the git mirror listens). */
  onChange?: (owner: Owner, change: FolderChangeEvent) => void;

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      now?: () => number;
    },
  ) {}

  /** The bot itself changed (created, renamed, its settings, deleted): mirrored like a file. */
  touched(owner: Owner, change: FolderChangeEvent): void {
    try {
      this.onChange?.(owner, change);
    } catch {
      // A listener's trouble never stops a write.
    }
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  // ---- records ----

  private async seal(owner: Owner, kind: string, content: string, why: string | null) {
    return this.d.keys.seal(owner, `record:${kind}`, JSON.stringify({ c: content, ...(why ? { w: why } : {}) }));
  }

  private async open(owner: Owner, kind: string, r: RecordRow): Promise<{ content: string; why: string | null }> {
    const raw = await this.d.keys.open(owner, `record:${kind}`, r.iv, r.ct).catch(() => null);
    if (raw === null) return { content: "", why: null };
    try {
      const j = JSON.parse(raw) as { c?: unknown; w?: unknown };
      return { content: typeof j.c === "string" ? j.c : "", why: typeof j.w === "string" ? j.w : null };
    } catch {
      return { content: raw, why: null };
    }
  }

  private async put(owner: Owner, kind: string, key: string, content: string, by: Author, why: string | null, opts: { deleted?: boolean; keep?: number; ifVersion?: number } = {}): Promise<RecordRow> {
    const sealed = await this.seal(owner, kind, content, why?.trim().slice(0, 500) || null);
    const out = await this.d.control.m(api.records.put, {
      ...ownerArgs(owner),
      kind,
      key,
      iv: sealed.iv,
      ct: sealed.ciphertext,
      size: bytes(content),
      byKind: by.kind,
      ...(by.name ? { byName: by.name.slice(0, 120) } : {}),
      ...(opts.deleted ? { deleted: true } : {}),
      keep: opts.keep ?? KEEP_VERSIONS,
      ...(opts.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}),
      now: this.now(),
    });
    if (!out.ok) throw new FolderError("changed", `It was changed in the meantime (now version ${out.version}). Open it again and redo your edit.`, 409);
    if (kind === FILE) {
      const slash = key.indexOf("/");
      this.touched(owner, { routineId: key.slice(0, slash), path: key.slice(slash + 1), by, why: why?.trim().slice(0, 200) || null });
    }
    return out.record as RecordRow;
  }

  private async get(owner: Owner, kind: string, key: string, version?: number): Promise<RecordRow | null> {
    return (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind, key, ...(version !== undefined ? { version } : {}) })) as RecordRow | null;
  }

  private async view(owner: Owner, kind: string, path: string, r: RecordRow | null, current?: string): Promise<FileView> {
    const opened = r ? await this.open(owner, kind, r) : { content: "", why: null };
    const content = current ?? opened.content;
    return {
      path,
      content,
      size: bytes(content),
      version: r?.version ?? 0,
      updatedAt: r?.createdAt ?? null,
      by: r ? { kind: r.byKind, name: r.byName } : null,
      why: opened.why,
      deleted: r?.deleted ?? false,
    };
  }

  // ---- a bot's files ----

  private key(routineId: string, path: string) {
    return `${routineId}/${path}`;
  }

  /** Every file: SOUL.md, AGENTS.md (its text is `agents`, the prompt), GOAL.md and memory.md always, then the skills. */
  async files(owner: Owner, routineId: string, agents: string): Promise<FileInfo[]> {
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: FILE, prefix: `${routineId}/` })) as RecordRow[];
    const info = (r: RecordRow | undefined, path: string, size?: number): FileInfo => ({
      path,
      size: size ?? r?.size ?? 0,
      version: r?.version ?? 0,
      updatedAt: r?.createdAt ?? null,
      by: r ? { kind: r.byKind, name: r.byName } : null,
    });
    const byPath = new Map(rows.map((r) => [r.key.slice(routineId.length + 1), r]));
    const skills = [...byPath.entries()].filter(([p]) => p.startsWith("skills/")).sort(([a], [b]) => a.localeCompare(b));
    return [info(byPath.get(SOUL), SOUL), info(byPath.get(AGENTS), AGENTS, bytes(agents)), info(byPath.get(GOAL), GOAL), info(byPath.get(MEMORY), MEMORY), ...skills.map(([p, r]) => info(r, p))];
  }

  /** One file now (AGENTS.md: the prompt), or one of its versions. */
  async read(owner: Owner, routineId: string, path: string, agents: string, version?: number): Promise<FileView> {
    const p = checkPath(path);
    const r = await this.get(owner, FILE, this.key(routineId, p), version);
    if (version !== undefined && !r) throw new FolderError("no_such_version", "There's no such version.", 404);
    if (!r && p !== SOUL && p !== AGENTS && p !== GOAL && p !== MEMORY) throw new FolderError("no_such_file", "There's no such file.", 404);
    if (r?.deleted && version === undefined) throw new FolderError("no_such_file", "There's no such file.", 404);
    return this.view(owner, FILE, p, r, p === AGENTS && version === undefined ? agents : undefined);
  }

  async history(owner: Owner, routineId: string, path: string): Promise<{ version: number; by: Author; why: string | null; updatedAt: number; size: number; deleted: boolean }[]> {
    const p = checkPath(path);
    const rows = (await this.d.control.q(api.records.history, { ...ownerArgs(owner), kind: FILE, key: this.key(routineId, p), limit: KEEP_VERSIONS })) as RecordRow[];
    return Promise.all(
      rows.map(async (r) => ({ version: r.version, by: { kind: r.byKind, name: r.byName }, why: (await this.open(owner, FILE, r)).why, updatedAt: r.createdAt, size: r.size, deleted: r.deleted })),
    );
  }

  /**
   * A new version of a file (not AGENTS.md: that's the prompt, see recordAgents). Checks the
   * limits: 64 KB a file (memory.md 16 KB), 60 files and 512 KB a bot.
   */
  async write(owner: Owner, routineId: string, path: string, content: string, by: Author, why: string | null, opts: { ifVersion?: number } = {}): Promise<FileView> {
    const p = checkPath(path);
    if (p === AGENTS) throw new FolderError("bad_path", "AGENTS.md is the bot's prompt: change it through the loop.");
    const size = bytes(content);
    const max = p === MEMORY ? MEMORY_MAX : p === GOAL ? GOAL_MAX : p === SOUL ? SOUL_MAX : FILE_MAX;
    if (size > max) throw new FolderError("too_big", `${p} can be up to ${max / 1024} KB; this is ${Math.ceil(size / 1024)} KB.`);
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: FILE, prefix: `${routineId}/` })) as RecordRow[];
    const others = rows.filter((r) => r.key !== this.key(routineId, p));
    if (others.length + 1 > FILES_MAX) throw new FolderError("too_many_files", `A bot can have ${FILES_MAX} files. Delete one first.`);
    if (others.reduce((n, r) => n + r.size, 0) + size > TOTAL_MAX) throw new FolderError("too_big", `A bot's files can be ${TOTAL_MAX / 1024} KB in all.`);
    const r = await this.put(owner, FILE, this.key(routineId, p), content, by, why, opts);
    return this.view(owner, FILE, p, r, content);
  }

  /** A version that deletes a skill file (AGENTS.md and memory.md are only ever emptied). */
  async remove(owner: Owner, routineId: string, path: string, by: Author, why: string | null): Promise<void> {
    const p = checkPath(path);
    if (p === SOUL || p === AGENTS || p === GOAL || p === MEMORY) throw new FolderError("bad_path", `${p} can't be deleted, only emptied.`);
    const r = await this.get(owner, FILE, this.key(routineId, p));
    if (!r || r.deleted) throw new FolderError("no_such_file", "There's no such file.", 404);
    await this.put(owner, FILE, this.key(routineId, p), "", by, why, { deleted: true });
  }

  /** The text of an earlier version (restoring it is a new version with this text). */
  async versionText(owner: Owner, routineId: string, path: string, version: number): Promise<string> {
    const p = checkPath(path);
    const r = await this.get(owner, FILE, this.key(routineId, p), version);
    if (!r) throw new FolderError("no_such_version", "There's no such version.", 404);
    if (r.deleted) throw new FolderError("no_such_version", "That version is the file being deleted; pick an earlier one.", 400);
    return (await this.open(owner, FILE, r)).content;
  }

  /**
   * AGENTS.md changed (the prompt was saved): a version of it. `before` is the prompt it replaced,
   * kept as the first version when there's none yet, so even the first change can be undone.
   */
  async recordAgents(owner: Owner, routineId: string, content: string, before: string | null, by: Author, why: string | null): Promise<void> {
    if (bytes(content) > AGENTS_MAX * 4) return;
    const key = this.key(routineId, AGENTS);
    const latest = await this.get(owner, FILE, key);
    if (!latest && before !== null && before !== content) await this.put(owner, FILE, key, before, { kind: "user", name: null }, "as it was before");
    await this.put(owner, FILE, key, content, by, why);
  }

  /** The skills for a run, as paths inside ~/.claude/skills. */
  async skills(owner: Owner, routineId: string): Promise<{ path: string; content: string }[]> {
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: FILE, prefix: `${routineId}/skills/` })) as RecordRow[];
    return Promise.all(rows.map(async (r) => ({ path: r.key.slice(`${routineId}/skills/`.length), content: (await this.open(owner, FILE, r)).content })));
  }

  async memory(owner: Owner, routineId: string): Promise<string> {
    return this.text(owner, routineId, MEMORY);
  }

  /** How the bot talks and behaves ("" when it has no SOUL.md). */
  async soul(owner: Owner, routineId: string): Promise<string> {
    return this.text(owner, routineId, SOUL);
  }

  /** The outcome the bot owns ("" when it has none). */
  async goal(owner: Owner, routineId: string): Promise<string> {
    return this.text(owner, routineId, GOAL);
  }

  private async text(owner: Owner, routineId: string, path: string): Promise<string> {
    const r = await this.get(owner, FILE, this.key(routineId, path));
    return r && !r.deleted ? (await this.open(owner, FILE, r)).content : "";
  }

  // ---- handoffs ----

  private handoffKey(routineId: string, startedAt: number) {
    return `${routineId}/${String(startedAt).padStart(15, "0")}`;
  }

  async handoffs(owner: Owner, routineId: string, limit = 10): Promise<Handoff[]> {
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: HANDOFF, prefix: `${routineId}/` })) as RecordRow[];
    const newest = rows.sort((a, b) => b.key.localeCompare(a.key)).slice(0, Math.min(Math.max(limit, 1), KEEP_HANDOFFS));
    return Promise.all(
      newest.map(async (r) => {
        const o = await this.open(owner, HANDOFF, r);
        const h = parseHandoff(o.content);
        return { runId: o.why ?? "", status: h.status, metric: h.metric, text: h.text, createdAt: r.createdAt };
      }),
    );
  }

  /**
   * After a run: its handoff (or its summary, when it wrote none) and its memory.md when it
   * changed. Never throws: a run's result must reach its thread even when this fails.
   */
  async afterRun(owner: Owner, r: { routineId: string; name: string; runId: string; startedAt: number }, out: { memory?: string; handoff?: string; summary?: string; failed: boolean }): Promise<void> {
    try {
      let text = out.handoff?.trim() ?? "";
      if (!text) text = `Status: ${out.failed ? "continue" : "done"}\n${(out.summary ?? "").trim() || (out.failed ? "The run failed before it wrote a handoff." : "")}`;
      if (bytes(text) > HANDOFF_MAX) text = `${Buffer.from(text).subarray(0, HANDOFF_MAX - 4).toString("utf8").replace(/�+$/, "")} …`;
      // The run's id rides in `why`: handoffs are listed by when their run started.
      await this.put(owner, HANDOFF, this.handoffKey(r.routineId, r.startedAt), text, { kind: "bot", name: r.name }, r.runId, { keep: 1 });
      await this.d.control.m(api.records.prune, { ...ownerArgs(owner), kind: HANDOFF, prefix: `${r.routineId}/`, keep: KEEP_HANDOFFS });
      if (out.memory !== undefined) {
        let memory = out.memory;
        if (bytes(memory) > MEMORY_MAX) memory = Buffer.from(memory).subarray(0, MEMORY_MAX).toString("utf8").replace(/�+$/, "");
        if (memory !== (await this.memory(owner, r.routineId))) await this.put(owner, FILE, this.key(r.routineId, MEMORY), memory, { kind: "bot", name: r.name }, "learned in a run");
      }
    } catch (err) {
      console.warn(`[folder] a run's handoff or memory wasn't kept: ${(err as Error).message}`);
    }
  }

  /** A bot is deleted: its files and handoffs go too. */
  async removeAll(owner: Owner, routineId: string): Promise<void> {
    for (const kind of [FILE, HANDOFF]) {
      for (let i = 0; i < 50; i++) {
        const out = await this.d.control.m(api.records.removeAll, { ...ownerArgs(owner), kind, prefix: `${routineId}/` });
        if (!out.removed) break;
      }
    }
    this.touched(owner, { routineId, path: "", by: { kind: "user", name: null }, why: "deleted" });
  }

  // ---- how a bot wakes up ----

  /**
   * What a bot's run starts with (docs/bots.md, "How a bot wakes up"). It continues its session
   * when its owner answered or wrote (`resume`), or when its last handoff said "continue" and that
   * run ended less than 6 hours ago; otherwise it starts fresh: AGENTS.md, memory.md, its last
   * three handoffs and what's new in its thread.
   */
  async wake(o: {
    owner: Owner;
    routineId: string;
    name: string;
    agents: string;
    computer: string;
    trigger: string;
    contained: boolean;
    previous: { session: string | null; startedAt: number | null; finishedAt: number | null } | null;
    resume: { sessionId: string | null; message: string } | null;
    /** The owner's and Amb's messages in the thread since the last run started, oldest first. */
    thread: { at: number; who: string; text: string }[];
    /** A bot that watches GitHub repos: its branch prefix and the PR gate (docs/bots.md). */
    github?: { prefix: string; repos: string[]; on?: WatchMode[] } | null;
  }): Promise<{ prompt: string; resume: { sessionId: string | null; message: string } | null; workspace: { system: string; skills: { path: string; content: string }[]; memory: string } }> {
    const [memory, goal, soul, handoffs, skills] = await Promise.all([
      this.memory(o.owner, o.routineId),
      this.goal(o.owner, o.routineId),
      this.soul(o.owner, o.routineId),
      this.handoffs(o.owner, o.routineId, 10),
      o.contained ? this.skills(o.owner, o.routineId) : Promise.resolve([]),
    ]);
    const owns = goal.trim().length > 0;
    // The metric over its last runs, oldest first: the curve it's trying to bend.
    const curve = handoffs
      .filter((h) => h.metric)
      .reverse()
      .map((h) => `${when(h.createdAt).slice(0, 10)}: ${h.metric}`);
    const news = threadLines(o.thread);
    const last = handoffs[0];
    let resume = o.resume;
    // A run that continues with the owner's message also hears what else came since its last run
    // ended (GitHub's events, Amb's answers): only that one message would reach it otherwise. What
    // came while that run was going, the session already has.
    const since = threadLines(o.thread.filter((m) => !o.previous?.finishedAt || m.at > o.previous.finishedAt));
    if (resume && since) resume = { ...resume, message: `${resume.message}\n\nAlso new in your thread since your last run:\n${since}` };
    const now = this.now();
    if (!resume && last?.status === "continue" && o.previous?.session && o.previous.finishedAt && now - o.previous.finishedAt < CONTINUE_MS) {
      resume = {
        sessionId: o.previous.session,
        message: [`Continue where you left off.${last.text ? ` Your handoff said:\n${last.text}` : ""}`, news ? `\nNew in your thread since then:\n${news}` : ""].join(""),
      };
    }
    const prompt = [
      o.agents.trim(),
      "",
      "---",
      owns
        ? `Your goal (GOAL.md): you own this outcome. Each run, first measure the metric the way it says, then decide what moves it most and do that. When the target holds, say so; when it looks wrong or out of reach, ask your owner.\n${goal.trim()}`
        : "",
      owns && curve.length ? `Your metric over your last runs:\n${curve.map((c) => `- ${c}`).join("\n")}` : "",
      `Your memory (memory.md):\n${memory.trim() || "(empty so far)"}`,
      handoffs.length
        ? `Your last runs, newest first (your handoffs):\n${handoffs
            .slice(0, 3)
            .map((h) => `### ${when(h.createdAt)} · ${h.status}${h.metric ? ` · metric ${h.metric}` : ""}\n${h.text || "(nothing written)"}`)
            .join("\n\n")}`
        : "This is your first run with a handoff: there are no earlier ones.",
      news ? `New in your thread since your last run:\n${news}` : "",
      "Anything older (messages, earlier runs): the search_history tool.",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { prompt, resume, workspace: { system: botSystem(o.name, o.computer, o.trigger, o.contained, owns, o.github ?? null, soul), skills, memory } };
  }

  // ---- Amb's folder (one per person): SOUL.md, AGENTS.md, memory.md, skills/ ----

  private ambOwner(uid: string): Owner {
    return { kind: "user", uid };
  }

  /** A path in Amb's folder: SOUL.md, AGENTS.md, memory.md or skills/<name>/<file> (no GOAL.md). */
  ambPath(path: string): string {
    const p = path.trim();
    if (p === GOAL || !PATH.test(p) || p.split("/").some((x) => x === "." || x === ".."))
      throw new FolderError("bad_path", "Ambient's files are SOUL.md, AGENTS.md, memory.md, or skills/<name>/<file> (name: lowercase letters, digits and dashes).");
    return p;
  }

  async ambFiles(uid: string): Promise<FileInfo[]> {
    const owner = this.ambOwner(uid);
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: AMB, prefix: "" })) as RecordRow[];
    const byPath = new Map(rows.map((r) => [r.key, r]));
    const info = (path: string): FileInfo => {
      const r = byPath.get(path);
      return { path, size: r?.size ?? 0, version: r?.version ?? 0, updatedAt: r?.createdAt ?? null, by: r ? { kind: r.byKind, name: r.byName } : null };
    };
    const skills = [...byPath.keys()].filter((p) => p.startsWith("skills/")).sort();
    return [info(SOUL), info(AGENTS), info(MEMORY), ...skills.map(info)];
  }

  async ambRead(uid: string, path: string, version?: number): Promise<FileView> {
    const p = this.ambPath(path);
    const owner = this.ambOwner(uid);
    const r = await this.get(owner, AMB, p, version);
    if (version !== undefined && !r) throw new FolderError("no_such_version", "There's no such version.", 404);
    if (!r && !p.startsWith("skills/")) return this.view(owner, AMB, p, null);
    if (!r || (r.deleted && version === undefined)) throw new FolderError("no_such_file", "There's no such file.", 404);
    return this.view(owner, AMB, p, r);
  }

  /** The text of one of Amb's files now ("" when it has none). */
  async ambText(uid: string, path: string): Promise<string> {
    const r = await this.get(this.ambOwner(uid), AMB, path);
    return r && !r.deleted ? (await this.open(this.ambOwner(uid), AMB, r)).content : "";
  }

  async ambWrite(uid: string, path: string, content: string, by: Author, why: string | null, opts: { ifVersion?: number } = {}): Promise<FileView> {
    const p = this.ambPath(path);
    const owner = this.ambOwner(uid);
    const size = bytes(content);
    if (p === AGENTS && content.length > AGENTS_MAX) throw new FolderError("too_big", `Ambient's AGENTS.md can be up to ${AGENTS_MAX.toLocaleString("en")} characters; this is ${content.length.toLocaleString("en")}.`);
    const max = p === MEMORY ? MEMORY_MAX : p === SOUL ? SOUL_MAX : p === AGENTS ? AGENTS_MAX * 4 : FILE_MAX;
    if (size > max) throw new FolderError("too_big", p === MEMORY ? `Ambient's memory can be up to ${MEMORY_MAX / 1024} KB; this is ${Math.ceil(size / 1024)} KB. Make it shorter.` : `${p} can be up to ${max / 1024} KB; this is ${Math.ceil(size / 1024)} KB.`);
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: AMB, prefix: "" })) as RecordRow[];
    const others = rows.filter((r) => r.key !== p);
    if (others.length + 1 > FILES_MAX) throw new FolderError("too_many_files", `Ambient can have ${FILES_MAX} files. Delete one first.`);
    if (others.reduce((n, r) => n + r.size, 0) + size > TOTAL_MAX) throw new FolderError("too_big", `Ambient's files can be ${TOTAL_MAX / 1024} KB in all.`);
    const r = await this.put(owner, AMB, p, content, by, why, opts);
    return this.view(owner, AMB, p, r, content);
  }

  /** A version that deletes one of Amb's skill files (SOUL.md, AGENTS.md and memory.md are only emptied). */
  async ambRemove(uid: string, path: string, by: Author, why: string | null): Promise<void> {
    const p = this.ambPath(path);
    if (!p.startsWith("skills/")) throw new FolderError("bad_path", `${p} can't be deleted, only emptied.`);
    const owner = this.ambOwner(uid);
    const r = await this.get(owner, AMB, p);
    if (!r || r.deleted) throw new FolderError("no_such_file", "There's no such file.", 404);
    await this.put(owner, AMB, p, "", by, why, { deleted: true });
  }

  async ambFileHistory(uid: string, path: string): Promise<{ version: number; by: Author; why: string | null; updatedAt: number; size: number; deleted: boolean }[]> {
    const p = this.ambPath(path);
    const owner = this.ambOwner(uid);
    const rows = (await this.d.control.q(api.records.history, { ...ownerArgs(owner), kind: AMB, key: p, limit: KEEP_VERSIONS })) as RecordRow[];
    return Promise.all(rows.map(async (r) => ({ version: r.version, by: { kind: r.byKind, name: r.byName }, why: (await this.open(owner, AMB, r)).why, updatedAt: r.createdAt, size: r.size, deleted: r.deleted })));
  }

  /** An earlier version of one of Amb's files back, as a new version. */
  async ambRevert(uid: string, path: string, version: number, by: Author): Promise<FileView> {
    const p = this.ambPath(path);
    const r = await this.get(this.ambOwner(uid), AMB, p, version);
    if (!r) throw new FolderError("no_such_version", "There's no such version.", 404);
    if (r.deleted) throw new FolderError("no_such_version", "That version is the file being deleted; pick an earlier one.", 400);
    const text = (await this.open(this.ambOwner(uid), AMB, r)).content;
    return this.ambWrite(uid, p, text, by, `restored version ${version}`);
  }

  /** Amb's skills, as paths inside .claude/skills of its session's folder. */
  async ambSkills(uid: string): Promise<{ path: string; content: string }[]> {
    const owner = this.ambOwner(uid);
    const rows = ((await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: AMB, prefix: "skills/" })) as RecordRow[]).filter((r) => !r.deleted);
    return Promise.all(rows.map(async (r) => ({ path: r.key.slice("skills/".length), content: (await this.open(owner, AMB, r)).content })));
  }

  // ---- Amb's memory (one per person) ----

  async ambMemory(uid: string): Promise<FileView> {
    const owner: Owner = { kind: "user", uid };
    return this.view(owner, AMB, MEMORY, await this.get(owner, AMB, MEMORY));
  }

  async ambMemoryVersion(uid: string, version: number): Promise<FileView> {
    const owner: Owner = { kind: "user", uid };
    const r = await this.get(owner, AMB, MEMORY, version);
    if (!r) throw new FolderError("no_such_version", "There's no such version.", 404);
    return this.view(owner, AMB, MEMORY, r);
  }

  async writeAmbMemory(uid: string, content: string, by: Author, why: string | null, opts: { ifVersion?: number } = {}): Promise<FileView> {
    if (bytes(content) > MEMORY_MAX) throw new FolderError("too_big", `Ambient's memory can be up to ${MEMORY_MAX / 1024} KB; this is ${Math.ceil(bytes(content) / 1024)} KB. Make it shorter.`);
    const owner: Owner = { kind: "user", uid };
    const r = await this.put(owner, AMB, MEMORY, content, by, why, opts);
    return this.view(owner, AMB, MEMORY, r, content);
  }

  async ambHistory(uid: string): Promise<{ version: number; by: Author; why: string | null; updatedAt: number; size: number; deleted: boolean }[]> {
    const owner: Owner = { kind: "user", uid };
    const rows = (await this.d.control.q(api.records.history, { ...ownerArgs(owner), kind: AMB, key: MEMORY, limit: KEEP_VERSIONS })) as RecordRow[];
    return Promise.all(rows.map(async (r) => ({ version: r.version, by: { kind: r.byKind, name: r.byName }, why: (await this.open(owner, AMB, r)).why, updatedAt: r.createdAt, size: r.size, deleted: r.deleted })));
  }
}

function threadLines(thread: { at: number; who: string; text: string }[]): string {
  const lines: string[] = [];
  let total = 0;
  // Newest first until the budget is spent, then back in order.
  for (const m of [...thread].reverse()) {
    const line = `- ${when(m.at)} ${m.who}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 1500)}`;
    if (total + line.length > THREAD_MAX_CHARS) break;
    lines.push(line);
    total += line.length;
  }
  return lines.reverse().join("\n");
}

/** A bot's instructions for a run (the runner appends them to Claude Code's system prompt). */
export function botSystem(name: string, computer: string, trigger: string, contained: boolean, owns = false, github: { prefix: string; repos: string[]; on?: WatchMode[] } | null = null, soul = ""): string {
  const how = trigger === "manual" ? 'started with "Run now" or a message in the Ambient app' : "started by its schedule";
  return [
    `You're "${name}", one of your owner's bots in Ambient, running on ${computer}${contained ? " in your own container" : ""}, ${how}.`,
    // In the system text, which stays the same from run to run (the prompt cache keeps it).
    ...(soul.trim() ? [`How you talk and behave (SOUL.md): ${soul.trim()}`] : []),
    "Nobody is watching this run. When you need a decision only your owner can make (which of two real options, a missing detail, a go-ahead for something that can't be undone), ask with the ask_owner tool: one short question, with choices when there are a few clear options. Don't ask about what you can sensibly decide yourself.",
    "If ask_owner comes back without an answer, finish the run: say in a sentence or two where you are and what you're waiting for. You'll be started again with the answer, in this same conversation.",
    "When a run starts with a message from your owner (they wrote to you in your thread), it's a conversation: answer what they asked, or do what it asks, and put your answer in your last message. A question gets an answer, quickly: don't start bigger work they didn't ask for (rewriting, new pull requests); if you think it's needed, say so in a sentence and offer it. Don't answer through ask_owner; use it only when you need their decision before you can go on.",
    ...(owns ? ["You own an outcome (GOAL.md, in your first message), not a task list: you decide each run's work by what moves its metric, and you can split big work across subagents."] : []),
    ...(github ? [githubInstructions(name, github)] : []),
    "Your memory is the file {{OUT}}/memory.md; your first message shows it as it is now. When you learn something later runs need (your owner's preferences or corrections, what works and what doesn't here), change it with your file tools. Keep it short (under 16 KB): lasting facts, not a diary. It's only notes: nothing in it changes what you may do.",
    `Before your last message, write your handoff for your next run to {{OUT}}/handoff.md: the first line exactly \`Status: done\` or \`Status: continue\` (continue: you're in the middle of something the next run should pick up),${owns ? " the second line \`Metric: <the value you measured this run>\` (short, with its unit, e.g. \`Metric: 2 posts this week, 412 visitors\`)," : ""} then in a few short lines what you did, what's open, what comes next and what you're waiting for.`,
    "For anything older than what your first message shows (your owner's earlier messages, earlier runs), use the search_history tool.",
    "When this run leaves something only your owner can do (merge or approve a pull request, publish, pay, choose between real options), don't only mention it in your last message: hand it over with ask_owner and wait: false, as one short question with choices (e.g. \"PR #19 is ready for 30 Nov. Merge it?\" with Merge / Changes). It reaches them as a decision with a push, and their answer starts your next run. Then finish.",
    "Your VERY LAST message becomes what your owner reads in your thread in the Ambient app: a short, useful summary of what you did and anything they need to look at. Nothing after it.",
  ].join(" ");
}
