// Bots (docs/bots.md): a bot's thread, the questions its runs ask its owner, and a person's chat
// with Ambient. Text is sealed by the gateway (the owner's data key, or the person's own for the
// chat); these functions only decide who may read and write what, and keep the bot's state.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";
import { routineFor } from "./routines.js";

const access = { uid: v.id("users"), teamIds: v.array(v.id("teams")) };
/** How much of the chat the app shows at once. Nothing is cut off: the history is kept in full. */
const SHOW_CHAT = 200;
/** A page of history for search (docs/bots.md, "History"). */
const HISTORY_PAGE = 500;

function messageShape(m: Doc<"botMessages">) {
  return {
    id: m._id,
    role: m.role,
    kind: m.kind,
    iv: m.iv,
    ct: m.ct,
    runId: m.runId ?? null,
    authorId: m.authorId ?? null,
    authorName: m.authorName ?? null,
    answeredAt: m.answeredAt ?? null,
    createdAt: m.createdAt,
  };
}


/** Everyone in a team (a team bot's group chat). */
export async function teamPeople(ctx: { db: QueryCtx["db"] }, teamId: Doc<"routines">["teamId"]): Promise<string[]> {
  if (!teamId) return [];
  return (await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", teamId)).take(200)).map((m) => String(m.userId));
}

/** Someone read a team bot's thread now (their own; the others' stay as they are). */
export async function markRead(ctx: MutationCtx, routineId: Id<"routines">, userId: Id<"users">, now: number) {
  const r = await ctx.db.query("botReads").withIndex("by_routine_user", (q) => q.eq("routineId", routineId).eq("userId", userId)).unique();
  if (!r) await ctx.db.insert("botReads", { routineId, userId, at: now });
  else if (r.at < now) await ctx.db.patch(r._id, { at: now });
}

/** A bot's thread, newest last, with its open question. Readable by whoever sees the bot. */
export const thread = query({
  args: { ...secretArg, ...access, id: v.string(), limit: v.number() },
  handler: async (ctx, { secret, uid, teamIds, id, limit }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r?.bot) return null;
    const rows = await ctx.db
      .query("botMessages")
      .withIndex("by_routine", (q) => q.eq("routineId", r._id))
      .order("desc")
      .take(Math.min(Math.max(limit, 1), 100));
    return { teamId: r.teamId ?? null, createdBy: r.userId, openQuestionId: r.openQuestionId ?? null, messages: rows.reverse().map(messageShape) };
  },
});

/**
 * Someone read a bot's thread: what its last run said isn't news any more, so the bot goes from
 * "done" to asleep until its next run (docs/bots.md, "Faces"). A team bot's thread is a group
 * chat: read for that person only.
 */
export const seen = mutation({
  args: { ...secretArg, ...access, id: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, teamIds, id, now }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r?.bot) return { ok: false as const };
    if (r.teamId) await markRead(ctx, r._id, uid, now);
    else if ((r.seenAt ?? 0) < now) await ctx.db.patch(r._id, { seenAt: now });
    return { ok: true as const };
  },
});

/** For the list: each bot's open question and the newest thing it said. */
export const latest = query({
  args: { ...secretArg, ...access, ids: v.array(v.string()) },
  handler: async (ctx, { secret, uid, teamIds, ids }) => {
    assertService(secret);
    const out: { id: string; question: ReturnType<typeof messageShape> | null; last: ReturnType<typeof messageShape> | null }[] = [];
    for (const id of ids.slice(0, 100)) {
      const r = await routineFor(ctx, uid, teamIds, id);
      if (!r?.bot) continue;
      const question = r.openQuestionId ? await ctx.db.get(r.openQuestionId) : null;
      const last = await ctx.db
        .query("botMessages")
        .withIndex("by_routine", (q) => q.eq("routineId", r._id))
        .order("desc")
        .filter((q) => q.eq(q.field("role"), "bot"))
        .first();
      out.push({ id: r._id, question: question ? messageShape(question) : null, last: last ? messageShape(last) : null });
    }
    return out;
  },
});

/**
 * Someone writes to a bot. With an open question it's the answer; otherwise a message. Either way
 * the bot's next run starts with it (resuming its session), requested now: unless its run is
 * still going and waiting for this answer, which then picks it up itself (questionAnswer).
 */
