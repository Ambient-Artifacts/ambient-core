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
import { BotInput, ModelChoice, RoutineSchedule, botLook, botSettings, modelRuntime, botState, describeSchedule, nextRun, onCalendar, storedModel, unseenNews, type BotColor, type BotSettings, type BotShape, type BotState, type BotWear } from "@brain/spec";
import { MESSAGE_PURPOSE, claudeFix, openMessage, resultHash, sealMessage, type ClaudeFix } from "../bots/messages.ts";
import type { BotsAccess } from "../config.ts";
import { api, type Control } from "../control.ts";
import { sha256Hex } from "../crypto.ts";
import type { Team } from "../directory.ts";
import type { Notifier, PushMessage } from "../push.ts";
import type { Owner, RoutineKeys } from "./keys.ts";
import type { CodeHasher } from "../auth/codes.ts";
import type { Author, BotFolder } from "../bots/folder.ts";
import type { AutomationEvent } from "../bots/automations.ts";

export const HOST_TOKEN_PREFIX = "ambient_host_";
export const RUN_TOKEN_PREFIX = "ambient_run_";
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
  bots_only: ["With bots, every loop is a bot: it can't be turned back into a plain loop. Pause it instead, or delete it.", 400],
  bot_needs_computer: ["A bot of your own runs on one of your computers, and none is picked. Connect a computer in the Ambient app (Bots, then Computers) or pick one, then try again. A team's bots run on the team's server.", 400],
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
  bots_not_enabled: ["Bots aren't switched on for this account or team yet.", 403],
  bad_token: ["That isn't a Claude plan token (sk-ant-oat…, from claude setup-token) or an Anthropic API key (sk-ant-api…).", 400],
  no_plan: ["There's no Claude plan stored for this computer yet. Add one in the Ambient app (the computer, then Claude).", 409],
  no_key: ["There's no API key stored for this computer yet. Add one in the Ambient app (the computer, then Claude).", 409],
  raise_in_app: ["An AI app can only lower Ambient's access to a computer; raise it in the Ambient app (the computer, then Ambient's access).", 403],
  bad_openai_key: ["That isn't an OpenAI API key (sk-…).", 400],
  no_openai_key: ["There's no OpenAI API key stored for this computer yet. Add one in the Ambient app (the computer, then Codex).", 409],
  model_runtime: ["That model is for the other runtime: Claude Code takes claude-… models, Codex takes OpenAI's (gpt-…, o3…, codex-…).", 400],
  claude_model_only: ["A computer's default model is Claude Code's (claude-…); give a Codex bot its own model instead.", 400],
  claude_admins_only: ["Only the person whose computer it is, or a team's owners and admins for its server, can change its Claude sign-in.", 403],
  no_such_bot: ["There's no such bot.", 404],
  run_over: ["This run is over; it can't ask anything anymore.", 409],
  no_such_question: ["There's no such question.", 404],
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
  /** A bot (docs/bots.md); null on a change: a plain loop again. */
  bot: BotInput.nullable().optional(),
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
  /** Codex's version and how it's signed in there (runner 0.9.0 on). */
  codex: z.string().max(80).optional(),
  codexLogin: z.enum(["chatgpt", "api_key", "none"]).optional(),
});
export type HostInfo = z.infer<typeof HostInfo>;

