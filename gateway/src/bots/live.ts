// A bot's answer as it's written (docs/bots.md, "Live text"): the runner sends the text Claude
// Code is writing (and the tool it's using) a few times a second, and everyone who may read the
// bot's thread sees it grow in the app, like Claude's own apps. In memory only: nothing here is
// stored, and the message itself still lands in the thread (sealed, in Convex) when the turn ends.
//
//   runner ──POST /v1/host/runs/:runId/live {seq, text, tool}──▶ update() ──▶ each reader's
//   /v1/app/events stream (event: bot_live) · the thread (GET …/thread: `live`) when it opens
//
// The readers are resolved once per run (Convex bots.liveAudience): the owner, or the team's people.
import { api, type Control } from "../control.ts";

/** What a reader gets: the text so far, or `done` once the message is in the thread. */
export interface LiveEvent {
  routineId: string;
  runId: string;
  /** Grows while it's written; the latest block of text (a new one starts after a tool). */
  text: string;
  /** The tool it's using now ("Bash: npm run build"), null while it writes. */
  tool: string | null;
  seq: number;
  done?: boolean;
}

interface LiveRun {
  routineId: string;
  uids: string[];
  last: LiveEvent | null;
  at: number;
}

/** A run's live text goes stale after this long without news (a runner that died mid-run). */
const STALE_MS = 10 * 60_000;
const TEXT_MAX = 8_000;
const TOOL_MAX = 200;

export class LiveText {
  private runs = new Map<string, LiveRun>();
  private resolving = new Map<string, Promise<LiveRun | null>>();
  private listeners = new Map<string, Set<(e: LiveEvent) => void>>();

  constructor(private d: { control: Control; now?: () => number }) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** A reader's stream: every live event of the bots they may read. */
  subscribe(uid: string, listener: (e: LiveEvent) => void): () => void {
    let set = this.listeners.get(uid);
    if (!set) {
      set = new Set();
      this.listeners.set(uid, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(uid);
    };
  }

  private emit(run: LiveRun, e: LiveEvent): void {
    for (const uid of run.uids) for (const l of this.listeners.get(uid) ?? []) l(e);
  }

  private async run(hostId: string, runId: string): Promise<LiveRun | null> {
    const known = this.runs.get(runId);
    if (known) return known;
    let pending = this.resolving.get(runId);
    if (!pending) {
      pending = (async () => {
        const who = (await this.d.control.q(api.bots.liveAudience, { hostId: hostId as never, runId })) as { routineId: string; uids: string[] } | null;
        if (!who) return null;
        const run: LiveRun = { routineId: String(who.routineId), uids: who.uids.map(String), last: null, at: this.now() };
        this.runs.set(runId, run);
        return run;
      })().finally(() => this.resolving.delete(runId));
      this.resolving.set(runId, pending);
    }
    return pending;
  }

  /** From the runner: the text so far. Older updates (by `seq`) than the last one are dropped. */
  async update(hostId: string, runId: string, body: { seq: number; text: string; tool?: string | null }): Promise<boolean> {
    this.sweep();
    const run = await this.run(hostId, runId);
    if (!run) return false;
    if (run.last && body.seq <= run.last.seq) return true;
    const e: LiveEvent = { routineId: run.routineId, runId, text: body.text.slice(-TEXT_MAX), tool: body.tool ? body.tool.slice(0, TOOL_MAX) : null, seq: body.seq };
    run.last = e;
    run.at = this.now();
    this.emit(run, e);
    return true;
  }

  /** The run is over: its message is in the thread (or it failed); readers drop the live text. */
  end(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    this.emit(run, { routineId: run.routineId, runId, text: "", tool: null, seq: (run.last?.seq ?? 0) + 1, done: true });
  }

  /**
   * A turn's message is in the thread while the run goes on (a run answering messages that came
   * in): readers drop this turn's text; the next turn's comes as it's written.
   */
  endTurn(routineId: string): void {
    for (const [runId, run] of this.runs) {
      if (run.routineId !== routineId || !run.last) continue;
      const seq = run.last.seq;
      run.last = null;
      this.emit(run, { routineId, runId, text: "", tool: null, seq, done: true });
    }
  }

  /** The text so far of a bot's run, for a thread that opens while it's written. */
  snapshot(routineId: string): LiveEvent | null {
    this.sweep();
    for (const run of this.runs.values()) if (run.routineId === routineId && run.last) return run.last;
    return null;
  }

  private sweep(): void {
    const cutoff = this.now() - STALE_MS;
    for (const [runId, run] of this.runs) if (run.at < cutoff) this.end(runId);
  }
}