export const post = mutation({
  args: { ...secretArg, ...access, id: v.string(), iv: v.string(), ct: v.string(), now: v.number(), asAmbient: v.optional(v.boolean()) },
  handler: async (ctx, { secret, uid, teamIds, id, iv, ct, now, asAmbient }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r?.bot) return { ok: false as const, error: "no_such_bot" };
    // A team bot's thread is a group chat: everyone in the team writes (and answers its questions).
    // Its settings stay with the team's owners and admins.
    if (!r.teamId && r.userId !== uid) return { ok: false as const, error: "admins_only" };
    if (!r.teamId && !r.hostId) return { ok: false as const, error: "no_computer" };
    if (r.teamId) {
      const server = await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", r.teamId)).first();
      if (!server?.tokenHash) return { ok: false as const, error: "no_team_server" };
    }
    const user = await ctx.db.get(uid);
    const open = r.openQuestionId ? await ctx.db.get(r.openQuestionId) : null;
    const question = open && !open.answeredAt ? open : null;
    const decision = question ? await ctx.db.query("decisions").withIndex("by_question", (q) => q.eq("questionId", question._id)).first() : null;
    // Its questions, its decisions and Ambient answering are its maker's (the decision's person):
    // in a team's group chat everyone sees the question, but another member's reply is a message
    // the bot reads, and the question stays open for its maker.
    const decider = String(decision?.userId ?? r.userId);
    if (asAmbient && String(uid) !== decider) return { ok: false as const, error: "not_yours" };
    const kind = question && String(uid) === decider ? ("answer" as const) : ("message" as const);
    const messageId = await ctx.db.insert("botMessages", {
      routineId: r._id,
      teamId: r.teamId,
      // Ambient answering for the person: its own role in the thread, on their behalf.
      role: asAmbient ? "ambient" : "user",
      kind,
      iv,
      ct,
      authorId: uid,
      authorName: asAmbient ? `Ambient, for ${user?.name ?? "you"}` : user?.name,
      createdAt: now,
    });
    if (question && kind === "answer") await ctx.db.patch(question._id, { answeredAt: now, answerId: messageId });
    // Writing to it means its thread was read (by the writer, in a team's group chat).
    if (r.teamId) await markRead(ctx, r._id, uid, now);
    await ctx.db.patch(r._id, {
      ...(kind === "answer" ? { openQuestionId: undefined } : {}),
      ...(r.teamId ? {} : { seenAt: now }),
      pendingMessageId: messageId,
      runRequestedAt: now,
      runRequestedBy: user?.name,
      updatedAt: now,
    });
    // The decision this question was, answered here (in the thread, or by Ambient).
    if (kind === "answer") {
      const d = decision;
      if (d && d.status === "open") await ctx.db.patch(d._id, { status: "answered", answerIv: iv, answerCt: ct, answeredBy: asAmbient ? "Ambient" : user?.name, via: asAmbient ? "ambient" : "thread", answeredAt: now });
    }
    const m = (await ctx.db.get(messageId))!;
    // A team's group chat: everyone else hears about it.
    const team = r.teamId ? await ctx.db.get(r.teamId) : null;
    const others = (await teamPeople(ctx, r.teamId)).filter((p) => p !== String(uid));
    return { ok: true as const, message: messageShape(m), group: team ? { team: team.name, others, bot: { name: r.name, face: r.bot.face, color: r.bot.color ?? null, wear: r.bot.wear ?? null } } : null };
  },
});

/**
 * A note from Amb in a bot's thread (it changed the bot's files, say): the owner sees it where they
 * talk to the bot, and it doesn't start a run.
 */
export const note = mutation({
  args: { ...secretArg, ...access, id: v.string(), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, teamIds, id, iv, ct, now }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r?.bot) return { ok: false as const, error: "no_such_bot" };
    const user = await ctx.db.get(uid);
    const messageId = await ctx.db.insert("botMessages", { routineId: r._id, teamId: r.teamId, role: "ambient", kind: "message", iv, ct, authorId: uid, authorName: `Ambient, for ${user?.name ?? "you"}`, createdAt: now });
    return { ok: true as const, message: messageShape((await ctx.db.get(messageId))!) };
  },
});

