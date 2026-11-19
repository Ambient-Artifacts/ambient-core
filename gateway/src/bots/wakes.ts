// Wake-ups (docs/bots.md, "Wake-ups"): a bot books times for itself with the runner's wake_me
// tool ("Tuesday 09:00: draft post 2, so my owner has two days to review it before Thursday").
// At its time the note goes into the bot's thread (author "Wake-up") and a run starts with it.
//
//   a run (its run token) ──▶ book() / list() / cancel() ──▶ Convex botWakes (the note sealed)
//   the app / MCP (its owner) ──▶ listFor() / bookFor() / cancelFor()
//   tick() every 30 s ──▶ wakes.due ──▶ wakes.fire ──▶ the thread, a run (at once on its long poll)
//
// With this a bot needs no schedule ("When it needs to"): it runs when it's written to, on its
// events, and when it booked itself. Guardrails in Convex (control/convex/wakes.ts): 5 booked at
// most, 10 minutes to 30 days ahead, an hour apart.
import { describeWake, wakeTime } from "@brain/spec";
import { api } from "../control.ts";
import { sha256Hex } from "../crypto.ts";
import { openMessage, sealMessage } from "./messages.ts";
import { RoutineError, RUN_TOKEN_PREFIX, type Actor, type RoutineService } from "../routines/service.ts";
import type { Owner } from "../routines/keys.ts";

export const WAKE_AUTHOR = "Wake-up";
const NOTE_MAX = 2_000;
const TICK_MS = 30_000;

export interface Wake {
  id: string;
  /** Milliseconds since 1970. */
  at: number;
  /** "Tue 24 Nov, 09:00", in the bot's time zone. */
  when: string;
  note: string;
  /** Booked by the bot itself (false: by its owner). */
  byBot: boolean;
}

interface WakeRow {
  id: string;
  routineId: string;
  at: number;
  iv: string;
  ct: string;
  byRun: boolean;
}

type Refusal = { ok: false; error: string; near?: WakeRow; pending?: WakeRow[] };

function refused(code: string, message: string, status = 400) {
  return new RoutineError(code, message, status);
}

export class Wakes {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private d: {
      routines: RoutineService;
      /** Starts a bot's run on its computer at once (its long poll) instead of at the next check. */
      startNow?: (hostId: string, routineId: string) => boolean;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private get control() {
    return this.d.routines.control;
  }

  private ownerOf(r: { teamId: string | null; createdBy: string }): Owner {
    return r.teamId ? { kind: "team", teamId: r.teamId } : { kind: "user", uid: r.createdBy };
  }

  private tokenHash(token: string | undefined): string {
    const t = token?.startsWith("Bearer ") ? token.slice(7).trim() : "";
    if (!t.startsWith(RUN_TOKEN_PREFIX)) throw refused("invalid_token", "This isn't a run's token.", 401);
    return sha256Hex(t);
  }

  private async view(owner: Owner, w: WakeRow, timezone: string): Promise<Wake> {
    const body = await openMessage(this.d.routines.keys, owner, w.iv, w.ct).catch(() => ({ text: "(couldn't be opened)" }));
    return { id: String(w.id), at: w.at, when: describeWake(w.at, timezone), note: body.text, byBot: w.byRun };
  }

  /** The time a bot or its owner wrote, or a clear refusal. */
  private instant(at: string, timezone: string): number {
    const ts = wakeTime(at, timezone);
    if (ts === null) throw refused("bad_time", `"${at}" isn't a time I can read. Write it like 2026-11-24 09:00 (in ${timezone}) or 2026-11-24T09:00:00+01:00.`);
    return ts;
  }

  private async refusal(out: Refusal, owner: Owner, timezone: string): Promise<never> {
    switch (out.error) {
      case "too_soon":
        throw refused("too_soon", "That's less than 10 minutes away: do it in this run instead.");
      case "too_far":
        throw refused("too_far", "Wake-ups go up to 30 days ahead. Book the nearest step now and the next one when you're up.");
      case "too_many": {
        const list = await Promise.all((out.pending ?? []).map((w) => this.view(owner, w, timezone)));
        throw refused("too_many", `There are 5 wake-ups booked already: ${list.map((w) => `${w.when} (${w.id})`).join(", ")}. Cancel one first, or do this at one of them.`);
      }
      case "too_close": {
        const near = out.near ? await this.view(owner, out.near, timezone) : null;
        throw refused("too_close", `There's one within an hour of that already${near ? `, at ${near.when} (${near.id}): "${near.note}"` : ""}. Do both then: cancel it and book one note for both.`);
      }
      case "no_such_wake":
        throw refused("no_such_wake", "There's no such wake-up booked (it may have happened already).", 404);
      case "admins_only":
        throw refused("admins_only", "Only the team's owners and admins can change its bots.", 403);
      case "no_such_bot":
        throw refused("no_such_bot", "There's no such bot.", 404);
      default:
        throw refused("run_over", "This run is over.", 409);
    }
  }

  // ---- a run's side (the runner's wake_me, cancel_wake_up) ----

