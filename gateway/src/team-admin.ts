// Settings people change: a team's settings and repo, and their own preferences. One function
// each, behind the app's routes (app-api.ts) and the AI apps' tools (mcp/settings-tools.ts), so
// both follow the same rules: members read a team's settings, owners and admins change them, the
// role as it is now. Ambient is built for agents as much as for people: anything the app can
// change, an AI app can change for its user (product/architecture.md, "Agents first").
import { api, type Control } from "./control.ts";
import type { Directory, Team } from "./directory.ts";
import { TeamServerError, type TeamLink } from "./teams.ts";

/** A status and a JSON body, as the team server or the gateway answers. */
export interface Reply {
  status: number;
  json: unknown;
}

const UNAVAILABLE: Reply = { status: 503, json: { error: "team_unavailable", message: "The team server didn't answer. Try again in a minute." } };

/** What a team's settings may be changed to: the team server checks the values. */
const SETTING_KEYS = ["transcripts", "work", "microsoft", "ignore", "notes"] as const;

export interface Prefs {
  consolidate: boolean;
  consolidateAsked: boolean;
  digest: boolean;
}

export class SettingsService {
  constructor(private d: { directory: Directory; teams: TeamLink; control: Control }) {}

  /** The team, for a member; to change anything, an owner or admin (asked fresh, not from cache). */
  private async member(uid: string, slug: string, change: boolean, what: string): Promise<{ team: Team } | { reply: Reply }> {
    const team = change ? await this.d.directory.freshMembership(uid, slug) : await this.d.directory.membership(uid, slug);
    if (!team || team.status !== "active") return { reply: { status: 403, json: { error: "not_a_member", message: "You're not a member of that team." } } };
    if (change && team.role !== "owner" && team.role !== "admin") {
      return { reply: { status: 403, json: { error: "admins_only", message: `Only team owners and admins can change the ${what}.` } } };
    }
    return { team };
  }

  /** GET: what the team's server delivers where, and the Microsoft 365 connection (never its secret). PUT: change some of it. */
  async teamSettings(uid: string, slug: string, method: "GET" | "PUT", body?: Record<string, unknown>): Promise<Reply> {
    const m = await this.member(uid, slug, method === "PUT", "team settings");
    if ("reply" in m) return m.reply;
    const b = body ?? {};
    // Ambient's own Microsoft app is connected only through "Connect Microsoft 365", where an
    // admin of that company approved it: never by naming a tenant here.
    const ms = b.microsoft as { kind?: unknown } | null | undefined;
    if (method === "PUT" && ms && typeof ms === "object" && ms.kind === "ambient") {
      return { status: 400, json: { error: "settings", message: "Use Connect Microsoft 365 to connect Ambient's Microsoft app." } };
    }
    try {
      const change = method === "PUT" ? Object.fromEntries(SETTING_KEYS.filter((k) => k in b).map((k) => [k, b[k]])) : undefined;
      const out = await this.d.teams.settings(m.team, uid, method, change);
      // Disconnected (or switched to the company's own app): no more tokens for that tenant.
      if (method === "PUT" && out.status === 200 && "microsoft" in b) {
        await this.d.control.m(api.teams.setMicrosoftTenant, { slug: m.team.slug, tenantId: null });
      }
      return out;
    } catch (err) {
      if (err instanceof TeamServerError) return UNAVAILABLE;
      throw err;
    }
  }

  /**
   * The team's own repo. GET: any member. POST connects one (with its token), PATCH switches a repo
   * another tool keeps between read-only and a folder for Ambient, DELETE disconnects.
   */
  async teamRepo(uid: string, slug: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>): Promise<Reply> {
    const m = await this.member(uid, slug, method !== "GET", "team repo");
    if ("reply" in m) return m.reply;
    const b = body ?? {};
    // How: Ambient keeps the wiki (two-way), or another tool does and Ambient only reads it
    // (read-only) or writes into one folder of it (folder).
    const mode = b.mode === "read-only" ? "read-only" : b.mode === "folder" ? "folder" : "two-way";
    const folder = typeof b.folder === "string" ? { folder: b.folder.slice(0, 100) } : {};
    const payload =
      method === "POST"
        ? {
            url: String(b.url ?? ""),
            token: String(b.token ?? ""),
            mode,
            ...folder,
            // The person saw what the repo already holds (the 409 has_content answer) and connects it anyway.
            existing: b.existing === true,
          }
        : method === "PATCH"
          ? { mode: b.mode === "read-only" ? "read-only" : "folder", ...folder }
          : undefined;
    try {
      return await this.d.teams.repo(m.team, uid, method, payload);
    } catch (err) {
      if (err instanceof TeamServerError) return UNAVAILABLE;
      throw err;
    }
  }

  /** The user's own preferences; with a change, changed first. */
  async prefs(uid: string, change?: { consolidate?: boolean; digest?: boolean }): Promise<Prefs> {
    if (change && (change.consolidate !== undefined || change.digest !== undefined)) {
      await this.d.control.m(api.users.setPrefs, { uid: uid as never, consolidate: change.consolidate, digest: change.digest });
    }
    const record = await this.d.control.q(api.users.get, { uid: uid as never });
    return { consolidate: record?.consolidate ?? false, consolidateAsked: record?.consolidateAsked ?? false, digest: record?.digest ?? true };
  }
}
