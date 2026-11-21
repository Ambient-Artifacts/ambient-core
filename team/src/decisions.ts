// Decision pages for the team wiki. A shared note lists decisions in its "## Decisions"
// section; one structured LLM call per such note says which are real team decisions
// (not small to-dos), what they affect, and whether one replaces an earlier decision.
// Plain code writes `decisions/NNNN-slug.md` and marks a replaced decision superseded.
import { z } from "zod";
import { DecisionFrontmatter, parsePage, renderPage, section, slugify } from "@brain/spec";
import type { Page, WikiStore } from "@brain/wiki";
import type { Usage } from "./consolidate.ts";

export interface DecisionInput {
  /** `prose`: the lines are what a work note says, not decisions (AnthropicDecisionFiler finds any). */
  note: { ref: string; title: string; date: string; decisions: string[]; links: string[]; prose?: boolean };
  existing: { ref: string; title: string; summary: string }[];
}

export const DecisionOutput = z.object({
  decisions: z.array(
    z.object({
      significant: z.boolean(),
      title: z.string(),
      statement: z.string(),
      affects: z.array(z.string()),
      supersedes: z.string().nullable(),
    }),
  ),
});
export type DecisionOutput = z.infer<typeof DecisionOutput>;

export interface DecisionFiler {
  model: string;
  file(input: DecisionInput): Promise<{ decisions: unknown; usage: Usage }>;
}

const LINK_FIELDS = ["people", "orgs", "projects", "topics"] as const;
const clean = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The note's decision bullets and the pages it links, or null when it records no decisions. A
 * work note from an AI app without a "## Decisions" section may still state one in what it says
 * it did ("dropped PayPal from the launch"): its summary and "Worked on" lines go in as prose, for
 * the filer to find decisions in, or none.
 */
export function decisionInput(note: Page, store: WikiStore): DecisionInput | null {
  let decisions = section(note.body, "Decisions")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter((l) => l && l !== "(none)");
  let prose = false;
  if (decisions.length === 0 && note.frontmatter.kind === "session" && !/^##\s+Decisions\b/m.test(note.body)) {
    decisions = [note.summary, ...section(note.body, "Worked on").map((l) => l.replace(/^\s*-\s*/, "").trim())].filter(Boolean).slice(0, 12);
    prose = true;
  }
  if (decisions.length === 0) return null;
  const fm = note.frontmatter;
  const links = [...new Set(LINK_FIELDS.flatMap((k) => (Array.isArray(fm[k]) ? (fm[k] as unknown[]).map(String) : [])))];
  const existing = store
    .ofType("decision")
    .filter((d) => d.frontmatter.status !== "superseded")
    .sort((a, b) => b.ref.localeCompare(a.ref))
    .slice(0, 30)
    .map((d) => ({ ref: d.ref, title: d.title, summary: d.summary }));
  return { note: { ref: note.ref, title: note.title, date: note.sortDate.slice(0, 10), decisions, links, ...(prose ? { prose: true } : {}) }, existing };
}

/** Pages to write for one note: new decision pages plus any decision they supersede. */
export function decisionPages(
  raw: unknown,
  note: Page,
  store: WikiStore,
  today: string,
  nextNumber: () => number,
): { path: string; text: string }[] {
  const out = DecisionOutput.parse(raw);
  const fm = note.frontmatter;
  const allowed = new Set(LINK_FIELDS.flatMap((k) => (Array.isArray(fm[k]) ? (fm[k] as unknown[]).map(String) : [])));
  const deciders = typeof fm.recorded_by === "string" ? [fm.recorded_by] : [];
  const pages: { path: string; text: string }[] = [];
  for (const d of out.decisions.filter((x) => x.significant).slice(0, 5)) {
    const title = clean(d.title, 80);
    const statement = clean(d.statement, 200);
    if (!title || !statement) continue;
    const ref = `decisions/${String(nextNumber()).padStart(4, "0")}-${slugify(title).slice(0, 60) || "decision"}`;
    const old = d.supersedes ? store.getByRef(d.supersedes) : undefined;
    const supersedes = old?.type === "decision" ? old.ref : undefined;
    const frontmatter = {
      title,
      type: "decision",
      summary: statement,
      status: "accepted",
      date: note.sortDate.slice(0, 10),
      deciders,
      affects: d.affects.filter((a) => allowed.has(a)).slice(0, 8),
      ...(supersedes ? { supersedes } : {}),
      source: note.ref,
      updated: today,
    };
    DecisionFrontmatter.parse(frontmatter);
    const body = [
      `# ${title}`,
      "",
      "## Decision",
      statement,
      "",
      "## Source",
      `- [${note.title.replace(/[[\]]/g, "")}](../${note.ref}.md) (${note.sortDate.slice(0, 10)})`,
      ...(supersedes ? ["", `Replaces [${old!.title.replace(/[[\]]/g, "")}](../${supersedes}.md).`] : []),
    ].join("\n");
    pages.push({ path: `${ref}.md`, text: renderPage({ frontmatter, body: `\n${body}\n` }) });
    if (old && supersedes) {
      const prev = parsePage(renderPage({ frontmatter: { ...old.frontmatter }, body: old.body }));
      prev.frontmatter.status = "superseded";
      prev.frontmatter.updated = today;
      const banner = `> Superseded on ${today} by [${title.replace(/[[\]]/g, "")}](../${ref}.md).`;
      const bodyText = prev.body.startsWith("\n") ? prev.body.slice(1) : prev.body;
      pages.push({ path: old.path, text: renderPage({ frontmatter: prev.frontmatter, body: `\n${banner}\n\n${bodyText}` }) });
    }
  }
  return pages;
}
