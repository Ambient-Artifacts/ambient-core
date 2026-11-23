// Ambient on the person's own computer: their runner keeps one Claude Code session open there,
// signed in with their own Claude plan, and stays connected to the gateway (a long poll). A chat
// message goes to it at once; the reply comes back the same way. The session has Ambient's tools
// (a personal token, renewed daily) and the computer's own, so Ambient can work on that machine.
//
//   app ──▶ AmbientChat ──▶ ask(host) ──▶ queue ──▶ GET /v1/host/ambient/next (the runner waits here)
//                                     ◀── reply ◀── POST /v1/host/ambient/:jobId
//
// Ambient's own turns (a bot's question, the heartbeat) go the same way with mode "internal": the
// runner answers them in a short session beside the chat's, never in it.
//
// One gateway process holds the queues: a restart loses a message in flight, and the chat says so.
import { randomUUID } from "node:crypto";
import type { PatService } from "../auth/pats.ts";
import type { Turn } from "../ai/loop.ts";
import type { LlmAnswer, WireRequest } from "@brain/team";
import type { RelayRequest, RelayResponse } from "../relay.ts";

/** A file Ambient made on the computer for the person (its outbox), as it comes with a reply. */
export interface OutboxFile {
  name: string;
  type: string;
  data: string;
}

/** Work for the computer that isn't a chat message: a root command, or a bot run to start now. */
export type ControlJob =
  | { id: string; kind: "exec"; command: string; timeoutS: number }
  | { id: string; kind: "start"; routineId: string }
  /** Sign Codex in on the computer with a ChatGPT plan (device code): the runner sends back the link and code. */
  | { id: string; kind: "codex-login" }
  /**
   * One structured answer from Claude Code there, for the brain's upkeep (docs/architecture.md,
   * "Upkeep on your computer"): no tools, no MCP, no settings, no saved session.
   */
  | ({ id: string; kind: "complete" } & WireRequest)
  /** A request for the team's brain on this computer (relay.ts): the runner passes it to 127.0.0.1. */
  | ({ id: string; kind: "http" } & RelayRequest);

export interface ComputerJob {
  id: string;
  kind?: "chat";
  /**
   * chat: the person's message, in their open session. internal: Ambient's own turn (a bot's
   * question, the heartbeat), in a short session of its own, so it neither waits behind the chat
   * nor ends up in its history. Runners before 0.7.7 don't know it and use the chat's session.
   */
  mode?: "chat" | "internal";
  /** Whose chat it is (a team's server runs Ambient for each of its people, one session each). */
  uid: string;
  /** What the person wrote. */
  text: string;
  /** Their name, and Ambient's instructions (the session's system prompt). */
  name: string;
  instructions: string;
  /** The chat was cleared (or is new): start a new session; `history` is what it starts from. */
  fresh: boolean;
  history: Turn[];
  /** Amb's skills (docs/bots.md, "One folder for every bot"): the runner puts them in the session's folder. */
  skills?: { path: string; content: string }[];
  /**
   * The MCP servers the person gave Amb (docs/bots.md, "MCP connections"): each by the name its
   * tools carry and its address at the gateway, reached with the session's own token (runner 0.16.0).
   */
  mcp?: { name: string; path: string }[];
  /** Files sent with the message (base64); the computer saves them in the person's folder. */
  attachments?: { name: string; type: string; data: string }[];
  /** The person's token for Ambient's MCP (the same until it's renewed). */
  token: string;
}

interface Waiter {
  resolve: (job: ComputerJob | ControlJob | null) => void;
  timer: NodeJS.Timeout;
}

/** A computer that asked for work this recently is connected. */
const CONNECTED_MS = 60_000;
const TOKEN_TTL_MS = 24 * 3600_000;
const TOKEN_RENEW_MS = 3600_000;
/** In a token's key: it's for one team only. */
const TEAM_KEY = "#team:";
const REPLY_TIMEOUT_MS = 15 * 60_000;
/** How long one of upkeep's answers may take on the computer (the runner stops Claude Code at 4 min). */
const COMPLETE_TIMEOUT_MS = 5 * 60_000;

/** The computer can't take the work now: not connected, or it didn't answer in time. */
export class ComputerUnavailable extends Error {
  constructor(readonly reason: "offline" | "timeout" | "no_computer") {
    super(reason === "no_computer" ? "no computer is connected" : reason === "offline" ? "the computer isn't connected" : "the computer didn't answer in time");
  }
}