/**
 * Something from outside wakes a bot (docs/bots.md, "GitHub events and the PR gate"): a message in
 * its thread from `authorName` (e.g. "GitHub") and, with `run`, a run that starts with it. A
 * message the owner left that no run has taken yet stays the one the run starts with; this one is
 * then among what's new in its thread. Returns the computer that runs it (to start it at once).
 */
export const wake = mutation({
  args: { ...secretArg, id: v.string(), iv: v.string(), ct: v.string(), authorName: v.string(), run: v.boolean(), now: v.number() },
  handler: async (ctx, { secret, id, iv, ct, authorName, run, now }) => {
    assertService(secret);
    const rid = ctx.db.normalizeId("routines", id);
    const r = rid ? await ctx.db.get(rid) : null;
    if (!r?.bot) return { ok: false as const, error: "no_such_bot" };
    const messageId = await ctx.db.insert("botMessages", { routineId: r._id, teamId: r.teamId, role: "user", kind: "message", iv, ct, authorName, createdAt: now });
    let hostId: string | null = r.hostId ?? null;
    if (r.teamId) {
      const server = await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", r.teamId)).first();
      hostId = server?._id ?? null;
    }
    if (run && r.enabled) {
      const pending = r.pendingMessageId ? await ctx.db.get(r.pendingMessageId) : null;
      await ctx.db.patch(r._id, { ...(pending ? {} : { pendingMessageId: messageId }), runRequestedAt: now, runRequestedBy: authorName, updatedAt: now });
    }
    return { ok: true as const, message: messageShape((await ctx.db.get(messageId))!), hostId, enabled: r.enabled };
  },
});

export async function runByToken(ctx: { db: QueryCtx["db"] }, runTokenHash: string) {
  const run = await ctx.db.query("routineRuns").withIndex("by_run_token", (q) => q.eq("runTokenHash", runTokenHash)).unique();
  if (!run || run.status !== "running") return null;
  const r = await ctx.db.get(run.routineId);
  return r?.bot ? { run, r } : null;
}

/** Who a run's text is sealed for (the gateway asks before sealing a question). */
export const runOwner = query({
  args: { ...secretArg, runTokenHash: v.string() },
  handler: async (ctx, { secret, runTokenHash }) => {
    assertService(secret);
    const found = await runByToken(ctx, runTokenHash);
    return found
      ? { routineId: found.r._id, name: found.r.name, face: found.r.bot?.face ?? "classic", color: found.r.bot?.color ?? null, wear: found.r.bot?.wear ?? null, createdBy: found.r.userId, teamId: found.r.teamId ?? null, delegate: found.r.bot?.delegate ?? "brain" }
      : null;
  },
});

/** A bot's run asks its owner something. A newer question replaces one still open. */
export const ask = mutation({
  args: { ...secretArg, runTokenHash: v.string(), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, runTokenHash, iv, ct, now }) => {
    assertService(secret);
    const found = await runByToken(ctx, runTokenHash);
    if (!found) return { ok: false as const, error: "run_over" };
    const { run, r } = found;
    const questionId = await ctx.db.insert("botMessages", { routineId: r._id, teamId: r.teamId, role: "bot", kind: "question", iv, ct, runId: run._id, createdAt: now });
    await ctx.db.patch(r._id, { openQuestionId: questionId });
    const team = r.teamId ? await ctx.db.get(r.teamId) : null;
    // A team bot asks its whole group chat; the decision (and Ambient answering) stays its maker's.
    const others = (await teamPeople(ctx, r.teamId)).filter((p) => p !== String(r.userId));
    return { ok: true as const, questionId, routineId: r._id, name: r.name, notify: r.userId, team: team?.name ?? null, others };
  },
});

/**
 * Has the question been answered? The run that asked it takes the answer itself: the next run it
 * would have started is called off.
 */
