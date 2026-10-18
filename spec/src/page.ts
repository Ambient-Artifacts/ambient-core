// Markdown page helpers shared by the gateway, the fleet agent and (mirrored in
// Swift) BrainCore. Keep behaviour identical across implementations; the golden
// fixtures in spec/fixtures pin it.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ParsedPage {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parsePage(text: string): ParsedPage {
  const m = FRONTMATTER.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const data = parseYaml(m[1] ?? "") as unknown;
  const frontmatter =
    data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return { frontmatter, body: text.slice(m[0].length) };
}

/**
 * parsePage for text Ambient didn't write (a team's own repository): a front matter block that isn't
 * valid YAML (a typo, a duplicate key) yields an empty front matter and the error instead of throwing.
 * Writers keep using parsePage, so they never rewrite a page whose front matter they couldn't read.
 */
export function parsePageLenient(text: string): ParsedPage & { error?: string } {
  try {
    return parsePage(text);
  } catch (e) {
    const m = FRONTMATTER.exec(text);
    return { frontmatter: {}, body: m ? text.slice(m[0].length) : text, error: (e as Error).message.split("\n")[0] };
  }
}

export function renderPage(page: ParsedPage): string {
  const yaml = stringifyYaml(page.frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${page.body.startsWith("\n") ? page.body.slice(1) : page.body}`;
}

/** Fold German umlauts and strip other diacritics so "Müller" and "Mueller" match. */
export function foldText(s: string): string {
  return s
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Stable slug for file names: folded, lowercase, hyphens. */
export function slugify(s: string): string {
  return foldText(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const TIMELINE_HEADING = "## Timeline";

/** Split a compiled living page into the model-owned part and the append-only timeline. */
export function splitCompiled(body: string): { currentTruth: string; timeline: string[] } {
  const idx = body.search(/^## Timeline\s*$/m);
  if (idx < 0) return { currentTruth: body.trimEnd(), timeline: [] };
  const head = body.slice(0, idx).trimEnd();
  const tail = body.slice(idx).split(/\r?\n/).slice(1);
  const timeline = tail.filter((l) => /^- \d{4}-\d{2}-\d{2}:/.test(l.trim())).map((l) => l.trim());
  return { currentTruth: head, timeline };
}

/** Append timeline lines (deduplicated, chronological) without touching current truth. */
export function appendTimeline(body: string, lines: string[]): string {
  const { currentTruth, timeline } = splitCompiled(body);
  const merged = [...new Set([...timeline, ...lines.map((l) => l.trim())])].sort((a, b) =>
    a.slice(2, 12).localeCompare(b.slice(2, 12)),
  );
  return `${currentTruth}\n\n${TIMELINE_HEADING}\n${merged.join("\n")}\n`;
}

/** Front-matter keys the server owns on a living page (it rewrites the head). */
const SERVER_OWNED = ["title", "summary", "aliases", "status", "compiled_through"] as const;

/**
 * Merge a living page changed on both sides. The server (Claude) owns the head:
 * current truth, open questions and the keys in SERVER_OWNED. The phone owns
 * the timeline, which is append-only, so both timelines are unioned. Returns
 * `serverText` unchanged when the phone added nothing the server lacks.
 */
export function mergeLiving(serverText: string, phoneText: string): string {
  const server = parsePage(serverText);
  const phone = parsePage(phoneText);
  const have = new Set(splitCompiled(server.body).timeline);
  const extra = splitCompiled(phone.body).timeline.filter((l) => !have.has(l));
  if (extra.length === 0) return serverText;
  const frontmatter: Record<string, unknown> = { ...phone.frontmatter };
  for (const k of SERVER_OWNED) if (k in server.frontmatter) frontmatter[k] = server.frontmatter[k];
  const dates = [server.frontmatter.updated, phone.frontmatter.updated].map((d) => String(d ?? "")).sort();
  frontmatter.updated = dates[1] || dates[0];
  frontmatter.pending_rewrite = extra.length;
  return renderPage({ frontmatter, body: `\n${appendTimeline(server.body, extra)}` });
}

/**
 * What deleting a recording changes in a wiki (the phone's BrainCore `forgetNote` does the same,
 * so merging the two sides never brings a removed line back). The note and its transcript go;
 * every living page loses the timeline lines that point at the note's file. A page left with no
 * timeline existed only because of the recording and goes too; the others get
 * `pending_rewrite`, since their current truth may still mention it.
 */
export function forgetNote(notePath: string, pages: Map<string, string>): { writes: { path: string; content: string }[]; deletes: string[] } {
  return forgetNotes([notePath], pages);
}

/**
 * `forgetNote` for several recordings at once, the same as one after another but reading each
 * living page once: a sync can delete hundreds, and a wiki has thousands of pages.
 */
export function forgetNotes(notePaths: string[], pages: Map<string, string>): { writes: { path: string; content: string }[]; deletes: string[] } {
  const deletes: string[] = [];
  const files = new Set<string>();
  for (const notePath of new Set(notePaths)) {
    files.add(notePath.split("/").pop() ?? notePath);
    deletes.push(notePath);
    const note = pages.get(notePath);
    const raw = note ? parsePage(note).frontmatter.raw : undefined;
    if (typeof raw === "string" && raw) deletes.push(raw);
  }
  // Whether a timeline line points at one of the files: "/<file>" somewhere in it.
  const plainNames = [...files].every((f) => !f.includes("/") && f.endsWith(".md") && f.indexOf(".md") === f.length - 3);
  const pointsAt = (line: string): boolean => {
    if (!plainNames) return [...files].some((f) => line.includes(`/${f}`));
    for (let i = line.indexOf("/"); i >= 0; i = line.indexOf("/", i + 1)) {
      const end = line.indexOf(".md", i + 1);
      if (end < 0) return false;
      if (files.has(line.slice(i + 1, end + 3))) return true;
    }
    return false;
  };
  const writes: { path: string; content: string }[] = [];
  for (const [path, text] of [...pages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^wiki\/(people|orgs|projects|topics)\//.test(path)) continue;
    // Most pages link none of them: skip those without parsing.
    if (!text.split("\n").some(pointsAt)) continue;
    const page = parsePage(text);
    const { currentTruth, timeline } = splitCompiled(page.body);
    const kept = timeline.filter((l) => !pointsAt(l));
    if (kept.length === timeline.length) continue;
    if (kept.length === 0) {
      deletes.push(path);
      continue;
    }
    const pending = Number(page.frontmatter.pending_rewrite ?? 0) || 0;
    const frontmatter = { ...page.frontmatter, pending_rewrite: Math.max(pending, 1) };
    writes.push({ path, content: renderPage({ frontmatter, body: `\n${currentTruth.replace(/^\n+/, "")}\n\n${TIMELINE_HEADING}\n${kept.join("\n")}\n` }) });
  }
  return { writes, deletes };
}

/** Return the lines under a `## Heading` until the next `## ` heading. */
export function section(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^## /.test(l)) break;
    out.push(l);
  }
  return out;
}

export interface ActionItem {
  done: boolean;
  owner: string | null;
  task: string;
  due: string | null;
}

/** Parse `- [ ] Owner: task (due 2026-10-10)` lines from an "Action items" section. */
export function parseActionItems(body: string): ActionItem[] {
  return section(body, "Action items")
    .map((l) => /^\s*- \[( |x|X)\]\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      let rest = (m[2] ?? "").trim();
      let due: string | null = null;
      const d = /\(due (\d{4}-\d{2}-\d{2})\)\s*$/.exec(rest);
      if (d) {
        due = d[1] ?? null;
        rest = rest.slice(0, d.index).trim();
      }
      const o = /^([^:]{1,60}):\s+(.*)$/.exec(rest);
      return {
        done: m[1] !== " ",
        owner: o ? (o[1] ?? "").trim() : null,
        task: o ? (o[2] ?? "").trim() : rest,
        due,
      };
    });
}

/** The first H1 of a body, if any. */
export function firstHeading(body: string): string | null {
  const m = /^# (.+)$/m.exec(body);
  return m ? (m[1] ?? "").trim() : null;
}
