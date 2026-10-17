// Routines: a prompt Claude Code runs on a schedule. A personal routine runs on one of the
// user's computers; a team's routine runs on the team's server.
//
//   app / MCP ──▶ RoutineService ──▶ Convex (routines; prompts, results and secrets sealed)
//   computer: ambient-runner sync (every minute) ──▶ POST /v1/host/sync ──▶ one systemd timer per routine
//             timer fires: ambient-runner run <id> ──▶ POST /v1/host/routines/:id/runs (prompt, secrets) … claude -p …
//                                                  ──▶ POST /v1/host/runs/:runId (status, cost, summary)
//
// Computers ("hosts") are set up with a one-time code; they get a token of their own that only
// reads their routines and reports their runs. A team's owners and admins manage its routines
// and secrets; members see the routines and their runs.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RoutineSchedule, describeSchedule, nextRun, onCalendar } from "@brain/spec";
import { api, type Control } from "../control.ts";
import { sha256Hex } from "../crypto.ts";
import type { Team } from "../directory.ts";
import type { Notifier, PushMessage } from "../push.ts";
import type { Owner, RoutineKeys } from "./keys.ts";
import type { CodeHasher } from "../auth/codes.ts";

export const HOST_TOKEN_PREFIX = "ambient_host_";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_TTL_MS = 30 * 60_000;
const SUMMARY_MAX = 4_000;
/** A computer that hasn't checked in for this long is shown as offline. */
const OFFLINE_AFTER_MS = 5 * 60_000;

export class RoutineError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const MESSAGES: Record<string, [string, number]> = {
  no_such_routine: ["There's no such loop.", 404],
  no_such_computer: ["There's no such computer. Connect one in the Ambient app under Loops.", 400],
  no_computer: ["This loop has no computer to run on. Pick one first.", 400],
  no_team_server: ["The team's server isn't set up for loops yet.", 400],
  team_routine_computer: ["A team's loops run on the team's server; leave the computer out.", 400],
  not_a_member: ["You're not in that team.", 403],
  admins_only: ["Only the team's owners and admins can change its loops and secrets.", 403],
  no_personal: ["This connection only reaches the team; personal loops need the personal connection.", 403],
  read_only: ["This connection can't change loops. Reconnect Ambient in this app and allow saving.", 403],
  too_many_routines: ["There are 50 loops already, the most there can be. Delete one first.", 400],
  too_many_computers: ["You have 10 computers, the most there can be. Remove one first.", 400],
  too_many_secrets: ["There are 30 secrets already, the most there can be. Delete one first.", 400],
  no_such_secret: ["There's no secret with that name.", 404],
  invalid_code: ["That setup code isn't valid. Create a new one in the Ambient app.", 400],
  expired_code: ["That setup code has expired. Create a new one in the Ambient app.", 400],
  no_such_run: ["There's no such run.", 404],
};

function refused(code: string): RoutineError {
  const [message, status] = MESSAGES[code] ?? ["That didn't work.", 400];
  return new RoutineError(code, message, status);
}

const Folder = z
  .string()
  .trim()
  .max(500)
  .regex(/^(\/|~\/|~$)[^\0\n\r]*$/, "an absolute path, or one starting with ~/");

/** What the app and the MCP tools send to create a routine. */
export const RoutineInput = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  schedule: RoutineSchedule,
  /** A team's slug: the routine belongs to the team and runs on its server. */
  team: z.string().trim().min(1).max(80).nullable().optional(),
  /** A computer's id or name (personal routines); the only computer when left out. */
  computer: z.string().trim().min(1).max(80).nullable().optional(),
  folder: Folder.nullable().optional(),
  enabled: z.boolean().optional(),
});
export type RoutineInput = z.infer<typeof RoutineInput>;
export const RoutinePatch = RoutineInput.omit({ team: true }).partial();
export type RoutinePatch = z.infer<typeof RoutinePatch>;

/**
 * Names a secret can't have: what the computer sets itself, and variables that change how Claude
 * Code, git, a shell, a language runtime or the network behave without the prompt asking (where
 * the model is, a proxy, a git hook, a library to preload). The runner drops them too.
 */
