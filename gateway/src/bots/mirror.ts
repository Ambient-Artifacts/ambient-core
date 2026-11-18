// Bots' folders in git (docs/bots.md, "A bot's folder in git"). Ambient's store stays the source;
// the mirror writes each bot as bots/<slug>/ (AGENTS.md, GOAL.md, memory.md, skills/, a generated bot.json)
// so its owner has it in their own repo, versioned there too:
//
//   a person's bots ──▶ their own connected repo, in its sync (PersonalRepos, the `bots` hook)
//   a team's bots   ──▶ the team's wiki repo on its server (PUT /v1/bots), pushed to the team's
//                       repo when one is connected; inside the fence when another tool keeps it
//
// After a change (a file, a rename, a run's memory), the owner's bots are mirrored once things go
// quiet for a moment (30 s), so a run's memory doesn't make a commit of its own per file. One-way:
// an edit made in git is overwritten by the next mirror. Only files Ambient wrote (the manifest,
// bots/.mirrored) are ever removed, so a bots/ folder of the repo's own keeps its files.
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { api, type Control } from "../control.ts";
import type { PersonalRepos } from "../repos/personal.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import type { TeamLink } from "../teams.ts";
import type { Author, BotFolder } from "./folder.ts";

export const BOTS_DIR = "bots";
const MANIFEST = ".mirrored";
const DELAY_MS = 30_000;

export const MIRROR_README = [
  "# Bots",
  "",
  "These folders are mirrored from Ambient: each bot's instructions (AGENTS.md), the outcome it owns (GOAL.md, when it has one), what it has learned (memory.md), its skills, and its settings (bot.json).",
  "",
  "Change a bot in Ambient (the app, or by asking Ambient). Edits made here are overwritten the next time a bot changes.",
  "",
].join("\n");

/** What changed in a bot's folder, for the commit message. */
export interface FolderChange {
  routineId: string;
  /** The file, or "" for the bot itself (renamed, settings, deleted). */
  path: string;
  by: Author;
  why: string | null;
}

export interface MirrorStatus {
  /** mirrored; pending (a change waits, or it never ran); not_connected (a person without a repo); read_only (another tool keeps the team's repo); error. */
  state: "mirrored" | "pending" | "not_connected" | "read_only" | "error";
  /** The repo's address, or null (a team without a repo of its own: in the brain's git on its server). */
  repo: string | null;
  /** The bot's folder in the repo, e.g. "bots/blog/" or "ambient/bots/blog/". */
  path: string | null;
  lastMirroredAt: number | null;
  lastError: string | null;
}

interface Stored {
  at: number;
  state: MirrorStatus["state"];
  repo: string | null;
  folder: string | null;
  error: string | null;
}

interface BotRow {
  id: string;
  name: string;
  promptIv: string;
  promptCt: string;
  schedule: unknown;
  enabled: boolean;
  bot: { face: string; color?: string; wear?: string[]; runtime: string; isolation: string; secrets?: string[]; report: string; model?: unknown; delegate?: string };
  createdAt: number;
}

interface TeamInfo {
  id: string;
  slug: string;
  name: string;
  status: string;
  serverUrl: string | null;
}

export interface MirroredBot {
  id: string;
  name: string;
  slug: string;
  files: { path: string; content: string }[];
}

/** A folder name for a bot: lowercase letters, digits and dashes. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "bot";
}

/** Each bot's folder name: its name's slug, made unique with the end of its id (oldest bot keeps the plain one). */
export function slugsOf(bots: { id: string; name: string; createdAt: number }[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const b of [...bots].sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id))) {
    let slug = slugify(b.name);
    if (taken.has(slug)) slug = `${slug.slice(0, 40)}-${b.id.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "0")}`;
    taken.add(slug);
    out.set(b.id, slug);
  }
  return out;
}

const ownerArgs = (owner: Owner) => (owner.kind === "user" ? { ownerKind: "user" as const, ownerId: owner.uid } : { ownerKind: "team" as const, ownerId: owner.teamId });
const ownerKey = (owner: Owner) => (owner.kind === "user" ? `user:${owner.uid}` : `team:${owner.teamId}`);

