// Decisions (docs/bots.md, "Decisions"): bots report to Ambient, Ambient reports to the person.
//
//   a bot asks ──▶ onBotQuestion: by the bot's `delegate`, Ambient answers in the thread itself
//                  (when the person's brain makes it clear), or it becomes a decision for the
//                  person: a message in Ambient's chat with a card, and a push
//   the person answers (app, chat in words, the bot's thread, a text on iMessage; later Slack, Teams)
//                  ──▶ answer(): the bot gets it, and it's settled everywhere
//
// Conversation first: a decision is a message in the conversation with Ambient, which every
// channel shows in its own way (buttons in the app, Slack and Teams; "1/2/3" in iMessage).
import { api, type Control } from "../control.ts";
import { ambientQuestionPush, botQuestionPush, type Channel } from "../channels/channel.ts";
import type { AmbReach } from "../channels/reach.ts";
import type { RoutineKeys } from "../routines/keys.ts";
import { RoutineError, type Actor, type RoutineService } from "../routines/service.ts";
import type { AmbientChat } from "./ambient.ts";
import type { BotService } from "./service.ts";

const PURPOSE = "decision";
const ANSWER_PURPOSE = "decision:answer";
/** How long Ambient may think about a bot's question before it goes to the person as it is. */
const TRIAGE_MS = 75_000;

/**
 * A change to a bot Amb proposes instead of making (docs/bots.md, "Automations"): its
 * instructions (a file), or its settings. Applied only when the person says yes.
 */
export interface ProposedChange {
  routineId: string;
  bot: string;
  /** A new version of this file (AGENTS.md, say)… */
  path?: string;
  content?: string;
  /** …or these settings (schedule, isolation, secrets, model, runtime, report, delegate). */
  settings?: Record<string, unknown>;
  why: string;
}

/** A question's answers as a text shows them (a channel without buttons): numbered, to answer by number or in words. */
export function numbered(choices: string[]): string {
  return choices.length ? `\n\n${choices.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nAnswer with the number or in your own words.` : "";
}

/** "Apply", "yes", "ja", "ok", "do it": the person says yes to a proposed change. */
export function saysYes(text: string): boolean {
  return /^\s*(apply|yes|yep|yeah|ja|jo|ok|okay|sure|do it|go|mach|passt)\b/i.test(text);
}

export interface Decision {
  id: string;
  status: "open" | "answered" | "expired";
  from: { kind: "bot"; id: string; name: string; face: string; color?: string; wear?: string[] } | { kind: "ambient" };
  question: string;
  /** What a bot's question is about: its draft, the pull request's link, the file. */
  details: string | null;
  options: string[];
  recommendation: { option: string; why: string } | null;
  answer: { text: string; by: string | null; via: string | null; at: number } | null;
  urgent: boolean;
  createdAt: number;
  /** A change Amb proposes (applied on "Apply"); null for questions. */
  change: Omit<ProposedChange, "why"> | null;
}

export interface DecisionRow {
  id: string;
  routineId: string | null;
  questionId: string | null;
  iv: string;
  ct: string;
  status: "open" | "answered" | "expired";
  answerIv: string | null;
  answerCt: string | null;
  answeredBy: string | null;
  via: string | null;
  answeredAt: number | null;
  urgent: boolean;
  createdAt: number;
}

interface Sealed {
  q: string;
  o: string[];
  /** The bot's work the question is about (the draft, the pull request). */
  d?: string;
  r?: { option: string; why: string };
  bot?: { id: string; name: string; face: string; color?: string; wear?: string[] };
  a?: ProposedChange;
}

/** What Ambient said about a bot's question: answer it, or ask the person (with a suggestion). */
export function parseTriage(text: string): { action: "answer"; answer: string; why: string } | { action: "ask"; suggest: string; why: string } | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { action?: string; answer?: string; suggest?: string; why?: string };
    if (j.action === "answer" && typeof j.answer === "string" && j.answer.trim()) return { action: "answer", answer: j.answer.trim(), why: (j.why ?? "").trim() };
    if (j.action === "ask") return { action: "ask", suggest: (j.suggest ?? "").trim(), why: (j.why ?? "").trim() };
  } catch {
    // Not JSON: treated as no verdict.
  }
  return null;
}

