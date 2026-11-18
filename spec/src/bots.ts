// Bots: loops with a face, a thread and a runtime of their own. A bot is a routine with these
// settings; the gateway works out its state, the runner starts it through the adapter its
// `runtime` names, and every run reports in Ambient's own events (never one vendor's format), so
// another runtime (Codex, Copilot, an API model) is a runner adapter, not a redesign.
import { z } from "zod";

/**
 * What a bot looks like (docs/bots.md, "Faces"): a piece of Yosemite peeking up from a disc in the
 * bot's own colour, dressed for its job. The colour never changes; how it's doing shows only in its
 * face and how it moves. Shapes: Half Dome, a pebble, El Capitan, a ridge, a cloud, a drop from
 * the falls.
 */
export const BOT_SHAPES = ["dome", "pebble", "cap", "ridge", "cloud", "drop"] as const;
export type BotShape = (typeof BOT_SHAPES)[number];
/** Stored faces: the shapes, and the names from before them (classic, round, tall, wide). */
export const BOT_FACES = [...BOT_SHAPES, "classic", "round", "tall", "wide"] as const;
export type BotFace = (typeof BOT_FACES)[number];
/** Ambient's pastels (design/color.md); a bot keeps its one for life. */
export const BOT_COLORS = ["sky", "sage", "sand", "clay", "lake", "rose", "moss", "stone"] as const;
export type BotColor = (typeof BOT_COLORS)[number];
/** What a bot can wear: real things a person in that job would wear (a few at once). */
export const BOT_WEAR = ["hoodie", "nerd", "glasses", "headset", "cap", "beret", "tie", "bowtie", "monocle", "ranger", "headlamp", "beanie"] as const;
export type BotWear = (typeof BOT_WEAR)[number];
/** A look for each kind of job, for whoever dresses a new bot (the app's picker, Claude over MCP). */
export const BOT_LOOKS: Record<string, BotWear[]> = {
  Engineer: ["hoodie"],
  "Bug fixer": ["nerd", "hoodie"],
  Reviewer: ["nerd"],
  Researcher: ["glasses"],
  Writer: ["beret"],
  Support: ["headset"],
  Sales: ["tie"],
  Growth: ["cap"],
  Finance: ["monocle", "bowtie"],
  Monitoring: ["ranger"],
  "Night jobs": ["headlamp"],
  Ops: ["beanie"],
};

/** One of `list`, picked by `name`: stable for a name, spread across names (FNV-1a). */
function pickBy<T>(name: string, list: readonly T[]): T {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return list[(h >>> 0) % list.length]!;
}

/**
 * The look a bot is drawn with. A face from before the shapes maps onto one (round, tall and wide
 * onto the pebble, El Cap and the ridge; classic, the old default, onto one picked by its name, so
 * the first bots don't all look alike); no colour yet: one picked by its name.
 */
export interface BotLook {
  face: BotShape;
  color: BotColor;
  wear: BotWear[];
}
export function botLook(name: string, s: { face: string; color?: string; wear?: string[] }): BotLook {
  const legacy: Record<string, BotShape> = { round: "pebble", tall: "cap", wide: "ridge" };
  const face = (BOT_SHAPES as readonly string[]).includes(s.face) ? (s.face as BotShape) : (legacy[s.face] ?? pickBy(name, BOT_SHAPES));
  const color = (BOT_COLORS as readonly string[]).includes(s.color ?? "") ? (s.color as BotColor) : pickBy(`${name}·colour`, BOT_COLORS);
  const wear = (s.wear ?? []).filter((w): w is BotWear => (BOT_WEAR as readonly string[]).includes(w));
  return { face, color, wear };
}

/** What runs a bot; the runner has one adapter per runtime (docs/bots.md, "Codex next to Claude Code"). */
export const BOT_RUNTIMES = ["claude-code", "codex"] as const;
export type BotRuntime = (typeof BOT_RUNTIMES)[number];

/**
 * container: its own container and volume (its workspace and HOME) with only its granted secrets;
 * host: as the computer's routine user, like a loop.
 */
export const BOT_ISOLATIONS = ["container", "host"] as const;
export type BotIsolation = (typeof BOT_ISOLATIONS)[number];

/** news: a result reaches the thread when it failed, asked or said something new; every_run: always. */
export const BOT_REPORTS = ["news", "every_run"] as const;
export type BotReport = (typeof BOT_REPORTS)[number];

export const BOT_STATES = ["asleep", "working", "needs_you", "stuck", "done"] as const;
export type BotState = (typeof BOT_STATES)[number];

/** A model, its effort and what to fall back to (docs/bots.md); the runner passes them to Claude Code or Codex. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Claude's model ids. */
export const CLAUDE_MODEL = /^claude-[a-z0-9.-]{2,60}$/;
/** OpenAI's model ids as Codex takes them (gpt-…, o3…, codex-…). */
export const OPENAI_MODEL = /^(gpt-[a-z0-9.-]{1,60}|o[1-9][a-z0-9.-]{0,40}|codex-[a-z0-9.-]{1,60})$/;
/** Which runtime a model id belongs to. */
export function modelRuntime(model: string): BotRuntime | null {
  return CLAUDE_MODEL.test(model) ? "claude-code" : OPENAI_MODEL.test(model) ? "codex" : null;
}
/** Codex's reasoning effort for ours (it has no "max"). */
export function codexEffort(effort: string | undefined): string | undefined {
  return effort === "max" ? "xhigh" : effort;
}
export const ModelChoice = z.object({
  model: z.string().refine((m) => modelRuntime(m) !== null, "a Claude model (claude-…) or an OpenAI one (gpt-…, o3…, codex-…)"),
  effort: z.enum(EFFORTS).nullable().optional(),
  fallback: z.string().regex(/^claude-[a-z0-9.-]{2,60}$/).nullable().optional(),
});
export type ModelChoice = z.infer<typeof ModelChoice>;

