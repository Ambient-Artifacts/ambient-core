// Amb's settings per person (docs/bots.md, "Amb's settings"). Watching the bots is part of Amb's
// job, not an automation: "notify" says whether it tells the person when something needs them
// (the heartbeat: a failed run, a decision waiting long, an approval) or never. A sealed record.
import { api, type Control } from "../control.ts";
import type { RoutineKeys } from "../routines/keys.ts";

export const NOTIFY = ["important", "never"] as const;
export type Notify = (typeof NOTIFY)[number];

export interface AmbSettingsView {
  notify: Notify;
}

const KIND = "amb-settings";

export class AmbSettings {
  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      /** "Watch my bots" switched off back when it was an automation: notify "never" until set here. */
      legacyOff?: (uid: string) => Promise<boolean>;
      now?: () => number;
    },
  ) {}

  async get(uid: string): Promise<AmbSettingsView> {
    const r = (await this.d.control.q(api.records.get, { ownerKind: "user", ownerId: uid, kind: KIND, key: "settings" })) as { iv: string; ct: string; deleted: boolean } | null;
    if (r && !r.deleted) {
      const raw = await this.d.keys.open({ kind: "user", uid }, `record:${KIND}`, r.iv, r.ct).catch(() => null);
      try {
        const v = raw ? (JSON.parse((JSON.parse(raw) as { c: string }).c) as Partial<AmbSettingsView>) : {};
        if (v.notify && (NOTIFY as readonly string[]).includes(v.notify)) return { notify: v.notify };
      } catch {
        // Unreadable: the defaults.
      }
    }
    return { notify: (await this.d.legacyOff?.(uid).catch(() => false)) ? "never" : "important" };
  }

  async set(uid: string, patch: Partial<AmbSettingsView>): Promise<AmbSettingsView> {
    const next = { ...(await this.get(uid)), ...patch };
    const content = JSON.stringify(next);
    const sealed = await this.d.keys.seal({ kind: "user", uid }, `record:${KIND}`, JSON.stringify({ c: content }));
    await this.d.control.m(api.records.put, { ownerKind: "user", ownerId: uid, kind: KIND, key: "settings", iv: sealed.iv, ct: sealed.ciphertext, size: content.length, byKind: "user", keep: 1, now: this.d.now?.() ?? Date.now() });
    return next;
  }

  /** Whether the heartbeat tells this person anything. */
  async notifies(uid: string): Promise<boolean> {
    return (await this.get(uid)).notify !== "never";
  }
}
