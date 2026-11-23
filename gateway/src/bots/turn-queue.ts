// Amb's turns in flight, kept in Convex (control/convex/turns.ts; the team wiki's
// product/conversations.md, "Running"): written before a turn starts, removed once its answer is
// out. When the gateway starts, turns a previous process left behind are picked up again by kind,
// so a restart in the middle of an answer no longer leaves a message unanswered.
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";

const PURPOSE = "turn";
/** A turn older than this at start was left by an earlier process (this one hasn't started any yet). */
const LEFT_AFTER_MS = 5_000;

export type TurnHandler = (owner: Owner, payload: Record<string, unknown>) => Promise<void>;

const ownerArgs = (owner: Owner) => ({ ownerKind: owner.kind, ownerId: owner.kind === "user" ? owner.uid : owner.teamId });

export class TurnQueue {
  private handlers = new Map<string, TurnHandler>();

  constructor(private d: { control: Control; keys: RoutineKeys; now?: () => number }) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** What picks a kind of turn up again after a restart. */
  on(kind: string, handler: TurnHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Writes a turn down before it starts; its id, for `done`. Null when it couldn't (the turn goes on anyway). */
  async enqueue(owner: Owner, kind: string, payload: Record<string, unknown>): Promise<string | null> {
    try {
      const sealed = await this.d.keys.seal(owner, PURPOSE, JSON.stringify(payload));
      return String(await this.d.control.m(api.turns.enqueue, { kind, ...ownerArgs(owner), iv: sealed.iv, ct: sealed.ciphertext, now: this.now() }));
    } catch (err) {
      console.warn(`[turns] a turn wasn't written down: ${(err as Error).message}`);
      return null;
    }
  }

  async done(id: string | null): Promise<void> {
    if (id) await this.d.control.m(api.turns.done, { id }).catch((err: Error) => console.warn(`[turns] a finished turn stayed listed: ${err.message}`));
  }

  /** At start: the turns an earlier process left behind, each tried again (3 times at most). */
  async recover(): Promise<number> {
    const rows = (await this.d.control.q(api.turns.leftovers, { before: this.now() - LEFT_AFTER_MS })) as { id: string; kind: string; ownerKind: "user" | "team"; ownerId: string; iv: string; ct: string }[];
    let picked = 0;
    for (const r of rows) {
      const handler = this.handlers.get(r.kind);
      if (!handler || !(await this.d.control.m(api.turns.attempt, { id: r.id }))) continue;
      const owner: Owner = r.ownerKind === "team" ? { kind: "team", teamId: r.ownerId } : { kind: "user", uid: r.ownerId };
      try {
        const payload = JSON.parse(await this.d.keys.open(owner, PURPOSE, r.iv, r.ct)) as Record<string, unknown>;
        await handler(owner, payload);
        await this.done(r.id);
        picked++;
      } catch (err) {
        console.warn(`[turns] a ${r.kind} turn couldn't be picked up again: ${(err as Error).message}`);
      }
    }
    if (picked) console.log(`[turns] picked up ${picked} turn(s) left by the last start`);
    return picked;
  }
}
