// Ambient on the person's own computer: their runner keeps one Claude Code session open there,
// signed in with their own Claude plan, and stays connected to the gateway (a long poll). A chat
// message goes to it at once; the reply comes back the same way. The session has Ambient's tools
// (a personal token, renewed daily) and the computer's own, so Ambient can work on that machine.
//
//   app ──▶ AmbientChat ──▶ ask(host) ──▶ queue ──▶ GET /v1/host/ambient/next (the runner waits here)
//                                     ◀── reply ◀── POST /v1/host/ambient/:jobId
//
// One gateway process holds the queues: a restart loses a message in flight, and the chat says so.
import { randomUUID } from "node:crypto";
import type { PatService } from "../auth/pats.ts";
import type { Turn } from "../ai/loop.ts";

/** Work for the computer that isn't a chat message: a root command, or a bot run to start now. */
export type ControlJob = { id: string; kind: "exec"; command: string; timeoutS: number } | { id: string; kind: "start"; routineId: string };

export interface ComputerJob {
  id: string;
  kind?: "chat";
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
const REPLY_TIMEOUT_MS = 15 * 60_000;

export class AmbientComputers {
  private queues = new Map<string, (ComputerJob | ControlJob)[]>();
  private waiters = new Map<string, Waiter>();
  private seen = new Map<string, number>();
  private pending = new Map<string, { hostId: string; resolve: (text: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private tokens = new Map<string, { token: string; expiresAt: number }>();

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
  private async token(hostId: string, uid: string, computer: string): Promise<string> {
    const key = `${hostId}:${uid}`;
    const t = this.tokens.get(key);
    if (t && t.expiresAt - this.now() > TOKEN_RENEW_MS) return t.token;
    const expiresAt = this.now() + TOKEN_TTL_MS;
    const made = await this.d.pats.create({ uid, scopes: this.d.scopes, resource: { kind: "personal" }, label: `Ambient on ${computer}`, expiresAt });
    this.tokens.set(key, { token: made.token, expiresAt });
    return made.token;
  }

  /** Hand a message to the computer and wait for Ambient's reply there. */
  async ask(host: { id: string; uid: string; name: string }, job: Omit<ComputerJob, "id" | "token" | "uid">): Promise<string> {
    const full: ComputerJob = { ...job, id: randomUUID(), uid: host.uid, token: await this.token(host.id, host.uid, host.name) };
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(full.id);
        reject(new Error("no reply from the computer"));
      }, REPLY_TIMEOUT_MS);
      timer.unref();
      this.pending.set(full.id, { hostId: host.id, resolve, reject, timer });
    });
    this.hand(host.id, full);
    return reply;
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

  /** The computer's reply to a message it took. */
  reply(hostId: string, jobId: string, text: string): boolean {
    const p = this.pending.get(jobId);
    if (!p || p.hostId !== hostId) return false;
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
