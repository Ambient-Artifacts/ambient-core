// Wiki health checks in plain code (no LLM): broken links, pages nothing links to,
// likely duplicates, notes that fell back to raw transcript text, open questions
// (contradictions Claude flagged) and stale living pages. Runs after every upkeep;
// the counts are kept per run so findings can be compared over time.
import { foldText, section } from "@brain/spec";
import type { Page } from "./wiki-store.ts";

export type LintKind = "broken_link" | "orphan" | "possible_duplicate" | "weak_note" | "open_question" | "stale";

export interface LintIssue {
  kind: LintKind;
  /** The page the issue is about. */
  ref: string;
  /** Other pages involved (the missing link target, the likely duplicate). */
  refs: string[];
  detail: string;
}

export interface LintReport {
  checked: { pages: number; notes: number; living: number };
  counts: Record<LintKind, number>;
  issues: LintIssue[];
}

/** What lint needs from a store (WikiStore implements it). */
export interface LintSource {
  ofType(type: string): Page[];
  getByRef(ref: string): Page | undefined;
  allLinks(): { src: string; dst: string; rel: string }[];
  readonly size: number;
}

const LIVING_TYPES = ["person", "org", "project", "topic"];
const PAGE_FOLDERS = new Set(["people", "orgs", "projects", "topics", "notes", "sessions", "decisions"]);
const STALE_DAYS = 120;

const words = (s: string) => foldText(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function lintWiki(store: LintSource, opts: { today?: string } = {}): LintReport {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const living = LIVING_TYPES.flatMap((t) => store.ofType(t));
  const notes = store.ofType("note");
  const issues: LintIssue[] = [];
  const links = store.allLinks();

  // Front-matter links to pages that don't exist (links in the text are the writer's business).
  const seen = new Set<string>();
  for (const l of links) {
    if (l.rel === "mentions" || !PAGE_FOLDERS.has(l.dst.split("/")[0]!) || store.getByRef(l.dst)) continue;
    const key = `${l.src}->${l.dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ kind: "broken_link", ref: l.src, refs: [l.dst], detail: `links to ${l.dst}, which doesn't exist` });
  }

  // Living pages no page links to.
  const linked = new Set(links.map((l) => l.dst));
  for (const p of living) {
    // The owner's own page (`me`) is read first by design, not found through links.
    if (!linked.has(p.ref) && p.frontmatter.self !== true) issues.push({ kind: "orphan", ref: p.ref, refs: [], detail: "no page links here" });
  }

  // Same folder, one name contained in the other ("Anna" / "Anna Müller", "Bergmann" / "Bergmann Logistik").
  const byFolder = new Map<string, Page[]>();
  for (const p of living) byFolder.set(p.ref.split("/")[0]!, [...(byFolder.get(p.ref.split("/")[0]!) ?? []), p]);
  for (const pages of byFolder.values()) {
    const names = pages.map((p) => ({ p, w: new Set(words(p.title)) }));
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = names[i]!.w.size <= names[j]!.w.size ? [names[i]!, names[j]!] : [names[j]!, names[i]!];
        if (a.w.size === 0 || [...a.w].some((x) => !b.w.has(x))) continue;
        issues.push({ kind: "possible_duplicate", ref: a.p.ref, refs: [b.p.ref], detail: `"${a.p.title}" may be the same as "${b.p.title}"` });
      }
    }
  }

  // Notes written from the transcript's first sentences because the summarizer failed.
  for (const n of notes) {
    const compile = n.frontmatter.compile as Record<string, unknown> | undefined;
    const fallback = compile && typeof compile.fallback === "string" ? compile.fallback : "none";
    if (fallback !== "none" || !n.summary.trim()) {
      issues.push({ kind: "weak_note", ref: n.ref, refs: [], detail: fallback !== "none" ? `summarized without the model (${fallback})` : "has no summary" });
    }
  }

  for (const p of living) {
    // Contradictions and unknowns Claude parked under "Open questions".
    const open = section(p.body, "Open questions")
      .map((l) => l.replace(/^\s*-\s*/, "").trim())
      .filter((l) => l && l !== "(none)");
    if (open.length) issues.push({ kind: "open_question", ref: p.ref, refs: [], detail: open[0]!.slice(0, 160) + (open.length > 1 ? ` (+${open.length - 1} more)` : "") });
    // Active pages nothing has touched in months.
    const updated = p.updated.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(updated) && p.frontmatter.status !== "outdated" && daysBetween(updated, today) > STALE_DAYS) {
      issues.push({ kind: "stale", ref: p.ref, refs: [], detail: `not updated since ${updated}` });
    }
  }

  const counts = { broken_link: 0, orphan: 0, possible_duplicate: 0, weak_note: 0, open_question: 0, stale: 0 } as Record<LintKind, number>;
  for (const i of issues) counts[i.kind]++;
  return { checked: { pages: store.size, notes: notes.length, living: living.length }, counts, issues };
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const PRIORITY: LintKind[] = ["broken_link", "possible_duplicate", "weak_note", "open_question", "orphan", "stale"];
const LABEL: Record<LintKind, string> = {
  broken_link: "Broken link",
  possible_duplicate: "Possible duplicate",
  weak_note: "Weak note",
  open_question: "Open question",
  orphan: "Nothing links here",
  stale: "Stale",
};

/** The few issues worth showing on the top-level index, most important first. */
export function attention(report: LintReport, max = 8): { label: string; ref: string; refs: string[]; detail: string }[] {
  return [...report.issues]
    .sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.ref.localeCompare(b.ref) || a.detail.localeCompare(b.detail))
    .slice(0, max)
    .map((i) => ({ label: LABEL[i.kind], ref: i.ref, refs: i.refs, detail: i.detail }));
}
