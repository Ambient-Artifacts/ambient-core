// Bots (docs/bots.md): a bot's thread, what people write to it, and the questions its runs ask.
//
//   app / MCP ──▶ thread(), post() ──▶ Convex botMessages (sealed) ──▶ the next run starts with it
//   a run (its run token) ──▶ ask() ──▶ the thread + every channel (the app: a push)
//                         ──▶ answer() while it waits; later, the answer starts a run that resumes
//
// Who may do what is the loops' rule: whoever sees a bot reads its thread, whoever may change it
// writes to it (a team bot's thread: everyone in the team). Every routine is a bot, for everyone.
import type { LiveEvent, LiveText } from "./live.ts";
import { botLook } from "@brain/spec";
import { api } from "../control.ts";
import { sha256Hex } from "../crypto.ts";
import type { Channel, Inbound } from "../channels/channel.ts";
import { claudeFix, openMessage, sealMessage, type ClaudeFix, type MessageBody } from "./messages.ts";
import { RoutineError, RUN_TOKEN_PREFIX, type Actor, type Routine, type RoutineService } from "../routines/service.ts";
import type { Owner } from "../routines/keys.ts";
import type { AutomationEvent } from "./automations.ts";
import type { Attachments, FileRef, IncomingFile } from "./attachments.ts";

export interface ThreadMessage {
  id: string;
  role: "bot" | "user" | "ambient";
  kind: "result" | "failure" | "question" | "answer" | "message";
  text: string;
  choices: string[] | null;
  /** A question's work to decide on: the draft, the pull request's link, the file. */
  details: string | null;
  runId: string | null;
  author: string | null;
  /** Written by whoever is asking (their own messages, in the app: on the right). */
  mine: boolean;
  createdAt: number;
  /** Questions: whether someone answered; null for everything else. */
  answered: boolean | null;
  /** A failure that's the computer's Claude account, not the bot: the app offers the fix. */
  fix: ClaudeFix | null;
  /** Files sent with it (attachments.ts), fetched from /v1/app/routines/:id/thread/files/:file. */
  files: FileRef[];
}

interface MessageRow {
  id: string;
  role: "bot" | "user" | "ambient";
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
/** How long a question's work may be (a post, a PR's summary with its link). */
const DETAILS_MAX = 20_000;
const MESSAGE_MAX = 8_000;

function refused(code: string, message: string, status = 400) {
  return new RoutineError(code, message, status);
}

export class BotService {
  /** What happened in a bot's thread, for automations (docs/bots.md, "Automations"). */
  onEvent?: (e: AutomationEvent) => void;

