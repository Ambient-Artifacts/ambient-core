// Amb's settings per person (docs/bots.md, "Amb's settings"). Watching the bots is part of Amb's
// job, not an automation: "notify" says whether it tells the person when something needs them
// (the heartbeat: a failed run, a decision waiting long, an approval) or never; "reach" says where
// Amb writes first: the app (a push) or a channel they connected (docs/bots.md, "Channels").
// A sealed record.
import { api, type Control } from "../control.ts";
import type { RoutineKeys } from "../routines/keys.ts";

export const NOTIFY = ["important", "never"] as const;
export type Notify = (typeof NOTIFY)[number];
/** Where Amb can write first: the app, or a channel (channels/reach.ts). */
export const REACH = ["app", "imessage"] as const;

export interface AmbSettingsView {
  notify: Notify;
  /** Where Amb writes first: "app" (a push), or a channel the person connected ("imessage"). */
  reach: string;
}

export class AmbSettingsError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const KIND = "amb-settings";

export class AmbSettings {
  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      /** "Watch my bots" switched off back when it was an automation: notify "never" until set here. */
      legacyOff?: (uid: string) => Promise<boolean>;
      /** Whether the person connected that channel (channels/reach.ts). */
      canReach?: (uid: string, kind: string) => Promise<boolean>;
      now?: () => number;
    },
  ) {}

  async get(uid: string): Promise<AmbSettingsView> {
    const r = (await this.d.control.q(api.records.get, { ownerKind: "user", ownerId: uid, kind: KIND, key: "settings" })) as { iv: string; ct: string; deleted: boolean } | null;
    if (r && !r.deleted) {
      const raw = await this.d.keys.open({ kind: "user", uid }, `record:${KIND}`, r.iv, r.ct).catch(() => null);
      try {
        const v = raw ? (JSON.parse((JSON.parse(raw) as { c: string }).c) as Partial<AmbSettingsView>) : {};
        if (v.notify && (NOTIFY as readonly string[]).includes(v.notify)) return { notify: v.notify, reach: typeof v.reach === "string" && v.reach ? v.reach : "app" };
      } catch {
        // Unreadable: the defaults.
      }
    }
    return { notify: (await this.d.legacyOff?.(uid).catch(() => false)) ? "never" : "important", reach: "app" };
  }

  async set(uid: string, patch: Partial<AmbSettingsView>): Promise<AmbSettingsView> {
    if (patch.reach && patch.reach !== "app" && !(await this.d.canReach?.(uid, patch.reach).catch(() => false))) {
      throw new AmbSettingsError("not_connected", patch.reach === "imessage" ? "iMessage isn't connected yet. Connect it first, then choose it." : patch.reach === "slack" || patch.reach === "teams" ? `Write to Ambient once in ${patch.reach === "slack" ? "Slack" : "Microsoft Teams"} (a direct message), then choose it.` : `There's no "${patch.reach}" to reach you on.`);
    }
    const next = { ...(await this.get(uid)), ...patch };
    const content = JSON.stringify(next);
    const sealed = await this.d.keys.seal({ kind: "user", uid }, `record:${KIND}`, JSON.stringify({ c: content }));
    await this.d.control.m(api.records.put, { ownerKind: "user", ownerId: uid, kind: KIND, key: "settings", iv: sealed.iv, ct: sealed.ciphertext, size: content.length, byKind: "user", keep: 1, now: this.d.now?.() ?? Date.now() });
    return next;
  }

  /** Where Amb writes first for this person. */
  async reach(uid: string): Promise<string> {
    return (await this.get(uid)).reach;
  }

  /** Whether the heartbeat tells this person anything. */
  async notifies(uid: string): Promise<boolean> {
    return (await this.get(uid)).notify !== "never";
  }
}
