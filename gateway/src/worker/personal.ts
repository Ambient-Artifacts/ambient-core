// The personal worker: Claude upkeep for personal wikis, on the core VM (it needs the
// master key to decrypt). For each user with upkeep on, new pages, and no phone write
// for a while: rewrite the head of every living page the new notes touch, refresh the
// overview page, lint, and record the run. The phone pulls the server's writes on its
// next sync (see PersonalStore.sync).
import { randomUUID } from "node:crypto";
import type { JobResult } from "@brain/spec";
import { consolidatePages, jobResult, normalizeUpdate, overviewInput, renderOverview, type ConsolidateOutcome, type OverviewWriter, type PageUpdater } from "@brain/team";
import { WikiStore } from "@brain/wiki";
import { api, type Control } from "../control.ts";
import { composeMe, ME_PATH, ME_REF } from "../me.ts";
import type { PersonalStore } from "../personal.ts";
import { lastOk, type UpkeepComputer, type WaitingResult } from "../upkeep.ts";

/** One person's writers: their page updater and overview writer. */
export interface Writers {
  updater: PageUpdater;
  overview: OverviewWriter | null;
}

export interface WorkerDeps {
  control: Control;
  personal: PersonalStore;
  /** The same writers for everyone (an API key: self-hosting, tests). */
  updater?: PageUpdater;
  overview?: OverviewWriter | null;
  /**
   * Upkeep on each person's own computer (upkeep.ts): where it runs, and their writers there.
   * Without a connected computer their notes wait.
   */
  computers?: {
    computerFor(uid: string): Promise<UpkeepComputer | null>;
    writers(uid: string): Writers;
  };
  version: string;
  /** Wait this long after the phone's last write, so a sync burst is processed once. */
  quietMs?: number;
  maxUsers?: number;
}

export interface UserRun {
  uid: string;
  status: JobResult["status"] | "waiting";
  notes: number;
  pagesUpdated: number;
  overview: boolean;
  lint: Record<string, number>;
  costUsd: number;
  error: string | null;
}

export async function runPersonalWorker(d: WorkerDeps, now = Date.now()): Promise<UserRun[]> {
  // People whose notes wait for a computer stay due (their next run is when it connects), and a
  // wait costs a query, so they don't count towards the runs per pass.
  const max = d.maxUsers ?? 50;
  const due = await d.control.q(api.work.due, { now, quietMs: d.quietMs ?? 10 * 60_000, limit: d.computers ? Math.max(max, 1000) : max });
  const runs: UserRun[] = [];
  for (const u of due) {
    if (runs.filter((r) => r.status !== "waiting").length >= max) break;
    try {
      let writers: Writers | null = d.updater ? { updater: d.updater, overview: d.overview ?? null } : null;
      if (d.computers) {
        const c = await d.computers.computerFor(u.uid);
        if (!c?.connected) {
          runs.push(await wait(d, u, c, now));
          continue;
        }
        writers = d.computers.writers(u.uid);
      }
      if (!writers) throw new Error("no model for upkeep: neither a computer nor a key");
      runs.push(await runUser(d, writers, u.uid, now));
    } catch (err) {
      // One user's failure must not stop the others; the health check sees the status.
      const error = (err as Error).message.slice(0, 300);
      await d.control.m(api.work.save, { uid: u.uid as never, done: (await d.control.q(api.work.get, { uid: u.uid as never }))?.done ?? [], lastSeq: 0, status: "failed", result: JSON.stringify({ error }), now });
      runs.push({ uid: u.uid, status: "failed", notes: 0, pagesUpdated: 0, overview: false, lint: {}, costUsd: 0, error });
    }
  }
  return runs;
}

async function runUser(d: WorkerDeps, w: Writers, uid: string, now: number): Promise<UserRun> {
  const started = new Date(now).toISOString();
  const today = started.slice(0, 10);
  const state = await d.control.q(api.work.get, { uid: uid as never });
  const done = new Set(state?.done ?? []);

  const store = new WikiStore("personal");
  for (const p of (await d.personal.pages(uid)).pages) if (p.path.startsWith("wiki/")) store.upsert(p.path, p.content);

  const outcome = await consolidatePages({
    store,
    updater: w.updater,
    done,
    mode: "personal",
    write: async (pages) => {
      await d.personal.serverWrite(uid, pages.map((p) => ({ path: p.path, content: p.text })));
      for (const p of pages) store.upsert(p.path, p.text);
      return null;
    },
  });

  await updateMe(w, d, uid, store, outcome, today);

  let overview = false;
  const wantsOverview = outcome.pagesUpdated > 0 || (outcome.fresh > 0 && outcome.failedNotes.size === 0) || !store.getByRef("overview");
  if (w.overview && wantsOverview && store.ofType("note").length > 0) {
    try {
      const { overview: raw, usage } = await w.overview.write(overviewInput(store, { kind: "personal", title: "Your brain", today }));
      outcome.requests++;
      outcome.usage.input_tokens += usage.input_tokens;
      outcome.usage.output_tokens += usage.output_tokens;
      outcome.usage.cache_read_tokens += usage.cache_read_tokens;
      const text = renderOverview(raw, store, { today, title: "Overview" });
      await d.personal.serverWrite(uid, [{ path: "wiki/overview.md", content: text }]);
      store.upsert("wiki/overview.md", text);
      overview = true;
    } catch (err) {
      outcome.checks.push({ name: "overview", ok: false, detail: (err as Error).message.slice(0, 200) });
    }
  }

  const lint = store.lint({ today });
  outcome.checks.push({ name: "lint", ok: lint.counts.broken_link === 0, detail: JSON.stringify(lint.counts) });
  const result = jobResult(outcome, w.updater.model, { runId: `${started.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`, version: d.version, started });
  // The seq after our own writes, so they don't make the user due again.
  const lastSeq = await d.control.q(api.personal.seq, { uid: uid as never });
  await d.control.m(api.work.save, { uid: uid as never, done: [...done], lastSeq, status: result.status, result: JSON.stringify(result), lint: lint.counts, now });
  return {
    uid,
    status: result.status,
    notes: outcome.fresh,
    pagesUpdated: outcome.pagesUpdated,
    overview,
    lint: lint.counts,
    costUsd: result.llm?.cost_usd ?? 0,
    error: result.error,
  };
}

