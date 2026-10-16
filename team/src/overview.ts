// The overview page: one page an agent (or person) reads first. Claude writes it from
// the wiki's current state (living pages, latest notes, open action items, decisions,
// open questions) as structured output; plain code renders it and keeps only links to
// pages that exist, so the model can't invent pages.
import { z } from "zod";
import { renderPage } from "@brain/spec";
import type { WikiStore } from "@brain/wiki";
import type { Usage } from "./consolidate.ts";

export interface OverviewInput {
  kind: "personal" | "team";
  title: string;
  today: string;
  living: { ref: string; type: string; title: string; summary: string; updated: string }[];
  notes: { ref: string; title: string; summary: string; date: string }[];
  actions: { owner: string | null; task: string; due: string | null; note: string }[];
  decisions: { text: string; date: string; source: string }[];
  openQuestions: { ref: string; text: string }[];
}

export const OverviewOutput = z.object({
  headline: z.string(),
  now: z.array(z.string()),
  activeProjects: z.array(z.object({ ref: z.string(), status: z.string() })),
  keyPeople: z.array(z.object({ ref: z.string(), why: z.string() })),
  openLoops: z.array(z.string()),
  recentDecisions: z.array(z.string()),
});
export type OverviewOutput = z.infer<typeof OverviewOutput>;

export interface OverviewWriter {
  model: string;
  write(input: OverviewInput): Promise<{ overview: unknown; usage: Usage }>;
}

const LIVING = ["person", "org", "project", "topic"];

/** What the model sees: the freshest slice of the wiki, bounded so the prompt stays small. */
export function overviewInput(store: WikiStore, o: { kind: "personal" | "team"; title: string; today: string }): OverviewInput {
  const living = LIVING.flatMap((t) => store.ofType(t))
    .sort((a, b) => (b.updated || b.sortDate).localeCompare(a.updated || a.sortDate))
    .slice(0, 40)
    .map((p) => ({ ref: p.ref, type: p.type, title: p.title, summary: p.summary, updated: (p.updated || p.sortDate).slice(0, 10) }));
  const notes = store
    .ofType("note")
    .sort((a, b) => b.sortDate.localeCompare(a.sortDate))
    .slice(0, 15)
    .map((n) => ({ ref: n.ref, title: n.title, summary: n.summary, date: n.sortDate.slice(0, 10) }));
  const actions = store
    .actionItems({ status: "open" })
    .slice(0, 25)
    .map((a) => ({ owner: a.owner ?? null, task: a.task, due: a.due ?? null, note: a.note.ref }));
  const decisions = store
    .decisions({})
    .slice(0, 12)
    .map((d) => ({ text: d.text, date: d.date, source: d.source.ref }));
  const openQuestions = store
    .lint({ today: o.today })
    .issues.filter((i) => i.kind === "open_question")
    .slice(0, 10)
    .map((i) => ({ ref: i.ref, text: i.detail }));
  return { kind: o.kind, title: o.title, today: o.today, living, notes, actions, decisions, openQuestions };
}

const clean = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Render the overview page. Links point at existing pages only; `prefix` is "wiki/" for personal wikis. */
export function renderOverview(raw: unknown, store: WikiStore, o: { today: string; title: string }): string {
  const out = OverviewOutput.parse(raw);
  const exists = (ref: string) => store.getByRef(ref) !== undefined;
  const title = (ref: string) => store.getByRef(ref)?.title ?? ref;
  const bullets = (xs: string[], n: number) => xs.map((x) => clean(x, 300)).filter(Boolean).slice(0, n).map((x) => `- ${x}`);
  const linked = (xs: { ref: string; text: string }[], n: number) =>
    xs
      .filter((x) => exists(x.ref))
      .slice(0, n)
      .map((x) => `- [${title(x.ref).replace(/[[\]]/g, "")}](${x.ref}.md)${x.text ? `: ${clean(x.text, 200)}` : ""}`);
  const sections: [string, string[]][] = [
    ["Now", bullets(out.now, 6)],
    ["Active projects", linked(out.activeProjects.map((p) => ({ ref: p.ref, text: p.status })), 8)],
    ["Key people", linked(out.keyPeople.map((p) => ({ ref: p.ref, text: p.why })), 8)],
    ["Open loops", bullets(out.openLoops, 8)],
    ["Recent decisions", bullets(out.recentDecisions, 6)],
  ];
  const headline = clean(out.headline, 200) || "What's going on right now.";
  const body = [
    `# ${o.title}`,
    "",
    headline,
    "",
    ...sections.flatMap(([h, lines]) => (lines.length ? [`## ${h}`, ...lines, ""] : [])),
  ].join("\n");
  return renderPage({
    frontmatter: { title: o.title, type: "overview", summary: headline, generated_by: "ambient", updated: o.today },
    body: `\n${body.trimEnd()}\n`,
  });
}