/** As stored: no nulls. */
export function storedModel(m: ModelChoice): { model: string; effort?: string; fallback?: string } {
  return { model: m.model, ...(m.effort ? { effort: m.effort } : {}), ...(m.fallback ? { fallback: m.fallback } : {}) };
}

const SecretNameList = z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(30);

/** What's stored with a routine that is a bot. `secrets` undefined: all of its owner's (loops from before). */
export const BotSettings = z.object({
  face: z.enum(BOT_FACES),
  /** Absent: one picked by its name (botLook). */
  color: z.enum(BOT_COLORS).optional(),
  /** What it wears; absent or empty: nothing. */
  wear: z.array(z.enum(BOT_WEAR)).max(3).optional(),
  runtime: z.enum(BOT_RUNTIMES),
  isolation: z.enum(BOT_ISOLATIONS),
  secrets: SecretNameList.optional(),
  report: z.enum(BOT_REPORTS),
  /** Absent: the computer's default model. */
  model: z.object({ model: z.string(), effort: z.string().optional(), fallback: z.string().optional() }).optional(),
  /** What Ambient may answer for the bot's owner (docs/bots.md, "Decisions"); absent: brain. */
  delegate: z.enum(["never", "brain", "most"]).optional(),
});
export type BotSettings = z.infer<typeof BotSettings>;

/** What the app and the MCP tools send; everything optional, defaults below. */
export const BotInput = z.object({
  face: z.enum(BOT_FACES).optional(),
  color: z.enum(BOT_COLORS).optional(),
  /** [] takes everything off. */
  wear: z.array(z.enum(BOT_WEAR)).max(3).optional(),
  runtime: z.enum(BOT_RUNTIMES).optional(),
  isolation: z.enum(BOT_ISOLATIONS).optional(),
  /** null: all of the owner's secrets. */
  secrets: SecretNameList.nullable().optional(),
  report: z.enum(BOT_REPORTS).optional(),
  /** null: the computer's default model. */
  model: ModelChoice.nullable().optional(),
  delegate: z.enum(["never", "brain", "most"]).optional(),
});
export type BotInput = z.infer<typeof BotInput>;

export const BOT_DEFAULTS: BotSettings = { face: "classic", runtime: "claude-code", isolation: "container", secrets: [], report: "news" };

/** Settings after `input` is applied to `current` (or to the defaults for a new bot). */
export function botSettings(input: BotInput, current?: BotSettings): BotSettings {
  const base = current ?? BOT_DEFAULTS;
  const secrets = input.secrets === null ? undefined : (input.secrets ?? base.secrets);
  // A new runtime drops a model of the other one's (a Claude model can't run in Codex).
  const runtime = input.runtime ?? base.runtime;
  const kept = base.model && modelRuntime(base.model.model) === runtime ? base.model : undefined;
  const model = input.model === null ? undefined : input.model ? storedModel(input.model) : kept;
  const color = input.color ?? base.color;
  const wear = input.wear ? [...new Set(input.wear)] : base.wear;
  return {
    face: input.face ?? base.face,
    ...(color ? { color } : {}),
    ...(wear?.length ? { wear } : {}),
    runtime,
    isolation: input.isolation ?? base.isolation,
    ...(secrets ? { secrets: [...new Set(secrets)].sort() } : {}),
    report: input.report ?? base.report,
    ...(model ? { model } : {}),
    ...((input.delegate ?? base.delegate) ? { delegate: input.delegate ?? base.delegate } : {}),
  };
}

/**
 * A bot's state from what is stored: never kept itself, so it can't go stale. "done" is news: its
 * last run went fine and reported something nobody has looked at yet (`news`; undefined counts as
 * news). Once its thread has been read, or when a run had nothing new to say, it's asleep until
 * the next run: between runs a bot isn't working.
 */
export function botState(r: { enabled: boolean; ready: boolean; lastRunStatus: string | null; openQuestion: boolean; news?: boolean }): BotState {
  if (r.lastRunStatus === "running") return "working";
  if (r.openQuestion) return "needs_you";
  if (!r.enabled || !r.ready || !r.lastRunStatus) return "asleep";
  if (r.lastRunStatus === "failed") return "stuck";
  return r.news === false ? "asleep" : "done";
}

/**
 * Whether a bot's last run left news nobody has read: its newest message is a result from that
 * run, newer than when its thread was last read.
 */
export function unseenNews(last: { kind: string; at: number } | null, lastRunStartedAt: number | null, seenAt: number | null): boolean {
  if (!last || last.kind !== "result") return false;
  return last.at >= (lastRunStartedAt ?? 0) && last.at > (seenAt ?? 0);
}

/**
 * What a runner adapter turns its runtime's output into, and what the gateway and the app see.
 * A runtime's own stream (Claude Code's stream-json, say) never leaves the adapter.
 */
export type RunEvent =
  | { type: "status"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "text"; text: string }
  | { type: "asked"; questionId: string; question: string }
  | { type: "result"; ok: boolean; text: string; costUsd?: number; turns?: number; session?: string };

/** The bot as a folder would hold it (bots/<name>/): the shape the spec moves to git in later. */
export interface BotSpecV1 {
  version: 1;
  name: string;
  face: BotFace;
  color?: BotColor;
  wear?: BotWear[];
  runtime: BotRuntime;
  /** AGENTS.md: what it does and how. */
  instructions: string;
  triggers: { schedule: { every: "hour" | "day" | "weekday" | "week"; days?: string[]; time: string; timezone: string } };
  grants: { secrets: string[] | "all" };
  isolation: BotIsolation;
  channels: { kind: "app" }[];
  report: BotReport;
}
