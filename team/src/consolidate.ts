// Nightly consolidation: fold the day's new notes into the living pages they
// mention (people, orgs, projects, topics). One structured LLM call per page,
// no agent and no tools besides the output schema; a plain-code applier writes
// the page, so a transcript can't make the model touch anything else.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JobResult, LivingPageFrontmatter, appendTimeline, parsePage, renderPage, section, slugify, splitCompiled } from "@brain/spec";
import { EntityIndex, type Page, type WikiStore } from "@brain/wiki";
import type { TeamWiki } from "./wiki.ts";
import { overviewInput, renderOverview, type OverviewWriter } from "./overview.ts";
import { decisionInput, decisionPages, type DecisionFiler } from "./decisions.ts";
import { dedupe } from "./dedup.ts";
import { headParts, renderHead, type Head } from "./head.ts";

export { headParts, renderHead, type Head };

export type EntityType = "person" | "org" | "project" | "topic";
export const FOLDER_TYPE: Record<string, EntityType> = { people: "person", orgs: "org", projects: "project", topics: "topic" };

export interface SectionSpec {
  /** The field the model fills. */
  key: string;
  heading: string;
  /** What belongs in it; `{owner}` is "the team" or "the wiki's owner". */
  hint: string;
  max: number;
}

/**
 * What a living page says above its timeline, by kind. A person page answers who someone is
 * and what they work on, not what they did each day (pages fed every note their subject
 * recorded read as changelogs). Topics keep one list.
 */
export const PAGE_SECTIONS: Record<EntityType, SectionSpec[]> = {
  person: [
    { key: "who", heading: "Who they are", hint: "role, company or team, and background", max: 3 },
    { key: "workingOn", heading: "Working on", hint: "what they build, lead or answer for now: projects and areas, not single tasks or commits", max: 4 },
    { key: "howTheyWork", heading: "How they work", hint: "how they like to work and communicate, tools they rely on, preferences", max: 3 },
    { key: "relationship", heading: "Relationship", hint: "how they relate to {owner} (colleague, customer, partner, investor…) and what you do together", max: 3 },
    { key: "contact", heading: "Contact", hint: "email, phone or handles, only when the evidence states them", max: 2 },
  ],
  project: [
    { key: "status", heading: "Status", hint: "active, paused or done; who owns it; where it stands", max: 2 },
    { key: "what", heading: "What it is", hint: "what the project is and why it exists", max: 3 },
    { key: "decisions", heading: "Key decisions", hint: "the decisions that shape it, with their date when known", max: 4 },
    { key: "next", heading: "What's next", hint: "the open work and who has it", max: 4 },
  ],
  org: [
    { key: "what", heading: "What they do", hint: "what the organization is and does", max: 2 },
    { key: "people", heading: "Key people", hint: "the people there {owner} deals with, by name and role", max: 4 },
    { key: "relationship", heading: "Relationship", hint: "customer, partner, supplier, competitor or investor, and where things stand", max: 3 },
  ],
  topic: [],
};

/**
 * The wiki owner's own page (`me` in a personal wiki), which their AI apps read before helping
 * them: who they are, their work, how they work and write, what they care about.
 */
export const SELF_SECTIONS: SectionSpec[] = [
  { key: "about", heading: "About", hint: "role, company or team, background, where they are based", max: 3 },
  { key: "workingOn", heading: "Working on", hint: "what they build, lead or answer for now: projects and areas, not single tasks", max: 4 },
  { key: "howTheyWork", heading: "How they work", hint: "how they like to work and get help: tools, habits, preferences for answers", max: 4 },
  { key: "howTheyWrite", heading: "How they write", hint: "their voice: language, tone, length, formality (du or Sie), so an AI can draft in it", max: 3 },
  { key: "interests", heading: "Interests", hint: "what they care about and like to dig into, at work and beyond, when they said so", max: 3 },
];

