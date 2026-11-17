// Bots (docs/bots.md): a bot's thread, the questions its runs ask its owner, and a person's chat
// with Ambient. Text is sealed by the gateway (the owner's data key, or the person's own for the
// chat); these functions only decide who may read and write what, and keep the bot's state.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { assertService, secretArg } from "./lib/service.js";
import { manages, routineFor } from "./routines.js";

const access = { uid: v.id("users"), teamIds: v.array(v.id("teams")) };
const KEEP_MESSAGES = 300;
const KEEP_CHAT = 200;

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

async function prune(ctx: MutationCtx, routineId: Id<"routines">) {
  const old = await ctx.db
    .query("botMessages")
    .withIndex("by_routine", (q) => q.eq("routineId", routineId))
    .order("desc")
    .take(KEEP_MESSAGES + 20);
  for (const m of old.slice(KEEP_MESSAGES)) await ctx.db.delete(m._id);
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
  args: { ...secretArg, ...access, id: v.string(), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, teamIds, id, iv, ct, now }) => {
    assertService(secret);
    const r = await routineFor(ctx, uid, teamIds, id);
    if (!r?.bot) return { ok: false as const, error: "no_such_bot" };
    if (r.teamId ? !(await manages(ctx, uid, r.teamId)) : r.userId !== uid) return { ok: false as const, error: "admins_only" };
    if (!r.teamId && !r.hostId) return { ok: false as const, error: "no_computer" };
    if (r.teamId) {
      const server = await ctx.db.query("routineHosts").withIndex("by_team", (q) => q.eq("teamId", r.teamId)).first();
      if (!server?.tokenHash) return { ok: false as const, error: "no_team_server" };
    }
    const user = await ctx.db.get(uid);
    const question = r.openQuestionId ? await ctx.db.get(r.openQuestionId) : null;
    const kind = question && !question.answeredAt ? ("answer" as const) : ("message" as const);
    const messageId = await ctx.db.insert("botMessages", {
      routineId: r._id,
      teamId: r.teamId,
      role: "user",
      kind,
      iv,
      ct,
      authorId: uid,
      authorName: user?.name,
      createdAt: now,
    });
    if (question && kind === "answer") await ctx.db.patch(question._id, { answeredAt: now, answerId: messageId });
    await ctx.db.patch(r._id, {
      openQuestionId: undefined,
      pendingMessageId: messageId,
      runRequestedAt: now,
      runRequestedBy: user?.name,
      updatedAt: now,
    });
    await prune(ctx, r._id);
    const m = (await ctx.db.get(messageId))!;
    return { ok: true as const, message: messageShape(m) };
  },
});

async function runByToken(ctx: { db: QueryCtx["db"] }, runTokenHash: string) {
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
    return found ? { routineId: found.r._id, name: found.r.name, face: found.r.bot?.face ?? "classic", createdBy: found.r.userId, teamId: found.r.teamId ?? null } : null;
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
    await prune(ctx, r._id);
    const team = r.teamId ? await ctx.db.get(r.teamId) : null;
    return { ok: true as const, questionId, routineId: r._id, name: r.name, notify: r.userId, team: team?.name ?? null };
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

// ---- Ambient, the master bot ----

export const chat = query({
  args: { ...secretArg, uid: v.id("users"), limit: v.number() },
  handler: async (ctx, { secret, uid, limit }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("ambientChat")
      .withIndex("by_user", (q) => q.eq("userId", uid))
      .order("desc")
      .take(Math.min(Math.max(limit, 1), KEEP_CHAT));
    return rows.reverse().map((m) => ({ id: m._id, role: m.role, iv: m.iv, ct: m.ct, createdAt: m.createdAt }));
  },
});

export const addChat = mutation({
  args: { ...secretArg, uid: v.id("users"), role: v.union(v.literal("user"), v.literal("ambient")), iv: v.string(), ct: v.string(), now: v.number() },
  handler: async (ctx, { secret, uid, role, iv, ct, now }) => {
    assertService(secret);
    const id = await ctx.db.insert("ambientChat", { userId: uid, role, iv, ct, createdAt: now });
    const old = await ctx.db
      .query("ambientChat")
      .withIndex("by_user", (q) => q.eq("userId", uid))
      .order("desc")
      .take(KEEP_CHAT + 20);
    for (const m of old.slice(KEEP_CHAT)) await ctx.db.delete(m._id);
    return { id, createdAt: now };
  },
});

export const clearChat = mutation({
  args: { ...secretArg, uid: v.id("users") },
  handler: async (ctx, { secret, uid }) => {
    assertService(secret);
    const rows = await ctx.db
      .query("ambientChat")
      .withIndex("by_user", (q) => q.eq("userId", uid))
      .take(KEEP_CHAT * 2);
    for (const m of rows) await ctx.db.delete(m._id);
    return { removed: rows.length };
  },
});
