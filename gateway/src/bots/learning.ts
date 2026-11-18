// How bots learn (docs/bots.md, "How bots learn"). Built into every bot, always on; nothing to
// switch on or find.
//
//   signals: a run failed, its owner corrected it, it asked the same twice; on GitHub its pull
//   request was merged as it left it, edited by a person first, closed, reverted, changes were
//   requested, a person pushed to its branch; a reviewer's comment led to a change, or didn't
//            ──▶ kept per bot (records), the scorecard is worked out from them
//   a few minutes after the negative ones ──▶ Amb looks at what went wrong and improves the bot:
//            memory.md and skills by itself ("learn": auto) or as a proposal ("ask"); AGENTS.md,
//            GOAL.md and settings always as a proposal the person applies
//   Monday mornings ──▶ a short retro in the bot's thread with its scorecard; a lesson after
//            which the scorecard got worse is proposed for undoing
//
// Code decides when and measures; Amb decides what the lesson is. Only people from the team
// count (GitHub's author_association), never bot accounts.
import { randomBytes } from "node:crypto";
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import type { Actor } from "../routines/service.ts";
import type { AmbientChat } from "./ambient.ts";
import type { DecisionService } from "./decisions.ts";
import type { BotFiles } from "./files.ts";
import { AGENTS, GOAL, MEMORY, type BotFolder } from "./folder.ts";
import type { GitHubSignal } from "./github.ts";
import { NOTHING } from "./heartbeat.ts";

export const LEARN = ["auto", "ask"] as const;
export type Learn = (typeof LEARN)[number];

export type SignalKind = GitHubSignal["kind"] | "run_failed" | "corrected" | "asked_twice";

export interface Signal {
  at: number;
  kind: SignalKind;
  text: string;
  /** A link or a reference (PR #41, a run). */
  source?: string;
  /** Hours from opening to ready (kind "ready"). */
  hours?: number;
  /** How many (a reviewer's comments on one PR). */
  count?: number;
}

/** What went wrong: these start Amb's look at the bot; the others are only counted. */
const NEGATIVE = new Set<SignalKind>(["run_failed", "corrected", "asked_twice", "closed_unmerged", "merged_edited", "changes_requested", "human_push", "reverted", "review_false_alarm"]);

export interface Scorecard {
  days: number;
  /** Its pull requests that were merged or closed. */
  prs: number;
  merged: number;
  closedUnmerged: number;
  /** Merged ÷ (merged + closed without merging); null without any. */
  mergeRate: number | null;
  /** Merged only after a person pushed changes to it. */
  humanEdits: number;
  humanEditRate: number | null;
  medianHoursToReady: number | null;
  reverts: number;
  changesRequested: number;
  runsFailed: number;
  corrections: number;
  /** A reviewer's comments: followed by a change, or a false alarm. */
  review: { useful: number; falseAlarms: number; precision: number | null };
}

export interface Lesson {
  text: string;
  source: string | null;
  date: string | null;
}

const PREFS = "bot-prefs";
const SIGNAL = "bot-signal";
const STATE = "bot-learning";
const SIGNALS_KEPT = 200;
const REVIEW_AFTER_MS = 10 * 60_000;
const TURN_MS = 6 * 60_000;
const DAY = 24 * 3600_000;
const ZONE = "Europe/Vienna";
const RETRO_HOUR = 8;

const ownerArgs = (owner: Owner) => (owner.kind === "user" ? { ownerKind: "user" as const, ownerId: owner.uid } : { ownerKind: "team" as const, ownerId: owner.teamId });

/** The scorecard over [from, to). */
export function scorecard(signals: Signal[], from: number, to: number): Scorecard {
  const inside = signals.filter((s) => s.at >= from && s.at < to);
  const n = (k: SignalKind) => inside.filter((s) => s.kind === k).reduce((a, s) => a + (s.count ?? 1), 0);
  const merged = n("merged") + n("merged_edited");
  const closed = n("closed_unmerged");
  const ready = inside
    .filter((s) => s.kind === "ready" && typeof s.hours === "number")
    .map((s) => s.hours!)
    .sort((a, b) => a - b);
  const median = ready.length ? (ready.length % 2 ? ready[(ready.length - 1) / 2]! : (ready[ready.length / 2 - 1]! + ready[ready.length / 2]!) / 2) : null;
  const useful = n("review_useful");
  const falseAlarms = n("review_false_alarm");
  return {
    days: Math.round((to - from) / DAY),
    prs: merged + closed,
    merged,
    closedUnmerged: closed,
    mergeRate: merged + closed ? merged / (merged + closed) : null,
    humanEdits: n("merged_edited"),
    humanEditRate: merged ? n("merged_edited") / merged : null,
    medianHoursToReady: median === null ? null : Math.round(median * 10) / 10,
    reverts: n("reverted"),
    changesRequested: n("changes_requested"),
    runsFailed: n("run_failed"),
    corrections: n("corrected"),
    review: { useful, falseAlarms, precision: useful + falseAlarms ? useful / (useful + falseAlarms) : null },
  };
}

