// Bots: loops with a face, a thread and a runtime of their own. A bot is a routine with these
// settings; the gateway works out its state, the runner starts it through the adapter its
// `runtime` names, and every run reports in Ambient's own events (never one vendor's format), so
// another runtime (Codex, Copilot, an API model) is a runner adapter, not a redesign.
import { z } from "zod";

/** The head's shape; the colour is always the bot's state. */
export const BOT_FACES = ["classic", "round", "tall", "wide"] as const;
export type BotFace = (typeof BOT_FACES)[number];

/** What runs a bot. One for now; the runner has one adapter per runtime. */
export const BOT_RUNTIMES = ["claude-code"] as const;
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

/** A model, its effort and what to fall back to (docs/bots.md); the runner passes them to Claude Code. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ModelChoice = z.object({
  model: z.string().regex(/^claude-[a-z0-9.-]{2,60}$/),
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
  runtime: z.enum(BOT_RUNTIMES),
  isolation: z.enum(BOT_ISOLATIONS),
  secrets: SecretNameList.optional(),
  report: z.enum(BOT_REPORTS),
  /** Absent: the computer's default model. */
  model: z.object({ model: z.string(), effort: z.string().optional(), fallback: z.string().optional() }).optional(),
});
export type BotSettings = z.infer<typeof BotSettings>;

/** What the app and the MCP tools send; everything optional, defaults below. */
export const BotInput = z.object({
  face: z.enum(BOT_FACES).optional(),
  runtime: z.enum(BOT_RUNTIMES).optional(),
  isolation: z.enum(BOT_ISOLATIONS).optional(),
  /** null: all of the owner's secrets. */
  secrets: SecretNameList.nullable().optional(),
  report: z.enum(BOT_REPORTS).optional(),
  /** null: the computer's default model. */
  model: ModelChoice.nullable().optional(),
});
export type BotInput = z.infer<typeof BotInput>;

export const BOT_DEFAULTS: BotSettings = { face: "classic", runtime: "claude-code", isolation: "container", secrets: [], report: "news" };

/** Settings after `input` is applied to `current` (or to the defaults for a new bot). */
export function botSettings(input: BotInput, current?: BotSettings): BotSettings {
  const base = current ?? BOT_DEFAULTS;
  const secrets = input.secrets === null ? undefined : (input.secrets ?? base.secrets);
  const model = input.model === null ? undefined : input.model ? storedModel(input.model) : base.model;
  return {
    face: input.face ?? base.face,
    runtime: input.runtime ?? base.runtime,
    isolation: input.isolation ?? base.isolation,
    ...(secrets ? { secrets: [...new Set(secrets)].sort() } : {}),
    report: input.report ?? base.report,
    ...(model ? { model } : {}),
  };
}

/** A bot's state from what is stored: never kept itself, so it can't go stale. */
export function botState(r: { enabled: boolean; ready: boolean; lastRunStatus: string | null; openQuestion: boolean }): BotState {
  if (r.lastRunStatus === "running") return "working";
  if (r.openQuestion) return "needs_you";
  if (!r.enabled || !r.ready || !r.lastRunStatus) return "asleep";
  return r.lastRunStatus === "failed" ? "stuck" : "done";
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
  runtime: BotRuntime;
  /** AGENTS.md: what it does and how. */
  instructions: string;
  triggers: { schedule: { every: "hour" | "day" | "weekday" | "week"; days?: string[]; time: string; timezone: string } };
  grants: { secrets: string[] | "all" };
  isolation: BotIsolation;
  channels: { kind: "app" }[];
  report: BotReport;
}