/** `rel` under `dir`, or null when it climbs out or a part on the way is a link (a repo's own symlink is never followed). */
export async function safeInside(dir: string, rel: string): Promise<string | null> {
  const parts = rel.split("/");
  if (!rel || parts.some((p) => p === "" || p === "." || p === "..") || rel.includes("\\") || rel.includes("\0")) return null;
  let at = dir;
  for (const part of parts) {
    at = join(at, part);
    try {
      if ((await lstat(at)).isSymbolicLink()) return null;
    } catch {
      break;
    }
  }
  return join(dir, rel);
}

/**
 * Write the bots' files into a checkout (a person's repo during its sync): `files` are paths from
 * the repo's root (bots/…). Removes only what the last mirror wrote. Returns how many files changed.
 */
export async function writeMirror(dir: string, files: Map<string, string>): Promise<number> {
  const manifestPath = `${BOTS_DIR}/${MANIFEST}`;
  const read = async (rel: string): Promise<string | null> => {
    const file = await safeInside(dir, rel);
    if (!file) return null;
    try {
      return (await lstat(file)).isFile() ? await readFile(file, "utf8") : null;
    } catch {
      return null;
    }
  };
  let before: string[] = [];
  try {
    const list = JSON.parse((await read(manifestPath)) ?? "[]") as unknown;
    if (Array.isArray(list)) before = list.filter((p): p is string => typeof p === "string" && p.startsWith(`${BOTS_DIR}/`));
  } catch {
    // An unreadable manifest: nothing is removed, everything is written again.
  }
  let changed = 0;
  for (const [rel, text] of files) {
    if ((await read(rel)) === text) continue;
    const file = await safeInside(dir, rel);
    if (!file) continue;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    changed++;
  }
  for (const rel of before) {
    if (files.has(rel)) continue;
    const file = await safeInside(dir, rel);
    if (!file) continue;
    await rm(file, { force: true });
    changed++;
  }
  const list = `${JSON.stringify([...files.keys()].sort(), null, 1)}\n`;
  if (files.size || before.length) {
    if ((await read(manifestPath)) !== list) {
      const file = await safeInside(dir, manifestPath);
      if (file) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, list);
      }
    }
  }
  return changed;
}

export class BotMirror {
  private waiting = new Map<string, { timer: NodeJS.Timeout; owner: Owner; changes: FolderChange[] }>();
  private running = new Map<string, Promise<unknown>>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      folder: BotFolder;
      /** Team servers (team bots); absent: team bots aren't mirrored. */
      teams?: TeamLink;
      /** People's own repos (personal bots); absent: personal bots aren't mirrored. */
      repos?: PersonalRepos;
      delayMs?: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** The owner's bots and every file of theirs to mirror. Null when the owner is gone. */
  async render(owner: Owner): Promise<{ team: TeamInfo | null; bots: MirroredBot[] } | null> {
    const out = (await this.d.control.q(api.bots.ownerBots, ownerArgs(owner))) as { team: TeamInfo | null; bots: BotRow[] } | null;
    if (!out) return null;
    const slugs = slugsOf(out.bots);
    const bots: MirroredBot[] = [];
    for (const b of out.bots) {
      const [agents, goal, memory, skills] = await Promise.all([
        this.d.keys.open(owner, "routine:prompt", b.promptIv, b.promptCt).catch(() => ""),
        this.d.folder.goal(owner, b.id),
        this.d.folder.memory(owner, b.id),
        this.d.folder.skills(owner, b.id),
      ]);
      const settings = {
        name: b.name,
        face: b.bot.face,
        ...(b.bot.color ? { color: b.bot.color } : {}),
        ...(b.bot.wear?.length ? { wear: b.bot.wear } : {}),
        runtime: b.bot.runtime,
        isolation: b.bot.isolation,
        schedule: b.schedule,
        enabled: b.enabled,
        report: b.bot.report,
        // Names only: values never leave Ambient. "all": a loop from before grants gets every secret.
        secrets: b.bot.secrets ?? "all",
        model: b.bot.model ?? null,
        delegate: b.bot.delegate ?? "brain",
        mirroredFrom: "Ambient",
      };
      bots.push({
        id: b.id,
        name: b.name,
        slug: slugs.get(b.id)!,
        files: [
          { path: "AGENTS.md", content: agents.endsWith("\n") ? agents : `${agents}\n` },
          // The outcome it owns, when it has one (docs/bots.md, "Outcomes, not tasks").
          ...(goal.trim() ? [{ path: "GOAL.md", content: goal.endsWith("\n") ? goal : `${goal}\n` }] : []),
          { path: "memory.md", content: memory },
          { path: "bot.json", content: `${JSON.stringify(settings, null, 2)}\n` },
          ...skills.map((s) => ({ path: `skills/${s.path}`, content: s.content })),
        ],
      });
    }
    return { team: out.team, bots };
  }

