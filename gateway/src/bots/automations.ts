// Automations (docs/bots.md, "Automations"): things Amb does for a person without being asked
// each time. One automation = when (a time, or an event) + what (instructions) + where (the chat,
// with or without a push, or a bot's thread), and Amb stays silent (NOTHING) when there's no news.
//
//   a ticker (every minute) ──▶ time automations that are due (once per due time, state in records)
//   events (a bot failed, its owner corrected it, it asked the same twice, a meeting note landed,
//   a decision waits) ──▶ the automations listening for them
//                     ──▶ an internal Amb turn (its own short session) ──▶ delivered, or nothing
//
// Code decides when; Amb decides what to say. Automations are only for the person: watching
// their bots is part of Amb (the heartbeat, "notify" in Amb's settings), and every bot learns on
// its own (learning.ts); neither is an automation to find and switch on. Proposed changes to a
// bot are decisions the person applies (decisions.ts). Stored as sealed records: no table.
import { randomBytes } from "node:crypto";
import { RoutineSchedule, describeSchedule, nextRun } from "@brain/spec";
import { z } from "zod";
import { api, type Control } from "../control.ts";
import type { Notifier } from "../push.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { RoutineError, type Actor, type RoutineService } from "../routines/service.ts";
import type { AmbientChat } from "./ambient.ts";
import type { DecisionService, ProposedChange } from "./decisions.ts";
import type { BotFiles } from "./files.ts";
import type { Author } from "./folder.ts";
import { NOTHING } from "./heartbeat.ts";
import { openMessage } from "./messages.ts";

// ---- what an automation is ----

export const EVENT_KINDS = ["bot_failed", "bot_corrected", "bot_asked_twice", "decision_waiting", "meeting_note", "github_ci_failed"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
/** "bot": the instructions go to one bot as a message, which starts it (no turn of Amb's). */
export const DELIVERIES = ["chat", "chat_silent", "thread", "bot"] as const;
export type Delivery = (typeof DELIVERIES)[number];

export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time"), schedule: RoutineSchedule.refine((s) => s.every !== "needed", { message: "a time automation needs a time" }) }),
  z.object({
    kind: z.literal("event"),
    events: z.array(z.enum(EVENT_KINDS)).min(1).max(EVENT_KINDS.length),
    /** decision_waiting: after how many hours. */
    hours: z.number().int().min(1).max(168).optional(),
    /** Only this bot's events (its id); null or absent: all of the person's bots. */
    bot: z.string().max(64).nullable().optional(),
  }),
]);
export type Trigger = z.infer<typeof Trigger>;

export interface Automation {
  id: string;
  /** The template it came from, or null for one written from scratch. */
  template: string | null;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  instructions: string;
  delivery: Delivery;
  /** The bot a "bot" automation starts (its id). */
  bot?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  at: number;
  by: "schedule" | "event" | "manual";
  /** What started it (an event in a few words), or null. */
  event: string | null;
  result: "sent" | "silent" | "failed";
  text: string;
}

export interface AutomationView extends Automation {
  /** In words: "Weekdays at 08:00", "When a bot fails or is corrected", … */
  when: string;
  nextRunAt: number | null;
  lastRun: AutomationRun | null;
}

interface State {
  /** The due time last handled (a time automation runs once per due time). */
  lastDueAt: number | null;
  runs: AutomationRun[];
  /** Event keys already handled (an event runs an automation once). */
  seen: string[];
  /** Event runs per day (a cap, so a noisy bot can't flood the chat). */
  day: string;
  eventRuns: number;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  trigger: Trigger;
  instructions: string;
  delivery: Delivery;
}

const vienna = "Europe/Vienna";