export const RESERVED_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TMP|TEMP|TERM|LANG|LANGUAGE|LC_.*|IFS|ENV|BASH_ENV|BASH_FUNC_.*|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|EDITOR|VISUAL|PAGER|MANPAGER|GIT_.*|SSH_.*|GNUPGHOME|ANTHROPIC_.*|CLAUDE.*|AMBIENT_.*|LD_.*|DYLD_.*|NODE_.*|NPM_CONFIG_.*|YARN_.*|PYTHON.*|PIP_.*|PERL.*|RUBY.*|GEM_.*|BUNDLE_.*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|.*_PROXY|SSL_.*|CURL_.*|OPENSSL_.*|REQUESTS_CA_BUNDLE|XDG_.*|DOCKER_HOST)$/;
export const SecretName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "capital letters, digits and _, like GITHUB_TOKEN")
  .refine((n) => !RESERVED_ENV.test(n), "that name is used by the computer itself, or changes how its tools behave");
export const SecretValue = z.string().min(1).max(10_000);

export const HostInfo = z.object({
  hostname: z.string().max(120),
  os: z.string().max(120),
  runner: z.string().max(40),
  claude: z.string().max(80),
});
export type HostInfo = z.infer<typeof HostInfo>;

export const RunResult = z.object({
  status: z.enum(["succeeded", "failed"]),
  exitCode: z.number().int().optional(),
  summary: z.string().max(100_000).optional(),
  costUsd: z.number().min(0).max(10_000).optional(),
  turns: z.number().int().min(0).optional(),
  sessionId: z.string().max(100).optional(),
});
export type RunResult = z.infer<typeof RunResult>;

/** Mid-run progress from the runner (summary, cost, turns so far). */
export const RunProgress = z.object({
  summary: z.string().max(100_000).optional(),
  costUsd: z.number().min(0).max(10_000).optional(),
  turns: z.number().int().min(0).optional(),
});
export type RunProgress = z.infer<typeof RunProgress>;

interface RoutineRow {
  id: string;
  teamId: string | null;
  createdBy: string;
  name: string;
  promptIv: string;
  promptCt: string;
  schedule: RoutineSchedule;
  hostId: string | null;
  folder: string | null;
  enabled: boolean;
  runRequestedAt: number | null;
  source: string;
  lastRun: { status: string; startedAt: number; finishedAt?: number } | null;
  createdAt: number;
  updatedAt: number;
}
interface HostRow {
  id: string;
  teamId: string | null;
  name: string;
  ready: boolean;
  codeExpiresAt: number | null;
  info: HostInfo | null;
  lastSeenAt: number | null;
  createdAt: number;
}

/**
 * Who's asking, and what they may do. The app passes a signed-in user (everything their roles
 * allow); an MCP connection passes what its token reaches and its scopes.
 */
export interface Actor {
  uid: string;
  /** Teams the user is in (with their role) that this connection reaches. */
  teams: Team[];
  /** Personal routines are reachable (not on a team-only connection). */
  personal: boolean;
  canWritePersonal: boolean;
  canWriteTeams: boolean;
}

export type TeamRef = { slug: string; name: string };

export interface Computer {
  id: string;
  name: string;
  /** A team's server (runs the team's routines), or null for one of the user's own computers. */
  team: TeamRef | null;
  /** False until `ambient-runner setup` ran with its code. */
  ready: boolean;
  online: boolean;
  setupCodeExpiresAt: number | null;
  hostname: string | null;
  os: string | null;
  claude: string | null;
  runner: string | null;
  lastSeenAt: number | null;
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  /** "Wednesdays at 08:52" */
  scheduleText: string;
  /** Milliseconds since 1970; null while paused or without a computer. */
  nextRunAt: number | null;
  /** The team it belongs to, or null for a personal routine. */
  team: TeamRef | null;
  /** The user may change, run and delete it. */
  canEdit: boolean;
  computer: { id: string; name: string } | null;
  folder: string | null;
  enabled: boolean;
  /** "Run now" was pressed; the computer starts it within a minute. */
  runRequested: boolean;
  source: string;
  lastRun: { status: string; startedAt: number; finishedAt: number | null } | null;
  createdAt: number;
  updatedAt: number;
}