  /** A person's bots as files from their repo's root (bots/…), for PersonalRepos' sync. */
  async personalFiles(uid: string): Promise<Map<string, string>> {
    const rendered = await this.render({ kind: "user", uid });
    const files = new Map<string, string>();
    if (!rendered?.bots.length) return files;
    files.set(`${BOTS_DIR}/README.md`, MIRROR_README);
    for (const b of rendered.bots) for (const f of b.files) files.set(`${BOTS_DIR}/${b.slug}/${f.path}`, f.content);
    return files;
  }

  /** Something in an owner's bots changed: mirror them once it's quiet for a moment. */
  changed(owner: Owner, change?: FolderChange): void {
    const key = ownerKey(owner);
    const w = this.waiting.get(key);
    if (w) clearTimeout(w.timer);
    const changes = [...(w?.changes ?? []), ...(change ? [change] : [])].slice(-50);
    const timer = setTimeout(() => {
      this.waiting.delete(key);
      void this.mirror(owner, changes).catch((err: Error) => console.warn(`[mirror] ${key}: ${err.message}`));
    }, this.d.delayMs ?? DELAY_MS);
    timer.unref();
    this.waiting.set(key, { timer, owner, changes });
  }

  /** Mirror now (the app's "mirror again", and the timer). One at a time per owner. */
  async mirror(owner: Owner, changes: FolderChange[] = []): Promise<Stored> {
    const key = ownerKey(owner);
    const before = this.running.get(key) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => this.mirrorOnce(owner, changes));
    this.running.set(key, next);
    try {
      return await next;
    } finally {
      if (this.running.get(key) === next) this.running.delete(key);
    }
  }

  private async mirrorOnce(owner: Owner, changes: FolderChange[]): Promise<Stored> {
    let stored: Stored;
    if (owner.kind === "user") {
      const rec = this.d.repos ? await this.d.repos.status(owner.uid) : null;
      if (!rec) stored = { at: this.now(), state: "not_connected", repo: null, folder: null, error: null };
      else {
        try {
          // The person's repo sync writes the bots too (and the wiki's changes with them).
          await this.d.repos!.sync(owner.uid);
          stored = { at: this.now(), state: "mirrored", repo: rec.url, folder: BOTS_DIR, error: null };
        } catch (err) {
          stored = { at: this.now(), state: "error", repo: rec.url, folder: BOTS_DIR, error: (err as Error).message.slice(0, 300) };
        }
      }
    } else stored = await this.mirrorTeam(owner, changes);
    await this.save(owner, stored);
    return stored;
  }

  private async mirrorTeam(owner: Extract<Owner, { kind: "team" }>, changes: FolderChange[]): Promise<Stored> {
    const at = this.now();
    const rendered = await this.render(owner);
    const team = rendered?.team;
    if (!rendered || !team) return { at, state: "error", repo: null, folder: null, error: "The team is gone." };
    if (!this.d.teams || !team.serverUrl) return { at, state: "error", repo: null, folder: null, error: "The team's server isn't set up yet." };
    const names = new Map(rendered.bots.map((b) => [b.id, b.name]));
    const body = {
      bots: rendered.bots.map((b) => ({ slug: b.slug, files: b.files })),
      readme: MIRROR_README,
      message: commitMessage(changes, names),
      ...(authorOf(changes) ? { author: authorOf(changes)! } : {}),
    };
    try {
      const out = await this.d.teams.mirrorBots(team, body);
      const repo = (out.json.repo ?? null) as { url?: string; status?: string; lastError?: string | null } | null;
      if (out.status === 409) return { at, state: "read_only", repo: repo?.url ?? null, folder: null, error: null };
      if (out.status !== 200) return { at, state: "error", repo: repo?.url ?? null, folder: null, error: String(out.json.message ?? `The team's server answered ${out.status}.`) };
      const folder = typeof out.json.folder === "string" ? out.json.folder : BOTS_DIR;
      // Mirrored into the brain's git on the server; pushing to the team's repo may have failed.
      if (repo?.status === "error") return { at, state: "error", repo: repo.url ?? null, folder, error: repo.lastError ?? "Pushing to the team's repo failed." };
      return { at, state: "mirrored", repo: repo?.url ?? null, folder, error: null };
    } catch (err) {
      return { at, state: "error", repo: null, folder: null, error: (err as Error).message.slice(0, 300) };
    }
  }

  private async save(owner: Owner, s: Stored): Promise<void> {
    const sealed = await this.d.keys.seal(owner, "record:mirror", JSON.stringify(s));
    await this.d.control
      .m(api.records.put, { ...ownerArgs(owner), kind: "mirror", key: "status", iv: sealed.iv, ct: sealed.ciphertext, size: 0, byKind: "amb", keep: 1, now: this.now() })
      .catch((err: Error) => console.warn(`[mirror] status not kept: ${err.message}`));
  }

  private async load(owner: Owner): Promise<Stored | null> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind: "mirror", key: "status" }).catch(() => null)) as { iv: string; ct: string } | null;
    if (!r) return null;
    try {
      return JSON.parse(await this.d.keys.open(owner, "record:mirror", r.iv, r.ct)) as Stored;
    } catch {
      return null;
    }
  }

  /** Where a bot is mirrored, and how the last mirror went. */
  async status(owner: Owner, routineId: string): Promise<MirrorStatus> {
    const rows = (await this.d.control.q(api.bots.ownerBots, ownerArgs(owner))) as { bots: BotRow[] } | null;
    const slug = rows ? slugsOf(rows.bots).get(routineId) : undefined;
    const pending = this.waiting.has(ownerKey(owner)) || this.running.has(ownerKey(owner));
    const stored = await this.load(owner);
    if (owner.kind === "user") {
      const rec = this.d.repos ? await this.d.repos.status(owner.uid) : null;
      if (!rec) return { state: "not_connected", repo: null, path: null, lastMirroredAt: null, lastError: null };
      // The 15-minute sync mirrors the bots too: its time and error are the mirror's.
      const error = rec.status === "error" ? rec.lastError : null;
      return {
        state: pending ? "pending" : error ? "error" : rec.lastSyncAt || stored ? "mirrored" : "pending",
        repo: rec.url,
        path: slug ? `${BOTS_DIR}/${slug}/` : null,
        lastMirroredAt: rec.lastSyncAt ?? stored?.at ?? null,
        lastError: error,
      };
    }
    if (!stored) return { state: "pending", repo: null, path: null, lastMirroredAt: null, lastError: null };
    return {
      state: pending ? "pending" : stored.state,
      repo: stored.repo,
      path: slug && stored.folder ? `${stored.folder}/${slug}/` : null,
      lastMirroredAt: stored.state === "mirrored" ? stored.at : null,
      lastError: stored.error,
    };
  }

  /** Tests: until every waiting and running mirror is done. */
  async idle(): Promise<void> {
    for (const [key, w] of [...this.waiting]) {
      clearTimeout(w.timer);
      this.waiting.delete(key);
      await this.mirror(w.owner, w.changes).catch(() => undefined);
    }
    await Promise.all([...this.running.values()].map((p) => p.catch(() => undefined)));
  }
}

/** One line: which bots and files changed, by whom and why (the commit message). */
export function commitMessage(changes: FolderChange[], names: Map<string, string>): string {
  if (!changes.length) return "mirror Ambient's bots";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of changes) {
    const name = names.get(c.routineId) ?? "a deleted bot";
    const who = c.by.kind === "bot" ? "the bot" : c.by.kind === "amb" ? (c.by.name === "Ambient" || !c.by.name ? "Ambient" : c.by.name) : (c.by.name ?? "someone");
    const line = `${name}${c.path ? ` ${c.path}` : ""} (${who}${c.why ? `: ${c.why}` : ""})`;
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line);
  }
  const text = parts.join("; ");
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

/** The commit's author when every change was one person's. */
function authorOf(changes: FolderChange[]): string | null {
  if (!changes.length || changes.some((c) => c.by.kind !== "user")) return null;
  const names = new Set(changes.map((c) => c.by.name).filter((n): n is string => Boolean(n)));
  return names.size === 1 ? [...names][0]! : null;
}