/** The sections a page has: its kind's, or the owner's own for `me`. */
export function sectionsFor(type: EntityType, self = false): SectionSpec[] {
  return self ? SELF_SECTIONS : PAGE_SECTIONS[type];
}

export interface Evidence {
  note: string;
  date: string;
  title: string;
  summary: string;
  body: string;
  /** "recorder": the page's subject recorded this note (their own meeting or work session). */
  role?: "recorder";
}

export interface PageUpdateInput {
  ref: string;
  type: EntityType;
  /** The wiki owner's own page (`me`): SELF_SECTIONS, written about the owner from their own notes. */
  self?: boolean;
  existing: null | {
    title: string;
    summary: string;
    aliases: string[];
    currentTruth: string;
    openQuestions: string[];
    timelineTail: string[];
  };
  evidence: Evidence[];
}

const Bullet = z.string().min(1).max(300);

export const PageUpdate = z.object({
  title: z.string().min(1).max(80),
  summary: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(80)).max(10),
  /** Topics, and pages of a kind without sections. */
  currentTruth: z.array(Bullet).max(10),
  sections: z.array(z.object({ heading: z.string().min(1).max(60), bullets: z.array(Bullet).min(1).max(5) })).max(6),
  openQuestions: z.array(Bullet).max(10),
  timeline: z.array(z.object({ note: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fact: z.string().min(1).max(200) })).max(20),
});
export type PageUpdate = z.infer<typeof PageUpdate>;

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const list = (v: unknown) => (Array.isArray(v) ? v : []);
const bulletText = (v: unknown, n: number) => clip(v, n + 4).replace(/^-\s*/, "").slice(0, n);

/**
 * Trim a model reply to the page limits instead of rejecting it for being a little long.
 * With `type`, the model's `sections` object becomes the kind's sections, in their order.
 */
export function normalizeUpdate(raw: unknown, type?: EntityType, self = false): PageUpdate {
  const r = (raw ?? {}) as Record<string, unknown>;
  const given = r.sections && typeof r.sections === "object" && !Array.isArray(r.sections) ? (r.sections as Record<string, unknown>) : {};
  const sections = (type ? sectionsFor(type, self) : [])
    .map((s) => ({ heading: s.heading, bullets: list(given[s.key]).map((b) => bulletText(b, 300)).filter(Boolean).slice(0, s.max) }))
    .filter((s) => s.bullets.length > 0);
  return PageUpdate.parse({
    title: clip(r.title, 80),
    summary: clip(r.summary, 200),
    aliases: list(r.aliases).map((a) => clip(a, 80)).filter(Boolean).slice(0, 10),
    currentTruth: list(r.currentTruth).map((b) => bulletText(b, 300)).filter(Boolean).slice(0, 10),
    sections,
    openQuestions: list(r.openQuestions).map((q) => clip(q, 300)).filter(Boolean).slice(0, 10),
    timeline: list(r.timeline)
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return { note: clip(o.note, 300), date: clip(o.date, 10), fact: clip(o.fact, 200) };
      })
      .filter((t) => t.note && t.fact && /^\d{4}-\d{2}-\d{2}$/.test(t.date))
      .slice(0, 20),
  });
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

export interface PageUpdater {
  model: string;
  update(input: PageUpdateInput): Promise<{ update: unknown; usage: Usage }>;
}

/**
 * What a note is about when its front matter names no organizations or topics. Work notes from
 * AI apps (log_work, agent sessions) arrive like that, so a note about a competitor never reached
 * an org page (the consolidation eval's e2 and f5; every competitor note in the live wiki).
 */
export interface EntityFinder {
  model: string;
  find(input: EntityFinderInput): Promise<{ entities: unknown; usage: Usage }>;
}

export interface EntityFinderInput {
  title: string;
  summary: string;
  body: string;
  /** Organizations and topics the wiki already has pages for, so names match them. */
  known: { ref: string; title: string }[];
}