/** What a bot is told on a night it may bring an idea of its own (the "nightly_idea" template). */
export const NIGHTLY_IDEA = [
  "[From Ambient, on your owner's schedule: tonight you may bring one idea of your own.]",
  "Look at what you worked on lately, what your owner asked for, and what you noticed along the way. If one small improvement would clearly help them, and nobody asked for it yet, build a first version of it now: small enough to judge in two minutes, in a draft pull request or a file, never merged or published.",
  'Then hand it to your owner with ask_owner and wait: false. Start the question with "My idea:" and say in one sentence what it is and why it helps; put what you built and how to look at it in the details; offer "Keep going" and "Drop it".',
  "One idea a night at most. No idea worth their two minutes tonight: do nothing and say so in one line. Never repeat an idea they dropped (your memory says which).",
].join("\n");

export const TEMPLATES: Template[] = [
  {
    id: "morning_brief",
    name: "Morning brief",
    description: "Weekday mornings: today's meetings with who's in them, what waits for you, and what your bots did overnight.",
    trigger: { kind: "time", schedule: { every: "weekday", time: "08:00", timezone: vienna } },
    instructions:
      "Write the morning brief. Open with what happened while they were away, when something did (a bot found or fixed something, a decision came in). Then: today's meetings and who's in them (brief each person or project that matters, from the brain), decisions and bots waiting for them (needs_you, list_routines; leave out what they set aside), and what their bots did since yesterday (bot_files handoffs, bot_thread). Five short lines at most, the most important first. NOTHING only when there's truly nothing.",
    delivery: "chat",
  },
  {
    id: "waiting_on_me",
    name: "Waiting on me",
    description: "Weekdays at noon: every open loop that needs you — decisions, bots asking, action items, approvals.",
    trigger: { kind: "time", schedule: { every: "weekday", time: "12:30", timezone: vienna } },
    instructions:
      "List what waits on them, oldest first: decisions (needs_you: only what waits now, not what they set aside), bots that asked and weren't answered (list_routines, bot_thread), their open action items in the brain (list_action_items), root commands waiting for approval. One line each with what you'd suggest. NOTHING when nothing waits.",
    delivery: "chat",
  },
  {
    id: "after_meeting",
    name: "After every meeting",
    description: "When a recorded meeting lands in your brain: the decisions, your action items and a follow-up draft.",
    trigger: { kind: "event", events: ["meeting_note"] },
    instructions:
      "A recorded meeting just landed in their brain (fetch the note). Write: the decisions in it, their own action items with dates, and offer a short follow-up message to the others, drafted in their voice. If it was a memo or nothing came of it, NOTHING.",
    delivery: "chat",
  },
  {
    id: "weekly_review",
    name: "Weekly review",
    description: "Friday afternoon: what moved this week, what's stuck, and three things for next week.",
    trigger: { kind: "time", schedule: { every: "week", days: ["fri"], time: "16:00", timezone: vienna } },
    instructions:
      "Write their weekly review from the brain and their bots: what moved this week (decisions, notes, projects), what's stuck or overdue, what their bots shipped, where each bot got stuck (bot_learning, bot_thread) with the one change that would fix it (a note, a skill, a setting), and three suggestions for next week. Ten short lines at most.",
    delivery: "chat",
  },
  {
    id: "new_in_brain",
    name: "New in the brain",
    description: "Every evening: what was added to your brain and your teams' brains today, in a few lines.",
    trigger: { kind: "time", schedule: { every: "day", time: "18:00", timezone: vienna } },
    instructions: "Go through what was added to their brain and their teams' brains today (list_recent) and tell them in a few lines what's worth knowing, with the page names. NOTHING when nothing new matters.",
    delivery: "chat_silent",
  },
  {
    id: "nightly_idea",
    name: "Nightly idea",
    description: "Once a night, one of your bots builds a small first version of an idea of its own and asks you in the morning whether to keep going.",
    trigger: { kind: "time", schedule: { every: "day", time: "02:00", timezone: vienna } },
    instructions: NIGHTLY_IDEA,
    delivery: "bot",
  },
];

