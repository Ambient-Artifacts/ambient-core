// A bot's conversation lanes (the team wiki's product/conversations.md, "Bots: conversations and
// work"): each Slack or Teams thread it's written to in is a lane with a session of its own,
// resumed when that thread writes again; the app and DMs are its main lane. Scheduled runs and
// GitHub wake-ups are work: they start fresh with handoffs and don't touch a lane.
//
// Kept per bot and lane in the owner's sealed records (kind "bot-lane"): the session, and the
// newest thread message it has read (ms), so a resumed lane gets only what's new.
import { api, type Control } from "../control.ts";
import { sha256Hex } from "../crypto.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";

const KIND = "bot-lane";

export interface BotLane {
  session?: string;
  seen?: number;
  at: number;
}

const ownerArgs = (owner: Owner) => ({ ownerKind: owner.kind, ownerId: owner.kind === "user" ? owner.uid : owner.teamId });
const keyOf = (routineId: string, lane: string) => sha256Hex(`${routineId}\n${lane}`).slice(0, 40);

export class BotLanes {
  constructor(private d: { control: Control; keys: RoutineKeys; now?: () => number }) {}

  async get(owner: Owner, routineId: string, lane: string): Promise<BotLane | null> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind: KIND, key: keyOf(routineId, lane) })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    try {
      return JSON.parse(await this.d.keys.open(owner, `record:${KIND}`, r.iv, r.ct)) as BotLane;
    } catch {
      return null;
    }
  }

  async put(owner: Owner, routineId: string, lane: string, patch: Partial<BotLane>): Promise<void> {
    const next: BotLane = { ...((await this.get(owner, routineId, lane)) ?? {}), ...patch, at: this.d.now?.() ?? Date.now() };
    const sealed = await this.d.keys.seal(owner, `record:${KIND}`, JSON.stringify(next));
    await this.d.control.m(api.records.put, { ...ownerArgs(owner), kind: KIND, key: keyOf(routineId, lane), iv: sealed.iv, ct: sealed.ciphertext, size: sealed.ciphertext.length, byKind: "user", keep: 1, now: this.d.now?.() ?? Date.now() });
  }
}
