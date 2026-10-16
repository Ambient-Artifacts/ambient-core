// The `me` page: who the owner of a personal wiki is, for every AI app they use. They write a
// few sentences about themselves in the app (`about`, theirs, kept word for word); Claude's
// upkeep keeps the sections below current from their own notes, at most once a day. The MCP
// server's instructions and the Claude Code plugin start every session with it.
import { parsePage, renderPage, splitCompiled } from "@brain/spec";
import { headParts, renderHead, type PageUpdate } from "@brain/team";
import type { Page } from "@brain/wiki";

export const ME_REF = "me";
export const ME_PATH = "wiki/me.md";
export const MAX_ABOUT = 1500;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The first sentence of what they wrote, as the page's one-line summary. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.{20,200}?[.!?])(\s|$)/.exec(flat);
  return clip(m ? m[1]! : flat, 200);
}

/** The me page with what they wrote about themselves: a new page, or theirs with the words replaced. */
export function writeAbout(prev: string | undefined, about: string, name: string, today: string): string {
  const words = about.trim().slice(0, MAX_ABOUT);
  if (prev) {
    const page = parsePage(prev);
    return renderPage({ frontmatter: { ...page.frontmatter, about: words, pending_rewrite: 1, updated: today }, body: page.body.startsWith("\n") ? page.body : `\n${page.body}` });
  }
  const title = name.trim() || "Me";
  return renderPage({
    frontmatter: { title, type: "person", self: true, summary: firstSentence(words) || title, about: words, update_mode: "compiled", status: "active", pending_rewrite: 1, updated: today },
    body: `\n# ${title}\n\n### About\n- ${clip(words.replace(/\s+/g, " "), 300)}\n`,
  });
}

/** Upkeep's sections on the me page; their own words and the name stay as they were. */
export function composeMe(prev: Page, upd: PageUpdate, compiledThrough: string | null, today: string): string {
  const head = renderHead(prev.title, { currentTruth: upd.currentTruth, sections: upd.sections, openQuestions: [] })
    .replace(/\n## Open questions\n- \(none\)$/, "")
    .trimEnd();
  const { timeline } = splitCompiled(prev.body);
  const frontmatter = {
    ...prev.frontmatter,
    summary: upd.summary || prev.summary,
    pending_rewrite: 0,
    ...(compiledThrough ? { compiled_through: compiledThrough } : {}),
    updated: today,
  };
  return renderPage({ frontmatter, body: `\n${head}\n${timeline.length ? `\n## Timeline\n${timeline.join("\n")}\n` : ""}` });
}

export interface Profile {
  name: string;
  /** What they wrote about themselves, word for word. */
  about: string | null;
  /** What the wiki says about them: the sections of their page, as markdown bullets. */
  truth: string;
  source: "me" | "team" | "none";
}

/** A profile from a person page (their `me` page, or their page in a team wiki). */
export function profileOf(page: Page | undefined, source: "me" | "team"): Profile | null {
  if (!page) return null;
  const h = headParts(page.body);
  const lines = [
    ...h.currentTruth.map((b) => `- ${b}`),
    ...h.sections.flatMap((s) => [`${s.heading}:`, ...s.bullets.map((b) => `- ${b}`)]),
  ];
  const about = typeof page.frontmatter.about === "string" && page.frontmatter.about.trim() ? page.frontmatter.about.trim() : null;
  return { name: page.title, about, truth: lines.join("\n"), source };
}
