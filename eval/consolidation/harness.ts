// The parts of the consolidation eval (run.ts) that don't need a model: the wiki the batch
// lands in, the nightly job run over it the way team/src/cli.ts runs it, and the scoring.
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import { parsePage, splitCompiled, type JobResult } from "@brain/spec";
import { consolidate, markConsolidated, type PageUpdater, type Usage } from "../../team/src/consolidate.ts";
import type { DecisionFiler } from "../../team/src/decisions.ts";
import { headParts } from "../../team/src/head.ts";
import type { OverviewWriter } from "../../team/src/overview.ts";
import { TeamWiki } from "../../team/src/wiki.ts";
import { CASES, CATEGORIES, LINK_RULE, type Case, type Category, type PageRef } from "./cases.ts";

const HERE = import.meta.dirname;
/** The starting wiki is the placement eval's fixture; batch/ holds the new notes, laid out as in the wiki. */
const FIXTURE = join(HERE, "..", "fixture");
const BATCH = join(HERE, "batch");
const TEAM = { id: "t_kessler", name: "Kessler Werkzeuge" };

/** Every page of a wiki folder by ref: notes, decisions and living pages, not the generated index, log and overview at the top. */
export function pages(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md") && d !== dir) out.set(relative(dir, p).split(sep).join("/").replace(/\.md$/, ""), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** The three model steps of the nightly job: page updates, decision pages, the overview. */
export interface Steps {
  pages: PageUpdater;
  decisions: DecisionFiler;
  overview: OverviewWriter;
}
export type Step = keyof Steps;

export interface Tally {
  model: string;
  calls: number;
  usage: Usage;
}

/**
 * A timeline entry the model returned for a note that isn't one of the page's evidence refs,
 * other than a repeat of a line the page already has: the applier drops it, and what it said
 * doesn't reach the timeline.
 */
export interface Dropped {
  page: string;
  note: string;
  date: string;
  fact: string;
}

/** The same steps, counting each one's calls and tokens and the timeline entries the applier will drop. */
function counted(steps: Steps): { steps: Steps; tally: Record<Step, Tally>; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const tally = Object.fromEntries(
    (["pages", "decisions", "overview"] as const).map((s) => [s, { model: steps[s].model, calls: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } }]),
  ) as Record<Step, Tally>;
  const add = (s: Step, u: Usage) => {
    tally[s].calls++;
    tally[s].usage.input_tokens += u.input_tokens;
    tally[s].usage.output_tokens += u.output_tokens;
    tally[s].usage.cache_read_tokens += u.cache_read_tokens;
  };
  return {
    tally,
    dropped,
    steps: {
      pages: {
        model: steps.pages.model,
        update: async (input) => {
          const r = await steps.pages.update(input);
          add("pages", r.usage);
          const given = new Set(input.evidence.map((e) => e.note));
          const stem = (s: string) => s.split("/").pop()!.replace(/\.md$/, "");
          const repeats = (t: { note: string; date: string }) =>
            (input.existing?.timelineTail ?? []).some((l) => l.startsWith(`- ${t.date}:`) && links(l, input.ref).some((r) => stem(r) === stem(t.note)));
          const entries = (r.update as { timeline?: { note?: unknown; date?: unknown; fact?: unknown }[] } | null)?.timeline ?? [];
          for (const e of Array.isArray(entries) ? entries : []) {
            const t = { page: input.ref, note: String(e.note), date: String(e.date), fact: String(e.fact) };
            if (!given.has(t.note) && !repeats(t)) dropped.push(t);
          }
          return r;
        },
      },
      decisions: {
        model: steps.decisions.model,
        file: async (input) => {
          const r = await steps.decisions.file(input);
          add("decisions", r.usage);
          return r;
        },
      },
      overview: {
        model: steps.overview.model,
        write: async (input) => {
          const r = await steps.overview.write(input);
          add("overview", r.usage);
          return r;
        },
      },
    },
  };
}

export interface Night {
  /** The temporary folder holding the wiki and the job's output; remove it when done. */
  root: string;
  before: Map<string, string>;
  after: Map<string, string>;
  result: JobResult;
  tally: Record<Step, Tally>;
  dropped: Dropped[];
}

/**
 * One night: the fixture and the batch in a fresh git wiki, the fixture's own notes marked as
 * folded in on earlier nights, then the real `consolidate()` with the decision and overview
 * steps, as `cli.ts consolidate` runs it.
 */
export async function runNight(steps: Steps): Promise<Night> {
  const root = mkdtempSync(join(tmpdir(), "ambient-consolidation-eval-"));
  const dir = join(root, "wiki");
  const outDir = join(root, "out");
  cpSync(FIXTURE, dir, { recursive: true });
  cpSync(BATCH, dir, { recursive: true });
  const earlier = [...pages(FIXTURE).values()].map((t) => parsePage(t).frontmatter).filter((fm) => fm.type === "note").map((fm) => String(fm.id));
  await markConsolidated(outDir, earlier);
  const before = pages(dir);
  const wiki = await TeamWiki.open(dir, TEAM.id, TEAM.name);
  const c = counted(steps);
  const result = await consolidate(wiki, c.steps.pages, { outDir, version: "eval", decisions: c.steps.decisions, overview: c.steps.overview });
  return { root, before, after: pages(dir), result, tally: c.tally, dropped: c.dropped };
}

