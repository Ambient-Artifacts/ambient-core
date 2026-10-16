// What changed, for the apps (control/convex/revisions.ts). The gateway bumps a team's wiki
// revision when it delivers to the team, and streams each connected user's revisions from
// Convex: one live subscription per user, shared by all their open apps. Convex is the fan-out,
// so more gateway processes need nothing in between (Nikolai, 2026-10-13: use Convex, not Redis).
import type { ConvexClient } from "convex/browser";
import { api, type Control } from "./control.ts";

/** A user's revisions, as `revisions.forUser` returns them. */
export interface UserRevisions {
  personal: number;
  routines: string;
  teams: { slug: string; wiki: number }[];
}

export class Revisions {
  constructor(private control: Control) {}

  /** A team's wiki changed (a note or work session was stored). Never throws: a missed bump only delays the apps. */
  async teamChanged(teamId: string): Promise<void> {
    try {
      await this.control.m(api.revisions.bumpTeam, { teamId: teamId as never });
    } catch (err) {
      console.error("[gateway] revision bump failed", (err as Error).message);
    }
  }

  /** The health check saw the team server's git head; true when it moved. */
  async teamHead(teamId: string, head: string): Promise<boolean> {
    const out = await this.control.m(api.revisions.noteTeamHead, { teamId: teamId as never, head });
    return out.changed;
  }

  forUser(uid: string): Promise<UserRevisions | null> {
    return this.control.q(api.revisions.forUser, { uid: uid as never });
  }
}

/** Where a user's revisions come from, as they change. Returns a function that stops it. */
export interface RevisionSource {
  watch(uid: string, onChange: (r: UserRevisions | null) => void): () => void;
}

/** Live: Convex pushes a new answer whenever anything `forUser` read changes. */
export class ConvexRevisionSource implements RevisionSource {
  constructor(
    private client: ConvexClient,
    private secret: string,
  ) {}

  watch(uid: string, onChange: (r: UserRevisions | null) => void): () => void {
    const stop = this.client.onUpdate(api.revisions.forUser, { secret: this.secret, uid: uid as never }, onChange, (err) =>
      console.error("[gateway] revisions subscription", err.message),
    );
    return () => stop();
  }
}

/** Asks Convex every `everyMs` and reports changes: the tests (convex-test has no live queries). */
export class PollingRevisionSource implements RevisionSource {
  constructor(
    private revisions: Revisions,
    private everyMs: number,
  ) {}

  watch(uid: string, onChange: (r: UserRevisions | null) => void): () => void {
    let stopped = false;
    let last: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await this.revisions.forUser(uid);
        const key = JSON.stringify(r);
        if (!stopped && key !== last) {
          last = key;
          onChange(r);
        }
      } catch {
        // Try again next time.
      }
      if (!stopped) timer = setTimeout(tick, this.everyMs);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
}

/**
 * Each connected user's revisions, fanned out to their open streams. One source subscription
 * per user, started with their first stream and stopped with their last; a new stream gets the
 * latest answer at once.
 */
export class EventHub {
  private users = new Map<string, { stop: () => void; last?: UserRevisions | null; listeners: Set<(r: UserRevisions | null) => void> }>();

  constructor(private source: RevisionSource) {}

  subscribe(uid: string, listener: (r: UserRevisions | null) => void): () => void {
    let entry = this.users.get(uid);
    if (!entry) {
      const fresh: { stop: () => void; last?: UserRevisions | null; listeners: Set<(r: UserRevisions | null) => void> } = { stop: () => {}, listeners: new Set() };
      this.users.set(uid, fresh);
      fresh.stop = this.source.watch(uid, (r) => {
        fresh.last = r;
        for (const l of fresh.listeners) l(r);
      });
      entry = fresh;
    }
    entry.listeners.add(listener);
    if (entry.last !== undefined) listener(entry.last);
    const current = entry;
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size === 0 && this.users.get(uid) === current) {
        current.stop();
        this.users.delete(uid);
      }
    };
  }

  /** How many users have an open stream (health and tests). */
  get size(): number {
    return this.users.size;
  }
}