export interface Run {
  id: string;
  trigger: "schedule" | "manual";
  status: "running" | "succeeded" | "failed";
  /** Display name of whoever pressed "Run now" (null for scheduled runs). */
  startedByName: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  /** Claude's last message (what it did), or why the run failed. */
  summary: string | null;
  costUsd: number | null;
  turns: number | null;
}

export interface Host {
  id: string;
  /** The user whose computer it is, or null for a team's server. */
  uid: string | null;
  teamId: string | null;
  name: string;
}

/** What a computer's sync gets: enough to write the systemd units. */
export interface HostRoutine {
  id: string;
  name: string;
  onCalendar: string;
  enabled: boolean;
  runRequested: boolean;
}

/**
 * The runner script computers download, pointed at this gateway, and its hash (installed
 * runners replace themselves when it changes).
 */
export function loadRunner(dir: string, origin: string): { version: string; sha256: string; signature?: string; source: string } | undefined {
  try {
    const source = readFileSync(join(dir, "ambient-runner.mjs"), "utf8").replace(/const DEFAULT_SERVER = "[^"]*";/, `const DEFAULT_SERVER = ${JSON.stringify(origin)};`);
    const version = /const VERSION = "([^"]+)"/.exec(source)?.[1] ?? "0";
    // The release signature (ops/sign-runner.mjs): runners install an update only with it.
    const signature = (() => {
      try {
        return readFileSync(join(dir, "ambient-runner.mjs.sig"), "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    })();
    return { version, sha256: createHash("sha256").update(source).digest("hex"), signature, source };
  } catch {
    return undefined;
  }
}

const isManager = (t: Team) => t.role === "owner" || t.role === "admin";

export class RoutineService {
  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      /** Setup codes are stored keyed (auth/codes.ts). */
      codes: CodeHasher;
      origin: string;
      runner?: { version: string; sha256: string; signature?: string };
      now?: () => number;
      /** Pushes to the owner's apps when a run fails (finishRun decides when it's news). */
      notifier?: Notifier;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  // ---- who may do what ----

  private readable(actor: Actor): Team[] {
    return actor.teams.filter((t) => t.status === "active");
  }

  private manageable(actor: Actor): Team[] {
    return actor.canWriteTeams ? this.readable(actor).filter(isManager) : [];
  }

  private teamOf(actor: Actor, teamId: string | null): Team | undefined {
    return teamId ? actor.teams.find((t) => t.id === teamId) : undefined;
  }

  /** The team (by slug) whose routines or secrets the user is about to change. */
  private managedTeam(actor: Actor, slug: string): Team {
    const team = this.readable(actor).find((t) => t.slug === slug);
    if (!team) throw refused("not_a_member");
    if (!isManager(team)) throw refused("admins_only");
    if (!actor.canWriteTeams) throw refused("read_only");
    return team;
  }

  private assertPersonalWrite(actor: Actor) {
    if (!actor.personal) throw refused("no_personal");
    if (!actor.canWritePersonal) throw refused("read_only");
  }

  private ownerOf(r: { teamId: string | null; createdBy: string }): Owner {
    return r.teamId ? { kind: "team", teamId: r.teamId } : { kind: "user", uid: r.createdBy };
  }

  // ---- views ----

  private computer(h: HostRow, actor?: Actor): Computer {
    const team = actor && this.teamOf(actor, h.teamId);
    return {
      id: h.id,
      name: h.name,
      team: team ? { slug: team.slug, name: team.name } : null,
      ready: h.ready,
      online: h.ready && h.lastSeenAt !== null && this.now() - h.lastSeenAt < OFFLINE_AFTER_MS,
      setupCodeExpiresAt: h.codeExpiresAt,
      hostname: h.info?.hostname ?? null,
      os: h.info?.os ?? null,
      claude: h.info?.claude ?? null,
      runner: h.info?.runner ?? null,
      lastSeenAt: h.lastSeenAt,
    };
  }

  private async routine(actor: Actor, r: RoutineRow, hosts: HostRow[]): Promise<Routine> {
    const team = this.teamOf(actor, r.teamId);
    const host = r.teamId ? hosts.find((h) => h.teamId === r.teamId) : r.hostId ? hosts.find((h) => h.id === r.hostId) : undefined;
    const canEdit = team ? this.manageable(actor).some((t) => t.id === team.id) : actor.canWritePersonal;
    return {
      id: r.id,
      name: r.name,
      prompt: await this.d.keys.open(this.ownerOf(r), "routine:prompt", r.promptIv, r.promptCt),
      schedule: r.schedule,
      scheduleText: describeSchedule(r.schedule),
      nextRunAt: r.enabled && host?.ready ? nextRun(r.schedule, this.now()) : null,
      team: team ? { slug: team.slug, name: team.name } : null,
      canEdit,
      computer: host ? { id: host.id, name: host.name } : null,
      folder: r.folder,
      enabled: r.enabled,
      runRequested: r.runRequestedAt !== null,
      source: r.source,
      lastRun: r.lastRun ? { status: r.lastRun.status, startedAt: r.lastRun.startedAt, finishedAt: r.lastRun.finishedAt ?? null } : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private async rows(actor: Actor): Promise<{ routines: RoutineRow[]; hosts: HostRow[] }> {
    const out = (await this.d.control.q(api.routines.list, { uid: actor.uid as never, teamIds: this.readable(actor).map((t) => t.id) as never })) as unknown as {
      routines: RoutineRow[];
      hosts: HostRow[];
    };
    if (actor.personal) return out;
    return { routines: out.routines.filter((r) => r.teamId), hosts: out.hosts.filter((h) => h.teamId) };
  }

  private async row(actor: Actor, id: string): Promise<{ r: RoutineRow; hosts: HostRow[] }> {
    const { routines, hosts } = await this.rows(actor);
    const r = routines.find((x) => x.id === id);
    if (!r) throw refused("no_such_routine");
    return { r, hosts };
  }

  /** The ids the user may change: their personal routines (by uid) and the teams they manage. */
  private writeAccess(actor: Actor, r: RoutineRow) {
    if (r.teamId) {
      const team = this.teamOf(actor, r.teamId);
      if (!team) throw refused("no_such_routine");
      this.managedTeam(actor, team.slug);
    } else this.assertPersonalWrite(actor);
    return { uid: actor.uid as never, teamIds: this.manageable(actor).map((t) => t.id) as never };
  }

  // ---- the user's side ----

  async list(actor: Actor): Promise<{ routines: Routine[]; computers: Computer[] }> {
    const { routines, hosts } = await this.rows(actor);
    return {
      routines: await Promise.all(routines.map((r) => this.routine(actor, r, hosts))),
      computers: hosts.map((h) => this.computer(h, actor)),
    };
  }

  async get(actor: Actor, id: string): Promise<Routine> {
    const { r, hosts } = await this.row(actor, id);
    return this.routine(actor, r, hosts);
  }

  /** One of the user's own computers by id or name (case-insensitive); the only ready one when `ref` is undefined. */
  private async resolveComputer(actor: Actor, ref: string | null | undefined): Promise<string | null | undefined> {
    if (ref === null) return null;
    const hosts = (await this.rows(actor)).hosts.filter((h) => !h.teamId);
    if (ref === undefined) {
      const ready = hosts.filter((h) => h.ready);
      return ready.length === 1 ? ready[0]!.id : undefined;
    }
    const want = ref.toLowerCase();
    const h = hosts.find((x) => x.id === ref) ?? hosts.find((x) => x.name.toLowerCase() === want || x.info?.hostname.toLowerCase() === want);
    if (!h) throw refused("no_such_computer");
    return h.id;
  }

  async create(actor: Actor, input: RoutineInput, source: string): Promise<Routine> {
    let team: Team | undefined;
    let hostId: string | null | undefined;
    if (input.team) {
      team = this.managedTeam(actor, input.team);
      if (input.computer) throw refused("team_routine_computer");
    } else {
      this.assertPersonalWrite(actor);
      hostId = await this.resolveComputer(actor, input.computer);
    }
    const owner: Owner = team ? { kind: "team", teamId: team.id } : { kind: "user", uid: actor.uid };
    const sealed = await this.d.keys.seal(owner, "routine:prompt", input.prompt);
    const out = await this.d.control.m(api.routines.create, {
      uid: actor.uid as never,
      teamId: team?.id as never,
      name: input.name,
      promptIv: sealed.iv,
      promptCt: sealed.ciphertext,
      schedule: input.schedule,
      hostId: hostId ?? undefined,
      folder: input.folder ?? undefined,
      enabled: input.enabled ?? true,
      source,
      now: this.now(),
    });
    if (!out.ok) throw refused(out.error);
    return this.get(actor, String(out.routine.id));
  }

  async update(actor: Actor, id: string, patch: RoutinePatch, source: string): Promise<Routine> {
    const { r } = await this.row(actor, id);
    const access = this.writeAccess(actor, r);
    if (r.teamId && patch.computer) throw refused("team_routine_computer");
    const sealed = patch.prompt !== undefined ? await this.d.keys.seal(this.ownerOf(r), "routine:prompt", patch.prompt) : undefined;
    const hostId = !r.teamId && patch.computer !== undefined ? await this.resolveComputer(actor, patch.computer) : undefined;
    const out = await this.d.control.m(api.routines.update, {
      ...access,
      id,
      name: patch.name,
      promptIv: sealed?.iv,
      promptCt: sealed?.ciphertext,
      schedule: patch.schedule,
      hostId,
      folder: patch.folder,
      enabled: patch.enabled,
      source,
      now: this.now(),
    });
    if (!out.ok) throw refused(out.error);
    return this.get(actor, id);
  }

  async remove(actor: Actor, id: string): Promise<{ name: string }> {
    const { r } = await this.row(actor, id);
    const out = await this.d.control.m(api.routines.remove, { ...this.writeAccess(actor, r), id });
    if (!out.ok) throw refused(out.error);
    return { name: out.name };
  }

  async runNow(actor: Actor, id: string): Promise<Routine> {
    const { r } = await this.row(actor, id);
    const out = await this.d.control.m(api.routines.requestRun, { ...this.writeAccess(actor, r), id, now: this.now() });
    if (!out.ok) throw refused(out.error);
    return this.get(actor, id);
  }

  async runs(actor: Actor, id: string, limit = 20): Promise<Run[]> {
    const { r } = await this.row(actor, id);
    const out = await this.d.control.q(api.routines.runs, { uid: actor.uid as never, teamIds: this.readable(actor).map((t) => t.id) as never, id, limit });
    if (!out) throw refused("no_such_routine");
    const owner = this.ownerOf(r);
    return Promise.all(
      out.runs.map(async (run) => ({
        id: String(run.id),
        trigger: run.trigger,
        status: run.status,
        startedByName: run.startedByName ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.finishedAt !== null ? run.finishedAt - run.startedAt : null,
        exitCode: run.exitCode,
        summary: run.summaryIv && run.summaryCt ? await this.d.keys.open(owner, "routine:run", run.summaryIv, run.summaryCt).catch(() => null) : null,
        costUsd: run.costUsd,
        turns: run.turns,
      })),
    );
  }

  // ---- secrets ----

  private secretOwner(actor: Actor, team: string | null | undefined, write: boolean): { owner: Owner; teamId?: string } {
    if (team) {
      const t = write ? this.managedTeam(actor, team) : this.readable(actor).find((x) => x.slug === team);
      if (!t) throw refused("not_a_member");
      return { owner: { kind: "team", teamId: t.id }, teamId: t.id };
    }
    if (write) this.assertPersonalWrite(actor);
    else if (!actor.personal) throw refused("no_personal");
    return { owner: { kind: "user", uid: actor.uid } };
  }

  /** Secret names (never values) for the user's own routines, or a team's. */
  async secrets(actor: Actor, team?: string | null): Promise<{ name: string; updatedAt: number }[]> {
    const { teamId } = this.secretOwner(actor, team, false);
    return this.d.control.q(api.routines.secretNames, { uid: actor.uid as never, teamId: teamId as never });
  }

  /** `pauseLoops` (an AI app set it): the owner's loops that are on pause; their names come back. */
  async setSecret(actor: Actor, team: string | null | undefined, name: string, value: string, opts: { pauseLoops?: boolean; source?: string } = {}): Promise<{ paused: string[] }> {
    const { owner, teamId } = this.secretOwner(actor, team, true);
    const sealed = await this.d.keys.seal(owner, `routine:secret:${name}`, value);
    const out = await this.d.control.m(api.routines.setSecret, {
      uid: actor.uid as never,
      teamId: teamId as never,
      name,
      valueIv: sealed.iv,
      valueCt: sealed.ciphertext,
      pauseLoops: opts.pauseLoops,
      source: opts.source,
      now: this.now(),
    });
    if (!out.ok) throw refused(out.error);
    return { paused: out.paused };
  }

  async removeSecret(actor: Actor, team: string | null | undefined, name: string): Promise<void> {
    const { teamId } = this.secretOwner(actor, team, true);
    const out = await this.d.control.m(api.routines.removeSecret, { uid: actor.uid as never, teamId: teamId as never, name });
    if (!out.ok) throw refused(out.error);
  }

  // ---- the user's own computers ----

  /** A new computer of the user's: a one-time code for `ambient-runner setup`, valid 30 minutes. */
  async addComputer(actor: Actor, name: string): Promise<{ computer: Computer; code: string; expiresAt: number; commands: string }> {
    this.assertPersonalWrite(actor);
    const code = newSetupCode();
    const expiresAt = this.now() + CODE_TTL_MS;
    const out = await this.d.control.m(api.routines.addHost, {
      uid: actor.uid as never,
      name,
      codeHash: this.d.codes.hash("host-setup", setupCode(code)),
      expiresAt,
      now: this.now(),
    });
    if (!out.ok) throw refused(out.error);
    return { computer: this.computer(out.host as unknown as HostRow), code, expiresAt, commands: setupCommands(this.d.origin, code) };
  }

  async removeComputer(actor: Actor, id: string): Promise<void> {
    this.assertPersonalWrite(actor);
    const out = await this.d.control.m(api.routines.removeHost, { uid: actor.uid as never, id, now: this.now() });
    if (!out.ok) throw refused(out.error);
  }

  // ---- the computer's side ----

  async authenticate(header: string | undefined): Promise<Host | undefined> {
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token.startsWith(HOST_TOKEN_PREFIX)) return undefined;
    const h = await this.d.control.q(api.routines.hostByToken, { tokenHash: sha256Hex(token) });
    return h ? { id: String(h.id), uid: h.uid ? String(h.uid) : null, teamId: h.teamId ? String(h.teamId) : null, name: h.name } : undefined;
  }

  private claim(codeHash: string, tokenHash: string, info: HostInfo) {
    return this.d.control.m(api.routines.claimHost, { codeHash, tokenHash, info, now: this.now() });
  }

  async setup(code: string, info: HostInfo): Promise<{ token: string; computer: { id: string; name: string; team: boolean } }> {
    const token = `${HOST_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const [keyed, legacy] = this.d.codes.candidates("host-setup", setupCode(code));
    let out = await this.claim(keyed!, sha256Hex(token), info);
    if (!out.ok && out.error === "invalid_code") out = await this.claim(legacy!, sha256Hex(token), info);
    if (!out.ok) throw refused(out.error);
    return { token, computer: { id: String(out.host.id), name: out.host.name, team: Boolean(out.host.teamId) } };
  }

  async sync(host: Host, info?: HostInfo): Promise<{ computer: { id: string; name: string }; routines: HostRoutine[]; runner?: { version: string; sha256: string; signature?: string } }> {
    const out = await this.d.control.m(api.routines.hostSync, { hostId: host.id as never, info, now: this.now() });
    if (!out) throw new RoutineError("unauthorized", "This computer was removed.", 401);
    return {
      computer: { id: host.id, name: host.name },
      routines: (out.routines as unknown as RoutineRow[]).map((r) => ({
        id: r.id,
        name: r.name,
        onCalendar: onCalendar(r.schedule),
        enabled: r.enabled,
        runRequested: r.runRequestedAt !== null,
      })),
      runner: this.d.runner,
    };
  }

  /** A run starts: what to run, its owner's secrets as environment variables, and the run's id. */
  async startRun(
    host: Host,
    id: string,
  ): Promise<{ run: { id: string; trigger: string }; routine: { id: string; name: string; prompt: string; folder: string | null }; env: Record<string, string> }> {
    const out = await this.d.control.m(api.routines.startRun, { hostId: host.id as never, id, now: this.now() });
    if (!out.ok) throw refused(out.error);
    const r = out.routine as unknown as RoutineRow;
    const owner = this.ownerOf(r);
    const env: Record<string, string> = {};
    // Secrets stored before a name was reserved don't go out either.
    for (const s of out.secrets) if (!RESERVED_ENV.test(s.name)) env[s.name] = await this.d.keys.open(owner, `routine:secret:${s.name}`, s.iv, s.ct);
    return {
      run: { id: String(out.runId), trigger: out.trigger },
      routine: { id: r.id, name: r.name, prompt: await this.d.keys.open(owner, "routine:prompt", r.promptIv, r.promptCt), folder: r.folder },
      env,
    };
  }

  async finishRun(host: Host, runId: string, result: RunResult): Promise<void> {
    const who = await this.d.control.q(api.routines.runOwner, { hostId: host.id as never, runId });
    if (!who) throw refused("no_such_run");
    const owner: Owner = who.teamId ? { kind: "team", teamId: String(who.teamId) } : { kind: "user", uid: String(who.uid) };
    const text = result.summary?.trim();
    const sealed = text ? await this.d.keys.seal(owner, "routine:run", text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text) : undefined;
    const out = await this.d.control.m(api.routines.finishRun, {
      hostId: host.id as never,
      runId,
      status: result.status,
      exitCode: result.exitCode,
      summaryIv: sealed?.iv,
      summaryCt: sealed?.ciphertext,
      costUsd: result.costUsd,
      turns: result.turns,
      sessionId: result.sessionId,
      now: this.now(),
    });
    if (!out.ok) throw refused(out.error);
    // Not awaited: the computer's report doesn't wait for Apple.
    if (out.notice) void this.d.notifier?.notify(String(out.notice.uid), routineFailedPush({ ...out.notice, routineId: String(out.notice.routineId), runId: String(out.notice.runId) }));
  }

  /** Mid-run progress: the runner sends the summary, cost and turns while the run is still going. */
  async updateRunProgress(host: Host, runId: string, progress: RunProgress): Promise<void> {
    const who = await this.d.control.q(api.routines.runOwner, { hostId: host.id as never, runId });
    if (!who) throw refused("no_such_run");
    const owner: Owner = who.teamId ? { kind: "team", teamId: String(who.teamId) } : { kind: "user", uid: String(who.uid) };
    const text = progress.summary?.trim();
    const sealed = text ? await this.d.keys.seal(owner, "routine:run", text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text) : undefined;
    await this.d.control.m(api.routines.updateRunProgress, {
      hostId: host.id as never,
      runId,
      summaryIv: sealed?.iv,
      summaryCt: sealed?.ciphertext,
      costUsd: progress.costUsd,
      turns: progress.turns,
    });
  }
}

/** The push when a routine's run failed. Tapping it opens the run in the app. */
export function routineFailedPush(n: { routineId: string; runId: string; name: string; team: string | null }): PushMessage {
  return {
    title: "Loop failed",
    body: `“${n.name}”${n.team ? ` (${n.team})` : ""} didn't finish. Open it to see what went wrong.`,
    url: `ambient://routine/${n.routineId}?run=${n.runId}`,
    thread: "routines",
    // A later failure of the same routine replaces this one instead of piling up.
    collapseId: `routine-failed-${n.routineId}`,
  };
}

export function newSetupCode(): string {
  const part = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${part()}-${part()}`;
}

const setupCode = (code: string) => code.trim().toUpperCase();

/** What the app shows to set up a computer (Linux with systemd, Node and Claude Code). */
export function setupCommands(origin: string, code: string): string {
  return [`curl -fsSL ${origin}/runner/ambient-runner.mjs -o ambient-runner.mjs`, `sudo node ambient-runner.mjs setup ${code}`].join("\n");
}