/** Templates that were automations once and are part of Amb and every bot now: ignored if stored. */
const RETIRED = new Set(["watch_bots", "improve_bots"]);

/** What the app and the MCP tools send to create or change one. */
export const AutomationInput = z.object({
  template: z.string().max(40).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  trigger: Trigger.optional(),
  instructions: z.string().trim().min(1).max(4_000).optional(),
  delivery: z.enum(DELIVERIES).optional(),
  /** The bot a "bot" automation starts (its id). */
  bot: z.string().max(64).optional(),
});
export type AutomationInput = z.infer<typeof AutomationInput>;

/** Something that happened that automations may listen for. */
export type AutomationEvent =
  | { kind: "bot_failed"; uid: string; routineId: string; bot: string; text: string; runId: string }
  | { kind: "bot_corrected"; uid: string; routineId: string; bot: string; text: string; messageId: string }
  | { kind: "bot_asked"; uid: string; routineId: string; bot: string; text: string; questionId: string }
  | { kind: "meeting_note"; uid: string; title: string; ref: string; team: string | null }
  | { kind: "github_ci_failed"; uid: string; repo: string; branch: string; url: string; sha: string };

const KIND = "automation";
const STATE = "automation-state";
const MAX = 30;
const RUNS_KEPT = 20;
const SEEN_KEPT = 300;
/** A time automation that was missed (the gateway was down) runs late only this long after. */
const GRACE_MS = 2 * 3600_000;
/** Event runs per automation per day. */
const EVENT_RUNS_A_DAY = 20;
/** No push between 22:00 and 07:00 (the message still lands in the chat). */
const QUIET_FROM = 22;
const QUIET_TO = 7;
/** How long Amb may take for one automation. */
const TURN_MS = 6 * 60_000;