export const questionAnswer = mutation({
  args: { ...secretArg, runTokenHash: v.string(), questionId: v.string() },
  handler: async (ctx, { secret, runTokenHash, questionId }) => {
    assertService(secret);
    const found = await runByToken(ctx, runTokenHash);
    if (!found) return { ok: false as const, error: "run_over" };
    const qid = ctx.db.normalizeId("botMessages", questionId);
    const question = qid ? await ctx.db.get(qid) : null;
    if (!question || question.routineId !== found.r._id || question.kind !== "question") return { ok: false as const, error: "no_such_question" };
    if (!question.answerId) return { ok: true as const, answer: null };
    const answer = await ctx.db.get(question.answerId);
    if (!answer) return { ok: true as const, answer: null };
    if (found.r.pendingMessageId === answer._id) await ctx.db.patch(found.r._id, { pendingMessageId: undefined, runRequestedAt: undefined, runRequestedBy: undefined });
    return { ok: true as const, answer: { iv: answer.iv, ct: answer.ct, authorName: answer.authorName ?? null } };
  },
});

/**
 * What came into a bot's thread while its run is going (docs/bots.md, "Messages while a bot
 * works"): its owner's messages, Amb's, GitHub's, after `after` (default: when the run started).
 * The run takes them into its session, so they don't start another run: a pending message among
 * them is called off. Answers to this run's own questions come back through ask_owner instead.
 */
export const claimInbox = mutation({
  args: { ...secretArg, runTokenHash: v.string(), after: v.optional(v.number()) },
  handler: async (ctx, { secret, runTokenHash, after }) => {
    assertService(secret);
    const found = await runByToken(ctx, runTokenHash);
    if (!found) return { ok: false as const, error: "run_over" };
    const { run, r } = found;
    const since = after ?? run.startedAt;
    const rows = await ctx.db
      .query("botMessages")
      .withIndex("by_routine", (q) => q.eq("routineId", r._id).gt("createdAt", since))
      .take(50);
    // This run's own questions (asked since it started) and the answers they got.
    const asked = await ctx.db
      .query("botMessages")
      .withIndex("by_routine", (q) => q.eq("routineId", r._id).gte("createdAt", run.startedAt))
      .take(200);
    const ownAnswers = new Set(asked.filter((m) => m.kind === "question" && m.runId === run._id && m.answerId).map((m) => String(m.answerId)));
    const out = rows.filter((m) => m.role !== "bot" && !ownAnswers.has(String(m._id)));
    if (out.length && (r.pendingMessageId === undefined || out.some((m) => m._id === r.pendingMessageId))) {
      await ctx.db.patch(r._id, { pendingMessageId: undefined, runRequestedAt: undefined, runRequestedBy: undefined });
    }
    return {
      ok: true as const,
      owner: { teamId: r.teamId ?? null, createdBy: r.userId },
      cursor: rows.length ? rows[rows.length - 1]!.createdAt : since,
      messages: out.map((m) => ({ id: m._id, role: m.role, kind: m.kind, iv: m.iv, ct: m.ct, authorName: m.authorName ?? null, createdAt: m.createdAt })),
    };
  },
});

/** A bot's answer in the middle of a run (it took a message in and answered it): into its thread. */
export const runReply = mutation({
  args: { ...secretArg, runTokenHash: v.string(), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, runTokenHash, iv, ct, now }) => {
    assertService(secret);
    const found = await runByToken(ctx, runTokenHash);
    if (!found) return { ok: false as const, error: "run_over" };
    const id = await ctx.db.insert("botMessages", { routineId: found.r._id, teamId: found.r.teamId, role: "bot", kind: "result", iv, ct, runId: found.run._id, createdAt: now });
    return { ok: true as const, id };
  },
});

// ---- Ambient, the master bot ----

/** The chat as the app shows it: since the person last started a new chat. */
export const chat = query({
  args: { ...secretArg, uid: v.id("users"), limit: v.number() },
  handler: async (ctx, { secret, uid, limit }) => {
    assertService(secret);
    const state = await ctx.db.query("ambientState").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    const from = state?.chatClearedAt ?? 0;
    const rows = await ctx.db
      .query("ambientChat")
      .withIndex("by_user", (q) => q.eq("userId", uid).gte("createdAt", from))
      .order("desc")
      .take(Math.min(Math.max(limit, 1), SHOW_CHAT));
    const out = [];
    for (const m of rows.reverse()) {
      const d = m.decisionId ? await ctx.db.get(m.decisionId) : null;
      out.push({ id: m._id, role: m.role, iv: m.iv, ct: m.ct, createdAt: m.createdAt, decision: d ? decisionShape(d) : null });
    }
    return out;
  },
});

