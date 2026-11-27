// Teams and the person's own profile: creating and joining teams, their people (invites, roles,
// removing, leaving), "about you" and the name, where work sessions go, and the Microsoft 365
// sign-in link. One function each, behind the app's routes (app-api.ts) and the AI apps' tools
// (mcp/account-tools.ts), so both follow the same rules and answer the same way: Ambient is built
// for agents as much as for people (product/architecture.md, "Agents first").
import { randomInt } from "node:crypto";
import { parsePage, slugify } from "@brain/spec";
import type { CodeHasher } from "./auth/codes.ts";
import { api, type Control } from "./control.ts";
import type { Directory, Team } from "./directory.ts";
import { limiter } from "./limiter.ts";
import { MAX_ABOUT, ME_PATH, writeAbout } from "./me.ts";
import type { MicrosoftConnectFlow } from "./microsoft-connect.ts";
import type { PersonalStore } from "./personal.ts";
import { TeamServerError, type TeamLink } from "./teams.ts";
import type { Reply } from "./team-admin.ts";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const REFUSALS: Record<string, string> = {
  forbidden: "Only the team's owner and admins can do that.",
  not_a_member: "You're not in this team.",
  owner_cannot_leave: "You own this team. Make someone else the owner first.",
};

/** A refusal from Convex as the app's routes answer it. */
function refused(error: string): Reply {
  return { status: error === "not_a_member" || error === "forbidden" ? 403 : 400, json: { error, message: REFUSALS[error] ?? "That didn't work." } };
}

const DONE: Reply = { status: 204, json: null };

export interface SessionRule {
  match: string;
  team: string;
}

/** One team per person (docs/architecture.md, "One team per person"): what to do when someone in one makes or joins another. */
function oneTeam(team?: string): string {
  return `You're in ${team ?? "a team"} already, and a person is in one team. Leave it first (its page in Settings), then make or join this one.`;
}

export class PeopleService {
  /** Creating and joining teams: 30 a minute per account, as the app's routes always allowed. */
  private limit = limiter(30);

  constructor(
    private d: {
      control: Control;
      directory: Directory;
      teams: TeamLink;
      codes: CodeHasher;
      personal: PersonalStore;
      microsoftConnect?: Pick<MicrosoftConnectFlow, "start">;
      /** Whether new teams take a server from the pool (BRAIN_TEAM_POOL=true); read each time. */
      pool?: () => boolean;
    },
  ) {}

  private peopleSlug(name: string | undefined): string {
    return `people/${slugify(name ?? "member") || "member"}`;
  }

  // ---- teams ----

