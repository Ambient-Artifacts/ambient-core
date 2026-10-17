// Brain control plane (MVP). Convex never stores readable note text: personal
// pages arrive already encrypted by the gateway. Only the gateway calls these
// functions (shared service secret); staff operations run via `npx convex run`.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const role = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"));
export const teamStatus = v.union(v.literal("active"), v.literal("suspended"), v.literal("canceled"));
export const runStatus = v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed"));
const weekday = v.union(v.literal("mon"), v.literal("tue"), v.literal("wed"), v.literal("thu"), v.literal("fri"), v.literal("sat"), v.literal("sun"));
/** See RoutineSchedule in @brain/spec (the gateway validates before writing). */
export const routineSchedule = v.object({
  every: v.union(v.literal("hour"), v.literal("day"), v.literal("weekday"), v.literal("week")),
  days: v.optional(v.array(weekday)),
  time: v.string(),
  timezone: v.string(),
});

export default defineSchema({
  users: defineTable({
    appleSub: v.optional(v.string()),
    /**
     * Sign in with Microsoft: the account's tenant and object ids ("tid:oid"), stable for one
     * person in one directory (personal Microsoft accounts share one tenant id). Email is never
     * the key: Microsoft lets it change and doesn't always verify it.
     */
    microsoftId: v.optional(v.string()),
    /**
     * An account made by a self-hosted server's admin (`admin user add`), for servers without
     * the apps' Apple or Microsoft sign-in: the lowercased email.
     */
    localId: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.string(),
    disabled: v.optional(v.boolean()),
    /** Bumped on every personal-page write; the gateway's index cache keys on it. */
    personalSeq: v.number(),
    /**
     * Claude keeps the personal wiki's living pages and overview current. Opt-in: absent means
     * the user hasn't been asked yet, and counts as off (note text goes to Anthropic only after
     * the user agreed).
     */
    consolidate: v.optional(v.boolean()),
    /** The morning push of open action items ("waiting on you"): absent means on. */
    digest: v.optional(v.boolean()),
    /** The user's local date (YYYY-MM-DD) the last morning push was considered, so it goes once a day. */
    digestSentOn: v.optional(v.string()),
    /** The user deleted their account: everything is refused while their data is removed. */
    deletingAt: v.optional(v.number()),
    /** First time an AI app or token was connected (the app's setup reminder). */
    aiAppConnectedAt: v.optional(v.number()),
    /** When accounts from before that field were checked once for older connections. */
    aiAppCheckedAt: v.optional(v.number()),
    /** Last write that came from the phone; the worker waits until syncing has settled. */
    personalWriteAt: v.optional(v.number()),
    /** Work sessions in these folders or repos go to a team (by slug); the rest stay personal. */
    sessionRules: v.optional(v.array(v.object({ match: v.string(), team: v.string() }))),
    createdAt: v.number(),
  })
    .index("by_appleSub", ["appleSub"])
    .index("by_microsoftId", ["microsoftId"])
    .index("by_localId", ["localId"]),

  /**
   * A personal wiki connected to the user's own git repo. The token and the sync state (path →
   * hash of what both sides last agreed on) are encrypted with the user's data key.
   */
  repos: defineTable({
    userId: v.id("users"),
    url: v.string(),
    branch: v.string(),
    tokenIv: v.string(),
    tokenCt: v.string(),
    stateIv: v.optional(v.string()),
    stateCt: v.optional(v.string()),
    status: v.union(v.literal("ok"), v.literal("error")),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  /** The personal worker's memory per user: which notes are folded in, how the last run went. */
  personalWork: defineTable({
    userId: v.id("users"),
    /** Note ids already consolidated into living pages. */
    done: v.array(v.string()),
    /** personalSeq after the last run; a newer seq means there is new input. */
    lastSeq: v.number(),
    lastRunAt: v.number(),
    lastStatus: v.string(),
    /** The last run's result (JobResult JSON), for the health check. */
    lastResult: v.optional(v.string()),
    /** Lint counts per run, newest last (kept short), so findings can be compared over time. */
    lintHistory: v.array(v.object({ at: v.number(), counts: v.record(v.string(), v.number()) })),
  }).index("by_user", ["userId"]),

  /** Per-user data key, wrapped (AES-256-GCM) by the gateway's master key. */
  userKeys: defineTable({
    userId: v.id("users"),
    masterKeyId: v.string(),
    wrapped: v.string(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  /** Encrypted personal wiki pages (AES-256-GCM, AAD = userId + path). */
  personalPages: defineTable({
    userId: v.id("users"),
    path: v.string(),
    hash: v.string(),
    iv: v.string(),
    ciphertext: v.string(),
    updated: v.string(),
    seq: v.number(),
    /**
     * Who wrote this version: "server" (Claude upkeep, overview, captures, merges),
     * "device:<id>" (one install of the app), or "phone" (app builds before per-device ids).
     * Every device pulls what the others wrote.
     */
    origin: v.optional(v.string()),
  })
    .index("by_user_path", ["userId", "path"])
    .index("by_user_seq", ["userId", "seq"]),

  /** A deleted personal page, so the user's other devices delete it too. Removed if the path is written again. */
  personalTombstones: defineTable({
    userId: v.id("users"),
    path: v.string(),
    seq: v.number(),
    origin: v.string(),
    at: v.number(),
  })
    .index("by_user_path", ["userId", "path"])
    .index("by_user_seq", ["userId", "seq"]),

  /**
   * Change counters for what the apps show, by key: `team:<teamId>` for a team's wiki (bumped
   * when the gateway delivers to it, and when the health check sees its git head move). A
   * user's personal pages count in `users.personalSeq`, their routines are fingerprinted in
   * `revisions.forUser`. The gateway streams `forUser` to open apps, which fetch only what
   * moved.
   */
  revisions: defineTable({
    key: v.string(),
    rev: v.number(),
    /** The team server's git head the health check last saw (`team:` keys). */
    head: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  teams: defineTable({
    slug: v.string(),
    name: v.string(),
    status: teamStatus,
    /** Base URL of the team server, e.g. https://t-acme.fleet.example.com */
    serverUrl: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_slug", ["slug"]),

  /**
   * Team servers ready for a team: provisioned and registered by us (ops/pool-add), claimed by
   * a team created in the app. `serverId` is also in the server's own config; the gateway's
   * claim is addressed to it.
   */
  /**
   * Work sessions uploaded by an agent integration (Claude Code), waiting to be summarized.
   * Holds the cut-down transcript sealed with the user's data key; deleted once the note exists.
   */
  sessionInbox: defineTable({
    userId: v.id("users"),
    sessionId: v.string(),
    iv: v.string(),
    ciphertext: v.string(),
    receivedAt: v.number(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    /** A worker holds the row until then; 0 when free. */
    leaseUntil: v.number(),
  })
    .index("by_user_session", ["userId", "sessionId"])
    .index("by_lease", ["leaseUntil"]),

  /**
   * One row per work-session note: where it is in the personal wiki, and its way to a team.
   * A share waits (`pending`, the note sealed) until `shareDueAt` so the user can keep it personal.
   */
  sessionNotes: defineTable({
    userId: v.id("users"),
    sessionId: v.string(),
    noteId: v.string(),
    /** Personal wiki path; empty for work logged on a team-only connection. */
    path: v.string(),
    title: v.string(),
    tool: v.string(),
    /** Hash of the cut-down text the note was written from: an unchanged block isn't summarized again. */
    contentHash: v.optional(v.string()),
    teamId: v.optional(v.id("teams")),
    share: v.optional(v.union(v.literal("pending"), v.literal("delivered"), v.literal("kept"))),
    shareDueAt: v.optional(v.number()),
    shareIv: v.optional(v.string()),
    shareCiphertext: v.optional(v.string()),
    shareAttempts: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_session", ["userId", "sessionId"])
    .index("by_user", ["userId", "updatedAt"])
    .index("by_share_due", ["share", "shareDueAt"]),

  teamServers: defineTable({
    serverId: v.string(),
    url: v.string(),
    status: v.union(v.literal("free"), v.literal("claimed")),
    teamId: v.optional(v.id("teams")),
    createdAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_server", ["serverId"]),

  members: defineTable({
    teamId: v.id("teams"),
    userId: v.id("users"),
    role,
    /** The member's page in the team wiki, e.g. people/anna-mueller */
    peopleSlug: v.string(),
    joinedAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_user", ["userId"])
    .index("by_team_user", ["teamId", "userId"]),

  invites: defineTable({
    teamId: v.id("teams"),
    codeHash: v.string(),
    role,
    usesLeft: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
    /** Who made it (from the app): it stops working once they no longer manage the team. */
    createdBy: v.optional(v.id("users")),
  })
    .index("by_code", ["codeHash"])
    .index("by_team", ["teamId"]),

  /**
   * Who an owner or admin took out of a team, and when: an invite made before that can't bring them
   * back. Also who left on their own (`at` 0, nothing to hold against them), for their people page.
   */
  removals: defineTable({
    teamId: v.id("teams"),
    userId: v.id("users"),
    at: v.number(),
    /** Their people page in the team wiki: never handed to someone else who joins. */
    peopleSlug: v.optional(v.string()),
  }).index("by_team_user", ["teamId", "userId"]),

  /** One-time codes the app shows so a user can approve an AI app (OAuth login). */
  pairingCodes: defineTable({
    userId: v.id("users"),
    codeHash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_code", ["codeHash"])
    .index("by_user", ["userId"]),

  /**
   * Where a user's push notifications go: one row per app install, by its APNs device token.
   * The app registers it at every launch while signed in and takes it back when signing out;
   * Apple refusing it (the app was deleted) removes it too. A token signed in to another account
   * moves to that account.
   */
  pushDevices: defineTable({
    userId: v.id("users"),
    token: v.string(),
    /** Builds run from Xcode get their tokens from APNs' sandbox; TestFlight and the App Store from production. */
    sandbox: v.boolean(),
    platform: v.union(v.literal("ios"), v.literal("macos")),
    /** The install's time zone (IANA, e.g. Europe/Vienna): morning pushes go out in its morning. */
    timeZone: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]),

  /**
   * The apps' own refresh tokens (hashed), until 2026-10-13. No longer written or read: the apps
   * sign in through the OAuth server now (its tokens live in `oauth`). Kept so the rows left
   * here still match a schema; drop the table once they're deleted.
   */
  appSessions: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    /** The token before `tokenHash`, accepted once more for a short while after a swap. */
    prevHash: v.optional(v.string()),
    rotatedAt: v.optional(v.number()),
    deviceName: v.string(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_token", ["tokenHash"])
    .index("by_prev", ["prevHash"])
    .index("by_user", ["userId"]),

  /** Personal access tokens for MCP clients without OAuth (hashed). */
  pats: defineTable({
    userId: v.id("users"),
    hash: v.string(),
    scopes: v.array(v.string()),
    resourceKind: v.union(v.literal("personal"), v.literal("team")),
    teamId: v.optional(v.id("teams")),
    label: v.string(),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_user", ["userId"]),

  /**
   * A computer that runs routines: Linux with systemd and Claude Code, set up with a one-time
   * code (`ambient-runner setup <code>`). A user's own computer runs their personal routines;
   * a team's server (teamId) runs the team's. Only hashes are stored.
   */
  routineHosts: defineTable({
    /** The user whose computer it is; absent on a team's server. */
    userId: v.optional(v.id("users")),
    teamId: v.optional(v.id("teams")),
    name: v.string(),
    /** The one-time setup code, until it's used or expires. */
    codeHash: v.optional(v.string()),
    codeExpiresAt: v.optional(v.number()),
    /** The computer's own token, once set up. */
    tokenHash: v.optional(v.string()),
    info: v.optional(v.object({ hostname: v.string(), os: v.string(), runner: v.string(), claude: v.string() })),
    lastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_team", ["teamId"])
    .index("by_code", ["codeHash"])
    .index("by_token", ["tokenHash"]),

  /**
   * A prompt Claude Code runs on a schedule: a personal one on one of the user's computers, a
   * team's (teamId) on the team's server. The prompt is sealed with the user's or the team's
   * data key; the computer gets it through the gateway.
   */
  routines: defineTable({
    /** Who made it; for a personal routine also whose it is. */
    userId: v.id("users"),
    teamId: v.optional(v.id("teams")),
    name: v.string(),
    promptIv: v.string(),
    promptCt: v.string(),
    schedule: routineSchedule,
    hostId: v.optional(v.id("routineHosts")),
    /** Working folder on the computer; the runner's own folder when absent. */
    folder: v.optional(v.string()),
    enabled: v.boolean(),
    /** "Run now": the computer starts a run within a minute and clears it. */
    runRequestedAt: v.optional(v.number()),
    /** Display name of whoever pressed "Run now" (looked up at request time). */
    runRequestedBy: v.optional(v.string()),
    /** Where it was last created or changed: "app" or "mcp" plus the client. */
    source: v.string(),
    lastRun: v.optional(v.object({ status: runStatus, startedAt: v.number(), finishedAt: v.optional(v.number()) })),
    /** When its owner was last sent a push about a failed run (finishRun keeps it to news). */
    failureNoticeAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_team", ["teamId"])
    .index("by_host", ["hostId"]),

  /** One run of a routine. The summary (Claude's last message, or the error) is sealed. */
  routineRuns: defineTable({
    routineId: v.id("routines"),
    userId: v.id("users"),
    hostId: v.id("routineHosts"),
    trigger: v.union(v.literal("schedule"), v.literal("manual")),
    status: runStatus,
    /** Display name of whoever pressed "Run now" (null for scheduled runs). */
    startedByName: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    exitCode: v.optional(v.number()),
    summaryIv: v.optional(v.string()),
    summaryCt: v.optional(v.string()),
    costUsd: v.optional(v.number()),
    turns: v.optional(v.number()),
    sessionId: v.optional(v.string()),
  }).index("by_routine", ["routineId", "startedAt"]),

  /**
   * Values a routine's runs get as environment variables (a GitHub token, say), per user or per
   * team. Sealed with the owner's data key; never shown again after they're set.
   */
  routineSecrets: defineTable({
    userId: v.optional(v.id("users")),
    teamId: v.optional(v.id("teams")),
    name: v.string(),
    valueIv: v.string(),
    valueCt: v.string(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_team", ["teamId"]),

  /** Per-team data key (for team routines and their secrets), wrapped by the gateway's master key. */
  teamKeys: defineTable({
    teamId: v.id("teams"),
    masterKeyId: v.string(),
    wrapped: v.string(),
    createdAt: v.number(),
  }).index("by_team", ["teamId"]),

  /**
   * oidc-provider storage (sessions, grants, codes, refresh tokens, clients). The gateway seals
   * `payload` with a key derived from the master key and stores `key`, `uid` and `userCode` as
   * HMACs ("h1:…"): codes, refresh tokens and session ids are bearer secrets, so the database
   * holds nothing usable. Rows from before that carry the raw id and a plain JSON payload until
   * they expire. `accountId`, `clientId` and `consumedAt` are copied out of the payload for the
   * few things Convex decides itself.
   */
  oauth: defineTable({
    model: v.string(),
    key: v.string(),
    payload: v.string(),
    expiresAt: v.number(),
    grantId: v.optional(v.string()),
    uid: v.optional(v.string()),
    userCode: v.optional(v.string()),
    accountId: v.optional(v.string()),
    clientId: v.optional(v.string()),
    consumedAt: v.optional(v.number()),
  })
    .index("by_model_key", ["model", "key"])
    .index("by_model_uid", ["model", "uid"])
    .index("by_model_userCode", ["model", "userCode"])
    .index("by_model_account", ["model", "accountId"])
    .index("by_model_client", ["model", "clientId"])
    .index("by_grant", ["grantId"])
    .index("by_expires", ["expiresAt"]),
});