export const FoundEntities = z.object({
  orgs: z.array(z.string().min(1).max(80)).max(5),
  topics: z.array(z.string().min(1).max(80)).max(3),
});

/** USD per million tokens. Check current prices before trusting the ledger. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export function cost(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES["claude-haiku-4-5"]!;
  return (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_tokens * p.cacheRead) / 1_000_000;
}

interface State {
  consolidated: string[];
}

async function readState(outDir: string): Promise<State> {
  try {
    return JSON.parse(await readFile(join(outDir, "state.json"), "utf8")) as State;
  } catch {
    return { consolidated: [] };
  }
}

/** Mark notes as folded in, so the nightly job leaves them alone (a note whose pages were written directly). */
export async function markConsolidated(outDir: string, ids: string[]): Promise<void> {
  const state = await readState(outDir);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "state.json"), JSON.stringify({ consolidated: [...new Set([...state.consolidated, ...ids])] }, null, 2));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function noteRefs(n: Page): string[] {
  const fm = n.frontmatter;
  const all = [fm.recorded_by, ...(["people", "orgs", "projects", "topics"] as const).flatMap((k) => (Array.isArray(fm[k]) ? fm[k] : []))];
  return [...new Set(all.filter((r): r is string => typeof r === "string" && Object.hasOwn(FOLDER_TYPE, r.split("/")[0]!)))];
}

function existingOf(page: Page | undefined): PageUpdateInput["existing"] {
  if (!page) return null;
  const { currentTruth, timeline } = splitCompiled(page.body);
  return {
    title: page.title,
    summary: page.summary,
    aliases: Array.isArray(page.frontmatter.aliases) ? page.frontmatter.aliases.map(String) : [],
    currentTruth: currentTruth.replace(/^# .+\n*/, "").split(/\n## /)[0]!.trim(),
    openQuestions: section(page.body, "Open questions").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean),
    timelineTail: timeline.slice(-10),
  };
}

const hasTruth = (h: Head) => h.currentTruth.length > 0 || h.sections.length > 0;

/**
 * Which of this run's notes a timeline entry means. The model names notes the way it sees them:
 * the ref it was given (`notes/2026-10/2026-10-14-call-m1n2o3`), but often just the file name, the
 * relative link an existing timeline uses, or with ".md". Matching only the exact ref dropped those
 * entries without a trace, so the page changed with nothing saying why (the consolidation eval's
 * e4 to e6 and s1). An entry naming none of this run's notes is still dropped: it's the model
 * repeating a line the timeline already has, for an older note.
 */
