// Shared data contracts. The iOS app mirrors these via the exported JSON Schemas
// (spec/json-schema/*.json), so every change here is a wire-format change.
import { z } from "zod";

/** Wiki-relative path without the `.md` extension, e.g. `people/anna-schmidt`. */
export const PageRef = z
  .string()
  .regex(/^[a-z0-9][a-z0-9/_-]*$/, "lowercase path without .md");

export const Scope = z.enum(["personal", "team"]);

/** `session`: a work session with an AI agent (Claude Code, Claude, ChatGPT, Copilot), not a recording. */
export const NoteKind = z.enum(["meeting", "call", "memo", "idea", "lecture", "other", "session"]);

export const ConsentMode = z.enum(["all-agreed", "announced", "solo", "unknown"]);

const isoDateTime = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Front matter of a note entry page (one per recording). */
export const NoteFrontmatter = z
  .object({
    id: z.string().min(10),
    type: z.literal("note"),
    title: z.string().min(1).max(60),
    summary: z.string().min(1).max(200),
    kind: NoteKind,
    recorded_at: isoDateTime,
    duration_s: z.number().int().nonnegative(),
    language: z.string().min(2),
    scope: Scope,
    team_id: z.string().optional(),
    recorded_by: PageRef.optional(),
    consent: z.object({ mode: ConsentMode, confirmed_at: isoDateTime.optional() }),
    people: z.array(PageRef).default([]),
    orgs: z.array(PageRef).default([]),
    projects: z.array(PageRef).default([]),
    topics: z.array(PageRef).default([]),
    raw: z.string().optional(),
    /** Work sessions: which agent, and where the work happened. */
    work: z
      .object({
        tool: z.string().min(1).max(40),
        repo: z.string().max(200).optional(),
        branch: z.string().max(120).optional(),
        ended_at: isoDateTime.optional(),
      })
      .optional(),
    compile: z
      .object({
        engine: z.enum(["fm-ondevice", "fm-pcc", "server"]),
        status: z.enum(["compiled", "partial", "failed"]),
        fallback: z.enum(["none", "extractive"]).default("none"),
      })
      .optional(),
    updated: isoDate,
  })
  .refine((n) => n.scope === "personal" || n.team_id !== undefined, {
    message: "team notes need team_id",
    path: ["team_id"],
  });
export type NoteFrontmatter = z.infer<typeof NoteFrontmatter>;

/** Front matter of a compiled living page (person, org, project, topic). */
export const LivingPageFrontmatter = z.object({
  title: z.string().min(1),
  type: z.enum(["person", "org", "project", "topic"]),
  summary: z.string().min(1).max(200),
  aliases: z.array(z.string()).default([]),
  update_mode: z.literal("compiled"),
  status: z.enum(["active", "outdated"]).default("active"),
  links: z.record(z.string(), z.union([PageRef, z.array(PageRef)])).default({}),
  compiled_through: z.string().optional(),
  owner: z.string().optional(),
  review: z.enum(["auto", "required"]).optional(),
  updated: isoDate,
});
export type LivingPageFrontmatter = z.infer<typeof LivingPageFrontmatter>;

/** Front matter of a team decision page (`decisions/NNNN-slug.md`). */
export const DecisionFrontmatter = z.object({
  title: z.string().min(1),
  type: z.literal("decision"),
  summary: z.string().min(1).max(200),
  status: z.enum(["recorded", "accepted", "superseded"]),
  date: isoDate,
  deciders: z.array(PageRef).default([]),
  affects: z.array(PageRef).default([]),
  supersedes: PageRef.optional(),
  source: PageRef.optional(),
  updated: isoDate,
});
export type DecisionFrontmatter = z.infer<typeof DecisionFrontmatter>;

/**
 * A note's id as the apps (a ULID) and the gateway (base36 time + hex) make it. Letters, digits,
 * "-" and "_" only: the team server names the note's raw transcript after it.
 */
export const NoteId = z.string().regex(/^[0-9A-Za-z_-]{10,64}$/, "letters, digits, - and _ only (10 to 64)");