  private async run(authorization: string | undefined) {
    const runTokenHash = this.tokenHash(authorization);
    const who = await this.control.q(api.bots.runOwner, { runTokenHash });
    const mine = who ? await this.control.q(api.wakes.forRun, { runTokenHash }) : null;
    if (!who || !mine) throw refused("run_over", "This run is over.", 409);
    const owner = this.ownerOf({ teamId: who.teamId ? String(who.teamId) : null, createdBy: String(who.createdBy) });
    return { runTokenHash, owner, timezone: mine.timezone, wakes: mine.wakes as unknown as WakeRow[] };
  }

  async book(authorization: string | undefined, at: string, note: string): Promise<{ wake: Wake; booked: Wake[] }> {
    const { runTokenHash, owner, timezone } = await this.run(authorization);
    const text = note.trim().slice(0, NOTE_MAX);
    if (!text) throw refused("bad_request", "Say what to do when you wake up (the note is your first message then).");
    const sealed = await sealMessage(this.d.routines.keys, owner, { text });
    const out = (await this.control.m(api.wakes.bookForRun, { runTokenHash, at: this.instant(at, timezone), iv: sealed.iv, ct: sealed.ct, now: this.now() })) as { ok: true; wake: WakeRow } | Refusal;
    if (!out.ok) return this.refusal(out, owner, timezone);
    const booked = await this.list(authorization);
    return { wake: await this.view(owner, out.wake, timezone), booked };
  }

  async list(authorization: string | undefined): Promise<Wake[]> {
    const { owner, timezone, wakes } = await this.run(authorization);
    return Promise.all(wakes.map((w) => this.view(owner, w, timezone)));
  }

  async cancel(authorization: string | undefined, wakeId: string): Promise<void> {
    const { runTokenHash, owner, timezone } = await this.run(authorization);
    const out = (await this.control.m(api.wakes.cancelForRun, { runTokenHash, wakeId })) as { ok: true } | Refusal;
    if (!out.ok) await this.refusal(out, owner, timezone);
  }

  /** What a run starts with: its booked wake-ups and the time now, where it books them. */
  async forRun(r: { id: string; teamId: string | null; createdBy: string; timezone: string }): Promise<{ timezone: string; now: string; wakes: Wake[] }> {
    const owner = this.ownerOf(r);
    const list = (await this.control.q(api.wakes.list, { uid: r.createdBy as never, teamIds: (r.teamId ? [r.teamId] : []) as never, id: r.id }).catch(() => null)) as { timezone: string; wakes: WakeRow[] } | null;
    const wakes = list ? await Promise.all(list.wakes.map((w) => this.view(owner, w, r.timezone))) : [];
    return { timezone: r.timezone, now: describeWake(this.now(), r.timezone), wakes };
  }

  // ---- its owner's side (the app, MCP) ----

  async listFor(actor: Actor, id: string): Promise<{ timezone: string; wakes: Wake[] }> {
    const { r, access } = await this.d.routines.botAccess(actor, id);
    const out = (await this.control.q(api.wakes.list, { ...access, id })) as { timezone: string; wakes: WakeRow[] } | null;
    if (!out) throw refused("no_such_bot", "There's no such bot.", 404);
    return { timezone: r.timezone, wakes: await Promise.all(out.wakes.map((w) => this.view(this.ownerOf(r), w, r.timezone))) };
  }

  async bookFor(actor: Actor, id: string, at: string, note: string): Promise<Wake> {
    const { r, access } = await this.d.routines.botAccess(actor, id, true);
    const owner = this.ownerOf(r);
    const text = note.trim().slice(0, NOTE_MAX);
    if (!text) throw refused("bad_request", "Say what the bot should do when it wakes up.");
    const sealed = await sealMessage(this.d.routines.keys, owner, { text });
    const out = (await this.control.m(api.wakes.bookForOwner, { ...access, id, at: this.instant(at, r.timezone), iv: sealed.iv, ct: sealed.ct, now: this.now() })) as { ok: true; wake: WakeRow } | Refusal;
    if (!out.ok) return this.refusal(out, owner, r.timezone);
    return this.view(owner, out.wake, r.timezone);
  }

  async cancelFor(actor: Actor, id: string, wakeId: string, by: string): Promise<void> {
    const { r, access } = await this.d.routines.botAccess(actor, id, true);
    const out = (await this.control.m(api.wakes.cancelForOwner, { ...access, id, wakeId, by })) as { ok: true } | Refusal;
    if (!out.ok) await this.refusal(out, this.ownerOf(r), r.timezone);
  }

  // ---- firing ----

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fires every wake-up that's due; returns how many. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let fired = 0;
    try {
      const due = (await this.control.q(api.wakes.due, { now: this.now(), limit: 50 })) as unknown as WakeRow[];
      for (const w of due) {
        const out = (await this.control.m(api.wakes.fire, { wakeId: String(w.id), now: this.now() }).catch((err: Error) => {
          console.warn(`[wakes] couldn't fire ${w.id}: ${err.message}`);
          return { ok: false };
        })) as { ok: boolean; hostId?: string | null; enabled?: boolean; routineId?: string };
        if (!out.ok) continue;
        fired++;
        if (out.enabled && out.hostId) this.d.startNow?.(String(out.hostId), String(out.routineId));
      }
    } catch (err) {
      console.warn(`[wakes] ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
    return fired;
  }
}