export function noteFor(named: string, notePaths: Map<string, string>): string | undefined {
  if (notePaths.has(named)) return named;
  const clean = named.trim().replace(/^(\.\.\/)+/, "").replace(/\.md$/, "");
  if (notePaths.has(clean)) return clean;
  const base = clean.split("/").pop()!;
  const byName = [...notePaths.keys()].filter((ref) => ref.split("/").pop() === base);
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * Build the page text from a validated update. Only the part above ## Timeline is rewritten.
 * Team mode also appends the model's timeline lines; personal mode leaves the timeline to the
 * phone (which already wrote one line per note) and keeps the page where the phone put it.
 * An update with nothing true in it leaves an existing head as it was, and gives a new page
 * its summary as the one line it knows.
 */
export function composePage(
  ref: string,
  type: EntityType,
  prev: Page | undefined,
  upd: PageUpdate,
  notePaths: Map<string, string>,
  lastNoteId: string,
  mode: "team" | "personal" = "team",
): { path: string; text: string } {
  const path = mode === "personal" && prev ? prev.path : `${ref}.md`;
  const kept = !hasTruth(upd) && prev ? headParts(prev.body) : null;
  const keep = kept && hasTruth(kept) ? kept : null;
  const title = keep ? prev!.title : upd.title;
  const aliases = [...new Set([...(prev && Array.isArray(prev.frontmatter.aliases) ? prev.frontmatter.aliases.map(String) : []), ...upd.aliases, ...(prev && prev.title !== title ? [prev.title] : [])])]
    .filter((a) => a !== title)
    .slice(0, 10);
  const frontmatter = {
    title,
    type,
    summary: keep ? prev!.summary || upd.summary : upd.summary,
    aliases,
    update_mode: "compiled",
    status: "active",
    ...(prev?.frontmatter.links ? { links: prev.frontmatter.links } : {}),
    compiled_through: lastNoteId,
    updated: today(),
  };
  LivingPageFrontmatter.parse(frontmatter);
  if (mode === "personal") Object.assign(frontmatter, { pending_rewrite: 0 });
  const head = renderHead(
    title,
    keep ?? (hasTruth(upd) ? upd : { currentTruth: [upd.summary], sections: [], openQuestions: upd.openQuestions }),
  );
  const lines = mode !== "team"
    ? []
    : upd.timeline.flatMap((t) => {
        const note = noteFor(t.note, notePaths);
        return note ? [`- ${t.date}: ${t.fact.replace(/\s+/g, " ").trim()} ([note](${relative(dirname(path), notePaths.get(note)!)}))`] : [];
      });
  const prevTimeline = prev ? splitCompiled(prev.body).timeline : [];
  const body = appendTimeline(`${head}\n\n## Timeline\n${prevTimeline.join("\n")}\n`, lines);
  return { path, text: renderPage({ frontmatter, body: `\n${body}` }) };
}

export interface ConsolidateRun {
  store: WikiStore;
  updater: PageUpdater;
  /** Note ids already folded in. Notes that succeed are added to it. */
  done: Set<string>;
  mode: "team" | "personal";
  maxPages?: number;
  /**
   * Pages to rewrite even without new notes (after a merge, or to bring a page into the
   * sections of its kind): their latest notes are the evidence, and no timeline lines are
   * added for them, since the timeline already has those notes.
   */
  rewrite?: string[];
  /** Persist the rewritten pages (one commit / one encrypted batch); returns a commit id if any. */
  write(pages: { path: string; text: string }[], message: string): Promise<string | null>;
  /** More pages a note is about than its front matter lists (EntityFinder), by note ref. */
  extraRefs?: Map<string, string[]>;
}

export interface ConsolidateOutcome {
  fresh: number;
  pagesUpdated: number;
  requests: number;
  usage: Usage;
  checks: JobResult["checks"];
  failedNotes: Set<string>;
  commit: string | null;
}

/**
 * Fold new notes into the living pages they mention: one structured LLM call per page.
 * Team mode creates missing pages and adds timeline lines; personal mode only rewrites
 * the head of pages the phone already created (the phone owns page creation and timeline).
 */
export async function consolidatePages(run: ConsolidateRun): Promise<ConsolidateOutcome> {
  const { store, updater, done, mode } = run;
  const fresh = store.ofType("note").filter((n) => typeof n.frontmatter.id === "string" && !done.has(n.frontmatter.id));
  const out: ConsolidateOutcome = {
    fresh: fresh.length,
    pagesUpdated: 0,
    requests: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
    checks: [],
    failedNotes: new Set(),
    commit: null,
  };
  const rewrite = (run.rewrite ?? []).filter((r) => Object.hasOwn(FOLDER_TYPE, r.split("/")[0]!) && store.getByRef(r));
  if (fresh.length === 0 && rewrite.length === 0) return out;

  const byTarget = new Map<string, { notes: Page[]; known: boolean }>();
  for (const n of fresh) {
    // Its front matter's pages, and the ones findEntities named for a work note that lists none.
    for (const r of new Set([...noteRefs(n), ...(run.extraRefs?.get(n.ref) ?? [])])) {
      if (mode === "personal" && !store.getByRef(r)) continue;
      byTarget.set(r, { notes: [...(byTarget.get(r)?.notes ?? []), n], known: false });
    }
  }
  for (const r of rewrite) {
    if (byTarget.has(r)) continue;
    const latest = store.backlinks(r).filter((p) => p.type === "note").sort((a, b) => a.sortDate.localeCompare(b.sortDate)).slice(-5);
    if (latest.length) byTarget.set(r, { notes: latest, known: true });
  }
  const targets = [...byTarget.entries()].slice(0, run.maxPages ?? 40);
  if (targets.length < byTarget.size) out.checks.push({ name: "page_cap", ok: false, detail: `${byTarget.size - targets.length} pages deferred` });

  const pages: { path: string; text: string }[] = [];
  for (const [ref, { notes, known }] of targets) {
    const type = FOLDER_TYPE[ref.split("/")[0]!]!;
    const prev = store.getByRef(ref);
    // Notes already in the timeline add no lines again.
    const notePaths = known ? new Map<string, string>() : new Map(notes.map((n) => [n.ref, n.path]));
    const input: PageUpdateInput = {
      ref,
      type,
      existing: existingOf(prev),
      evidence: notes.map((n) => ({
        note: n.ref,
        date: n.sortDate.slice(0, 10),
        title: n.title,
        summary: n.summary,
        body: n.body.slice(0, 4000),
        ...(n.frontmatter.recorded_by === ref ? { role: "recorder" as const } : {}),
      })),
    };
    try {
      out.requests++;
      const { update, usage: u } = await updater.update(input);
      out.usage.input_tokens += u.input_tokens;
      out.usage.output_tokens += u.output_tokens;
      out.usage.cache_read_tokens += u.cache_read_tokens;
      const lastId = String(known ? (prev?.frontmatter.compiled_through ?? notes[notes.length - 1]!.frontmatter.id) : notes[notes.length - 1]!.frontmatter.id);
      pages.push(composePage(ref, type, prev, normalizeUpdate(update, type), notePaths, lastId, mode));
    } catch (err) {
      out.checks.push({ name: `page:${ref}`, ok: false, detail: (err as Error).message.slice(0, 200) });
      if (!known) for (const n of notes) out.failedNotes.add(String(n.frontmatter.id));
    }
  }
  out.pagesUpdated = pages.length;
  out.commit = pages.length ? await run.write(pages, `consolidate: ${pages.length} pages from ${fresh.length} notes`) : null;
  for (const n of fresh) {
    const id = String(n.frontmatter.id);
    if (!out.failedNotes.has(id)) done.add(id);
  }
  return out;
}

/** Cost and status of a run in the shared JobResult shape. */
export function jobResult(o: ConsolidateOutcome, model: string, meta: { runId: string; version: string; started: string }): JobResult {
  const pageFailures = o.checks.filter((c) => c.name.startsWith("page:") && !c.ok).length;
  const status: JobResult["status"] =
    o.fresh === 0 && o.requests === 0 ? "noop" : pageFailures > 0 ? (o.pagesUpdated > 0 ? "partial" : "failed") : "ok";
  const result: JobResult = {
    job: "consolidate",
    run_id: meta.runId,
    version: meta.version,
    started_at: meta.started,
    finished_at: new Date().toISOString(),
    status,
    reason: status === "noop" ? "no new notes" : null,
    input: { notes: o.fresh },
    output: { pages_updated: o.pagesUpdated, review_items: 0, commits: o.commit ? [o.commit] : [] },
    llm: o.requests
      ? {
          requests: o.requests,
          input_tokens: o.usage.input_tokens,
          output_tokens: o.usage.output_tokens,
          cache_read_tokens: o.usage.cache_read_tokens,
          cost_usd: Number(cost(model, o.usage).toFixed(5)),
          by_model: { [model]: o.requests },
        }
      : null,
    checks: o.checks,
    error: status === "failed" ? "every page update failed" : null,
  };
  return JobResult.parse(result);
}

/**
 * The organizations and topics of new work notes that name none: one structured call each, the
 * names matched to pages the wiki has (EntityIndex), else a new page's ref. The note itself stays
 * as it is (notes are never rewritten); its pages get it in this run.
 */
export async function findEntities(store: WikiStore, notes: Page[], finder: EntityFinder) {
  const out = { refs: new Map<string, string[]>(), requests: 0, failed: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
  const index = new EntityIndex(store);
  const known = [...store.ofType("org"), ...store.ofType("topic")].slice(0, 200).map((p) => ({ ref: p.ref, title: p.title }));
  for (const n of notes) {
    const fm = n.frontmatter;
    const listed = (k: string) => Array.isArray(fm[k]) && (fm[k] as unknown[]).length > 0;
    if (fm.kind !== "session" || listed("orgs") || listed("topics")) continue;
    out.requests++;
    try {
      const { entities, usage } = await finder.find({ title: n.title, summary: n.summary, body: n.body.slice(0, 8000), known });
      out.usage.input_tokens += usage.input_tokens;
      out.usage.output_tokens += usage.output_tokens;
      out.usage.cache_read_tokens += usage.cache_read_tokens;
      const f = FoundEntities.parse(entities);
      const refs = [...f.orgs.map((name) => `orgs/${slugify(name)}`), ...f.topics.map((name) => `topics/${slugify(name)}`)]
        .filter((r) => /^(orgs|topics)\/[a-z0-9][a-z0-9-]{0,79}$/.test(r))
        .map((r) => index.canonical(r))
        .filter((r): r is string => r !== null);
      if (refs.length) out.refs.set(n.ref, [...new Set(refs)]);
    } catch {
      out.failed++;
    }
  }
  return out;
}

/** Team server's nightly job: the core plus git, the state file and the result JSON on disk. */
export async function consolidate(
  wiki: TeamWiki,
  updater: PageUpdater,
  opts: {
    outDir: string;
    version: string;
    maxPages?: number;
    overview?: OverviewWriter;
    decisions?: DecisionFiler;
    /** Finds the organizations and topics of work notes whose front matter names none. */
    finder?: EntityFinder;
    /** Pages to rewrite from their latest notes even without new ones (`cli.ts rewrite`). */
    rewrite?: string[];
    /** Write the overview even when no page changed (after seeding). */
    forceOverview?: boolean;
  },
): Promise<JobResult> {
  const started = new Date().toISOString();
  const runId = `${started.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const state = await readState(opts.outDir);
  const done = new Set(state.consolidated);
  // One page per person and org first, so new notes land on the page that stays.
  const dedup = await dedupe(wiki).catch((err: Error) => ({ error: err.message }));
  const merged = "merged" in dedup ? dedup.merged : [];
  const freshNotes = wiki.store.ofType("note").filter((n) => typeof n.frontmatter.id === "string" && !done.has(n.frontmatter.id));
  const found = opts.finder ? await findEntities(wiki.store, freshNotes, opts.finder) : null;
  const outcome = await consolidatePages({
    extraRefs: found?.refs,
    store: wiki.store,
    updater,
    done,
    mode: "team",
    maxPages: opts.maxPages,
    rewrite: [...new Set([...merged.map((m) => m.into), ...(opts.rewrite ?? [])])],
    write: async (pages, message) =>
      (
        await wiki.write(async (put) => {
          for (const p of pages) await put(p.path, p.text);
          return { message, result: {} };
        })
      ).commit,
  });
  if (found) {
    outcome.requests += found.requests;
    outcome.usage.input_tokens += found.usage.input_tokens;
    outcome.usage.output_tokens += found.usage.output_tokens;
    outcome.usage.cache_read_tokens += found.usage.cache_read_tokens;
    if (found.requests) outcome.checks.push({ name: "entities", ok: found.failed === 0, detail: `${found.refs.size} of ${found.requests} work notes named pages${found.failed ? `, ${found.failed} failed` : ""}` });
  }
  if ("error" in dedup) outcome.checks.push({ name: "dedup", ok: false, detail: dedup.error.slice(0, 200) });
  else if (dedup.merged.length || dedup.touched) {
    const dropped = [...dedup.relinked.values()].filter((v) => v === null).length;
    outcome.checks.push({
      name: "dedup",
      ok: true,
      detail: `${dedup.merged.map((m) => `${m.from.join(", ")} → ${m.into}`).join("; ") || "no merges"}; ${dedup.touched} pages relinked${dropped ? `, ${dropped} description links dropped` : ""}`.slice(0, 500),
    });
  }
  if (outcome.fresh > 0) {
    await mkdir(opts.outDir, { recursive: true });
    await writeFile(join(opts.outDir, "state.json"), JSON.stringify({ consolidated: [...done] }, null, 2));
  }
  // Decision pages from the decisions the new notes record (successful notes only).
  if (opts.decisions) {
    const today = new Date().toISOString().slice(0, 10);
    let n = Math.max(0, ...wiki.store.ofType("decision").map((d) => Number(/^decisions\/(\d+)/.exec(d.ref)?.[1] ?? 0)));
    const pages: { path: string; text: string }[] = [];
    for (const note of freshNotes) {
      if (!done.has(String(note.frontmatter.id))) continue;
      const input = decisionInput(note, wiki.store);
      if (!input) continue;
      try {
        const { decisions, usage } = await opts.decisions.file(input);
        outcome.requests++;
        outcome.usage.input_tokens += usage.input_tokens;
        outcome.usage.output_tokens += usage.output_tokens;
        outcome.usage.cache_read_tokens += usage.cache_read_tokens;
        pages.push(...decisionPages(decisions, note, wiki.store, today, () => ++n));
      } catch (err) {
        outcome.checks.push({ name: `decisions:${note.ref}`, ok: false, detail: (err as Error).message.slice(0, 200) });
      }
    }
    if (pages.length) {
      const out = await wiki.write(async (put) => {
        for (const p of pages) await put(p.path, p.text);
        return { message: `decisions: ${pages.length} pages from ${freshNotes.length} notes`, result: {} };
      });
      if (out.commit) outcome.commit = out.commit;
    }
  }
  // The overview page, after new notes (or when there is none yet but there are pages).
  if (opts.overview && (opts.forceOverview || outcome.pagesUpdated > 0 || merged.length > 0 || (outcome.fresh > 0 && outcome.failedNotes.size === 0) || (!wiki.store.getByRef("overview") && wiki.store.size > 0))) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { overview, usage } = await opts.overview.write(overviewInput(wiki.store, { kind: "team", title: `${wiki.teamName} brain`, today }));
      outcome.requests++;
      outcome.usage.input_tokens += usage.input_tokens;
      outcome.usage.output_tokens += usage.output_tokens;
      outcome.usage.cache_read_tokens += usage.cache_read_tokens;
      const text = renderOverview(overview, wiki.store, { today, title: "Overview" });
      const out = await wiki.write(async (put) => {
        await put("overview.md", text);
        return { message: "overview: rewritten", result: {} };
      });
      if (out.commit) outcome.commit = out.commit;
    } catch (err) {
      outcome.checks.push({ name: "overview", ok: false, detail: (err as Error).message.slice(0, 200) });
    }
  }
  // Lint after the run; every report is kept so findings can be compared over time.
  const lint = wiki.store.lint();
  await mkdir(join(opts.outDir, "lint"), { recursive: true });
  await writeFile(join(opts.outDir, "lint", `${runId}.json`), JSON.stringify(lint, null, 2));
  outcome.checks.push({ name: "lint", ok: lint.counts.broken_link === 0, detail: JSON.stringify(lint.counts) });
  const result = jobResult(outcome, updater.model, { runId, version: opts.version, started });
  await mkdir(join(opts.outDir, "consolidate"), { recursive: true });
  await writeFile(join(opts.outDir, "consolidate", `${runId}.json`), JSON.stringify(result, null, 2));
  return result;
}