export const addChat = mutation({
  args: { ...secretArg, uid: v.id("users"), role: v.union(v.literal("user"), v.literal("ambient")), iv: v.string(), ct: v.string(), decisionId: v.optional(v.string()), now: v.number() },
  handler: async (ctx, { secret, uid, role, iv, ct, decisionId, now }) => {
    assertService(secret);
    const did = decisionId ? ctx.db.normalizeId("decisions", decisionId) : null;
    const id = await ctx.db.insert("ambientChat", { userId: uid, role, iv, ct, ...(did ? { decisionId: did } : {}), createdAt: now });
    return { id, createdAt: now };
  },
});

/** "New chat": the app shows the chat from now on; the history stays for search. */
export const clearChat = mutation({
  args: { ...secretArg, uid: v.id("users"), now: v.number() },
  handler: async (ctx, { secret, uid, now }) => {
    assertService(secret);
    const state = await ctx.db.query("ambientState").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    if (state) await ctx.db.patch(state._id, { chatClearedAt: now });
    else await ctx.db.insert("ambientState", { userId: uid, lastBeatAt: 0, day: "", sentToday: 0, seen: [], chatClearedAt: now });
    return { ok: true };
  },
});

/** The whole chat history goes, for good. A page at a time: call until it says 0. */
export const forgetChat = mutation({
  args: { ...secretArg, uid: v.id("users"), now: v.number() },
  handler: async (ctx, { secret, uid, now }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("ambientChat")
      .withIndex("by_user", (q) => q.eq("userId", uid))
      .take(HISTORY_PAGE);
    for (const m of rows) await ctx.db.delete(m._id);
    const state = await ctx.db.query("ambientState").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    if (state) await ctx.db.patch(state._id, { chatClearedAt: now });
    return { removed: rows.length };
  },
});

/** A page of the whole chat (search), newest first, before `before`. */
export const chatHistory = query({
  args: { ...secretArg, uid: v.id("users"), before: v.number(), after: v.number() },
  handler: async (ctx, { secret, uid, before, after }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("ambientChat")
      .withIndex("by_user", (q) => q.eq("userId", uid).gt("createdAt", after).lt("createdAt", before))
      .order("desc")
      .take(HISTORY_PAGE);
    return rows.map((m) => ({ id: m._id, role: m.role, iv: m.iv, ct: m.ct, createdAt: m.createdAt }));
  },
});

/**
 * A page of a bot's thread (search, a run's wake-up), newest first, between `after` and `before`.
 * The gateway has checked who may read it.
 */
export const threadHistory = query({
  args: { ...secretArg, id: v.string(), before: v.number(), after: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { secret, id, before, after, limit }) => {
    assertService(secret);
    const rid = ctx.db.normalizeId("routines", id);
    const r = rid ? await ctx.db.get(rid) : null;
    if (!r?.bot) return null;
    const rows = await ctx.db
      .query("botMessages")
      .withIndex("by_routine", (q) => q.eq("routineId", r._id).gt("createdAt", after).lt("createdAt", before))
      .order("desc")
      .take(Math.min(Math.max(limit ?? HISTORY_PAGE, 1), HISTORY_PAGE));
    return { teamId: r.teamId ?? null, createdBy: r.userId, messages: rows.map(messageShape) };
  },
});

/** Amb's nightly look at the day (docs/bots.md, "Amb's memory"): done for that day. */
export const memoryDay = mutation({
  args: { ...secretArg, uid: v.id("users"), day: v.string() },
  handler: async (ctx, { secret, uid, day }) => {
    assertService(secret);
    const state = await ctx.db.query("ambientState").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    if (state?.memoryDay === day) return { first: false };
    if (state) await ctx.db.patch(state._id, { memoryDay: day });
    else await ctx.db.insert("ambientState", { userId: uid, lastBeatAt: 0, day: "", sentToday: 0, seen: [], memoryDay: day });
    return { first: true };
  },
});

// ---- decisions (docs/bots.md, "Decisions") ----