function localHourDay(ts: number, zone: string): { hour: number; day: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}` };
}

/**
 * The due time to handle now: the latest scheduled time at or before `now` that comes after the
 * last one handled (and after the automation was made), within the grace period. Null: not due.
 */
export function dueAt(schedule: RoutineSchedule, now: number, lastDueAt: number | null, createdAt: number): number | null {
  const from = Math.max(lastDueAt ?? createdAt, now - GRACE_MS - 1);
  let next = nextRun(schedule, from);
  if (next === null || next > now) return null;
  // The latest due time not after now (several missed: only the last one runs).
  for (let i = 0; i < 100; i++) {
    const after = nextRun(schedule, next);
    if (after === null || after > now) break;
    next = after;
  }
  return next;
}

export function describeTrigger(t: Trigger): string {
  if (t.kind === "time") return describeSchedule(t.schedule, { withZone: true });
  const words: Record<EventKind, string> = {
    bot_failed: "a bot fails",
    bot_corrected: "you correct a bot",
    bot_asked_twice: "a bot asks the same thing twice",
    decision_waiting: `a decision waits over ${t.hours ?? 4} hours`,
    meeting_note: "a recorded meeting lands in your brain",
    github_ci_failed: "CI fails on the main branch of a repo your bots watch",
  };
  const list = t.events.map((e) => words[e]);
  return `When ${list.length > 1 ? `${list.slice(0, -1).join(", ")} or ${list.at(-1)}` : list[0]}`;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2);

/** Whether two questions ask the same thing (most of their words are the same). */
export function sameQuestion(a: string, b: string): boolean {
  const x = new Set(normalize(a));
  const y = new Set(normalize(b));
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / new Set([...x, ...y]).size >= 0.7;
}

export class Automations {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  /** One person's automations run one at a time. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      routines: RoutineService;
      ambient: AmbientChat;
      files: BotFiles;
      decisions: DecisionService;
      notifier?: Notifier;
      /** Where what Amb says first goes (the person's channel, or the app's push). */
      reach?: import("../channels/reach.ts").AmbReach;
      /** Everyone with bots or a chat with Ambient (Convex `bots.people`). */
      people?: () => Promise<string[]>;
      actorFor: (uid: string) => Promise<Actor>;
      now?: () => number;
      /** Sends a bot a message from Amb, which starts it ("bot" automations). */
      tellBot?: (actor: Actor, routineId: string, text: string) => Promise<unknown>;
      /** Tests: how long Amb may take. */
      turnMs?: number;
    },
  ) {
    d.decisions.applyChange = (actor, change) => this.apply(actor, change);
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private owner(uid: string): Owner {
    return { kind: "user", uid };
  }

  // ---- storage ----

  private async seal(uid: string, kind: string, value: unknown) {
    return this.d.keys.seal(this.owner(uid), `record:${kind}`, JSON.stringify(value));
  }

  private async open<T>(uid: string, kind: string, r: { iv: string; ct: string }): Promise<T | null> {
    const raw = await this.d.keys.open(this.owner(uid), `record:${kind}`, r.iv, r.ct).catch(() => null);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async put(uid: string, kind: string, key: string, value: unknown, opts: { deleted?: boolean; keep: number }) {
    const sealed = await this.seal(uid, kind, value);
    await this.d.control.m(api.records.put, {
      ownerKind: "user",
      ownerId: uid,
      kind,
      key,
      iv: sealed.iv,
      ct: sealed.ciphertext,
      size: sealed.ciphertext.length,
      byKind: "user",
      ...(opts.deleted ? { deleted: true } : {}),
      keep: opts.keep,
      now: this.now(),
    });
  }

  /** The person's automations (ones from retired templates are left out: they're part of Amb now). */
  async all(uid: string): Promise<Automation[]> {
    const rows = (await this.d.control.q(api.records.list, { ownerKind: "user", ownerId: uid, kind: KIND, prefix: "" })) as { key: string; iv: string; ct: string }[];
    const out: Automation[] = [];
    for (const r of rows) {
      const a = await this.open<Automation>(uid, KIND, r);
      if (a && !RETIRED.has(a.id) && !(a.template && RETIRED.has(a.template)) && Trigger.safeParse(a.trigger).success) out.push(a);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** "Watch my bots" switched off back when it was an automation (Amb's settings take it over). */
  async legacyWatchOff(uid: string): Promise<boolean> {
    const r = (await this.d.control.q(api.records.get, { ownerKind: "user", ownerId: uid, kind: KIND, key: "watch_bots" })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return false;
    return (await this.open<Automation>(uid, KIND, r))?.enabled === false;
  }

  private async state(uid: string, id: string): Promise<State> {
    const r = (await this.d.control.q(api.records.get, { ownerKind: "user", ownerId: uid, kind: STATE, key: id })) as { iv: string; ct: string } | null;
    const s = r ? await this.open<State>(uid, STATE, r) : null;
    return s ?? { lastDueAt: null, runs: [], seen: [], day: "", eventRuns: 0 };
  }

  private async saveState(uid: string, id: string, s: State) {
    await this.put(uid, STATE, id, { ...s, runs: s.runs.slice(-RUNS_KEPT), seen: s.seen.slice(-SEEN_KEPT) }, { keep: 1 });
  }

  private fromTemplate(t: Template, id: string, at: number): Automation {
    return { id, template: t.id, name: t.name, enabled: true, trigger: t.trigger, instructions: t.instructions, delivery: t.delivery, createdAt: at, updatedAt: at };
  }

  async view(uid: string, a: Automation): Promise<AutomationView> {
    const s = await this.state(uid, a.id);
    const now = this.now();
    return {
      ...a,
      when: describeTrigger(a.trigger),
      nextRunAt: a.enabled && a.trigger.kind === "time" ? nextRun(a.trigger.schedule, Math.max(now, s.lastDueAt ?? 0)) : null,
      lastRun: s.runs.at(-1) ?? null,
    };
  }

  async list(uid: string): Promise<AutomationView[]> {
    return Promise.all((await this.all(uid)).map((a) => this.view(uid, a)));
  }

  async get(uid: string, id: string): Promise<Automation> {
    const a = (await this.all(uid)).find((x) => x.id === id);
    if (!a) throw new RoutineError("no_such_automation", "There's no such automation.", 404);
    return a;
  }

  /** From a template (with changes), or written from scratch (name, trigger and instructions). */
  async create(uid: string, input: AutomationInput): Promise<AutomationView> {
    const now = this.now();
    const all = await this.all(uid);
    if (all.length >= MAX) throw new RoutineError("too_many_automations", `There are ${MAX} automations already. Delete one first.`, 400);
    let a: Automation;
    if (input.template) {
      const t = TEMPLATES.find((x) => x.id === input.template);
      if (!t) throw new RoutineError("no_such_template", `There's no template "${input.template}". Templates: ${TEMPLATES.map((x) => x.id).join(", ")}.${RETIRED.has(input.template) ? " Watching bots is part of Ambient (its settings), and every bot learns on its own." : ""}`, 400);
      a = this.fromTemplate(t, `a${randomBytes(6).toString("hex")}`, now);
    } else {
      if (!input.name || !input.trigger || !input.instructions) throw new RoutineError("bad_request", "Give it a name, a trigger and instructions, or start from a template.", 400);
      a = { id: `a${randomBytes(6).toString("hex")}`, template: null, name: input.name, enabled: true, trigger: input.trigger, instructions: input.instructions, delivery: "chat", createdAt: now, updatedAt: now };
    }
    a = this.merge(a, input, now);
    await this.checkBot(uid, a);
    await this.put(uid, KIND, a.id, a, { keep: 10 });
    // A new time automation starts from now: no run for a time that's already past.
    if (a.trigger.kind === "time") await this.saveState(uid, a.id, { lastDueAt: now, runs: [], seen: [], day: "", eventRuns: 0 });
    return this.view(uid, a);
  }

  private merge(a: Automation, input: AutomationInput, now: number): Automation {
    const trigger = input.trigger ?? a.trigger;
    return {
      ...a,
      ...(input.name ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.bot ? { bot: input.bot } : {}),
      trigger,
      updatedAt: now,
    };
  }

  /** A "bot" automation names one of the person's bots, and runs at a time. */
  private async checkBot(uid: string, a: Automation): Promise<void> {
    if (a.delivery !== "bot") return;
    if (!this.d.tellBot) throw new RoutineError("bad_request", "Bots can't be started by automations here.", 400);
    if (a.trigger.kind !== "time") throw new RoutineError("bad_request", "An automation that starts a bot runs at a time.", 400);
    if (!a.bot) throw new RoutineError("bad_request", "Say which bot it starts (bot: its id).", 400);
    // Throws when it isn't theirs.
    await this.d.routines.get(await this.d.actorFor(uid), a.bot);
  }

  async update(uid: string, id: string, input: AutomationInput): Promise<AutomationView> {
    const now = this.now();
    const before = await this.get(uid, id);
    const a = this.merge(before, input, now);
    await this.checkBot(uid, a);
    await this.put(uid, KIND, id, a, { keep: 10 });
    // Switched on again, or a new time: from now on, not for what was missed meanwhile.
    if (a.trigger.kind === "time" && (input.trigger || (input.enabled && !before.enabled))) {
      const s = await this.state(uid, id);
      await this.saveState(uid, id, { ...s, lastDueAt: now });
    }
    return this.view(uid, a);
  }

  async remove(uid: string, id: string): Promise<void> {
    await this.get(uid, id);
    await this.d.control.m(api.records.removeAll, { ownerKind: "user", ownerId: uid, kind: KIND, prefix: id });
    await this.d.control.m(api.records.removeAll, { ownerKind: "user", ownerId: uid, kind: STATE, prefix: id });
  }

  async runs(uid: string, id: string): Promise<AutomationRun[]> {
    await this.get(uid, id);
    return [...(await this.state(uid, id)).runs].reverse();
  }

  // ---- running one ----

  private enqueue<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(uid) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.queues.set(uid, next.catch(() => undefined));
    return next;
  }

  /** "Run now" (app, MCP): runs it at once, whatever its trigger. */
  async runNow(uid: string, id: string): Promise<AutomationRun> {
    const a = await this.get(uid, id);
    return this.enqueue(uid, () => this.execute(uid, a, { by: "manual", facts: null, event: null }));
  }

  private prompt(name: string, a: Automation, o: { by: AutomationRun["by"]; facts: string | null }): string {
    const at = new Intl.DateTimeFormat("en-GB", { timeZone: a.trigger.kind === "time" ? a.trigger.schedule.timezone : vienna, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(this.now()));
    return [
      `[Not a message from ${name}: your automation "${a.name}" (${describeTrigger(a.trigger)}), ${o.by === "manual" ? `run now by ${name}` : o.by === "event" ? "started by something that happened" : "on its schedule"}. It's ${at}.]`,
      o.facts ? `What happened:\n${o.facts}` : "",
      `What to do:\n${a.instructions}`,
      a.delivery === "thread"
        ? `Your reply goes into the bot's thread as a note from you. If there's nothing worth saying, reply exactly ${NOTHING}.`
        : `Your reply is what ${name} reads in your chat: short, plain, chat-style, the most important first. If there's nothing worth their attention, reply exactly ${NOTHING}.`,
    ]
      .filter(Boolean)
      .join("\n\n");
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

  /** One run: Amb's internal turn, then delivery (or silence). Recorded in the automation's log. */
  private async execute(uid: string, a: Automation, o: { by: AutomationRun["by"]; facts: string | null; event: string | null; routineId?: string }): Promise<AutomationRun> {
    const name = await this.d.ambient.nameOf(uid);
    let run: AutomationRun;
    try {
      if (a.delivery === "bot") {
        // No turn of Amb's: the bot gets the instructions as they are, and its run does the work.
        if (!a.bot || !this.d.tellBot) throw new Error("it has no bot to start");
        await this.d.tellBot(await this.d.actorFor(uid), a.bot, a.instructions);
        run = { at: this.now(), by: o.by, event: o.event, result: "sent", text: "" };
        const st = await this.state(uid, a.id);
        await this.saveState(uid, a.id, { ...st, runs: [...st.runs, run] });
        return run;
      }
      const reply = (await this.withTimeout(this.d.ambient.internalTurn(uid, name, this.prompt(name, a, o)), this.d.turnMs ?? TURN_MS)).trim();
      const silent = !reply || reply.replace(/[.\s]/g, "").toUpperCase() === NOTHING;
      if (!silent) await this.deliver(uid, a, reply, o.routineId);
      run = { at: this.now(), by: o.by, event: o.event, result: silent ? "silent" : "sent", text: silent ? "" : reply.slice(0, 2_000) };
    } catch (err) {
      run = { at: this.now(), by: o.by, event: o.event, result: "failed", text: (err as Error).message.slice(0, 500) };
    }
    const s = await this.state(uid, a.id);
    await this.saveState(uid, a.id, { ...s, runs: [...s.runs, run] });
    return run;
  }

  private async deliver(uid: string, a: Automation, text: string, routineId?: string) {
    if (a.delivery === "thread" && routineId) {
      await this.d.files.note(await this.d.actorFor(uid), routineId, text);
      return;
    }
    await this.d.ambient.say(uid, text);
    if (a.delivery !== "chat") return;
    const zone = a.trigger.kind === "time" ? a.trigger.schedule.timezone : vienna;
    const { hour } = localHourDay(this.now(), zone);
    if (hour >= QUIET_FROM || hour < QUIET_TO) return;
    const push = { title: a.name, body: text.length > 180 ? `${text.slice(0, 179)}…` : text, url: "ambient://ambient", thread: "ambient", collapseId: `automation-${a.id}` };
    if (this.d.reach) void this.d.reach.tell(uid, text, push).catch(() => undefined);
    else void this.d.notifier?.notify(uid, push).catch(() => undefined);
  }

  // ---- the ticker: time automations and waiting decisions ----

  start(): void {
    if (this.timer || !this.d.people) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.busy || !this.d.people) return;
    this.busy = true;
    try {
      const people = await this.d.people();
      for (const uid of people) await this.tickFor(uid).catch((err: Error) => console.warn(`[automations] ${err.message}`));
    } finally {
      this.busy = false;
    }
  }

  /** One person's due automations. The due time is recorded before the run: at most once each. */
  async tickFor(uid: string): Promise<void> {
    const now = this.now();
    for (const a of await this.all(uid)) {
      if (!a.enabled) continue;
      if (a.trigger.kind === "time") {
        const s = await this.state(uid, a.id);
        const due = dueAt(a.trigger.schedule, now, s.lastDueAt, a.createdAt);
        if (due === null) continue;
        await this.saveState(uid, a.id, { ...s, lastDueAt: due });
        void this.enqueue(uid, () => this.execute(uid, a, { by: "schedule", facts: null, event: null }));
      } else if (a.trigger.kind === "event" && a.trigger.events.includes("decision_waiting")) {
        await this.waitingDecisions(uid, a, now);
      }
    }
  }

  private async waitingDecisions(uid: string, a: Automation, now: number) {
    const hours = a.trigger.kind === "event" ? (a.trigger.hours ?? 4) : 4;
    const rows = (await this.d.control.q(api.bots.openDecisions, { uid: uid as never })) as { id: string; createdAt: number }[];
    const due = rows.filter((d) => now - d.createdAt >= hours * 3600_000);
    if (!due.length) return;
    const views = await this.d.decisions.list(uid);
    for (const d of due) {
      const v = views.find((x) => x.id === String(d.id));
      if (!v) continue;
      await this.fire(uid, a, `decision_waiting:${d.id}`, `A decision has waited ${Math.round((now - d.createdAt) / 3600_000)} hours for them: “${v.question}”${v.from.kind === "bot" ? ` (${v.from.name} asked)` : ""}.`, "a decision waits", undefined);
    }
  }

  // ---- events ----

  /** Something happened (a run failed, a message to a bot, a meeting note): the automations listening run. Never throws. */
  async onEvent(e: AutomationEvent): Promise<void> {
    try {
      let kind: EventKind;
      let key: string;
      let facts: string;
      let routineId: string | undefined;
      if (e.kind === "bot_asked") {
        if (!(await askedBefore(this.d.control, this.d.keys, e, this.now()))) return;
        kind = "bot_asked_twice";
        key = `asked:${e.questionId}`;
        facts = `The bot "${e.bot}" (id ${e.routineId}) asked again what it asked before: “${e.text}”.`;
        routineId = e.routineId;
      } else if (e.kind === "bot_failed") {
        kind = "bot_failed";
        key = `failed:${e.runId}`;
        facts = `The bot "${e.bot}" (id ${e.routineId}) failed its run. Its report:\n${e.text.slice(0, 1500)}`;
        routineId = e.routineId;
      } else if (e.kind === "bot_corrected") {
        kind = "bot_corrected";
        key = `corrected:${e.messageId}`;
        facts = `They wrote to the bot "${e.bot}" (id ${e.routineId}) after its result: “${e.text.slice(0, 1500)}”.`;
        routineId = e.routineId;
      } else if (e.kind === "github_ci_failed") {
        kind = "github_ci_failed";
        key = `ci:${e.repo}:${e.sha}`;
        facts = `CI failed on ${e.branch} of ${e.repo} (a repo their bots watch): ${e.url}`;
      } else {
        kind = "meeting_note";
        key = `meeting:${e.ref}`;
        facts = `A recorded ${e.team ? `meeting went to the team ${e.team}'s brain` : "meeting landed in their brain"}: “${e.title}” (${e.ref}).`;
      }
      const label = kind.replace(/_/g, " ");
      for (const a of await this.all(e.uid)) {
        if (!a.enabled || a.trigger.kind !== "event" || !a.trigger.events.includes(kind)) continue;
        if (routineId && a.trigger.bot && a.trigger.bot !== routineId) continue;
        await this.fire(e.uid, a, key, facts, label, routineId);
      }
    } catch (err) {
      console.warn(`[automations] an event wasn't handled: ${(err as Error).message}`);
    }
  }

  private async fire(uid: string, a: Automation, key: string, facts: string, label: string, routineId: string | undefined) {
    const s = await this.state(uid, a.id);
    if (s.seen.includes(key)) return;
    const { day } = localHourDay(this.now(), vienna);
    const count = s.day === day ? s.eventRuns : 0;
    if (count >= EVENT_RUNS_A_DAY) return;
    await this.saveState(uid, a.id, { ...s, seen: [...s.seen, key], day, eventRuns: count + 1 });
    void this.enqueue(uid, () => this.execute(uid, a, { by: "event", facts, event: label, routineId }));
  }

  // ---- proposed changes (learning's, and Amb's) ----

  /** Amb proposes a change to a bot: a decision the person applies. */
  async propose(actor: Actor, change: ProposedChange) {
    const f = await this.d.routines.folderOf(actor, change.routineId, true);
    return this.d.decisions.propose(actor.uid, { ...change, bot: f.name });
  }

  /** The person said yes: the change is made as theirs. */
  private async apply(actor: Actor, change: ProposedChange): Promise<string> {
    const by: Author = { kind: "user", name: null };
    if (change.path !== undefined) {
      const f = await this.d.files.write(actor, change.routineId, change.path, change.content ?? "", by, `applied Ambient's proposal: ${change.why}`, "app");
      return `${change.path} changed (version ${f.version}).`;
    }
    if (change.settings) {
      const patch = ProposedSettings.parse(change.settings);
      const { bot, ...rest } = patch;
      await this.d.routines.update(actor, change.routineId, { ...rest, ...(bot ? { bot } : {}) } as never, "app");
      return "Settings changed.";
    }
    return "Nothing to change.";
  }
}