// Reading pages.

const LIVING = /^(people|orgs|projects|topics)\//;

function fm(text: string): Record<string, unknown> {
  return parsePage(text).frontmatter;
}

/** Current-truth bullets: the flat list and every section, not the open questions. */
export function bullets(text: string): string[] {
  const h = headParts(parsePage(text).body);
  return [...h.currentTruth, ...h.sections.flatMap((s) => s.bullets)];
}

/** What a page states now: its summary and current truth. */
export function head(text: string): string {
  return [String(fm(text).summary ?? ""), ...bullets(text)].join("\n");
}

export function timeline(text: string): string[] {
  return splitCompiled(parsePage(text).body).timeline;
}

/** The refs a piece of markdown on page `ref` links to (relative .md links). */
export function links(markdown: string, ref: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/\]\(([^)\s]+?\.md)(#[^)]*)?\)/g)) {
    const href = m[1]!;
    if (/^[a-z]+:/i.test(href) || href.startsWith("/")) continue;
    out.push(posix.normalize(posix.join(posix.dirname(ref), href)).replace(/\.md$/, ""));
  }
  return out;
}

/** The notes whose front matter names the page (the evidence the nightly job gives it), oldest first. */
export function notesNaming(ref: string, wiki: Map<string, string>): string[] {
  return [...wiki.entries()]
    .map(([r, text]) => ({ r, f: fm(text) }))
    .filter(({ f }) => f.type === "note" && (f.recorded_by === ref || ["people", "orgs", "projects", "topics"].some((k) => Array.isArray(f[k]) && (f[k] as unknown[]).includes(ref))))
    .sort((a, b) => String(a.f.recorded_at).localeCompare(String(b.f.recorded_at)))
    .map(({ r }) => r);
}

function find(after: Map<string, string>, page: PageRef): string | undefined {
  if (typeof page === "string") return after.has(page) ? page : undefined;
  return [...after.entries()]
    .filter(([ref]) => ref.startsWith(`${page.folder}/`))
    .find(([ref, text]) => {
      const f = fm(text);
      const names = [ref, String(f.title ?? ""), ...(Array.isArray(f.aliases) ? f.aliases.map(String) : [])];
      return names.some((n) => page.name.test(n));
    })?.[0];
}

const label = (page: PageRef) => (typeof page === "string" ? page : `a page in ${page.folder}/ named ${page.name}`);
const missing = (patterns: RegExp[], text: string) => patterns.filter((p) => !p.test(text)).map(String);

// Scoring.

export interface CaseResult {
  id: string;
  category: Category;
  pass: boolean;
  /** What was found, in a line: why it passed or failed. */
  detail: string;
  why: string;
}

const CATEGORY: Record<Case["kind"], (c: Case) => Category> = {
  entity: () => "entity recall",
  fact: () => "fact recall",
  decision: (c) => ((c as Extract<Case, { kind: "decision" }>).exists ? "decision recall" : "decision precision"),
  supersession: () => "supersession",
  untouched: () => "untouched",
};

/** New decision pages: ref, source note and the text the cases match. */
function newDecisions(before: Map<string, string>, after: Map<string, string>) {
  return [...after.entries()]
    .filter(([ref]) => ref.startsWith("decisions/") && !before.has(ref))
    .map(([ref, text]) => ({ ref, source: String(fm(text).source ?? ""), text: `${fm(text).title ?? ""}\n${fm(text).summary ?? ""}\n${parsePage(text).body}` }));
}

