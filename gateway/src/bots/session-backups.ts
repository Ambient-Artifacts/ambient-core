// A lane's Claude Code session, backed up (the team wiki's product/conversations.md, "Sessions move
// with the lane"): after each answer the runner sends the session's file (gzipped); it's sealed
// with the lane's owner's key (the person's, or the team's) and kept in Convex, one per lane. A
// computer that doesn't have the session (wiped, replaced, or another one) gets it back before it
// resumes. A computer may only send or fetch the session of a lane it was just given a turn of.
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";

const LABEL = "session-backup";
/** Larger sessions (gzipped) aren't backed up: they start from the lane's turns instead. */
export const BACKUP_MAX = 12 * 1024 * 1024;

const ownerArgs = (owner: Owner) => ({ ownerKind: owner.kind, ownerId: owner.kind === "user" ? owner.uid : owner.teamId });

export class SessionBackups {
  constructor(private d: { control: Control; keys: RoutineKeys; now?: () => number }) {}

  async put(owner: Owner, lane: string, session: string, gz: Buffer): Promise<void> {
    if (gz.length > BACKUP_MAX) throw new Error("too big");
    const sealed = await this.d.keys.sealBytes(owner, `${LABEL}:${lane}`, gz);
    await this.d.control.a(api.sessionBackups.put, { ...ownerArgs(owner), lane, session, iv: sealed.iv, data: sealed.ciphertext, size: gz.length, now: this.d.now?.() ?? Date.now() });
  }

  async get(owner: Owner, lane: string): Promise<{ session: string; gz: Buffer } | null> {
    const r = (await this.d.control.a(api.sessionBackups.get, { ...ownerArgs(owner), lane })) as { session: string; iv: string; data: string } | null;
    if (!r) return null;
    return { session: r.session, gz: await this.d.keys.openBytes(owner, `${LABEL}:${lane}`, r.iv, r.data) };
  }

  /** All of an owner's backups (Forget chat), or one lane's (New chat). */
  async forget(owner: Owner, lane?: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const out = (await this.d.control.m(api.sessionBackups.forget, { ...ownerArgs(owner), ...(lane ? { lane } : {}) })) as { removed: number };
      if (!out.removed) break;
    }
  }
}