export class AmbientComputers {
  private queues = new Map<string, (ComputerJob | ControlJob)[]>();
  private waiters = new Map<string, Waiter>();
  private seen = new Map<string, number>();
  private pending = new Map<string, { hostId: string; resolve: (text: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  /** Files that came with a reply, until `askWithFiles` takes them. */
  private replyFiles = new Map<string, OutboxFile[]>();
  private relays = new Map<string, { hostId: string; resolve: (r: RelayResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private d: {
      pats: PatService;
      scopes: string[];
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Whether the computer is connected (it's waiting for work, or asked within the last minute). */
  connected(hostId: string): boolean {
    return this.waiters.has(hostId) || this.now() - (this.seen.get(hostId) ?? 0) < CONNECTED_MS;
  }

  /** The person's token for Ambient's tools on that computer, renewed a day at a time. */
  /** With `teamId`: a token for that team alone (a team's Amb in a channel: nothing personal reaches it). */
  private async token(hostId: string, uid: string, computer: string, teamId?: string): Promise<string> {
    const key = teamId ? `${hostId}:${uid}${TEAM_KEY}${teamId}` : `${hostId}:${uid}`;
    const t = this.tokens.get(key);
    if (t && t.expiresAt - this.now() > TOKEN_RENEW_MS) return t.token;
    const expiresAt = this.now() + TOKEN_TTL_MS;
    const made = await this.d.pats.create({ uid, scopes: this.d.scopes, resource: teamId ? { kind: "team", teamId } : { kind: "personal" }, label: teamId ? `Ambient for a team on ${computer}` : `Ambient on ${computer}`, expiresAt });
    this.tokens.set(key, { token: made.token, expiresAt });
    return made.token;
  }

  /** Whose token this is, when it's one handed to Amb's session on a computer and still good (the relay's check). */
  uidOfToken(token: string): string | null {
    for (const [key, t] of this.tokens) {
      // A team's token reaches no one's own MCP connections.
      if (t.token === token && t.expiresAt > this.now() && !key.includes(TEAM_KEY)) return key.slice(key.indexOf(":") + 1);
    }
    return null;
  }

  /** Hand a message to the computer and wait for Ambient's reply there. */
  async ask(host: { id: string; uid: string; name: string }, job: Omit<ComputerJob, "id" | "token" | "uid">): Promise<string> {
    return (await this.askWithFiles(host, job)).text;
  }

  /** As `ask`, with the files Ambient made for the person there (its outbox), if any. */
  async askWithFiles(host: { id: string; uid: string; name: string }, job: Omit<ComputerJob, "id" | "token" | "uid">, opts: { teamId?: string } = {}): Promise<{ text: string; files: OutboxFile[] }> {
    const full: ComputerJob = { ...job, id: randomUUID(), uid: host.uid, token: await this.token(host.id, host.uid, host.name, opts.teamId) };
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(full.id);
        reject(new Error("no reply from the computer"));
      }, REPLY_TIMEOUT_MS);
      timer.unref();
      this.pending.set(full.id, { hostId: host.id, resolve, reject, timer });
    });
    this.hand(host.id, full);
    const text = await reply;
    const files = this.replyFiles.get(full.id) ?? [];
    this.replyFiles.delete(full.id);
    return { text, files };
  }

  /** To the computer's waiting long poll, or first in its queue. */
  private hand(hostId: string, job: ComputerJob | ControlJob) {
    const waiter = this.waiters.get(hostId);
    if (waiter) {
      this.waiters.delete(hostId);
      clearTimeout(waiter.timer);
      waiter.resolve(job);
    } else {
      this.queues.set(hostId, [...(this.queues.get(hostId) ?? []), job]);
    }
  }

  /** Run a command as root on the computer (its runner, as root) and wait for its output. */
  exec(hostId: string, command: string, timeoutS = 120): Promise<{ code: number; output: string }> {
    const job: ControlJob = { id: randomUUID(), kind: "exec", command, timeoutS };
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        reject(new Error("the computer didn't answer"));
      }, (timeoutS + 30) * 1000);
      timer.unref();
      this.pending.set(job.id, { hostId, resolve, reject, timer });
    });
    this.hand(hostId, job);
    return done.then((text) => {
      try {
        const out = JSON.parse(text) as { code?: number; output?: string };
        return { code: typeof out.code === "number" ? out.code : -1, output: String(out.output ?? "") };
      } catch {
        return { code: -1, output: text };
      }
    });
  }

  /**
   * Start Codex's ChatGPT sign-in on the computer (docs/bots.md, "Codex next to Claude Code"): the
   * runner starts `codex login --device-auth` as the routine user and sends back the link and the
   * one-time code; the person finishes it in their browser, and the computer's next sync says it's
   * signed in.
   */
  async codexLogin(hostId: string, waitMs = 90_000): Promise<{ url: string; code: string; expiresAt: number }> {
    if (!this.connected(hostId)) throw new Error("not_connected");
    const job: ControlJob = { id: randomUUID(), kind: "codex-login" };
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        reject(new Error("the computer didn't answer"));
      }, waitMs);
      timer.unref();
      this.pending.set(job.id, { hostId, resolve, reject, timer });
      this.hand(hostId, job);
    });
    const out = JSON.parse(text) as { url?: unknown; code?: unknown; expiresAt?: unknown };
    if (typeof out.url !== "string" || !/^https:\/\//.test(out.url) || typeof out.code !== "string") throw new Error("the computer sent no sign-in code");
    return { url: out.url, code: out.code, expiresAt: typeof out.expiresAt === "number" ? out.expiresAt : this.now() + 15 * 60_000 };
  }

  /**
   * One structured answer from Claude Code on the computer, signed in with its Claude: the brain's
   * upkeep runs there instead of on Ambient's key. Rejects when the computer isn't connected or
   * doesn't answer in time; the answer's shape is checked by the caller.
   */
  async complete(hostId: string, req: WireRequest, waitMs = COMPLETE_TIMEOUT_MS): Promise<LlmAnswer> {
    if (!this.connected(hostId)) throw new ComputerUnavailable("offline");
    const job: ControlJob = { id: randomUUID(), kind: "complete", ...req };
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        this.unqueue(hostId, job.id);
        reject(new ComputerUnavailable("timeout"));
      }, waitMs);
      timer.unref();
      this.pending.set(job.id, { hostId, resolve, reject, timer });
      this.hand(hostId, job);
    });
    let out: { output?: unknown; usage?: Partial<LlmAnswer["usage"]> };
    try {
      out = JSON.parse(text);
    } catch {
      throw new Error(`the computer's answer to the ${req.what} wasn't JSON`);
    }
    if (out.output === undefined) throw new Error(`the computer sent no ${req.what}`);
    const u = out.usage ?? {};
    return { output: out.output, usage: { input_tokens: Number(u.input_tokens) || 0, output_tokens: Number(u.output_tokens) || 0, cache_read_tokens: Number(u.cache_read_tokens) || 0 } };
  }

  /**
   * A request for the team's brain on the computer (relay.ts), answered as the team server answered
   * it. Rejects when the computer isn't connected or doesn't answer within `timeoutMs`.
   */
  relay(hostId: string, req: RelayRequest, timeoutMs: number): Promise<RelayResponse> {
    if (!this.connected(hostId)) return Promise.reject(new ComputerUnavailable("offline"));
    const job: ControlJob = { id: randomUUID(), kind: "http", ...req };
    return new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.relays.delete(job.id);
        this.unqueue(hostId, job.id);
        reject(new ComputerUnavailable("timeout"));
      }, timeoutMs);
      timer.unref();
      this.relays.set(job.id, { hostId, resolve, reject, timer });
      this.hand(hostId, job);
    });
  }

  /** The team server's answer to a relayed request, from the computer. */
  relayed(hostId: string, jobId: string, res: RelayResponse | { error: string }): boolean {
    const p = this.relays.get(jobId);
    if (!p || p.hostId !== hostId) return false;
    this.relays.delete(jobId);
    clearTimeout(p.timer);
    if ("error" in res) p.reject(new Error(res.error));
    else p.resolve(res);
    return true;
  }

  /** A job that timed out before the computer took it leaves its queue. */
  private unqueue(hostId: string, jobId: string) {
    const q = this.queues.get(hostId);
    if (!q) return;
    const left = q.filter((j) => j.id !== jobId);
    if (left.length) this.queues.set(hostId, left);
    else this.queues.delete(hostId);
  }

  /** Start a bot's run on the computer now (a message to it), instead of at its next check. */
  start(hostId: string, routineId: string): boolean {
    if (!this.connected(hostId)) return false;
    this.hand(hostId, { id: randomUUID(), kind: "start", routineId });
    return true;
  }

  /** The computer waits up to `waitMs` for the next message (null: nothing yet, ask again). */
  next(hostId: string, waitMs: number): Promise<ComputerJob | ControlJob | null> {
    this.seen.set(hostId, this.now());
    const queued = this.queues.get(hostId);
    if (queued?.length) {
      const job = queued.shift()!;
      if (!queued.length) this.queues.delete(hostId);
      return Promise.resolve(job);
    }
    // A second connection from the same computer replaces the first.
    const old = this.waiters.get(hostId);
    if (old) {
      clearTimeout(old.timer);
      old.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(hostId);
        this.seen.set(hostId, this.now());
        resolve(null);
      }, waitMs);
      timer.unref();
      this.waiters.set(hostId, { resolve, timer });
    });
  }

  /** The computer's reply to a message it took, with the files Ambient put in its outbox. */
  reply(hostId: string, jobId: string, text: string, files: OutboxFile[] = []): boolean {
    const p = this.pending.get(jobId);
    if (!p || p.hostId !== hostId) return false;
    if (files.length) this.replyFiles.set(jobId, files);
    this.pending.delete(jobId);
    clearTimeout(p.timer);
    p.resolve(text);
    return true;
  }

  /** The computer couldn't answer (its Claude Code failed): the chat says why. */
  fail(hostId: string, jobId: string, why: string): boolean {
    const p = this.pending.get(jobId);
    if (!p || p.hostId !== hostId) return false;
    this.pending.delete(jobId);
    clearTimeout(p.timer);
    p.reject(new Error(why));
    return true;
  }

  /** A waiting long poll stops (its connection closed). */
  drop(hostId: string) {
    const w = this.waiters.get(hostId);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(hostId);
    w.resolve(null);
  }

  /** A message handed to a connection that had just closed goes first in line again. */
  requeue(hostId: string, job: ComputerJob | ControlJob) {
    this.queues.set(hostId, [job, ...(this.queues.get(hostId) ?? [])]);
  }
}