/** Whether things got worse after a lesson: fewer merges, more edits by people, or reverts. */
export function worse(before: Scorecard, after: Scorecard): boolean {
  if (after.reverts > before.reverts) return true;
  if (before.prs >= 2 && after.prs >= 2) {
    if (before.mergeRate !== null && after.mergeRate !== null && after.mergeRate <= before.mergeRate - 0.2) return true;
    if (before.humanEditRate !== null && after.humanEditRate !== null && after.humanEditRate >= before.humanEditRate + 0.2) return true;
  }
  const b = before.review;
  const a = after.review;
  return b.useful + b.falseAlarms >= 3 && a.useful + a.falseAlarms >= 3 && b.precision !== null && a.precision !== null && a.precision <= b.precision - 0.2;
}

/** A memory.md's lessons: lines like "- PR #41 (2026-11-18): migrations go in their own PR." */
export function lessonsOf(memory: string): Lesson[] {
  const out: Lesson[] = [];
  for (const raw of memory.split("\n")) {
    const line = raw.trim();
    if (!/^[-*] /.test(line)) continue;
    const body = line.slice(2).trim();
    const m = /^(.+?) \((\d{4}-\d{2}-\d{2})\):\s*(.+)$/.exec(body);
    out.push(m ? { source: m[1]!, date: m[2]!, text: m[3]! } : { source: null, date: null, text: body });
  }
  return out;
}

function scoreLine(c: Scorecard): string {
  const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
  const parts = [
    c.prs ? `${c.merged} of ${c.prs} pull requests merged (${pct(c.mergeRate)}), ${c.humanEdits} after a person's edits` : "",
    c.medianHoursToReady !== null ? `ready after ${c.medianHoursToReady} h (median)` : "",
    c.reverts ? `${c.reverts} reverted` : "",
    c.changesRequested ? `${c.changesRequested} times changes requested` : "",
    c.review.useful + c.review.falseAlarms ? `review comments: ${c.review.useful} led to a change, ${c.review.falseAlarms} didn't (${pct(c.review.precision)})` : "",
    c.runsFailed ? `${c.runsFailed} failed runs` : "",
    c.corrections ? `${c.corrections} corrections` : "",
  ].filter(Boolean);
  return parts.join("; ") || "nothing measured";
}

function localParts(ts: number): { hour: number; weekday: string; day: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), weekday: String(p.weekday).toLowerCase().slice(0, 3), day: `${p.year}-${p.month}-${p.day}` };
}

interface State {
  lastReviewAt: number | null;
  /** The Monday (Vienna date) of the last retro. */
  retro: string | null;
  /** memory.md versions already checked for undoing. */
  checked: number[];
}