export function triagePrompt(o: { name: string; bot: string; question: string; choices: string[]; details?: string; delegate: "brain" | "most" }): string {
  const rule =
    o.delegate === "brain"
      ? `Answer it yourself only when ${o.name}'s brain makes the answer clear (search it: decisions, project pages, earlier answers). Otherwise ask ${o.name}.`
      : `Answer it yourself unless it spends money, publishes something, deletes something or can't be undone; those go to ${o.name}.`;
  return [
    `[Not from ${o.name}: one of their bots asks something, and you decide whether you can answer for them. Don't write to ${o.name} now; they'll see your answer in the bot's thread, or the question with your suggestion.]`,
    `Bot: ${o.bot}`,
    `Question: ${o.question}`,
    o.choices.length ? `Choices: ${o.choices.join(" / ")}` : "",
    // What it's about (the draft, the pull request): look at it before suggesting anything.
    o.details ? `What it's about (from the bot):\n<details>\n${o.details.slice(0, 12_000)}\n</details>` : `The bot showed nothing of the work it asks about: don't suggest approving work you haven't seen; say what's missing instead.`,
    rule,
    'Reply with only one line of JSON: {"action":"answer","answer":"<your answer, one of the choices if there are any>","why":"<one sentence, name the page>"} or {"action":"ask","suggest":"<what you would choose, or empty>","why":"<one sentence>"}.',
  ]
    .filter(Boolean)
    .join("\n");
}

export class DecisionService {
  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      routines: RoutineService;
      bots: BotService;
      ambient: AmbientChat;
      /** Where a decision reaches the person besides the chat (the app: a push). */
      channels: Channel[];
      /** Where what Amb says first goes: the person's channel, or the app's push (channels/reach.ts). */
      reach?: AmbReach;
      /** The person as an actor with everything their roles allow (for answers Ambient files). */
      actorFor: (uid: string) => Promise<Actor>;
      now?: () => number;
      triageMs?: number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private owner(uid: string) {
    return { kind: "user" as const, uid };
  }

  async view(uid: string, row: DecisionRow): Promise<Decision> {
    const raw = await this.d.keys.open(this.owner(uid), PURPOSE, row.iv, row.ct).catch(() => "{}");
    let s: Sealed = { q: "", o: [] };
    try {
      s = { ...s, ...(JSON.parse(raw) as Sealed) };
    } catch {
      // Unreadable: shown empty.
    }
    const answer = row.answerIv && row.answerCt ? await this.answerText(uid, row) : null;
    return {
      id: String(row.id),
      status: row.status,
      from: s.bot ? { kind: "bot", ...s.bot } : { kind: "ambient" },
      question: s.q,
      details: s.d ?? null,
      options: s.o ?? [],
      recommendation: s.r ?? null,
      answer: answer !== null ? { text: answer, by: row.answeredBy, via: row.via, at: row.answeredAt ?? row.createdAt } : null,
      urgent: row.urgent,
      createdAt: row.createdAt,
      change: s.a ? { routineId: s.a.routineId, bot: s.a.bot, ...(s.a.path ? { path: s.a.path, content: s.a.content ?? "" } : {}), ...(s.a.settings ? { settings: s.a.settings } : {}) } : null,
    };
  }

  /** An answer sealed by a bot thread (the thread's own message) or by answer() here. */
  private async answerText(uid: string, row: DecisionRow): Promise<string> {
    const own = await this.d.keys.open(this.owner(uid), ANSWER_PURPOSE, row.answerIv!, row.answerCt!).catch(() => null);
    if (own !== null) return own;
    // Answered in the thread: sealed as a thread message (the bot's owner's key, or its team's).
    const r = row.routineId ? await this.d.control.q(api.bots.routineOwner, { id: row.routineId }) : null;
    if (!r) return "";
    const { openMessage } = await import("./messages.ts");
    return (await openMessage(this.d.keys, r.teamId ? { kind: "team", teamId: String(r.teamId) } : { kind: "user", uid: String(r.createdBy) }, row.answerIv!, row.answerCt!).catch(() => ({ text: "" }))).text;
  }