/** Phone → gateway → team VPS payload for one Team-scoped recording. */
export const TeamNoteV1 = z.object({
  schema: z.literal("brain.team-note/v1"),
  note_id: NoteId,
  team_id: z.string().min(1),
  recorded_by: z.string().min(1),
  /** Display name of the recorder, filled in by the gateway from the account. */
  recorded_by_name: z.string().max(80).optional(),
  recorded_at: isoDateTime,
  duration_s: z.number().int().nonnegative(),
  language: z.string().min(2).max(35),
  kind: NoteKind,
  consent: z.object({
    mode: ConsentMode.exclude(["unknown"]),
    confirmed_at: isoDateTime,
  }),
  entry_page: z.object({
    frontmatter: z.record(z.string(), z.unknown()),
    body_md: z.string().max(20_000),
  }),
  transcript: z
    .object({
      segments: z
        .array(z.object({ t0: z.number(), t1: z.number(), text: z.string().max(20_000), speaker: z.string().max(80).optional() }))
        .max(20_000),
    })
    .nullable(),
  participants_hint: z.array(z.string().max(120)).max(50).default([]),
  client: z.object({ app: z.string().max(200), transcriber: z.string().max(200), compiler: z.string().max(200) }),
  /** When the recording ended. Optional: older apps don't send it. */
  ended_at: isoDateTime.optional(),
  /** The calendar event the recording matched: names only, never the call link. */
  meeting: z
    .object({
      title: z.string().max(200),
      start: isoDateTime.optional(),
      end: isoDateTime.optional(),
      attendees: z.array(z.string().max(120)).max(50).default([]),
    })
    .optional(),
  /** Speaker labels as used in the transcript ("Lena Vogel", "Speaker 1"). */
  speakers: z.array(z.string().max(80)).max(50).optional(),
});
export type TeamNoteV1 = z.infer<typeof TeamNoteV1>;

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** A OneDrive or SharePoint folder, written through the team's Microsoft 365 connection. */
const DriveFolder = z.object({
  kind: z.literal("drive"),
  drive_id: z.string().min(5).max(300),
  folder_id: z.string().min(5).max(300),
  /** What people see, e.g. "Documents / Meetings". */
  label: z.string().max(300).default(""),
});

/** Where a team's meeting transcripts go (product/sources.md in the team wiki). */
export const TranscriptDestination = z.discriminatedUnion("kind", [
  /** `raw/` in the team's repository, committed with the note (and kept out of the page index). The default. */
  z.object({ kind: z.literal("repo"), folder: z.literal("raw").default("raw") }),
  DriveFolder,
  /** Kept only on the team server, as before destinations existed. */
  z.object({ kind: z.literal("none") }),
]);
export type TranscriptDestination = z.infer<typeof TranscriptDestination>;

/** Where copies of shared work logs (agent sessions, log_work) go. Off by default. */
export const WorkDestination = z.discriminatedUnion("kind", [z.object({ kind: z.literal("none") }), DriveFolder]);
export type WorkDestination = z.infer<typeof WorkDestination>;

/** App-only access with the team's own Entra app (client credentials, the secret on the team server). */
export const OwnMicrosoftApp = z.object({
  kind: z.literal("own"),
  tenant_id: guid,
  client_id: guid,
  client_secret: z.string().min(10).max(300),
});

/**
 * App-only access with Ambient's own Microsoft app, which the company's admin approved and gave
 * one folder ("Connect Microsoft 365"). Its credential lives only on the gateway; the team server
 * gets short-lived tokens for this tenant from it.
 */
export const AmbientMicrosoftApp = z.object({
  kind: z.literal("ambient"),
  tenant_id: guid,
  /** The company's name in Microsoft 365, for the settings screen. */
  tenant_name: z.string().max(200).default(""),
});

/** Settings written before there were two kinds have no `kind`: those are "own" (see withKind). */
export const MicrosoftConnection = z.discriminatedUnion("kind", [OwnMicrosoftApp, AmbientMicrosoftApp]);
export type MicrosoftConnection = z.infer<typeof MicrosoftConnection>;

/** A connection as older settings files and apps send it, without `kind`: the company's own app. */
export function withKind(v: unknown): unknown {
  return v && typeof v === "object" && !Array.isArray(v) && !("kind" in v) ? { ...(v as object), kind: "own" } : v;
}

/**
 * Per-team settings, kept on the team server (0600, the secret sealed). Who maintains the wiki
 * isn't one of them: a repo connected read-only means another tool does.
 */
