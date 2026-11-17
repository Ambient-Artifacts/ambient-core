// Bots (docs/bots.md): a bot's thread, what people write to it, and the questions its runs ask.
//
//   app / MCP ──▶ thread(), post() ──▶ Convex botMessages (sealed) ──▶ the next run starts with it
//   a run (its run token) ──▶ ask() ──▶ the thread + every channel (the app: a push)
//                         ──▶ answer() while it waits; later, the answer starts a run that resumes
//
// Who may do what is the loops' rule: whoever sees a bot reads its thread, whoever may change it
// writes to it. Only accounts and teams in BRAIN_BOTS have bots at all.
import { api } from "../control.ts";
import { sha256Hex } from "../crypto.ts";
import type { Channel, Inbound } from "../channels/channel.ts";
import { openMessage, sealMessage } from "./messages.ts";
import { RoutineError, RUN_TOKEN_PREFIX, type Actor, type Routine, type RoutineService } from "../routines/service.ts";
import type { Owner } from "../routines/keys.ts";

export interface ThreadMessage {
  id: string;
  role: "bot" | "user";
  kind: "result" | "failure" | "question" | "answer" | "message";
  text: string;
  choices: string[] | null;
  runId: string | null;
  author: string | null;
  /** Written by whoever is asking (their own messages, in the app: on the right). */
  mine: boolean;
  createdAt: number;
  /** Questions: whether someone answered; null for everything else. */
  answered: boolean | null;
}

interface MessageRow {
  id: string;
  role: "bot" | "user";
  kind: ThreadMessage["kind"];
  iv: string;
  ct: string;
  runId: string | null;
  authorId: string | null;
  authorName: string | null;
  answeredAt: number | null;
  createdAt: number;
}

const QUESTION_MAX = 2_000;
const MESSAGE_MAX = 8_000;

function refused(code: string, message: string, status = 400) {
  return new RoutineError(code, message, status);
}