export class BotLearning {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  /** Bots whose look is scheduled (one per bot at a time). */
  private pending = new Map<string, NodeJS.Timeout>();
  private running = new Set<Promise<unknown>>();
  /** Bots Amb is improving right now: what it may write there (docs/bots.md, "How bots learn"). */
  private reviewing = new Map<string, Learn>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      folder: BotFolder;
      files: BotFiles;
      ambient: AmbientChat;
      decisions: DecisionService;
      actorFor: (uid: string) => Promise<Actor>;
      /** The owners whose bots get a retro: people with bots, and teams with bots (their ids). */
      owners?: () => Promise<Owner[]>;
      now?: () => number;
      /** Tests: how long after a signal Amb looks, and how long it may take. */
      reviewAfterMs?: number;
      turnMs?: number;
    },
  ) {
    // While Amb improves a bot on its own: AGENTS.md and GOAL.md only as a proposal; with "ask",
    // every file only as a proposal.
    d.files.guard = (_actor, id, path, by) => {
      const mode = by.kind === "amb" ? this.reviewing.get(id) : undefined;
      if (!mode) return null;
      if (path === AGENTS || path === GOAL) return `While improving a bot on its own, Ambient doesn't change its ${path}: propose the change with propose_bot_change, and the user applies it.`;
      if (mode === "ask") return "This bot's owner wants to see each improvement first: propose it with propose_bot_change (the whole new file), don't write it.";
      return null;
    };
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  // ---- records ----

  private async read<T>(owner: Owner, kind: string, key: string): Promise<T | null> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind, key })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    return this.open<T>(owner, kind, r);
  }

  private async open<T>(owner: Owner, kind: string, r: { iv: string; ct: string }): Promise<T | null> {
    const raw = await this.d.keys.open(owner, `record:${kind}`, r.iv, r.ct).catch(() => null);
    if (raw === null) return null;
    try {
      return JSON.parse((JSON.parse(raw) as { c: string }).c) as T;
    } catch {
      return null;
    }
  }

  private async write(owner: Owner, kind: string, key: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value);
    const sealed = await this.d.keys.seal(owner, `record:${kind}`, JSON.stringify({ c: content }));
    await this.d.control.m(api.records.put, { ...ownerArgs(owner), kind, key, iv: sealed.iv, ct: sealed.ciphertext, size: Buffer.byteLength(content), byKind: "user", keep: 1, now: this.now() });
  }

  // ---- the bot's preference ----

  async learnOf(owner: Owner, routineId: string): Promise<Learn> {
    return (await this.read<{ learn: Learn }>(owner, PREFS, routineId))?.learn ?? "auto";
  }

  async setLearn(owner: Owner, routineId: string, learn: Learn): Promise<Learn> {
    await this.write(owner, PREFS, routineId, { learn });
    return learn;
  }

  // ---- signals ----

  async signals(owner: Owner, routineId: string): Promise<Signal[]> {
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: SIGNAL, prefix: `${routineId}/` })) as { iv: string; ct: string }[];
    const out: Signal[] = [];
    for (const r of rows) {
      const s = await this.open<Signal>(owner, SIGNAL, r);
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Something the bot can learn from. Kept, and a negative one has Amb look at it soon. Never throws. */
  async signal(owner: Owner, routineId: string, s: Omit<Signal, "at">): Promise<void> {
    try {
      const at = this.now();
      await this.write(owner, SIGNAL, `${routineId}/${String(at).padStart(15, "0")}-${randomBytes(3).toString("hex")}`, { ...s, at, text: s.text.slice(0, 600) });
      await this.d.control.m(api.records.prune, { ...ownerArgs(owner), kind: SIGNAL, prefix: `${routineId}/`, keep: SIGNALS_KEPT });
      if (NEGATIVE.has(s.kind)) this.scheduleReview(owner, routineId);
    } catch (err) {
      console.warn(`[learning] a signal wasn't kept: ${(err as Error).message}`);
    }
  }

  private scheduleReview(owner: Owner, routineId: string) {
    if (this.pending.has(routineId)) return;
    const t = setTimeout(() => {
      this.pending.delete(routineId);
      const done = this.review(owner, routineId).catch((err: Error) => console.warn(`[learning] ${err.message}`));
      this.running.add(done);
      void done.finally(() => this.running.delete(done));
    }, this.d.reviewAfterMs ?? REVIEW_AFTER_MS);
    t.unref();
    this.pending.set(routineId, t);
  }

  /** Tests: every scheduled look now, then wait for them. */
  async idle(): Promise<void> {
    for (const [routineId, t] of [...this.pending]) {
      clearTimeout(t);
      this.pending.delete(routineId);
      const owner = await this.ownerOf(routineId);
      if (owner) await this.review(owner.owner, routineId).catch(() => undefined);
    }
    await Promise.all([...this.running]);
  }

  private async ownerOf(routineId: string): Promise<{ owner: Owner; uid: string; name: string } | null> {
    const r = (await this.d.control.q(api.bots.routineOwner, { id: routineId })) as { teamId: string | null; createdBy: string } | null;
    if (!r) return null;
    const owner: Owner = r.teamId ? { kind: "team", teamId: String(r.teamId) } : { kind: "user", uid: String(r.createdBy) };
    const bots = (await this.d.control.q(api.bots.ownerBots, ownerArgs(owner))) as { bots: { id: string; name: string }[] } | null;
    const name = bots?.bots.find((b) => String(b.id) === routineId)?.name ?? "the bot";
    return { owner, uid: String(r.createdBy), name };
  }

  private async state(owner: Owner, routineId: string): Promise<State> {
    return (await this.read<State>(owner, STATE, routineId)) ?? { lastReviewAt: null, retro: null, checked: [] };
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("took too long")), ms);
      t.unref();
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(t);
          reject(e as Error);
        },
      );
    });
  }

  /** Amb looks at what went wrong since its last look, and improves the bot (auto) or proposes (ask). */
  async review(owner: Owner, routineId: string): Promise<string> {
    const who = await this.ownerOf(routineId);
    if (!who) return "";
    const st = await this.state(owner, routineId);
    const since = st.lastReviewAt ?? 0;
    const fresh = (await this.signals(owner, routineId)).filter((s) => s.at > since && NEGATIVE.has(s.kind));
    if (!fresh.length) return "";
    await this.write(owner, STATE, routineId, { ...st, lastReviewAt: this.now() });
    const learn = await this.learnOf(owner, routineId);
    const name = await this.d.ambient.nameOf(who.uid);
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const prompt = [
      `[Not a message from ${name}: improving the bot "${who.name}" (id ${routineId}), which learns from what happens to its work.]`,
      `What happened since you last looked:\n${fresh.map((s) => `- ${new Date(s.at).toISOString().slice(0, 10)} ${s.kind.replace(/_/g, " ")}: ${s.text}${s.source ? ` (${s.source})` : ""}`).join("\n")}`,
      "Find out what went wrong: bot_files (its files and last runs), bot_thread, read_bot_file, search_history, and on GitHub what was changed or said. Ignore bad luck (a network error, a full disk).",
      learn === "auto"
        ? "If it should do better next time, improve it yourself: a lesson in its memory.md, or a skill for something it does repeatedly (write_bot_file, the whole file, with a short why)."
        : "Its owner wants to see each improvement first: propose every change with propose_bot_change (memory.md and skills too, the whole new file), don't write files.",
      `Write each lesson in memory.md as one line: "- <source> (${today}): <the lesson>", e.g. "- PR #41 (${today}): migrations go in their own pull request." Merge it with a lesson that says the same, and drop lessons that are no longer true; keep the file short.`,
      "Changes to its AGENTS.md, its GOAL.md or its settings (schedule, secrets, isolation, model, runtime, what it publishes, deletes or sends) you only propose, with propose_bot_change.",
      `Reply with one sentence on what you changed or proposed, or ${NOTHING}.`,
    ].join("\n\n");
    this.reviewing.set(routineId, learn);
    try {
      return (await this.withTimeout(this.d.ambient.internalTurn(who.uid, name, prompt), this.d.turnMs ?? TURN_MS)).trim();
    } finally {
      this.reviewing.delete(routineId);
    }
  }

  // ---- what the app shows ----

  async view(owner: Owner, routineId: string): Promise<{
    learn: Learn;
    lessons: Lesson[];
    scorecard: { week: Scorecard; month: Scorecard };
    signals: Signal[];
    changes: { path: string; version: number; by: { kind: string; name: string | null }; why: string | null; at: number }[];
  }> {
    const now = this.now();
    const [learn, signals, memory, files] = await Promise.all([this.learnOf(owner, routineId), this.signals(owner, routineId), this.d.folder.memory(owner, routineId), this.d.folder.skills(owner, routineId)]);
    const paths = [MEMORY, ...files.map((f) => `skills/${f.path}`)];
    const changes: { path: string; version: number; by: { kind: string; name: string | null }; why: string | null; at: number }[] = [];
    for (const path of paths) {
      for (const v of await this.d.folder.history(owner, routineId, path).catch(() => [])) {
        if (v.by.kind !== "user") changes.push({ path, version: v.version, by: v.by, why: v.why, at: v.updatedAt });
      }
    }
    return {
      learn,
      lessons: lessonsOf(memory),
      scorecard: { week: scorecard(signals, now - 7 * DAY, now + 1), month: scorecard(signals, now - 28 * DAY, now + 1) },
      signals: signals.slice(-20).reverse(),
      changes: changes.sort((a, b) => b.at - a.at).slice(0, 10),
    };
  }

  // ---- Monday mornings: the retro, and undoing a lesson that made things worse ----

  start(): void {
    if (this.timer || !this.d.owners) return;
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.busy || !this.d.owners) return;
    const { hour, weekday } = localParts(this.now());
    if (weekday !== "mon" || hour !== RETRO_HOUR) return;
    this.busy = true;
    try {
      for (const owner of await this.d.owners()) {
        const out = (await this.d.control.q(api.bots.ownerBots, ownerArgs(owner))) as { bots: { id: string }[] } | null;
        for (const b of out?.bots ?? []) await this.retro(owner, String(b.id)).catch((err: Error) => console.warn(`[learning] retro: ${err.message}`));
      }
    } finally {
      this.busy = false;
    }
  }

  /** One bot's week: a few lines in its thread with its scorecard, once a week (`force`: tests). */
  async retro(owner: Owner, routineId: string, opts: { force?: boolean } = {}): Promise<"sent" | "quiet" | "skipped"> {
    const now = this.now();
    const { day } = localParts(now);
    const st = await this.state(owner, routineId);
    if (!opts.force && st.retro === day) return "skipped";
    await this.write(owner, STATE, routineId, { ...st, retro: day });
    const who = await this.ownerOf(routineId);
    if (!who) return "skipped";
    const signals = await this.signals(owner, routineId);
    await this.checkUndo(owner, routineId, who, signals, st);
    const week = signals.filter((s) => s.at >= now - 7 * DAY);
    if (!week.length) return "quiet";
    const card = scorecard(signals, now - 7 * DAY, now + 1);
    const lessons = (await this.d.folder.history(owner, routineId, MEMORY).catch(() => [])).filter((v) => v.by.kind !== "user" && v.updatedAt >= now - 7 * DAY);
    const name = await this.d.ambient.nameOf(who.uid);
    const prompt = [
      `[Not a message from ${name}: the weekly retro for the bot "${who.name}" (id ${routineId}), for its thread.]`,
      `Its week: ${scoreLine(card)}.`,
      `What happened:\n${week.map((s) => `- ${s.kind.replace(/_/g, " ")}: ${s.text}`).join("\n")}`,
      lessons.length ? `Its memory changed ${lessons.length} time(s) this week: ${lessons.map((l) => l.why ?? "").filter(Boolean).join("; ")}` : "Its memory didn't change this week.",
      `Write three to five short lines for its thread: what it did, what it learned, what still goes wrong and what you'd change. Plain words, no headings. If nothing worth saying happened, reply ${NOTHING}.`,
    ].join("\n\n");
    const reply = (await this.withTimeout(this.d.ambient.internalTurn(who.uid, name, prompt), this.d.turnMs ?? TURN_MS).catch(() => "")).trim();
    if (!reply || reply.replace(/[.\s]/g, "").toUpperCase() === NOTHING) return "quiet";
    await this.d.files.note(await this.d.actorFor(who.uid), routineId, `This week: ${reply}\n\n(${scoreLine(card)})`);
    return "sent";
  }

  /**
   * A lesson (a memory.md version by Amb or the bot) two to four weeks old, after which the
   * scorecard got worse than in the two weeks before it: proposed for undoing, once.
   */
  private async checkUndo(owner: Owner, routineId: string, who: { uid: string; name: string }, signals: Signal[], st: State) {
    const now = this.now();
    const versions = await this.d.folder.history(owner, routineId, MEMORY).catch(() => []);
    const lesson = versions.find((v) => v.by.kind !== "user" && v.updatedAt <= now - 14 * DAY && v.updatedAt >= now - 28 * DAY && !st.checked.includes(v.version));
    if (!lesson) return;
    await this.write(owner, STATE, routineId, { ...(await this.state(owner, routineId)), checked: [...st.checked, lesson.version].slice(-50) });
    const before = scorecard(signals, lesson.updatedAt - 14 * DAY, lesson.updatedAt);
    const after = scorecard(signals, lesson.updatedAt, lesson.updatedAt + 14 * DAY);
    if (!worse(before, after)) return;
    const previous = versions.find((v) => v.version < lesson.version && !v.deleted);
    if (!previous) return;
    const content = await this.d.folder.versionText(owner, routineId, MEMORY, previous.version);
    await this.d.decisions.propose(who.uid, {
      routineId,
      bot: who.name,
      path: MEMORY,
      content,
      why: `Since it learned “${lesson.why ?? "a lesson"}” (${new Date(lesson.updatedAt).toISOString().slice(0, 10)}), it does worse: before ${scoreLine(before)}; after ${scoreLine(after)}. Undo it?`,
    });
  }
}