function decisionShape(d: Doc<"decisions">) {
  return {
    id: d._id,
    routineId: d.routineId ?? null,
    questionId: d.questionId ?? null,
    iv: d.iv,
    ct: d.ct,
    status: d.status,
    answerIv: d.answerIv ?? null,
    answerCt: d.answerCt ?? null,
    answeredBy: d.answeredBy ?? null,
    via: d.via ?? null,
    answeredAt: d.answeredAt ?? null,
    urgent: d.urgent,
    createdAt: d.createdAt,
  };
}

export const createDecision = mutation({
  args: { ...secretArg, uid: v.id("users"), routineId: v.optional(v.string()), questionId: v.optional(v.string()), iv: v.string(), ct: v.string(), urgent: v.boolean(), now: v.number() },
  handler: async (ctx, { secret, uid, routineId, questionId, iv, ct, urgent, now }) => {
    assertService(secret);
    const rid = routineId ? ctx.db.normalizeId("routines", routineId) : null;
    const qid = questionId ? ctx.db.normalizeId("botMessages", questionId) : null;
    const id = await ctx.db.insert("decisions", { userId: uid, ...(rid ? { routineId: rid } : {}), ...(qid ? { questionId: qid } : {}), iv, ct, status: "open", urgent, createdAt: now });
    return decisionShape((await ctx.db.get(id))!);
  },
});

/** The person's open decisions, oldest first (the stack). */
export const openDecisions = query({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("decisions")
      .withIndex("by_user", (q) => q.eq("userId", uid).eq("status", "open"))
      .order("asc")
      .take(50);
    return rows.map(decisionShape);
  },
});

export const decision = query({
  args: { ...secretArg, uid: v.id("users"), id: v.string() },
  handler: async (ctx, { secret, uid, id }) => {
    assertService(secret);
    const did = ctx.db.normalizeId("decisions", id);
    const d = did ? await ctx.db.get(did) : null;
    return d && d.userId === uid ? decisionShape(d) : null;
  },
});

/** An answer that didn't go through a bot's thread (Ambient's own question, or a record). */
export const resolveDecision = mutation({
  args: { ...secretArg, uid: v.id("users"), id: v.string(), answerIv: v.string(), answerCt: v.string(), by: v.string(), via: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, id, answerIv, answerCt, by, via, now }) => {
    assertService(secret);
    const did = ctx.db.normalizeId("decisions", id);
    const d = did ? await ctx.db.get(did) : null;
    if (!d || d.userId !== uid) return { ok: false as const, error: "no_such_decision" };
    if (d.status !== "open") return { ok: false as const, error: "already_answered" };
    await ctx.db.patch(d._id, { status: "answered", answerIv, answerCt, answeredBy: by, via, answeredAt: now });
    return { ok: true as const, decision: decisionShape((await ctx.db.get(d._id))!) };
  },
});

// ---- Ambient's heartbeat ----