/**
 * The owner's own page, rewritten from what they wrote about themselves and their latest notes:
 * when they changed what they wrote, or once a day when there were new notes.
 */
async function updateMe(w: Writers, d: WorkerDeps, uid: string, store: WikiStore, outcome: ConsolidateOutcome, today: string): Promise<void> {
  const me = store.getByRef(ME_REF);
  if (!me) return;
  const pending = Number(me.frontmatter.pending_rewrite ?? 0) > 0;
  if (!pending && !(outcome.fresh > 0 && me.updated.slice(0, 10) < today)) return;
  const notes = store.ofType("note").slice(-8);
  const about = typeof me.frontmatter.about === "string" ? me.frontmatter.about : "";
  try {
    outcome.requests++;
    const { update, usage } = await w.updater.update({
      ref: ME_REF,
      type: "person",
      self: true,
      existing: { title: me.title, summary: me.summary, aliases: [], currentTruth: me.body.replace(/^\s*# .+\n*/, "").split(/\n## /)[0]!.trim(), openQuestions: [], timelineTail: [] },
      evidence: [
        ...(about ? [{ note: ME_REF, date: today, title: "In their own words", summary: "How they describe themselves.", body: about }] : []),
        ...notes.map((n) => ({ note: n.ref, date: n.sortDate.slice(0, 10), title: n.title, summary: n.summary, body: n.body.slice(0, 2000), role: "recorder" as const })),
      ],
    });
    outcome.usage.input_tokens += usage.input_tokens;
    outcome.usage.output_tokens += usage.output_tokens;
    outcome.usage.cache_read_tokens += usage.cache_read_tokens;
    const text = composeMe(me, normalizeUpdate(update, "person", true), notes.length ? String(notes[notes.length - 1]!.frontmatter.id ?? "") || null : null, today);
    await d.personal.serverWrite(uid, [{ path: ME_PATH, content: text }]);
    store.upsert(ME_PATH, text);
  } catch (err) {
    outcome.checks.push({ name: "page:me", ok: false, detail: (err as Error).message.slice(0, 200) });
  }
}

/**
 * No connected computer: the person's notes wait. It's recorded once per change (new notes, or
 * the computer coming or going), with how many notes wait, so the app can say so; the next run
 * with the computer connected catches up.
 */
async function wait(d: WorkerDeps, u: { uid: string; seq: number }, c: UpkeepComputer | null, now: number): Promise<UserRun> {
  const reason = c ? "offline" : "no_computer";
  const prev = await d.control.q(api.work.get, { uid: u.uid as never });
  const run: UserRun = { uid: u.uid, status: "waiting", notes: 0, pagesUpdated: 0, overview: false, lint: {}, costUsd: 0, error: null };
  if (prev?.lastStatus === "waiting") {
    const was = JSON.parse(prev.lastResult ?? "{}") as Partial<WaitingResult>;
    if (was.seq === u.seq && was.waiting === reason && (was.computer ?? null) === (c?.name ?? null)) return { ...run, notes: was.pending ?? 0 };
  }
  const done = new Set(prev?.done ?? []);
  const store = new WikiStore("personal");
  for (const p of (await d.personal.pages(u.uid)).pages) if (p.path.startsWith("wiki/")) store.upsert(p.path, p.content);
  const pending = store.ofType("note").filter((n) => typeof n.frontmatter.id === "string" && !done.has(n.frontmatter.id)).length;
  const result: WaitingResult = { waiting: reason, computer: c?.name ?? null, pending, seq: u.seq, lastOkAt: lastOk(prev) };
  await d.control.m(api.work.save, { uid: u.uid as never, done: [...done], lastSeq: prev?.lastSeq ?? 0, status: "waiting", result: JSON.stringify(result), now });
  return { ...run, notes: pending };
}