export const RunResult = z.object({
  status: z.enum(["succeeded", "failed"]),
  exitCode: z.number().int().optional(),
  summary: z.string().max(100_000).optional(),
  costUsd: z.number().min(0).max(10_000).optional(),
  turns: z.number().int().min(0).optional(),
  sessionId: z.string().max(200).optional(),
  /** A bot's run (runner 0.8.0): its memory.md and its handoff as the run left them. */
  memory: z.string().max(70_000).optional(),
  handoff: z.string().max(70_000).optional(),
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
  bot: BotSettings | null;
  openQuestionId: string | null;
  /** When the bot's thread was last read (absent on rows from before it). */
  seenAt?: number | null;
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
  claude: ClaudeAccount | null;
  openai: { use: "plan" | "key"; key: { by: string | null; at: number } | null } | null;
  model: StoredModel | null;
  access: Access;
  allowed: string[];
  createdAt: number;
}

export type StoredModel = { model: string; effort?: string; fallback?: string };
export type Access = "standard" | "admin" | "full";

/** Whose Claude a computer's runs and Ambient sign in with (docs/bots.md). Never the values. */
export interface ClaudeAccount {
  use: "plan" | "key" | "computer";
  plan: { by: string | null; at: number } | null;
  key: { by: string | null; at: number } | null;
}

/**
 * How a computer's Codex bots sign in to OpenAI (docs/bots.md, "Codex next to Claude Code"): the
 * computer's own Codex sign-in ("plan": a ChatGPT plan signed in there) or a stored API key.
 */
export interface OpenAIAccount {
  use: "plan" | "key";
  key: { by: string | null; at: number } | null;
  /** How Codex is signed in on the computer itself; null: not known yet (an older runner). */
  signedIn: "chatgpt" | "api_key" | "none" | null;
}

/** A plan's token (claude setup-token) or an Anthropic API key, as people paste them. */
export const ClaudeToken = z.object({
  kind: z.enum(["plan", "key"]),
  token: z.string().trim().min(20).max(500),
});

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
  /** Whose Claude it signs in with: a stored plan or key, or its own (`use: "computer"`). */
  claudeAccount: ClaudeAccount;
  /** Codex's version there ("not found" when it isn't installed); null: an older runner. */
  codex: string | null;
  /** How its Codex bots sign in to OpenAI. */
  openaiAccount: OpenAIAccount;
  /** The default model for its runs and Ambient there; null: Claude Code's own. */
  model: { model: string; effort: string | null; fallback: string | null } | null;
  /** What Ambient may do there (docs/bots.md). */
  access: Access;
  /** Root commands approved with "Always". */
  allowed: string[];
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
  /** A bot's settings and how it's doing; null for a plain loop. */
  bot: BotView | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotView {
  /** Its shape (an older stored face is mapped onto one, botLook). */
  face: BotShape;
  /** Its colour for life. */
  color: BotColor;
  /** What it wears for its job. */
  wear: BotWear[];
  runtime: BotSettings["runtime"];
  isolation: BotSettings["isolation"];
  /** The secrets its runs get; null: all of its owner's. */
  secrets: string[] | null;
  report: BotSettings["report"];
  /** Its own model; null: the computer's default. */
  model: { model: string; effort: string | null; fallback: string | null } | null;
  /** What Ambient may answer for its owner. */
  delegate: "never" | "brain" | "most";
  state: BotState;
  openQuestion: { id: string; text: string; choices: string[] | null; askedAt: number } | null;
  /** The newest thing it said: a result, a failure or a question; `fix` for a Claude account problem. */
  lastMessage: { text: string; kind: string; at: number; fix: ClaudeFix | null } | null;
}

interface LatestRow {
  id: string;
  question: { id: string; iv: string; ct: string; createdAt: number } | null;
  last: { id: string; kind: string; iv: string; ct: string; createdAt: number } | null;
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
  /** A bot's run failed: automations may listen (docs/bots.md, "Automations"). Set once they're up. */
  onBotEvent?: (e: AutomationEvent) => void;
  /** A bot that watches GitHub repos: its branch prefix and repos, for the PR gate in its instructions (app.ts sets it). */
  githubFor?: (owner: Owner, routineId: string) => Promise<{ prefix: string; repos: string[]; on?: import("../bots/github.ts").WatchMode[] } | null>;
  /** A GitHub token for a bot's run from Ambient's GitHub App (docs/bots.md, "Connect GitHub"); null: none covers it. */
  githubToken?: (owner: Owner, routineId: string) => Promise<string | null>;

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
      /** Who has bots (BRAIN_BOTS); absent: nobody. */
      bots?: BotsAccess;
      /** A user's teams (for whether their own computer runs Ambient). */
      teamsOf?: (uid: string) => Promise<Team[]>;
      /** A team by slug (for whether a team's server runs Ambient). */
      teamBySlug?: (slug: string) => Promise<Team | undefined>;
      /** Bots' folders, memory and handoffs (docs/bots.md, "A bot's folder"). */
      folder?: BotFolder;
    },
  ) {}

  // ---- bots: who has them ----

  /** Bots for a personal owner (`uid`), or a team (by slug). */
  private botsOn(owner: { uid: string } | { slug: string }): boolean {
    const b = this.d.bots;
    if (!b) return false;
    return "uid" in owner ? b.users.includes("*") || b.users.includes(owner.uid) : b.teams.includes("*") || b.teams.includes(owner.slug);
  }

  /**
   * Personal bots: the account is listed, or it's in a team that has bots (the team's people try
   * bots on their own loops too, without listing every account id).
   */
  private personalBots(actor: Actor): boolean {
    return this.botsOn({ uid: actor.uid }) || this.readable(actor).some((t) => this.botsOn({ slug: t.slug }));
  }

  /** Whether the app shows bots to this user: their own, or one of their teams has them. */
  botsEnabled(actor: Actor): boolean {
    return (actor.personal && this.personalBots(actor)) || this.readable(actor).some((t) => this.botsOn({ slug: t.slug }));
  }

  /** Bots for the owner of `r` (its team, or whoever made a personal one). */
  botsFor(actor: Actor, r: { teamId: string | null; createdBy: string }): boolean {
    if (r.teamId) {
      const team = this.teamOf(actor, r.teamId);
      return !!team && this.botsOn({ slug: team.slug });
    }
    return r.createdBy === actor.uid ? this.personalBots(actor) : this.botsOn({ uid: r.createdBy });
  }

  /** Whether a user has bots (and so Ambient), from their account alone. */
  async botsForUser(uid: string): Promise<boolean> {
    if (this.botsOn({ uid })) return true;
    const teams = (await this.d.teamsOf?.(uid).catch(() => [])) ?? [];
    return teams.some((t) => t.status === "active" && this.botsOn({ slug: t.slug }));
  }

  /** The teams (by id) that have bots: only those in BRAIN_BOTS by slug. */
  private async botTeamIds(): Promise<Set<string>> {
    const slugs = (this.d.bots?.teams ?? []).filter((s) => s !== "*");
    const teams = await Promise.all(slugs.map((s) => this.d.teamBySlug?.(s).catch(() => undefined)));
    return new Set(teams.filter((t): t is Team => !!t && t.status === "active").map((t) => t.id));
  }

  /** Whether a computer runs Ambient: a person's own, when they have bots; a team's server, when the team has. */
  async ambientOn(host: Host): Promise<boolean> {
    if (host.teamId) return this.d.bots?.teams.includes("*") || (await this.botTeamIds()).has(host.teamId);
    return host.uid !== null && (await this.botsForUser(host.uid));
  }

  /**
   * Where Ambient can run for a user, in order: their own computers, then the servers of their teams
   * that have bots (Ambient's own machine for the team, one session per person there).
   */
  async computersOf(uid: string): Promise<{ id: string; uid: string; name: string; team: string | null }[]> {
    const botTeams = await this.botTeamIds();
    const teams = ((await this.d.teamsOf?.(uid).catch(() => [])) ?? []).filter((t) => t.status === "active" && (this.d.bots?.teams.includes("*") || botTeams.has(t.id)));
    const out = (await this.d.control.q(api.routines.list, { uid: uid as never, teamIds: teams.map((t) => t.id) as never })) as unknown as { hosts: HostRow[] };
    const ready = out.hosts.filter((h) => h.ready);
    return [...ready.filter((h) => !h.teamId), ...ready.filter((h) => h.teamId)].map((h) => ({ id: h.id, uid, name: h.name, team: teams.find((t) => t.id === h.teamId)?.name ?? null }));
  }

  get keys(): RoutineKeys {
    return this.d.keys;
  }

  get control(): Control {
    return this.d.control;
  }

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
      claudeAccount: h.claude ?? { use: "computer", plan: null, key: null },
      codex: h.info?.codex ?? null,
      openaiAccount: { use: h.openai?.use ?? "plan", key: h.openai?.key ?? null, signedIn: h.info?.codexLogin ?? null },
      model: h.model ? { model: h.model.model, effort: h.model.effort ?? null, fallback: h.model.fallback ?? null } : null,
      access: h.access ?? "standard",
      allowed: h.allowed ?? [],
    };
  }

  private async botView(r: RoutineRow, ready: boolean, latest: LatestRow | undefined, computer?: string): Promise<BotView | null> {
    if (!r.bot) return null;
    const owner = this.ownerOf(r);
    const open = async (m: { iv: string; ct: string }) => openMessage(this.d.keys, owner, m.iv, m.ct, MESSAGE_PURPOSE).catch(() => ({ text: "", choices: undefined }));
    const q = latest?.question ? { m: latest.question, body: await open(latest.question) } : null;
    const last = latest?.last ? { m: latest.last, body: await open(latest.last) } : null;
    const look = botLook(r.name, r.bot);
    const news = unseenNews(last ? { kind: last.m.kind, at: last.m.createdAt } : null, r.lastRun?.startedAt ?? null, r.seenAt ?? null);
    return {
      ...look,
      runtime: r.bot.runtime,
      isolation: r.bot.isolation,
      secrets: r.bot.secrets ?? null,
      report: r.bot.report,
      model: r.bot.model ? { model: r.bot.model.model, effort: r.bot.model.effort ?? null, fallback: r.bot.model.fallback ?? null } : null,
      delegate: r.bot.delegate ?? "brain",
      state: botState({ enabled: r.enabled, ready, lastRunStatus: r.lastRun?.status ?? null, openQuestion: r.openQuestionId !== null, news }),
      openQuestion: q ? { id: String(q.m.id), text: q.body.text, choices: q.body.choices ?? null, askedAt: q.m.createdAt } : null,
      lastMessage: last ? { text: last.body.text, kind: last.m.kind, at: last.m.createdAt, fix: claudeFix(last.m.kind, last.body.text, computer) } : null,
    };
  }

  /** The open question and newest message of each bot among `rows`. */
  private async latest(actor: Actor, rows: RoutineRow[]): Promise<Map<string, LatestRow>> {
    const ids = rows.filter((r) => r.bot).map((r) => r.id);
    if (!ids.length) return new Map();
    const out = (await this.d.control.q(api.bots.latest, { uid: actor.uid as never, teamIds: this.readable(actor).map((t) => t.id) as never, ids })) as unknown as LatestRow[];
    return new Map(out.map((x) => [String(x.id), x]));
  }

  private async routine(actor: Actor, r: RoutineRow, hosts: HostRow[], latest?: Map<string, LatestRow>): Promise<Routine> {
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
      bot: await this.botView(r, Boolean(host?.ready), latest?.get(r.id), host?.id),
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
    const latest = await this.latest(actor, routines);
    return {
      routines: await Promise.all(routines.map((r) => this.routine(actor, r, hosts, latest))),
      computers: hosts.map((h) => this.computer(h, actor)),
    };
  }

  async get(actor: Actor, id: string): Promise<Routine> {
    const { r, hosts } = await this.row(actor, id);
    return this.routine(actor, r, hosts, await this.latest(actor, [r]));
  }

  /** The raw row (for the bots' own service). */
  async rowOf(actor: Actor, id: string): Promise<{ id: string; teamId: string | null; createdBy: string; bot: BotSettings | null; name: string }> {
    const { r } = await this.row(actor, id);
    return { id: r.id, teamId: r.teamId, createdBy: r.createdBy, bot: r.bot, name: r.name };
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
    const ownerHasBots = team ? this.botsOn({ slug: team.slug }) : this.personalBots(actor);
    if (input.bot && !ownerHasBots) throw refused("bots_not_enabled");
    // With bots there are no plain loops (docs/bots.md, "Loops are bots"): one made without bot
    // settings is a bot with a new bot's defaults.
    if (!input.bot && ownerHasBots) input = { ...input, bot: {} };
    // A bot of one's own without a computer would only ever sit there asleep: refused up front.
    if (input.bot && !team && !hostId) throw refused("bot_needs_computer");
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
      bot: input.bot ? matchingModel(botSettings(input.bot)) : undefined,
      source,
      now: this.now(),
    });
    if (!out.ok) throw refused(out.error);
    if (input.bot) this.d.folder?.touched(this.ownerOf(out.routine as unknown as RoutineRow), { routineId: String(out.routine.id), path: "", by: source === "app" ? { kind: "user", name: null } : { kind: "amb", name: source }, why: "created" });
    return this.get(actor, String(out.routine.id));
  }

  /** `meta`: who changed a bot's prompt (its AGENTS.md) and why; by default the source says. */
  async update(actor: Actor, id: string, patch: RoutinePatch, source: string, meta: { by?: Author; why?: string | null } = {}): Promise<Routine> {
    const { r } = await this.row(actor, id);
    const access = this.writeAccess(actor, r);
    if (r.teamId && patch.computer) throw refused("team_routine_computer");
    const sealed = patch.prompt !== undefined ? await this.d.keys.seal(this.ownerOf(r), "routine:prompt", patch.prompt) : undefined;
    const hostId = !r.teamId && patch.computer !== undefined ? await this.resolveComputer(actor, patch.computer) : undefined;
    if (patch.bot && !this.botsFor(actor, r)) throw refused("bots_not_enabled");
    // With bots every loop is a bot: none goes back to being a plain loop.
    if (patch.bot === null && r.bot && this.botsFor(actor, r)) throw refused("bots_only");
    // A personal bot keeps a computer: taking it away, or making a loop without one a bot, is refused.
    if (!r.teamId && (r.bot || patch.bot) && patch.bot !== null) {
      const keeps = hostId !== undefined ? hostId : r.hostId;
      if (!keeps) throw refused("bot_needs_computer");
    }
    const bot = patch.bot === undefined ? undefined : patch.bot === null ? null : matchingModel(botSettings(patch.bot, r.bot ?? undefined));
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
      bot,
      source,
      now: this.now(),
    });
    if (!out.ok) throw refused(out.error);
    // A bot's name or settings changed (or it became a loop again): its mirror in git follows.
    if (this.d.folder && (r.bot || patch.bot) && (patch.name !== undefined || patch.schedule !== undefined || patch.enabled !== undefined || patch.bot !== undefined)) {
      this.d.folder.touched(this.ownerOf(r), { routineId: id, path: "", by: meta.by ?? (source === "app" ? { kind: "user", name: null } : { kind: "amb", name: source }), why: meta.why ?? "settings" });
    }
    // A bot's prompt is its AGENTS.md: every change is a version of it (undo, who and why).
    if (this.d.folder && patch.prompt !== undefined && (r.bot || patch.bot)) {
      const owner = this.ownerOf(r);
      const before = await this.d.keys.open(owner, "routine:prompt", r.promptIv, r.promptCt).catch(() => null);
      if (before !== patch.prompt) {
        const by: Author = meta.by ?? (source === "app" ? { kind: "user", name: null } : { kind: "amb", name: source });
        await this.d.folder.recordAgents(owner, id, patch.prompt, before, by, meta.why ?? null).catch((err: Error) => console.warn(`[folder] AGENTS.md version not kept: ${err.message}`));
      }
    }
    return this.get(actor, id);
  }

  /**
   * A bot's folder for someone (docs/bots.md, "A bot's folder"): its owner, and AGENTS.md (the
   * prompt). `write`: only who may change the bot.
   */
  /**
   * Whose bots someone may change: their own (no team), or a team's they own or admin. For what
   * belongs to an owner rather than one bot (the GitHub webhook, docs/bots.md).
   */
  botOwner(actor: Actor, team?: string | null): Owner {
    if (team) {
      const t = this.managedTeam(actor, team);
      if (!this.botsOn({ slug: t.slug })) throw refused("bots_not_enabled");
      return { kind: "team", teamId: t.id };
    }
    this.assertPersonalWrite(actor);
    if (!this.personalBots(actor)) throw refused("bots_not_enabled");
    return { kind: "user", uid: actor.uid };
  }

  async folderOf(actor: Actor, id: string, write: boolean): Promise<{ owner: Owner; routineId: string; name: string; agents: string; teamId: string | null }> {
    const { r } = await this.row(actor, id);
    if (!r.bot) throw new RoutineError("no_such_bot", "There's no such bot.", 404);
    if (!this.botsFor(actor, r)) throw refused("bots_not_enabled");
    if (write) {
      this.writeAccess(actor, r);
      if (!r.teamId && r.createdBy !== actor.uid) throw refused("no_such_routine");
    }
    const owner = this.ownerOf(r);
    return { owner, routineId: r.id, name: r.name, teamId: r.teamId, agents: await this.d.keys.open(owner, "routine:prompt", r.promptIv, r.promptCt) };
  }

  async remove(actor: Actor, id: string): Promise<{ name: string }> {
    const { r } = await this.row(actor, id);
    const out = await this.d.control.m(api.routines.remove, { ...this.writeAccess(actor, r), id });
    if (!out.ok) throw refused(out.error);
    if (r.bot && this.d.folder) await this.d.folder.removeAll(this.ownerOf(r), id).catch((err: Error) => console.warn(`[folder] a deleted bot's files stayed: ${err.message}`));
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

  // ---- whose Claude a computer uses ----

  /** A computer the user may change (theirs, or a managed team's server), by id or name. */
  private async claudeComputer(actor: Actor, ref: string): Promise<HostRow> {
    const hosts = (await this.rows(actor)).hosts;
    const want = ref.toLowerCase();
    const h = hosts.find((x) => x.id === ref) ?? hosts.find((x) => x.name.toLowerCase() === want || x.info?.hostname.toLowerCase() === want);
    if (!h) throw refused("no_such_computer");
    if (h.teamId) {
      const team = this.teamOf(actor, h.teamId);
      if (!team || !isManager(team) || !actor.canWriteTeams) throw refused("claude_admins_only");
    } else if (!actor.canWritePersonal) throw refused("read_only");
    return h;
  }

  private computerOwner(h: HostRow, actor: Actor): Owner {
    return h.teamId ? { kind: "team", teamId: h.teamId } : { kind: "user", uid: actor.uid };
  }

  private afterClaude(actor: Actor, out: { ok: boolean; error?: string; host?: unknown }): Computer {
    if (!out.ok) throw refused(out.error ?? "bad_request");
    return this.computer(out.host as HostRow, actor);
  }

  /** Store a plan token or an API key for the computer, sealed, and use it. Only from the app. */
  async setClaude(actor: Actor, ref: string, kind: "plan" | "key", token: string): Promise<Computer> {
    const t = token.trim().replace(/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/, "");
    if (!/^[A-Za-z0-9_-]+$/.test(t) || (kind === "plan" ? !t.startsWith("sk-ant-oat") : !t.startsWith("sk-ant-api"))) throw refused("bad_token");
    const h = await this.claudeComputer(actor, ref);
    const sealed = await this.d.keys.seal(this.computerOwner(h, actor), `host:claude:${kind}`, t);
    return this.afterClaude(actor, await this.d.control.m(api.routines.setClaude, { uid: actor.uid as never, id: h.id, kind, iv: sealed.iv, ct: sealed.ciphertext, now: this.now() }));
  }

  /** Switch the computer between its stored plan, its stored key and its own sign-in. */
  async useClaude(actor: Actor, ref: string, use: "plan" | "key" | "computer"): Promise<Computer> {
    const h = await this.claudeComputer(actor, ref);
    return this.afterClaude(actor, await this.d.control.m(api.routines.useClaude, { uid: actor.uid as never, id: h.id, use }));
  }

  async removeClaude(actor: Actor, ref: string, kind: "plan" | "key"): Promise<Computer> {
    const h = await this.claudeComputer(actor, ref);
    return this.afterClaude(actor, await this.d.control.m(api.routines.removeClaude, { uid: actor.uid as never, id: h.id, kind }));
  }

  private async claudeVersion(host: Host): Promise<string | null> {
    const c = await this.d.control.q(api.routines.hostClaude, { hostId: host.id as never });
    return c ? `${c.kind}:${c.at}` : null;
  }

  /** The default model for the computer's runs and Ambient there; null: Claude Code's own. */
  async setModel(actor: Actor, ref: string, model: ModelChoice | null): Promise<Computer> {
    if (model && modelRuntime(model.model) !== "claude-code") throw refused("claude_model_only");
    const h = await this.claudeComputer(actor, ref);
    return this.afterClaude(actor, await this.d.control.m(api.routines.setModel, { uid: actor.uid as never, id: h.id, model: model ? storedModel(model) : null }));
  }

  /** What Ambient may do on the computer. An AI app (`fromAI`) may only lower it. */
  async setAccess(actor: Actor, ref: string, access: Access, opts: { fromAI?: boolean } = {}): Promise<Computer> {
    const h = await this.claudeComputer(actor, ref);
    return this.afterClaude(actor, await this.d.control.m(api.routines.setAccess, { uid: actor.uid as never, id: h.id, access, onlyLower: Boolean(opts.fromAI) }));
  }

  async removeAllowed(actor: Actor, ref: string, command: string): Promise<Computer> {
    const h = await this.claudeComputer(actor, ref);
    return this.afterClaude(actor, await this.d.control.m(api.routines.removeAllowed, { uid: actor.uid as never, id: h.id, command }));
  }

  /** A computer the user may change, for Ambient's root commands there. */
  async adminComputer(actor: Actor, ref: string): Promise<Computer & { hostTeamId: string | null }> {
    const h = await this.claudeComputer(actor, ref);
    return { ...this.computer(h, actor), hostTeamId: h.teamId };
  }

  // ---- how a computer's Codex bots sign in to OpenAI ----

  /** Store an OpenAI API key for the computer, sealed, and use it. Only from the app. */
  async setOpenAIKey(actor: Actor, ref: string, key: string): Promise<Computer> {
    const k = key.trim().replace(/^(OPENAI_API_KEY|CODEX_API_KEY)=/, "");
    if (!/^sk-[A-Za-z0-9_-]{20,300}$/.test(k) || k.startsWith("sk-ant-")) throw refused("bad_openai_key");
    const h = await this.claudeComputer(actor, ref);
    const sealed = await this.d.keys.seal(this.computerOwner(h, actor), "host:openai:key", k);
    return this.afterClaude(actor, await this.d.control.m(api.routines.setOpenAI, { uid: actor.uid as never, id: h.id, iv: sealed.iv, ct: sealed.ciphertext, now: this.now() }));
  }

  /** Switch the computer's Codex bots between the stored key and the computer's own sign-in. */
  async useOpenAI(actor: Actor, ref: string, use: "plan" | "key"): Promise<Computer> {
    const h = await this.claudeComputer(actor, ref);
    return this.afterClaude(actor, await this.d.control.m(api.routines.useOpenAI, { uid: actor.uid as never, id: h.id, use }));
  }

  async removeOpenAIKey(actor: Actor, ref: string): Promise<Computer> {
    const h = await this.claudeComputer(actor, ref);
    return this.afterClaude(actor, await this.d.control.m(api.routines.removeOpenAI, { uid: actor.uid as never, id: h.id }));
  }

  /** A computer the user may change, for signing Codex in there (the runner does it, by device code). */
  async openaiComputer(actor: Actor, ref: string): Promise<Computer> {
    return this.computer(await this.claudeComputer(actor, ref), actor);
  }

  private async openaiVersion(host: Host): Promise<string | null> {
    const c = await this.d.control.q(api.routines.hostOpenAI, { hostId: host.id as never });
    return c ? `key:${c.at}` : null;
  }

  /** The computer's stored OpenAI key as environment for its Codex runs; none: its own sign-in. */
  async hostOpenAI(host: Host): Promise<{ version: string | null; env: Record<string, string> }> {
    const c = await this.d.control.q(api.routines.hostOpenAI, { hostId: host.id as never });
    if (!c) return { version: null, env: {} };
    const owner: Owner = c.teamId ? { kind: "team", teamId: String(c.teamId) } : { kind: "user", uid: String(c.uid) };
    return { version: `key:${c.at}`, env: { CODEX_API_KEY: await this.d.keys.open(owner, "host:openai:key", c.iv, c.ct) } };
  }

  /** The computer's chosen sign-in as environment (only the computer asks, with its token). */
  async hostClaude(host: Host): Promise<{ version: string | null; env: Record<string, string> }> {
    const c = await this.d.control.q(api.routines.hostClaude, { hostId: host.id as never });
    if (!c) return { version: null, env: {} };
    // A personal computer's is sealed with its owner's key, a team server's with the team's.
    const owner: Owner = c.teamId ? { kind: "team", teamId: String(c.teamId) } : { kind: "user", uid: String(c.uid) };
    const value = await this.d.keys.open(owner, `host:claude:${c.kind}`, c.iv, c.ct);
    return { version: `${c.kind}:${c.at}`, env: c.kind === "plan" ? { CLAUDE_CODE_OAUTH_TOKEN: value } : { ANTHROPIC_API_KEY: value } };
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

  async sync(
    host: Host,
    info?: HostInfo,
  ): Promise<{ computer: { id: string; name: string }; routines: HostRoutine[]; runner?: { version: string; sha256: string; signature?: string }; ambient: boolean; claude: string | null; openai: string | null; model: StoredModel | null }> {
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
      // A person's own computer runs Ambient for them, a team's server for the team's people.
      ambient: await this.ambientOn(host),
      // Which Claude sign-in it uses, as a version: the computer fetches it when this changes.
      claude: await this.claudeVersion(host),
      // Which OpenAI key its Codex bots use, as a version (null: the computer's own sign-in).
      openai: await this.openaiVersion(host),
      // The default model for its runs (a bot's own wins; startRun says).
      model: (out as unknown as { model?: StoredModel | null }).model ?? null,
    };
  }

  /** A run starts: what to run, its owner's secrets as environment variables, and the run's id. */
  async startRun(
    host: Host,
    id: string,
  ): Promise<{
    run: { id: string; trigger: string };
    routine: { id: string; name: string; prompt: string; folder: string | null };
    env: Record<string, string>;
    /** A bot's settings (runtime, isolation, …); null for a plain loop. */
    bot: BotSettings | null;
    /** A bot's run that continues a conversation: the session and what it continues with. */
    resume: { sessionId: string | null; message: string } | null;
    /** A bot's run: its token for asking the owner (POST /v1/bot/ask), valid while it runs. */
    runToken: string | null;
    /** A bot's run (runner 0.8.0): its instructions, skills and memory (docs/bots.md, "A bot's folder"). */
    workspace?: { system: string; skills: { path: string; content: string }[]; memory: string };
  }> {
    // Every run gets a token; only a bot's run stores (and so honours) it.
    const runToken = `${RUN_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const out = await this.d.control.m(api.routines.startRun, { hostId: host.id as never, id, runTokenHash: sha256Hex(runToken), now: this.now() });
    if (!out.ok) throw refused(out.error);
    const r = out.routine as unknown as RoutineRow;
    const owner = this.ownerOf(r);
    const env: Record<string, string> = {};
    // Secrets stored before a name was reserved don't go out either.
    for (const s of out.secrets) if (!RESERVED_ENV.test(s.name)) env[s.name] = await this.d.keys.open(owner, `routine:secret:${s.name}`, s.iv, s.ct);
    // A bot without a GitHub token of its own gets one from Ambient's GitHub App, for this run and
    // the repos it watches only (it lasts an hour; never stored).
    if (r.bot && !env.GH_TOKEN && this.githubToken) {
      const token = await this.githubToken(owner, r.id).catch((err: Error) => {
        console.warn(`[github-app] no token for a run: ${err.message}`);
        return null;
      });
      if (token) {
        env.GH_TOKEN = token;
        env.GITHUB_TOKEN = token;
      }
    }
    let resume: { sessionId: string | null; message: string } | null = null;
    if (r.bot && out.resume) {
      const body = await openMessage(this.d.keys, owner, out.resume.iv, out.resume.ct).catch(() => ({ text: "" }));
      const who = out.resume.authorName ?? "Your owner";
      resume = {
        sessionId: out.resume.sessionId,
        message:
          out.resume.kind === "answer"
            ? `${who} answered your question: ${body.text}`
            : out.resume.authorName === "GitHub" && !(out.resume as { authorId?: string | null }).authorId
              ? body.text
              : `${who} wrote to you in the Ambient app: ${body.text}`,
      };
    }
    let prompt = await this.d.keys.open(owner, "routine:prompt", r.promptIv, r.promptCt);
    let workspace: { system: string; skills: { path: string; content: string }[]; memory: string } | undefined;
    if (r.bot && this.d.folder) {
      const previous = (out as unknown as { previous: { session: string | null; startedAt: number | null; finishedAt: number | null } | null }).previous;
      const pendingId = (out.resume as { id?: string } | null)?.id ? String((out.resume as { id: string }).id) : null;
      const thread = await this.threadSince(owner, r.id, previous?.startedAt ?? 0, pendingId);
      const github = this.githubFor ? await this.githubFor(owner, r.id).catch(() => null) : null;
      const woken = await this.d.folder.wake({ owner, routineId: r.id, name: r.name, agents: prompt, computer: host.name, trigger: out.trigger, contained: r.bot.isolation === "container", previous, resume, thread, github });
      prompt = woken.prompt;
      resume = woken.resume;
      workspace = woken.workspace;
    }
    return {
      run: { id: String(out.runId), trigger: out.trigger },
      routine: { id: r.id, name: r.name, prompt, folder: r.folder },
      env,
      bot: r.bot,
      resume,
      runToken: r.bot ? runToken : null,
      ...(workspace ? { workspace } : {}),
    };
  }

  /** What the owner and Amb wrote in a bot's thread since `after` (a fresh run's wake-up), oldest first. */
  private async threadSince(owner: Owner, id: string, after: number, skip: string | null): Promise<{ at: number; who: string; text: string }[]> {
    const page = (await this.d.control.q(api.bots.threadHistory, { id, after, before: this.now() + 1, limit: 60 }).catch(() => null)) as { messages: { id: string; role: string; iv: string; ct: string; authorName: string | null; createdAt: number }[] } | null;
    if (!page) return [];
    const out: { at: number; who: string; text: string }[] = [];
    for (const m of page.messages.reverse()) {
      if (m.role === "bot" || String(m.id) === skip) continue;
      const body = await openMessage(this.d.keys, owner, m.iv, m.ct).catch(() => null);
      if (body?.text) out.push({ at: m.createdAt, who: m.authorName ?? (m.role === "ambient" ? "Ambient" : "Your owner"), text: body.text });
    }
    return out;
  }

  async finishRun(host: Host, runId: string, result: RunResult): Promise<void> {
    const who = await this.d.control.q(api.routines.runOwner, { hostId: host.id as never, runId });
    if (!who) throw refused("no_such_run");
    const owner: Owner = who.teamId ? { kind: "team", teamId: String(who.teamId) } : { kind: "user", uid: String(who.uid) };
    const text = result.summary?.trim();
    const clipped = text && text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
    const sealed = clipped ? await this.d.keys.seal(owner, "routine:run", clipped) : undefined;
    // A bot's thread gets the result too (Convex decides whether it's news).
    const message = who.bot && clipped ? { ...(await sealMessage(this.d.keys, owner, { text: clipped })), hash: resultHash(clipped) } : undefined;
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
      message,
      now: this.now(),
    });
    if (!out.ok) throw refused(out.error);
    // A bot's handoff and memory for its next run (docs/bots.md, "How a bot wakes up").
    if (who.bot && this.d.folder) {
      const w = who as unknown as { routineId: string; startedAt: number; name: string };
      await this.d.folder.afterRun(owner, { routineId: String(w.routineId), name: w.name, runId, startedAt: w.startedAt }, { memory: result.memory, handoff: result.handoff, summary: clipped, failed: result.status === "failed" });
    }
    if (who.bot && result.status === "failed") {
      const w = who as unknown as { routineId: string; name: string };
      this.onBotEvent?.({ kind: "bot_failed", uid: String(who.uid), routineId: String(w.routineId), bot: w.name, text: clipped ?? "", runId });
    }
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

/** A bot's own model must be its runtime's (a Claude model can't run in Codex, nor the other way). */
function matchingModel(b: BotSettings): BotSettings {
  if (b.model && modelRuntime(b.model.model) !== b.runtime) throw refused("model_runtime");
  return b;
}
