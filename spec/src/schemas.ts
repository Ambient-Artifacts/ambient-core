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

/** Phone → gateway → team VPS payload for one Team-scoped recording. */
export const TeamNoteV1 = z.object({
  schema: z.literal("brain.team-note/v1"),
  note_id: z.string().min(10),
  team_id: z.string().min(1),
  recorded_by: z.string().min(1),
  /** Display name of the recorder, filled in by the gateway from the account. */
  recorded_by_name: z.string().max(80).optional(),
  recorded_at: isoDateTime,
  duration_s: z.number().int().nonnegative(),
  language: z.string().min(2),
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
        .array(z.object({ t0: z.number(), t1: z.number(), text: z.string(), speaker: z.string().max(80).optional() }))
        .max(20_000),
    })
    .nullable(),
  participants_hint: z.array(z.string()).max(50).default([]),
  client: z.object({ app: z.string(), transcriber: z.string(), compiler: z.string() }),
});
export type TeamNoteV1 = z.infer<typeof TeamNoteV1>;

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
  "sync-request": SyncRequest,
  "sync-response": SyncResponse,
  "job-result": JobResult,
  "review-item": ReviewItem,
} as const;