export class BotService {
  constructor(
    private d: {
      routines: RoutineService;
      /** Where bots reach people: the app first (a push), more later. */
      channels: Channel[];
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private access(actor: Actor) {
    return { uid: actor.uid as never, teamIds: actor.teams.filter((t) => t.status === "active").map((t) => t.id) as never };
  }

  /** Writes go through the teams the user manages (Convex checks the role again). */
  private writeAccess(actor: Actor) {
    return { uid: actor.uid as never, teamIds: (actor.canWriteTeams ? actor.teams.filter((t) => t.status === "active" && (t.role === "owner" || t.role === "admin")) : []).map((t) => t.id) as never };
  }

  private async bot(actor: Actor, id: string) {
    const r = await this.d.routines.rowOf(actor, id).catch((err) => {
      if (err instanceof RoutineError && err.code === "no_such_routine") throw refused("no_such_bot", "There's no such bot.", 404);
      throw err;
    });
    if (!r.bot) throw refused("no_such_bot", "There's no such bot.", 404);
    if (!this.d.routines.botsFor(actor, r)) throw refused("bots_not_enabled", "Bots aren't switched on for this account or team yet.", 403);
    return r;
  }

  private ownerOf(r: { teamId: string | null; createdBy: string }): Owner {
    return r.teamId ? { kind: "team", teamId: r.teamId } : { kind: "user", uid: r.createdBy };
  }

  private async message(owner: Owner, m: MessageRow, uid: string): Promise<ThreadMessage> {
    const body = await openMessage(this.d.routines.keys, owner, m.iv, m.ct).catch(() => ({ text: "(couldn't be opened)", choices: undefined }));
    return {
      id: String(m.id),
      role: m.role,
      kind: m.kind,
      text: body.text,
      choices: body.choices?.length ? body.choices : null,
      runId: m.runId ? String(m.runId) : null,
      author: m.authorName,
      mine: m.role === "user" && m.authorId !== null && String(m.authorId) === uid,
      createdAt: m.createdAt,
      answered: m.kind === "question" ? m.answeredAt !== null : null,
    };
  }

  /** A bot's thread, newest last, and its open question. */
  async thread(actor: Actor, id: string, limit = 50): Promise<{ messages: ThreadMessage[]; openQuestion: ThreadMessage | null; routine: Routine }> {
    const r = await this.bot(actor, id);
    const out = await this.d.routines.control.q(api.bots.thread, { ...this.access(actor), id, limit });
    if (!out) throw refused("no_such_bot", "There's no such bot.", 404);
    const owner = this.ownerOf(r);
    const messages = await Promise.all((out.messages as unknown as MessageRow[]).map((m) => this.message(owner, m, actor.uid)));
    const openId = out.openQuestionId ? String(out.openQuestionId) : null;
    // The bot as the list shows it (its state while the app polls the thread).
    return { messages, openQuestion: messages.find((m) => m.id === openId) ?? null, routine: await this.d.routines.get(actor, id) };
  }

  /**
   * Someone writes to a bot: the answer to its open question, or a message. Its next run starts
   * with it (within a minute), unless the run that asked is still waiting and takes it itself.
   */
  async post(actor: Actor, id: string, text: string): Promise<{ message: ThreadMessage; routine: Routine }> {
    const r = await this.bot(actor, id);
    if (r.teamId ? !actor.canWriteTeams : !actor.canWritePersonal) throw refused("read_only", "This connection can't write to bots. Reconnect Ambient in this app and allow saving.", 403);
    const body = text.trim().slice(0, MESSAGE_MAX);
    if (!body) throw refused("bad_request", "Write something first.");
    const owner = this.ownerOf(r);
    const sealed = await sealMessage(this.d.routines.keys, owner, { text: body });
    const out = await this.d.routines.control.m(api.bots.post, { ...this.writeAccess(actor), id, iv: sealed.iv, ct: sealed.ct, now: this.now() });
    if (!out.ok) {
      const messages: Record<string, [string, number]> = {
        no_such_bot: ["There's no such bot.", 404],
        admins_only: ["Only whoever may change this bot can write to it.", 403],
        no_computer: ["This bot has no computer to run on. Pick one first.", 400],
        no_team_server: ["The team's server isn't set up for loops yet.", 400],
      };
      const [m, s] = messages[out.error] ?? ["That didn't work.", 400];
      throw refused(out.error, m, s);
    }
    return { message: await this.message(owner, out.message as unknown as MessageRow, actor.uid), routine: await this.d.routines.get(actor, id) };
  }

  /** What arrives on a channel for a bot (Ambient's own messages go to AmbientChat). */
  async receive(actor: Actor, inbound: Inbound): Promise<{ message: ThreadMessage; routine: Routine }> {
    if (inbound.target.kind !== "bot") throw refused("bad_request", "That message isn't for a bot.");
    return this.post(actor, inbound.target.botId, inbound.text);
  }

  // ---- a run's side (its run token) ----

  private tokenHash(token: string | undefined): string {
    const t = token?.startsWith("Bearer ") ? token.slice(7).trim() : "";
    if (!t.startsWith(RUN_TOKEN_PREFIX)) throw refused("invalid_token", "This isn't a run's token.", 401);
    return sha256Hex(t);
  }

  /** A run asks its bot's owner; every channel gets the question. Returns the question's id. */
  async ask(authorization: string | undefined, question: string, choices: string[] = []): Promise<{ id: string }> {
    const runTokenHash = this.tokenHash(authorization);
    const who = await this.d.routines.control.q(api.bots.runOwner, { runTokenHash });
    if (!who) throw refused("run_over", "This run is over; it can't ask anything anymore.", 409);
    const owner = this.ownerOf({ teamId: who.teamId ? String(who.teamId) : null, createdBy: String(who.createdBy) });
    const text = question.trim().slice(0, QUESTION_MAX);
    const picks = choices.map((c) => c.trim().slice(0, 120)).filter(Boolean).slice(0, 6);
    const sealed = await sealMessage(this.d.routines.keys, owner, { text, choices: picks });
    const out = await this.d.routines.control.m(api.bots.ask, { runTokenHash, iv: sealed.iv, ct: sealed.ct, now: this.now() });
    if (!out.ok) throw refused("run_over", "This run is over; it can't ask anything anymore.", 409);
    for (const channel of this.d.channels) {
      void channel
        .deliver({
          speaker: { kind: "bot", botId: String(out.routineId), name: who.name, face: who.face, team: out.team },
          to: String(out.notify),
          kind: "question",
          text,
          ...(picks.length ? { choices: picks } : {}),
        })
        .catch((err: Error) => console.warn(`[bots] ${channel.kind} couldn't deliver a question: ${err.message}`));
    }
    return { id: String(out.questionId) };
  }

  /** Whether the run's question was answered (the run then carries on with it). */
  async answer(authorization: string | undefined, questionId: string): Promise<{ answer: string | null; author: string | null }> {
    const runTokenHash = this.tokenHash(authorization);
    const who = await this.d.routines.control.q(api.bots.runOwner, { runTokenHash });
    if (!who) throw refused("run_over", "This run is over.", 409);
    const out = await this.d.routines.control.m(api.bots.questionAnswer, { runTokenHash, questionId });
    if (!out.ok) throw refused(out.error, out.error === "no_such_question" ? "There's no such question." : "This run is over.", out.error === "no_such_question" ? 404 : 409);
    if (!out.answer) return { answer: null, author: null };
    const owner = this.ownerOf({ teamId: who.teamId ? String(who.teamId) : null, createdBy: String(who.createdBy) });
    const body = await openMessage(this.d.routines.keys, owner, out.answer.iv, out.answer.ct);
    return { answer: body.text, author: out.answer.authorName };
  }
}