/** What a proposal may change about a bot's settings. */
export const ProposedSettings = z
  .object({
    schedule: RoutineSchedule.optional(),
    enabled: z.boolean().optional(),
    bot: z
      .object({
        isolation: z.enum(["container", "host"]).optional(),
        secrets: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(30).nullable().optional(),
        report: z.enum(["news", "every_run"]).optional(),
        delegate: z.enum(["never", "brain", "most"]).optional(),
        model: z.unknown().optional(),
        runtime: z.string().max(40).optional(),
      })
      .optional(),
  })
  .strict();

/** Whether the bot asked this before (an earlier question in its thread says much the same). */
export async function askedBefore(control: Control, keys: RoutineKeys, e: { routineId: string; questionId: string; text: string }, now: number): Promise<boolean> {
  const page = (await control.q(api.bots.threadHistory, { id: e.routineId, after: 0, before: now + 1, limit: 200 }).catch(() => null)) as {
    teamId: string | null;
    createdBy: string;
    messages: { id: string; kind: string; iv: string; ct: string }[];
  } | null;
  if (!page) return false;
  const owner: Owner = page.teamId ? { kind: "team", teamId: String(page.teamId) } : { kind: "user", uid: String(page.createdBy) };
  for (const m of page.messages) {
    if (m.kind !== "question" || String(m.id) === e.questionId) continue;
    const body = await openMessage(keys, owner, m.iv, m.ct).catch(() => null);
    if (body && sameQuestion(body.text, e.text)) return true;
  }
  return false;
}