  constructor(
    private d: {
      routines: RoutineService;
      /** Where bots reach people: the app first (a push), more later. */
      channels: Channel[];
      /** Starts a bot's run on its computer at once (its long poll) instead of at the next check. */
      startNow?: (hostId: string, routineId: string) => boolean;
      /** Files sent with messages in its thread, kept so the thread shows them again (attachments.ts). */
      attachments?: Attachments;
      /** A bot's question goes to Ambient first (DecisionService); without it, straight to the channels. */
      /** Bots' answers as they're written (bots/live.ts): a thread that opens mid-answer shows it. */
      live?: LiveText;
      onQuestion?: (q: { uid: string; routineId: string; questionId: string; bot: { name: string; face: string; color?: string; wear?: string[] }; question: string; choices: string[]; details?: string; files?: string[]; delegate: "never" | "brain" | "most"; team: string | null }) => void;
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
    return r;
  }

  private ownerOf(r: { teamId: string | null; createdBy: string }): Owner {
    return r.teamId ? { kind: "team", teamId: r.teamId } : { kind: "user", uid: r.createdBy };
  }

  private async message(owner: Owner, m: MessageRow, uid: string, computer?: string | null): Promise<ThreadMessage> {
    const body: MessageBody = await openMessage(this.d.routines.keys, owner, m.iv, m.ct).catch(() => ({ text: "(couldn't be opened)" }));
    return {
      id: String(m.id),
      role: m.role,
      kind: m.kind,
      text: body.text,
      choices: body.choices?.length ? body.choices : null,
      details: body.details ?? null,
      runId: m.runId ? String(m.runId) : null,
      author: m.authorName,
      mine: m.role === "user" && m.authorId !== null && String(m.authorId) === uid,
      createdAt: m.createdAt,
      answered: m.kind === "question" ? m.answeredAt !== null : null,
      fix: claudeFix(m.kind, body.text, computer),
      files: body.files ?? [],
    };
  }

  /**
   * A bot's thread, newest last, and its open question. With `markSeen` (the app showing it, or
   * the user reading it with their AI) what it said stops being news: it goes from done to asleep.
   */
  async thread(actor: Actor, id: string, limit = 50, opts: { markSeen?: boolean } = {}): Promise<{ messages: ThreadMessage[]; openQuestion: ThreadMessage | null; routine: Routine; live: LiveEvent | null }> {
    const r = await this.bot(actor, id);
    const out = await this.d.routines.control.q(api.bots.thread, { ...this.access(actor), id, limit });
    if (!out) throw refused("no_such_bot", "There's no such bot.", 404);
    if (opts.markSeen) await this.d.routines.control.m(api.bots.seen, { ...this.access(actor), id, now: this.now() });
    const owner = this.ownerOf(r);
    // The bot as the list shows it (its state while the app polls the thread).
    const routine = await this.d.routines.get(actor, id);
    const messages = await Promise.all((out.messages as unknown as MessageRow[]).map((m) => this.message(owner, m, actor.uid, routine.computer?.id)));
    const openId = out.openQuestionId ? String(out.openQuestionId) : null;
    return { messages, openQuestion: messages.find((m) => m.id === openId) ?? null, routine, live: this.d.live?.snapshot(id) ?? null };
  }

  /**
   * Someone writes to a bot: the answer to its open question, or a message. Its next run starts
   * with it (within a minute), unless the run that asked is still waiting and takes it itself.
   */
  /** Ambient answers (or writes) in a bot's thread for its owner, under its own name. */
  async postAsAmbient(actor: Actor, id: string, text: string): Promise<{ message: ThreadMessage; routine: Routine }> {
    return this.post(actor, id, text, { asAmbient: true });
  }

  async post(actor: Actor, id: string, text: string, opts: { asAmbient?: boolean; files?: IncomingFile[] } = {}): Promise<{ message: ThreadMessage; routine: Routine }> {
    const r = await this.bot(actor, id);
    if (r.teamId ? !actor.canWriteTeams : !actor.canWritePersonal) throw refused("read_only", "This connection can't write to bots. Reconnect Ambient in this app and allow saving.", 403);
    const body = text.trim().slice(0, MESSAGE_MAX);
    const incoming = opts.files ?? [];
    if (!body && !incoming.length) throw refused("bad_request", "Write something first.");
    if (incoming.length && !this.d.attachments) throw refused("bad_attachment", "Files can't go to bots here.");
    const owner = this.ownerOf(r);
    const files = incoming.length ? await this.d.attachments!.save(owner, { routineId: id }, incoming) : [];
    // The run reads the thread's text: it learns of the files there, and fetches them with its token.
    const sealed = await sealMessage(this.d.routines.keys, owner, { text: body || "(See the attached files.)", files });
    // A team bot's thread is a group chat: everyone in the team writes (not only its admins).
    const out = await this.d.routines.control.m(api.bots.post, { ...(r.teamId ? this.access(actor) : this.writeAccess(actor)), id, iv: sealed.iv, ct: sealed.ct, now: this.now(), ...(opts.asAmbient ? { asAmbient: true } : {}) });
    if (!out.ok) {
      const messages: Record<string, [string, number]> = {
        no_such_bot: ["There's no such bot.", 404],
        admins_only: ["Only whoever may change this bot can write to it.", 403],
        not_yours: ["Only the bot's maker, or their Ambient, answers its questions.", 403],
        no_computer: ["This bot has no computer to run on. Pick one first.", 400],
        no_team_server: ["The team has no computer for its bots yet. An owner or admin connects one on the team's page in the Ambient app (Computers), with the same one-line command as a computer of your own.", 400],
      };
      const [m, s] = messages[out.error] ?? ["That didn't work.", 400];
      throw refused(out.error, m, s);
    }
    const routine = await this.d.routines.get(actor, id);
    if (routine.computer) this.d.startNow?.(routine.computer.id, id);
    // Everyone else in the group chat hears it, as in any group chat.
    const group = (out as { group?: { team: string; others: string[]; bot: { name: string; face: string; color: string | null; wear: string[] | null } } | null }).group;
    if (group?.others.length) {
      const m = out.message as unknown as MessageRow;
      const said = body || (files.length ? `sent ${files.length === 1 ? "a file" : `${files.length} files`}` : "");
      const speaker = { kind: "bot" as const, botId: id, name: group.bot.name, ...botLook(group.bot.name, { face: group.bot.face, color: group.bot.color ?? undefined, wear: group.bot.wear ?? undefined }), team: group.team };
      for (const to of group.others) {
        for (const channel of this.d.channels) {
          void channel
            .deliver({ speaker, to, kind: "text", text: `${m.authorName ?? "Someone"}: ${said}` })
            .catch((err: Error) => console.warn(`[bots] ${channel.kind} couldn't deliver a message: ${err.message}`));
        }
      }
    }
    // The owner wrote to the bot (not an answer to its question, not Amb): maybe a correction.
    if (!opts.asAmbient && (out.message as unknown as MessageRow).kind === "message") {
      this.onEvent?.({ kind: "bot_corrected", uid: actor.uid, routineId: id, bot: r.name, text: body, messageId: String((out.message as unknown as MessageRow).id) });
    }
    return { message: await this.message(owner, out.message as unknown as MessageRow, actor.uid), routine };
  }

  /** A file sent in a bot's thread, to whoever may read the thread. */
  async file(actor: Actor, id: string, fileId: string): Promise<{ name: string; type: string; bytes: Buffer }> {
    const r = await this.bot(actor, id);
    if (!this.d.attachments) throw refused("no_such_file", "There's no such file.", 404);
    return this.d.attachments.read(this.ownerOf(r), { routineId: id }, fileId);
  }

  /** A file of the running bot's thread, for its run (its run token): it fetches what came with a message. */
  async runFile(authorization: string | undefined, fileId: string): Promise<{ name: string; type: string; bytes: Buffer }> {
    const who = await this.d.routines.control.q(api.bots.runOwner, { runTokenHash: this.tokenHash(authorization) });
    if (!who) throw refused("run_over", "This run is over.", 409);
    if (!this.d.attachments) throw refused("no_such_file", "There's no such file.", 404);
    const owner = this.ownerOf({ teamId: who.teamId ? String(who.teamId) : null, createdBy: String(who.createdBy) });
    return this.d.attachments.read(owner, { routineId: String(who.routineId) }, fileId);
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
  /** `details`: what the question is about, shown with it (the draft, the PR's link, the file). */
  async ask(authorization: string | undefined, question: string, choices: string[] = [], details?: string, incoming: IncomingFile[] = []): Promise<{ id: string }> {
    const runTokenHash = this.tokenHash(authorization);
    const who = await this.d.routines.control.q(api.bots.runOwner, { runTokenHash });
    if (!who) throw refused("run_over", "This run is over; it can't ask anything anymore.", 409);
    const owner = this.ownerOf({ teamId: who.teamId ? String(who.teamId) : null, createdBy: String(who.createdBy) });
    const text = question.trim().slice(0, QUESTION_MAX);
    const picks = choices.map((c) => c.trim().slice(0, 120)).filter(Boolean).slice(0, 6);
    const work = details?.trim().slice(0, DETAILS_MAX) || undefined;
    // The files it asks about (a picture for a post, a PDF): shown with the question.
    const files = incoming.length && this.d.attachments ? await this.d.attachments.save(owner, { routineId: String(who.routineId) }, incoming) : [];
    const sealed = await sealMessage(this.d.routines.keys, owner, { text, choices: picks, ...(work ? { details: work } : {}), files });
    const out = await this.d.routines.control.m(api.bots.ask, { runTokenHash, iv: sealed.iv, ct: sealed.ct, now: this.now() });
    if (!out.ok) throw refused("run_over", "This run is over; it can't ask anything anymore.", 409);
    this.onEvent?.({ kind: "bot_asked", uid: String(out.notify), routineId: String(out.routineId), bot: who.name, text, questionId: String(out.questionId) });
    // Ambient looks first (DecisionService): it answers for the owner, or brings it to them.
    if (this.d.onQuestion) {
      this.d.onQuestion({
        uid: String(out.notify),
        routineId: String(out.routineId),
        questionId: String(out.questionId),
        bot: { name: who.name, ...botLook(who.name, { face: who.face, color: who.color ?? undefined, wear: who.wear ?? undefined }) },
        question: text,
        choices: picks,
        ...(work ? { details: work } : {}),
        ...(files.length ? { files: files.map((f) => f.name) } : {}),
        delegate: (who as { delegate?: "never" | "brain" | "most" }).delegate ?? "brain",
        team: out.team,
      });
    } else {
      for (const channel of this.d.channels) {
        void channel
          .deliver({ speaker: { kind: "bot", botId: String(out.routineId), name: who.name, ...botLook(who.name, { face: who.face, color: who.color ?? undefined, wear: who.wear ?? undefined }), team: out.team }, to: String(out.notify), kind: "question", text, ...(picks.length ? { choices: picks } : {}) })
          .catch((err: Error) => console.warn(`[bots] ${channel.kind} couldn't deliver a question: ${err.message}`));
      }
    }
    // A team bot asks its whole group chat: the others get the question too, and whoever answers
    // first in the thread answers it (the decision, and Ambient answering, stay its maker's).
    for (const to of (out as { others?: string[] }).others ?? []) {
      for (const channel of this.d.channels) {
        void channel
          .deliver({ speaker: { kind: "bot", botId: String(out.routineId), name: who.name, ...botLook(who.name, { face: who.face, color: who.color ?? undefined, wear: who.wear ?? undefined }), team: out.team }, to, kind: "question", text, ...(picks.length ? { choices: picks } : {}) })
          .catch((err: Error) => console.warn(`[bots] ${channel.kind} couldn't deliver a question: ${err.message}`));
      }
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

  /**
   * What came into the bot's thread while its run is going (docs/bots.md, "Messages while a bot
   * works"): the run takes them into its session instead of a second run starting afterwards.
   * `cursor`: pass it back as `after` next time.
   */
  async inbox(authorization: string | undefined, after?: number): Promise<{ messages: { text: string; who: string; at: number }[]; cursor: number }> {
    const runTokenHash = this.tokenHash(authorization);
    const out = await this.d.routines.control.m(api.bots.claimInbox, { runTokenHash, ...(after !== undefined ? { after } : {}) });
    if (!out.ok) throw refused("run_over", "This run is over.", 409);
    const owner = this.ownerOf({ teamId: out.owner.teamId ? String(out.owner.teamId) : null, createdBy: String(out.owner.createdBy) });
    const messages = [];
    for (const m of out.messages) {
      const body = await openMessage(this.d.routines.keys, owner, m.iv, m.ct).catch(() => null);
      if (body?.text) messages.push({ text: body.text, who: m.authorName ?? (m.role === "ambient" ? "Ambient" : "Your owner"), at: m.createdAt });
    }
    return { messages, cursor: out.cursor };
  }

  /** The run answered a message it took in: into the thread now, not only at the end of the run. */
  /**
   * The run's message into its thread while it works: an answer to a message, or files it made
   * for its owner to see (send_file: a picture, a PDF), stored like the files people send.
   */
  async runReply(authorization: string | undefined, text: string, incoming: IncomingFile[] = []): Promise<void> {
    const runTokenHash = this.tokenHash(authorization);
    const who = await this.d.routines.control.q(api.bots.runOwner, { runTokenHash });
    if (!who) throw refused("run_over", "This run is over.", 409);
    const owner = this.ownerOf({ teamId: who.teamId ? String(who.teamId) : null, createdBy: String(who.createdBy) });
    const files = incoming.length && this.d.attachments ? await this.d.attachments.save(owner, { routineId: String(who.routineId) }, incoming) : [];
    const sealed = await sealMessage(this.d.routines.keys, owner, { text: text.trim().slice(0, MESSAGE_MAX), files });
    const out = await this.d.routines.control.m(api.bots.runReply, { runTokenHash, iv: sealed.iv, ct: sealed.ct, now: this.now() });
    if (!out.ok) throw refused("run_over", "This run is over.", 409);
    // This turn's answer is in the thread: its live text goes (the run goes on with the next).
    this.d.live?.endTurn(String(who.routineId));
  }
}