/** The people with bots: listed accounts and the members of teams that have them. */
export const heartbeatPeople = query({
  args: { ...secretArg, users: v.array(v.string()), teams: v.array(v.string()) },
  handler: async (ctx, { secret, users, teams }) => {
    assertService(secret);
    const out = new Set<string>();
    for (const u of users) {
      const uid = ctx.db.normalizeId("users", u);
      if (uid && (await ctx.db.get(uid))) out.add(uid);
    }
    for (const slug of teams) {
      const t = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
      if (!t) continue;
      for (const m of await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", t._id)).take(200)) out.add(m.userId);
    }
    return [...out];
  },
});

/**
 * What happened for a person since their last heartbeat, as keys and facts (no sealed text): their
 * bots' failed runs, decisions waiting over two hours, root commands waiting for approval.
 */
export const heartbeatEvents = query({
  args: { ...secretArg, uid: v.id("users"), since: v.number(), now: v.number() },
  handler: async (ctx, { secret, uid, since, now }) => {
    assertService(secret);
    const events: { key: string; kind: "failed" | "waiting" | "approval"; routineId?: string; name?: string; at: number }[] = [];
    for (const r of await ctx.db.query("routines").withIndex("by_user", (q) => q.eq("userId", uid)).take(200)) {
      if (!r.bot || r.lastRun?.status !== "failed" || (r.lastRun.finishedAt ?? 0) < since) continue;
      events.push({ key: `failed:${r._id}:${r.lastRun.startedAt}`, kind: "failed", routineId: r._id, name: r.name, at: r.lastRun.finishedAt ?? now });
    }
    for (const d of await ctx.db.query("decisions").withIndex("by_user", (q) => q.eq("userId", uid).eq("status", "open")).take(50)) {
      if (now - d.createdAt < 2 * 3600_000) continue;
      const r = d.routineId ? await ctx.db.get(d.routineId) : null;
      events.push({ key: `waiting:${d._id}:${Math.floor((now - d.createdAt) / (24 * 3600_000))}`, kind: "waiting", routineId: d.routineId, name: r?.name, at: d.createdAt });
    }
    for (const a of await ctx.db.query("approvals").withIndex("by_user", (q) => q.eq("uid", uid)).order("desc").take(20)) {
      if (a.status !== "pending" || a.expiresAt < now) continue;
      events.push({ key: `approval:${a._id}`, kind: "approval", at: a.createdAt });
    }
    const state = await ctx.db.query("ambientState").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    return { events, state: state ? { lastBeatAt: state.lastBeatAt, day: state.day, sentToday: state.sentToday, seen: state.seen } : null };
  },
});

export const recordBeat = mutation({
  args: { ...secretArg, uid: v.id("users"), at: v.number(), day: v.string(), sent: v.boolean(), seen: v.array(v.string()) },
  handler: async (ctx, { secret, uid, at, day, sent, seen }) => {
    assertService(secret);
    const state = await ctx.db.query("ambientState").withIndex("by_user", (q) => q.eq("userId", uid)).unique();
    const sentToday = (state && state.day === day ? state.sentToday : 0) + (sent ? 1 : 0);
    const keep = [...new Set([...(state?.seen ?? []), ...seen])].slice(-300);
    if (state) await ctx.db.patch(state._id, { lastBeatAt: at, day, sentToday, seen: keep });
    else await ctx.db.insert("ambientState", { userId: uid, lastBeatAt: at, day, sentToday, seen: keep });
  },
});

/** Whose key a bot's thread is sealed with (a decision answered there). */
export const routineOwner = query({
  args: { ...secretArg, id: v.string() },
  handler: async (ctx, { secret, id }) => {
    assertService(secret);
    const rid = ctx.db.normalizeId("routines", id);
    const r = rid ? await ctx.db.get(rid) : null;
    return r ? { teamId: r.teamId ?? null, createdBy: r.userId } : null;
  },
});

// ---- the git mirror (docs/bots.md, "A bot's folder in git") ----

/**
 * An owner's bots (a person's own, or a team's), for mirroring their folders into git: the sealed
 * prompt (AGENTS.md) and settings. A team's also comes with where its server is.
 */
export const ownerBots = query({
  args: { ...secretArg, ownerKind: v.union(v.literal("user"), v.literal("team")), ownerId: v.string() },
  handler: async (ctx, { secret, ownerKind, ownerId }) => {
    assertService(secret);
    let team: { id: string; slug: string; name: string; status: string; serverUrl: string | null } | null = null;
    let rows: Doc<"routines">[];
    if (ownerKind === "team") {
      const tid = ctx.db.normalizeId("teams", ownerId);
      const t = tid ? await ctx.db.get(tid) : null;
      if (!t) return null;
      team = { id: t._id, slug: t.slug, name: t.name, status: t.status, serverUrl: t.serverUrl ?? null };
      rows = await ctx.db
        .query("routines")
        .withIndex("by_team", (q) => q.eq("teamId", t._id))
        .take(200);
    } else {
      const uid = ctx.db.normalizeId("users", ownerId);
      if (!uid || !(await ctx.db.get(uid))) return null;
      rows = (
        await ctx.db
          .query("routines")
          .withIndex("by_user", (q) => q.eq("userId", uid))
          .take(200)
      ).filter((r) => !r.teamId);
    }
    return {
      team,
      bots: rows
        .filter((r) => r.bot)
        .map((r) => ({ id: r._id, name: r.name, promptIv: r.promptIv, promptCt: r.promptCt, schedule: r.schedule, enabled: r.enabled, bot: r.bot!, createdAt: r.createdAt })),
    };
  },
});