  /** A team the person owns: on a computer of its own (no server yet), or a pool server. */
  /**
   * `shareComputer`: whether the owner's computer serves the team too (the app asks; absent: yes,
   * as before it asked).
   */
  async createTeam(uid: string, rawName: unknown, shareComputer?: unknown): Promise<Reply> {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name || name.length > 80 || !this.limit(`create:${uid}`)) {
      return { status: 400, json: { error: "bad_request", message: "Give the team a name (up to 80 characters)." } };
    }
    const user = await this.d.directory.user(uid);
    // A new team runs on a computer of its own (relay.ts), connected by its owner; Ambient's pool
    // of hosted servers only with BRAIN_TEAM_POOL=true (self-hosting with spare servers).
    const pool = this.d.pool ? this.d.pool() : process.env.BRAIN_TEAM_POOL === "true";
    const share = typeof shareComputer === "boolean" ? { shareComputer } : {};
    const made = await this.d.control.m(api.teams.createOwned, { uid: uid as never, name, peopleSlug: this.peopleSlug(user?.name), now: Date.now(), pool, ...share });
    if (!made.ok) {
      if (made.error === "no_server") {
        console.warn("[gateway] team creation refused: the server pool is empty");
        return { status: 503, json: { error: "no_server", message: "We're setting up more team servers. Try again in a few hours; we've been told." } };
      }
      if (made.error === "one_team") return { status: 409, json: { error: made.error, message: oneTeam((made as { team?: string }).team) } };
      if (made.error === "too_many_teams") return { status: 403, json: { error: made.error, message: "You already own three teams. Write to us if you need another." } };
      return { status: 400, json: { error: made.error, message: "Give the team a name." } };
    }
    const t = made.team;
    const server = made.server;
    // The owner's computer that serves the team too until they connect another for it (docs/bots.md).
    const computer = (made as { computer?: { id: string; name: string } | null }).computer ?? null;
    const shared = computer ? { computer: { id: String(computer.id), name: computer.name } } : {};
    if (!server) {
      this.d.directory.invalidate(uid);
      return { status: 200, json: { team: { slug: t.slug, name: t.name, status: t.status, role: t.role, peopleSlug: t.peopleSlug, server: "none", ...shared } } };
    }
    try {
      await this.d.teams.claim(server, { id: t.id, name: t.name });
    } catch (err) {
      const claim = err instanceof TeamServerError ? err.claim : undefined;
      console.error(`[gateway] claiming pool server ${server.serverId} failed (${claim ?? "error"}): ${(err as Error).message}`);
      // It may have taken the claim before the answer was lost: keep the team, as when the server
      // is slow to restart. Freeing it then would hand a server that now serves a deleted team to
      // the next team, and every creation after would fail on it.
      if (claim !== "uncertain") {
        // A server that says it's taken stays out of the pool; one that surely didn't claim goes back.
        await this.d.control.m(api.teams.abandonCreate, { teamId: t.id as never, release: claim !== "taken" });
        this.d.directory.invalidate(uid);
        return { status: 503, json: { error: "team_unavailable", message: "The team's server didn't answer. Try again in a minute." } };
      }
    }
    this.d.directory.invalidate(uid);
    // Best effort: the server restarts as the team's; notes queue on the phone until it's up.
    await this.d.teams.ready(server.url);
    return { status: 200, json: { team: { slug: t.slug, name: t.name, status: t.status, role: t.role, peopleSlug: t.peopleSlug, server: "hosted", ...shared } } };
  }

  /** Join with an invite code (or the code from an invite link). */
  async joinTeam(uid: string, rawCode: unknown): Promise<Reply> {
    const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
    if (!code || !this.limit(`join:${uid}`)) return { status: 400, json: { error: "bad_request" } };
    const user = await this.d.directory.user(uid);
    const join = (codeHash: string) => this.d.control.m(api.teams.joinWithInvite, { uid: uid as never, codeHash, peopleSlug: this.peopleSlug(user?.name), now: Date.now() });
    let out!: Awaited<ReturnType<typeof join>>;
    for (const codeHash of this.d.codes.candidates("invite", code)) {
      out = await join(codeHash);
      if (out.ok || out.error !== "invalid_code") break;
    }
    this.d.directory.invalidate(uid);
    if (!out.ok && out.error === "one_team") return { status: 409, json: { error: out.error, message: oneTeam((out as { team?: string }).team) } };
    if (!out.ok) return { status: 400, json: { error: out.error } };
    return { status: 200, json: { team: { slug: out.team.slug, name: out.team.name, role: out.team.role, peopleSlug: out.team.peopleSlug } } };
  }

  private async membership(uid: string, slug: string): Promise<Team | Reply> {
    const team = await this.d.directory.membership(uid, slug);
    return team ?? { status: 403, json: { error: "not_a_member" } };
  }

  async members(uid: string, slug: string): Promise<Reply> {
    const team = await this.membership(uid, slug);
    if (!("id" in team)) return team;
    const t = team;
    const members = await this.d.control.q(api.teams.members, { uid: uid as never, slug: t.slug });
    if (!members) return refused("not_a_member");
    return { status: 200, json: { team: { slug: t.slug, name: t.name, status: t.status, role: t.role }, members } };
  }

  /** An invite code (owners and admins): `uses` people may join with it within `days`. */
  async invite(uid: string, slug: string, body: { role?: "admin" | "member"; uses?: number; days?: number }): Promise<Reply> {
    const team = await this.membership(uid, slug);
    if (!("id" in team)) return team;
    const part = () => Array.from({ length: 4 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join("");
    const prefix = team.slug.replace(/[^a-z0-9]/g, "").slice(0, 4).toUpperCase() || "TEAM";
    const code = `${prefix}-${part()}-${part()}`;
    const uses = body.uses ?? 10;
    const out = await this.d.control.m(api.teams.invite, {
      uid: uid as never,
      slug: team.slug,
      codeHash: this.d.codes.hash("invite", code),
      role: body.role,
      uses,
      days: body.days ?? 14,
      now: Date.now(),
    });
    if (!out.ok) return refused(out.error);
    return { status: 200, json: { code, role: out.role, uses, expiresAt: out.expiresAt } };
  }

  async removeMember(uid: string, slug: string, target: string): Promise<Reply> {
    const team = await this.membership(uid, slug);
    if (!("id" in team)) return team;
    const out = await this.d.control.m(api.teams.removeMemberBy, { uid: uid as never, slug: team.slug, target });
    this.d.directory.invalidate(target);
    return out.ok ? DONE : refused(out.error);
  }

  async setRole(uid: string, slug: string, target: string, role: unknown): Promise<Reply> {
    const team = await this.membership(uid, slug);
    if (!("id" in team)) return team;
    if (role !== "admin" && role !== "member") return { status: 400, json: { error: "bad_request" } };
    const out = await this.d.control.m(api.teams.setRole, { uid: uid as never, slug: team.slug, target, role });
    this.d.directory.invalidate(target);
    return out.ok ? DONE : refused(out.error);
  }

  /**
   * Whether the user's personal space (their own brain's upkeep) runs on the team's computer while
   * they have none of their own (docs/bots.md, "Every computer has a person"). Their choice only.
   */
  async setPersonalOnTeamComputer(uid: string, slug: string, on: unknown): Promise<Reply> {
    if (typeof on !== "boolean") return { status: 400, json: { error: "bad_request", message: "Say on (true) or off (false)." } };
    const team = await this.d.directory.freshMembership(uid, slug);
    if (!team || team.status !== "active") return refused("not_a_member");
    const out = await this.d.control.m(api.teams.setPersonalOnTeamComputer, { uid: uid as never, teamId: team.id as never, on });
    this.d.directory.invalidate(uid);
    return out.ok ? DONE : refused(out.error);
  }

  async leave(uid: string, slug: string): Promise<Reply> {
    const out = await this.d.control.m(api.teams.leaveBySlug, { uid: uid as never, slug });
    this.d.directory.invalidate(uid);
    return out.ok ? DONE : refused(out.error);
  }

  /** "Connect Microsoft 365": the address to open in a browser, for an owner or admin. */
  async microsoftLink(uid: string, slug: string, purpose: "transcripts" | "work"): Promise<Reply> {
    if (!this.d.microsoftConnect) {
      return { status: 501, json: { error: "unavailable", message: "This server has no Microsoft app for Connect Microsoft 365. Use your company's own Entra app instead." } };
    }
    const team = await this.d.directory.freshMembership(uid, slug);
    if (!team || team.status !== "active") return { status: 403, json: { error: "not_a_member" } };
    if (team.role !== "owner" && team.role !== "admin") return { status: 403, json: { error: "admins_only", message: "Only team owners and admins can connect Microsoft 365." } };
    if (!team.serverUrl) return { status: 503, json: { error: "team_unavailable", message: "The team's server isn't ready yet." } };
    const requester = (await this.d.directory.user(uid))?.name ?? "a team admin";
    return { status: 200, json: { url: this.d.microsoftConnect.start({ uid, team, requester, purpose }) } };
  }

  // ---- the person ----

  /** What they wrote about themselves, and the page Claude's upkeep keeps from it. */
  async about(uid: string): Promise<{ about: string | null; page: { title: string; summary: string; updated: string; body: string } | null }> {
    const text = await this.d.personal.readPage(uid, ME_PATH);
    if (!text) return { about: null, page: null };
    const page = parsePage(text);
    return {
      about: typeof page.frontmatter.about === "string" ? page.frontmatter.about : null,
      page: { title: String(page.frontmatter.title ?? ""), summary: String(page.frontmatter.summary ?? ""), updated: String(page.frontmatter.updated ?? ""), body: page.body.trim() },
    };
  }

  /** What they write about themselves, kept word for word; upkeep writes the rest of the page. */
  async setAbout(uid: string, raw: unknown): Promise<Reply> {
    const about = typeof raw === "string" ? raw.trim() : "";
    if (!about || about.length > MAX_ABOUT) return { status: 400, json: { error: "bad_request", message: `Write a few sentences, at most ${MAX_ABOUT} characters.` } };
    const [user, prev] = await Promise.all([this.d.directory.user(uid), this.d.personal.readPage(uid, ME_PATH)]);
    const text = writeAbout(prev, about, user?.name ?? "", new Date().toISOString().slice(0, 10));
    await this.d.personal.serverWrite(uid, [{ path: ME_PATH, content: text }]);
    return { status: 200, json: { about, path: ME_PATH } };
  }

  async rename(uid: string, raw: unknown): Promise<Reply> {
    const name = typeof raw === "string" ? raw : "";
    if (!name.trim()) return { status: 400, json: { error: "bad_request" } };
    await this.d.control.m(api.users.rename, { uid: uid as never, name });
    this.d.directory.invalidate(uid);
    return DONE;
  }

  /** Which work sessions go to which team, by folder or repo. */
  async sessionRules(uid: string): Promise<SessionRule[]> {
    return (await this.d.control.q(api.sessions.rules, { uid: uid as never })) as SessionRule[];
  }

  async setSessionRules(uid: string, rules: SessionRule[]): Promise<Reply> {
    const mine = new Set((await this.d.directory.teamsOf(uid)).map((t) => t.slug));
    const unknown = rules.find((r) => !mine.has(r.team));
    if (unknown) return { status: 400, json: { error: "not_a_member", message: `You're not in the team "${unknown.team}".` } };
    await this.d.control.m(api.sessions.setRules, { uid: uid as never, rules });
    return { status: 200, json: { rules } };
  }
}