export const TeamSettings = z.object({
  transcripts: TranscriptDestination.default({ kind: "repo", folder: "raw" }),
  work: WorkDestination.default({ kind: "none" }),
  microsoft: MicrosoftConnection.nullable().default(null),
});
export type TeamSettings = z.infer<typeof TeamSettings>;

/** Phone → personal store sync (one-way). Ops are idempotent on (path, hash). hash = sha256(content). */
export const SyncOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    /** Wiki pages, and raw transcripts (`raw/…`) so they are backed up as well. */
    path: z.string().regex(/^(wiki\/[a-z0-9][a-z0-9/_.-]*|raw\/\d{4}\/\d{2}\/[0-9A-Za-z_-]+)\.md$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().max(600_000),
    updated: isoDate,
  }),
  z.object({
    op: z.literal("delete"),
    path: z.string().regex(/^(wiki\/[a-z0-9][a-z0-9/_.-]*|raw\/\d{4}\/\d{2}\/[0-9A-Za-z_-]+)\.md$/),
  }),
]);
export const SyncRequest = z.object({
  device_id: z.string().min(1).max(100),
  ops: z.array(SyncOp).max(500),
  /** The highest seq this device has pulled; the reply carries what others wrote after it. */
  since_seq: z.number().int().nonnegative().optional(),
});
export const SyncResponse = z.object({
  seq: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  rejected: z.array(z.object({ path: z.string(), reason: z.string() })),
  /**
   * What changed since `since_seq` that this device didn't write: the server's pages (Claude
   * upkeep, overview, captures, merges) and the user's other devices' pages and deletions.
   * Older builds without their own device id get only the server's pages.
   */
  changes: z.array(z.object({ path: z.string(), hash: z.string(), content: z.string(), deleted: z.boolean().optional() })),
  /** Set when there's more: the device has caught up to this seq and asks again from it. */
  through: z.number().int().nonnegative().nullable().optional(),
  /** True when the reply follows per-device sync (the device sent its own id). */
  devices: z.boolean().optional(),
});
export type SyncRequest = z.infer<typeof SyncRequest>;
export type SyncResponse = z.infer<typeof SyncResponse>;

/**
 * Every fleet job writes exactly one of these. Monitoring reads only this
 * contract, never free-text logs (the Miora notify gates broke that way).
 */
export const JobResult = z.object({
  job: z.enum(["ingest", "lint", "consolidate", "gardener", "backup", "update", "purge"]),
  run_id: z.string(),
  version: z.string(),
  started_at: isoDateTime,
  finished_at: isoDateTime,
  status: z.enum(["ok", "noop", "partial", "failed"]),
  reason: z.string().nullable(),
  input: z.record(z.string(), z.number()),
  output: z.object({
    pages_updated: z.number().int().nonnegative(),
    review_items: z.number().int().nonnegative(),
    commits: z.array(z.string()),
  }),
  llm: z
    .object({
      requests: z.number().int().nonnegative(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cache_read_tokens: z.number().int().nonnegative(),
      cost_usd: z.number().nonnegative(),
      by_model: z.record(z.string(), z.number()),
    })
    .nullable(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().optional() })),
  error: z.string().nullable(),
});
export type JobResult = z.infer<typeof JobResult>;

/** A change that needs a human (section owner or admin) before it lands. */
export const ReviewItem = z.object({
  id: z.string(),
  kind: z.enum(["contradiction", "supersede", "low-confidence", "protected-page", "merge", "rename", "delete", "gardener", "lint"]),
  target: PageRef,
  diff: z.string(),
  evidence: z.array(PageRef),
  proposed_by: z.enum(["consolidate", "gardener", "lint"]),
  owner_uids: z.array(z.string()),
  created: isoDateTime,
  expires: isoDateTime,
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const schemas = {
  "note-frontmatter": NoteFrontmatter,
  "living-page-frontmatter": LivingPageFrontmatter,
  "decision-frontmatter": DecisionFrontmatter,
  "team-note-v1": TeamNoteV1,
  "team-settings": TeamSettings,
  "sync-request": SyncRequest,
  "sync-response": SyncResponse,
  "job-result": JobResult,
  "review-item": ReviewItem,
} as const;