function check(c: Case, before: Map<string, string>, after: Map<string, string>): { pass: boolean; detail: string } {
  switch (c.kind) {
    case "entity": {
      const ref = find(after, c.page);
      if (!ref) return { pass: false, detail: `no page: ${label(c.page)}` };
      const how = before.has(ref) ? "updated" : "created";
      const linked = timeline(after.get(ref)!).some((l) => links(l, ref).includes(c.note));
      if (linked) return { pass: true, detail: `${ref} ${how}, its timeline links the note` };
      return { pass: false, detail: before.get(ref) === after.get(ref) ? `${ref} not updated` : `${ref} ${how}, but no timeline line links ${c.note}` };
    }
    case "fact": {
      const ref = find(after, c.page);
      if (!ref) return { pass: false, detail: `no page: ${label(c.page)}` };
      const lacking = missing(c.expect, head(after.get(ref)!));
      return lacking.length ? { pass: false, detail: `${ref} lacks ${lacking.join(", ")}` } : { pass: true, detail: `${ref} states it` };
    }
    case "decision": {
      const hits = newDecisions(before, after).filter((d) => d.source === c.note && c.match.test(d.text)).map((d) => d.ref);
      if (c.exists) return hits.length ? { pass: true, detail: `filed as ${hits.join(", ")}` } : { pass: false, detail: `no decision page from ${c.note} matches ${c.match}` };
      return hits.length ? { pass: false, detail: `filed anyway as ${hits.join(", ")}` } : { pass: true, detail: "not filed" };
    }
    case "supersession": {
      const text = after.get(c.page);
      if (!text) return { pass: false, detail: `no page ${c.page}` };
      const now = head(text);
      const problems = [
        ...(c.now && !c.now.test(now) ? ["current truth lacks the new value"] : []),
        ...(c.was.test(now) ? [`current truth still states the old value ("${now.split("\n").find((l) => c.was.test(l))}")`] : []),
        ...(c.inTimeline && !timeline(text).some((l) => c.was.test(l)) ? ["the timeline doesn't keep the old value"] : []),
      ];
      return problems.length ? { pass: false, detail: `${c.page}: ${problems.join("; ")}` } : { pass: true, detail: `${c.page} superseded it` };
    }
    case "untouched": {
      if (c.identical) {
        const changed = c.pages.filter((p) => before.get(p) === undefined || after.get(p) !== before.get(p));
        return changed.length ? { pass: false, detail: `changed: ${changed.join(", ")}` } : { pass: true, detail: `${c.pages.length} pages as they were` };
      }
      const page = c.pages[0];
      const text = after.get(page);
      if (!text) return { pass: false, detail: `no page ${page}` };
      const had = new Set(timeline(before.get(page) ?? ""));
      const added = timeline(text).filter((l) => !had.has(l));
      const now = head(text);
      const problems = [
        ...(added.length ? [`new timeline line "${added[0]}"`] : []),
        ...missing(c.keep, now).map((p) => `lost ${p}`),
        ...c.forbid.filter((p) => p.test(now)).map((p) => `now states ${p}`),
      ];
      return problems.length ? { pass: false, detail: `${page}: ${problems.join("; ")}` } : { pass: true, detail: `${page} kept as it was` };
    }
  }
}

/** One case per living page the run wrote: every timeline line cites an existing note, no link is broken. */
function linkResults(before: Map<string, string>, after: Map<string, string>): CaseResult[] {
  const isNote = (ref: string) => after.has(ref) && fm(after.get(ref)!).type === "note";
  return [...after.entries()]
    .filter(([ref, text]) => LIVING.test(ref) && before.get(ref) !== text)
    .map(([ref, text]) => {
      const lines = timeline(text);
      const cited = lines.filter((l) => links(l, ref).some(isNote)).length;
      const broken = links(parsePage(text).body, ref).filter((r) => !after.has(r));
      const pass = lines.length > 0 && cited === lines.length && broken.length === 0;
      const detail = `${ref}: ${cited} of ${lines.length} timeline lines cite a note${broken.length ? `; broken links to ${broken.join(", ")}` : ""}`;
      return { id: `l:${ref}`, category: "link validity" as const, pass, detail, why: LINK_RULE };
    });
}

export function score(before: Map<string, string>, after: Map<string, string>): CaseResult[] {
  const results: CaseResult[] = CASES.map((c) => ({ id: c.id, category: CATEGORY[c.kind](c), ...check(c, before, after), why: c.why }));
  // Precision also means filing nothing the cases don't expect at all.
  const known = CASES.filter((c): c is Extract<Case, { kind: "decision" }> => c.kind === "decision");
  const extra = newDecisions(before, after).filter((d) => !known.some((c) => d.source === c.note && c.match.test(d.text)));
  results.push({
    id: "d0",
    category: "decision precision",
    pass: extra.length === 0,
    detail: extra.length ? `unexpected: ${extra.map((d) => d.ref).join(", ")}` : "no unexpected decision pages",
    why: "every new decision page is one a case expects",
  });
  return [...results, ...linkResults(before, after)];
}

export interface Summary {
  categories: Record<Category, { passed: number; of: number; score: number }>;
  /** The mean of the category scores: a category with two cases weighs as much as one with seven. */
  total: number;
  failed: string[];
}

export function summarize(results: CaseResult[]): Summary {
  const categories = Object.fromEntries(
    CATEGORIES.map((cat) => {
      const rs = results.filter((r) => r.category === cat);
      const passed = rs.filter((r) => r.pass).length;
      return [cat, { passed, of: rs.length, score: rs.length ? passed / rs.length : 0 }];
    }),
  ) as Summary["categories"];
  const scored = CATEGORIES.filter((c) => categories[c].of > 0);
  const total = scored.reduce((t, c) => t + categories[c].score, 0) / (scored.length || 1);
  return { categories, total, failed: results.filter((r) => !r.pass).map((r) => r.id) };
}

/** The living and decision pages the run wrote, with their previous text (null for new pages). */
export function written(before: Map<string, string>, after: Map<string, string>): { ref: string; before: string | null; after: string }[] {
  return [...after.entries()]
    .filter(([ref, text]) => (LIVING.test(ref) || ref.startsWith("decisions/")) && before.get(ref) !== text)
    .map(([ref, text]) => ({ ref, before: before.get(ref) ?? null, after: text }));
}