  async list(uid: string): Promise<Decision[]> {
    const rows = (await this.d.control.q(api.bots.openDecisions, { uid: uid as never })) as unknown as DecisionRow[];
    return Promise.all(rows.map((r) => this.view(uid, r)));
  }

  /**
   * A bot asked its owner something (the run waits a few minutes). Ambient looks first, by the
   * bot's `delegate`; what it doesn't answer becomes a decision for the person. Never throws.
   */
  async onBotQuestion(q: { uid: string; routineId: string; questionId: string; bot: { name: string; face: string; color?: string; wear?: string[] }; question: string; choices: string[]; details?: string; files?: string[]; delegate: "never" | "brain" | "most"; team: string | null }): Promise<void> {
    try {
      const name = (await this.d.actorFor(q.uid).catch(() => null)) ? await this.d.ambient.nameOf(q.uid) : "them";
      let suggestion: { option: string; why: string } | null = null;
      if (q.delegate !== "never") {
        const verdict = await this.withTimeout(this.d.ambient.internalTurn(q.uid, name, triagePrompt({ name, bot: q.bot.name, question: q.question, choices: q.choices, details: q.details, delegate: q.delegate })), this.d.triageMs ?? TRIAGE_MS).catch(() => null);
        const t = verdict ? parseTriage(verdict) : null;
        if (t?.action === "answer") {
          const actor = await this.d.actorFor(q.uid);
          await this.d.bots.postAsAmbient(actor, q.routineId, t.why ? `${t.answer} (${t.why})` : t.answer);
          return;
        }
        if (t?.action === "ask" && t.suggest) suggestion = { option: t.suggest, why: t.why };
      }
      await this.escalate(q, suggestion);
    } catch (err) {
      console.warn(`[decisions] a bot's question didn't reach its owner: ${(err as Error).message}`);
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out")), ms);
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

  /** To the person: a decision in Ambient's chat, and a push (the app channel). */
  private async escalate(q: { uid: string; routineId: string; questionId: string; bot: { name: string; face: string; color?: string; wear?: string[] }; question: string; choices: string[]; details?: string; files?: string[]; team: string | null }, suggestion: { option: string; why: string } | null) {
    const body: Sealed = { q: q.question, o: q.choices, ...(q.details ? { d: q.details } : {}), ...(suggestion ? { r: suggestion } : {}), bot: { id: q.routineId, name: q.bot.name, face: q.bot.face, ...(q.bot.color ? { color: q.bot.color } : {}), ...(q.bot.wear ? { wear: q.bot.wear } : {}) } };
    const sealed = await this.d.keys.seal(this.owner(q.uid), PURPOSE, JSON.stringify(body));
    const row = (await this.d.control.m(api.bots.createDecision, { uid: q.uid as never, routineId: q.routineId, questionId: q.questionId, iv: sealed.iv, ct: sealed.ciphertext, urgent: true, now: this.now() })) as unknown as DecisionRow;
    // The work comes with the question, so it's decided on what was done, not on its description.
    const work = q.details ? `\n\n${q.details.length > 6_000 ? `${q.details.slice(0, 6_000)}…\n\n(The rest is in ${q.bot.name}'s thread.)` : q.details}` : "";
    // Files with the question (a picture for a post) stay in the bot's thread, where they open.
    const attached = q.files?.length ? `\n\n📎 ${q.files.join(", ")}: in ${q.bot.name}'s thread.` : "";
    const text = `${q.bot.name} asks: ${q.question}${work}${attached}${suggestion ? `\n\nI'd go with “${suggestion.option}”${suggestion.why ? `: ${suggestion.why}` : "."}` : ""}`;
    await this.d.ambient.say(q.uid, text, String(row.id));
    if (this.d.reach) {
      // One place hears of it: their channel (the question with its answers to pick from), or a push.
      void this.d.reach.tell(q.uid, `${text}${numbered(q.choices)}`, botQuestionPush({ botId: q.routineId, name: q.bot.name, team: q.team, question: q.question })).catch(() => undefined);
      return;
    }
    for (const channel of this.d.channels) {
      void channel
        .deliver({ speaker: { kind: "bot", botId: q.routineId, name: q.bot.name, face: q.bot.face, color: q.bot.color, wear: q.bot.wear, team: q.team }, to: q.uid, kind: "question", text: q.question, ...(q.choices.length ? { choices: q.choices } : {}) })
        .catch(() => undefined);
    }
  }

  /** Applies a proposed change for the person (set by the automations; docs/bots.md, "Automations"). */
  applyChange?: (actor: Actor, change: ProposedChange) => Promise<string>;

  /**
   * Amb proposes a change to a bot instead of making it: a decision in the chat with "Apply" and
   * "Not now", and a push. Applied when the person says yes, wherever they answer.
   */
  async propose(uid: string, change: ProposedChange, opts: { push?: boolean } = {}): Promise<Decision> {
    const what = change.path ? `change ${change.bot}'s ${change.path}` : `change ${change.bot}'s settings (${Object.keys(change.settings ?? {}).join(", ")})`;
    const question = `Should I ${what}? ${change.why}`.trim();
    const body: Sealed = { q: question, o: ["Apply", "Not now"], a: change };
    const sealed = await this.d.keys.seal(this.owner(uid), PURPOSE, JSON.stringify(body));
    const row = (await this.d.control.m(api.bots.createDecision, { uid: uid as never, iv: sealed.iv, ct: sealed.ciphertext, urgent: false, now: this.now() })) as unknown as DecisionRow;
    const preview = change.path && change.content !== undefined ? `\n\nThe new ${change.path} would be:\n\n${change.content.length > 1500 ? `${change.content.slice(0, 1500)}…` : change.content}` : change.settings ? `\n\n${JSON.stringify(change.settings)}` : "";
    await this.d.ambient.say(uid, `${question}${preview}`, String(row.id));
    if (opts.push !== false && this.d.reach) {
      void this.d.reach.tell(uid, `${question}${preview}${numbered(["Apply", "Not now"])}`, ambientQuestionPush(question)).catch(() => undefined);
    } else if (opts.push !== false) {
      for (const channel of this.d.channels) {
        void channel.deliver({ speaker: { kind: "ambient" }, to: uid, kind: "question", text: question, choices: ["Apply", "Not now"] }).catch(() => undefined);
      }
    }
    return this.view(uid, row);
  }

  /** The person answers (`via`: app, chat, later a channel). A bot's question goes to the bot. */
  async answer(actor: Actor, id: string, text: string, via: string): Promise<Decision> {
    const row = (await this.d.control.q(api.bots.decision, { uid: actor.uid as never, id })) as unknown as DecisionRow | null;
    if (!row) throw new RoutineError("no_such_decision", "There's no such decision.", 404);
    if (row.status !== "open") throw new RoutineError("already_answered", "It's already answered.", 409);
    const answer = text.trim().slice(0, 4000);
    if (!answer) throw new RoutineError("bad_request", "Give an answer.", 400);
    if (row.routineId) {
      // Through the bot's thread: the bot gets it and the decision is settled there (Convex).
      await this.d.bots.post(actor, String(row.routineId), answer);
      const after = (await this.d.control.q(api.bots.decision, { uid: actor.uid as never, id })) as unknown as DecisionRow;
      return this.view(actor.uid, after);
    }
    // A proposed change is applied on yes; what came of it is part of the answer.
    let outcome = answer;
    const raw = await this.d.keys.open(this.owner(actor.uid), PURPOSE, row.iv, row.ct).catch(() => "{}");
    const proposed = (JSON.parse(raw) as Sealed).a;
    if (proposed && saysYes(answer)) {
      if (!this.applyChange) throw new RoutineError("cannot_apply", "That change can't be applied here.", 400);
      outcome = `${answer} → ${await this.applyChange(actor, proposed)}`;
    }
    const sealed = await this.d.keys.seal(this.owner(actor.uid), ANSWER_PURPOSE, outcome);
    const name = await this.d.ambient.nameOf(actor.uid);
    const out = await this.d.control.m(api.bots.resolveDecision, { uid: actor.uid as never, id, answerIv: sealed.iv, answerCt: sealed.ciphertext, by: name, via, now: this.now() });
    if (!out.ok) throw new RoutineError(out.error, "It's already answered.", 409);
    return this.view(actor.uid, out.decision as unknown as DecisionRow);
  }
}
