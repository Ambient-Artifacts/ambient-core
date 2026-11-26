// Bots' folders mirrored into the team's wiki repo (docs/bots.md, "A bot's folder in git"). The
// gateway sends every bot of the team at once (AGENTS.md, GOAL.md, SOUL.md, memory.md, skills, a generated
// bot.json); this replaces what Ambient mirrored before under bots/ (inside the fence when another
// tool keeps the repo) in one commit, and pushes to the team's repo when one is connected.
//
// Ambient's own store is the source: an edit made here in git is overwritten by the next mirror.
// Only files Ambient wrote are ever removed (the manifest, bots/.mirrored, lists them), so a
// bots/ folder the team had of its own keeps its files.
import { lstat, readdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { personAuthor } from "./repo.ts";
import { BOTS_DIR, type TeamWiki } from "./wiki.ts";

const MANIFEST = ".mirrored";
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A file inside a bot's folder: AGENTS.md, GOAL.md, SOUL.md, memory.md, bot.json, skills/<name>/<file>[/<file>]. */
const FILE = /^(AGENTS\.md|GOAL\.md|SOUL\.md|memory\.md|bot\.json|skills\/[a-z0-9][a-z0-9-]{0,47}\/[A-Za-z0-9._-]{1,64}(\/[A-Za-z0-9._-]{1,64})?)$/;
/** Together, as sent: a bot is up to 512 KB; a team has up to 50 loops. */
export const MAX_MIRROR_BYTES = 12 * 1024 * 1024;

export const BotsMirror = z.object({
  bots: z
    .array(
      z.object({
        slug: z.string().regex(SLUG),
        files: z.array(z.object({ path: z.string().regex(FILE), content: z.string() })).max(80),
      }),
    )
    .max(60),
  readme: z.string().max(4000),
  /** One line for the commit: what changed and why. */
  message: z.string().min(1).max(500),
  /** Whose change it is, when it was one person's (the commit's author). */
  author: z.string().max(120).optional(),
});
export type BotsMirror = z.infer<typeof BotsMirror>;

/**
 * What to tell the app when a mirror is refused as sent (the app shows it under the bot's Git
 * section; a bare "400" said nothing): the bot and file it was about, when the issue names one.
 */
export function mirrorRefusal(body: unknown, issues: string[]): string {
  const bots = (body as { bots?: { slug?: unknown; files?: { path?: unknown }[] }[] } | null)?.bots;
  for (const issue of issues) {
    const m = /^bots\.(\d+)(?:\.files\.(\d+))?/.exec(issue);
    if (!m || !Array.isArray(bots)) continue;
    const bot = bots[Number(m[1])];
    const slug = typeof bot?.slug === "string" ? bot.slug : `bot ${Number(m[1]) + 1}`;
    const path = m[2] !== undefined ? bot?.files?.[Number(m[2])]?.path : undefined;
    if (typeof path === "string") return `This team server doesn't take ${path} for ${slug} yet. Update the team server and try again.`;
    return `This team server couldn't take ${slug}'s folder (${issue}).`;
  }
  return `This team server couldn't take the bots as sent (${issues.join(", ") || "unknown"}).`;
}

const okPath = (p: string) => p.split("/").every((s) => s !== "" && s !== "." && s !== "..");

export async function mirrorBots(wiki: TeamWiki, body: BotsMirror): Promise<{ commit: string | null; folder: string; files: number }> {
  const folder = wiki.place(BOTS_DIR);
  const want = new Map<string, string>([[`${folder}/README.md`, body.readme]]);
  const slugs = new Set<string>();
  for (const b of body.bots) {
    if (slugs.has(b.slug)) throw new MirrorError(`Two bots are named ${b.slug}.`);
    slugs.add(b.slug);
    for (const f of b.files) {
      if (!okPath(f.path)) throw new MirrorError(`Not a bot's file: ${f.path}`);
      want.set(`${folder}/${b.slug}/${f.path}`, f.content);
    }
  }
  const out = await wiki.write(async (put, remove) => {
    const before = await manifest(wiki, folder);
    for (const [path, text] of want) {
      if ((await current(wiki, path)) === text) continue;
      await put(path, text, { index: false });
    }
    for (const path of before) if (!want.has(path) && path.startsWith(`${folder}/`)) await remove(path);
    await pruneEmpty(join(wiki.dir, folder));
    const list = `${JSON.stringify([...want.keys()].sort(), null, 1)}\n`;
    if ((await current(wiki, `${folder}/${MANIFEST}`)) !== list) await put(`${folder}/${MANIFEST}`, list, { index: false });
    return { message: `bots: ${body.message.replace(/\s+/g, " ").trim()}`, result: {}, author: personAuthor(body.author) };
  });
  return { commit: out.commit, folder, files: want.size };
}

export class MirrorError extends Error {}

/** Folders left empty by a renamed or deleted bot go too (git keeps no folders, the disk would). */
async function pruneEmpty(dir: string): Promise<boolean> {
  let entries;
  try {
    if (!(await lstat(dir)).isDirectory()) return false;
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    if (e.isDirectory() && (await pruneEmpty(join(dir, e.name)))) continue;
    empty = false;
  }
  if (empty) await rmdir(dir).catch(() => undefined);
  return empty;
}

/** What Ambient mirrored last time (paths from the repo's root). */
async function manifest(wiki: TeamWiki, folder: string): Promise<string[]> {
  const text = await current(wiki, `${folder}/${MANIFEST}`);
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && okPath(p)) : [];
  } catch {
    return [];
  }
}

/** A file's text as it is in the repo, or null (missing, or not a plain file: never followed). */
async function current(wiki: TeamWiki, path: string): Promise<string | null> {
  const file = join(wiki.dir, path);
  try {
    if (!(await lstat(file)).isFile()) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
