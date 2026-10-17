/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "s".repeat(40);

beforeEach(() => {
  process.env.BRAIN_SERVICE_SECRET = secret;
});

async function setup() {
  const t = convexTest(schema, modules);
  const lena = await t.mutation(api.users.upsertApple, { secret, appleSub: "apple-lena", email: "lena@example.com", name: "Lena Vogel", now: 1 });
  return { t, uid: lena!.uid };
}

describe("service secret", () => {
  it("rejects calls without the right secret", async () => {
    const { t, uid } = await setup();
    await expect(t.query(api.users.get, { secret: "wrong".repeat(10), uid })).rejects.toThrow();
  });
});

describe("users", () => {
  it("creates once per Apple subject and keeps the first name", async () => {
    const { t, uid } = await setup();
    const again = await t.mutation(api.users.upsertApple, { secret, appleSub: "apple-lena", now: 2 });
    expect(again).toMatchObject({ uid, name: "Lena Vogel", created: false });
    expect(await t.query(api.users.get, { secret, uid })).toMatchObject({ name: "Lena Vogel", personalSeq: 0 });
    expect(await t.query(api.users.get, { secret, uid: "not-an-id" })).toBeNull();
  });
});

describe("AI app connected", () => {
  it("doesn't count the Ambient app's own sign-in as an AI app", async () => {
    const { t, uid } = await setup();
    const grant = (clientId: string) => ({ model: "Grant", key: clientId, payload: JSON.stringify({ accountId: uid, clientId }), expiresAt: 9e15 });
    await t.mutation(api.oauth.upsert, { secret, ...grant("ambient-app") });
    expect(await t.mutation(api.users.checkAppConnected, { secret, uid, now: 2 })).toEqual({ connected: false });

    const other = await t.mutation(api.users.upsertApple, { secret, appleSub: "apple-tom", name: "Tom", now: 3 });
    await t.mutation(api.oauth.upsert, { secret, model: "Grant", key: "g2", payload: JSON.stringify({ accountId: other!.uid, clientId: "claude-abc" }), expiresAt: 9e15 });
    expect(await t.mutation(api.users.checkAppConnected, { secret, uid: other!.uid, now: 4 })).toEqual({ connected: true });
  });
});

describe("OAuth storage", () => {
  it("sweeps expired rows and keeps the rest", async () => {
    const { t } = await setup();
    const row = (key: string, expiresAt: number) => ({ secret, model: "ReplayDetection", key, payload: "{}", expiresAt });
    await t.mutation(api.oauth.upsert, row("old", 1_000));
    await t.mutation(api.oauth.upsert, row("live", 9_000));
    expect(await t.mutation(internal.oauth.sweepExpired, { now: 5_000 })).toEqual({ removed: 1 });
    expect(await t.query(api.oauth.find, { secret, model: "ReplayDetection", key: "live", now: 5_000 })).toMatchObject({ payload: "{}" });
    expect(await t.mutation(internal.oauth.sweepExpired, { now: 5_000 })).toEqual({ removed: 0 });
  });
});

describe("teams and invites", () => {
  it("joins with a valid invite, dedupes people slugs, and refuses spent codes", async () => {
    const { t, uid } = await setup();
    await t.mutation(internal.teams.create, { slug: "acme", name: "Acme", serverUrl: "https://t-acme.example.com" });
    await t.mutation(internal.teams.createInvite, { slug: "acme", codeHash: "h1", uses: 2, days: 1 });

    const first = await t.mutation(api.teams.joinWithInvite, { secret, uid, codeHash: "h1", peopleSlug: "people/lena-vogel", now: Date.now() });
    expect(first).toMatchObject({ ok: true, team: { slug: "acme", role: "member", peopleSlug: "people/lena-vogel" } });

    const other = await t.mutation(api.users.upsertApple, { secret, appleSub: "apple-lena-2", name: "Lena Vogel", now: 1 });
    const second = await t.mutation(api.teams.joinWithInvite, { secret, uid: other!.uid, codeHash: "h1", peopleSlug: "people/lena-vogel", now: Date.now() });
    expect(second).toMatchObject({ ok: true, team: { peopleSlug: "people/lena-vogel-2" } });

    const third = await t.mutation(api.users.upsertApple, { secret, appleSub: "apple-3", name: "X", now: 1 });
    expect(await t.mutation(api.teams.joinWithInvite, { secret, uid: third!.uid, codeHash: "h1", peopleSlug: "people/x", now: Date.now() })).toEqual({
      ok: false,
      error: "invalid_code",
    });

    expect((await t.query(api.teams.ofUser, { secret, uid })).map((x) => x.slug)).toEqual(["acme"]);
    await t.mutation(internal.teams.setStatus, { slug: "acme", status: "canceled" });
    expect(await t.query(api.teams.ofUser, { secret, uid })).toEqual([]);
  });
});

describe("pairing codes", () => {
  it("are single-use, expire, and replace older codes", async () => {
    const { t, uid } = await setup();
    expect(await t.mutation(api.auth.createPairingCode, { secret, uid, codeHash: "c1", expiresAt: 1000, now: 0 })).toBe(true);
    expect(await t.mutation(api.auth.createPairingCode, { secret, uid, codeHash: "c2", expiresAt: 1000, now: 0 })).toBe(true);
    expect(await t.mutation(api.auth.consumePairingCode, { secret, codeHash: "c1", now: 10 })).toBeNull();
    expect(await t.mutation(api.auth.consumePairingCode, { secret, codeHash: "c2", now: 2000 })).toBeNull();
    await t.mutation(api.auth.createPairingCode, { secret, uid, codeHash: "c3", expiresAt: 1000, now: 0 });
    expect(await t.mutation(api.auth.consumePairingCode, { secret, codeHash: "c3", now: 10 })).toBe(uid);
    expect(await t.mutation(api.auth.consumePairingCode, { secret, codeHash: "c3", now: 11 })).toBeNull();
  });
});

describe("personal pages", () => {
  it("applies idempotent upserts and deletes and bumps seq", async () => {
    const { t, uid } = await setup();
    const up = { op: "upsert" as const, path: "wiki/a.md", hash: "h1", iv: "iv", ciphertext: "ct", updated: "2026-10-07" };
    expect(await t.mutation(api.personal.apply, { secret, uid, ops: [up] })).toEqual({ seq: 1, applied: 1 });
    expect(await t.mutation(api.personal.apply, { secret, uid, ops: [up] })).toEqual({ seq: 1, applied: 0 });
    expect(await t.mutation(api.personal.apply, { secret, uid, ops: [{ ...up, hash: "h2" }, { op: "delete", path: "wiki/missing.md" }] })).toEqual({
      seq: 2,
      applied: 1,
    });
    const listed = await t.query(api.personal.list, { secret, uid });
    expect(listed.seq).toBe(2);
    expect(listed.pages).toEqual([{ path: "wiki/a.md", hash: "h2", iv: "iv", ciphertext: "ct", updated: "2026-10-07", origin: "phone" }]);
    await t.mutation(api.personal.apply, { secret, uid, ops: [{ op: "delete", path: "wiki/a.md" }] });
    expect((await t.query(api.personal.list, { secret, uid })).pages).toEqual([]);
  });

  it("keeps the first wrapped key", async () => {
    const { t, uid } = await setup();
    expect(await t.mutation(api.personal.putKeyIfAbsent, { secret, uid, masterKeyId: "m1", wrapped: "w1", now: 0 })).toEqual({ masterKeyId: "m1", wrapped: "w1" });
    expect(await t.mutation(api.personal.putKeyIfAbsent, { secret, uid, masterKeyId: "m1", wrapped: "w2", now: 0 })).toEqual({ masterKeyId: "m1", wrapped: "w1" });
  });
});

describe("oauth storage", () => {
  it("finds, consumes, expires and revokes by grant", async () => {
    const { t } = await setup();
    await t.mutation(api.oauth.upsert, { secret, model: "AuthorizationCode", key: "h1:k1", payload: "v1.sealed", expiresAt: 1000, grantId: "g1" });
    expect(await t.query(api.oauth.find, { secret, model: "AuthorizationCode", key: "h1:k1", now: 10 })).toEqual({ key: "h1:k1", payload: "v1.sealed", consumedAt: null });
    await t.mutation(api.oauth.consume, { secret, model: "AuthorizationCode", key: "h1:k1", now: 5000 });
    expect(await t.query(api.oauth.find, { secret, model: "AuthorizationCode", key: "h1:k1", now: 10 })).toMatchObject({ consumedAt: 5000 });
    expect(await t.query(api.oauth.find, { secret, model: "AuthorizationCode", key: "h1:k1", now: 2000 })).toBeNull();
    await t.mutation(api.oauth.revokeByGrantId, { secret, grantId: "g1" });
    expect(await t.query(api.oauth.find, { secret, model: "AuthorizationCode", key: "h1:k1", now: 10 })).toBeNull();
  });

  it("treats a second use of a code or refresh token as reuse: the grant goes", async () => {
    const { t } = await setup();
    await t.mutation(api.oauth.upsert, { secret, model: "RefreshToken", key: "h1:r1", payload: "v1.x", expiresAt: 10_000, grantId: "g2" });
    await t.mutation(api.oauth.upsert, { secret, model: "Grant", key: "h1:g2", payload: "v1.y", expiresAt: 10_000, grantId: "g2" });
    expect(await t.mutation(api.oauth.consume, { secret, model: "RefreshToken", key: "h1:r1", now: 1 })).toEqual({ reused: false });
    expect(await t.mutation(api.oauth.consume, { secret, model: "RefreshToken", key: "h1:r1", now: 2 })).toEqual({ reused: true });
    expect(await t.query(api.oauth.find, { secret, model: "Grant", key: "h1:g2", now: 3 })).toBeNull();
  });

  it("still reads, consumes and replaces rows written before keys were hashed", async () => {
    const { t } = await setup();
    await t.mutation(api.oauth.upsert, { secret, model: "Session", key: "raw-session-id", payload: JSON.stringify({ accountId: "u1" }), expiresAt: 10_000, accountId: undefined });
    expect(await t.query(api.oauth.find, { secret, model: "Session", key: "h1:s", legacyKey: "raw-session-id", now: 1 })).toMatchObject({ key: "raw-session-id" });
    await t.mutation(api.oauth.upsert, { secret, model: "Session", key: "h1:s", legacyKey: "raw-session-id", payload: "v1.z", expiresAt: 10_000, accountId: "u1" });
    expect(await t.query(api.oauth.find, { secret, model: "Session", key: "raw-session-id", now: 1 })).toBeNull();
    expect(await t.query(api.oauth.find, { secret, model: "Session", key: "h1:s", now: 1 })).toMatchObject({ payload: "v1.z" });
    expect((await t.mutation(api.oauth.destroyByAccount, { secret, accountId: "u1" })).removed).toBe(1);
  });
});

describe("server writes, two-way sync and the personal worker", () => {
  const page = (path: string, hash: string) => ({ op: "upsert" as const, path, hash, iv: "iv", ciphertext: "ct", updated: "2026-10-07" });

  it("hands the phone only what the server wrote after its last seen seq", async () => {
    const { t, uid } = await setup();
    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/notes/a.md", "p1"), page("wiki/people/anna.md", "p2")] });
    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/people/anna.md", "s1"), page("wiki/overview.md", "s2")], origin: "server" });
    const changed = await t.query(api.personal.changedSince, { secret, uid, since: 2 });
    expect(changed.pages.map((c) => [c.path, c.hash])).toEqual([
      ["wiki/people/anna.md", "s1"],
      ["wiki/overview.md", "s2"],
    ]);
    expect(changed.deleted).toEqual([]);
    expect(await t.query(api.personal.changedSince, { secret, uid, since: 4 })).toEqual({ pages: [], deleted: [], through: null });
    const got = await t.query(api.personal.getMany, { secret, uid, paths: ["wiki/people/anna.md", "wiki/notes/a.md", "wiki/none.md"] });
    expect(got.map((g) => [g.path, g.origin])).toEqual([
      ["wiki/people/anna.md", "server"],
      ["wiki/notes/a.md", "phone"],
    ]);
  });

  it("hands each device what the server and the other devices wrote, deletions included", async () => {
    const { t, uid } = await setup();
    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/notes/mac.md", "m1")], origin: "device:mac" });
    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/notes/phone.md", "i1")], origin: "device:iphone-1" });
    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/overview.md", "s1")], origin: "server" });
    await t.mutation(api.personal.apply, { secret, uid, ops: [{ op: "delete", path: "wiki/notes/mac.md" }], origin: "device:mac" });

    const forPhone = await t.query(api.personal.changedSince, { secret, uid, since: 0, device: "device:iphone-1" });
    expect(forPhone.pages.map((p) => p.path)).toEqual(["wiki/overview.md"]);  // mac.md was written, then deleted
    expect(forPhone.deleted.map((d) => d.path)).toEqual(["wiki/notes/mac.md"]);
    const forMac = await t.query(api.personal.changedSince, { secret, uid, since: 0, device: "device:mac" });
    expect(forMac.pages.map((p) => p.path)).toEqual(["wiki/notes/phone.md", "wiki/overview.md"]);
    expect(forMac.deleted).toEqual([]);  // its own deletion

    // Written again: no longer deleted.
    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/notes/mac.md", "m2")], origin: "device:mac" });
    expect((await t.query(api.personal.changedSince, { secret, uid, since: 0, device: "device:iphone-1" })).deleted).toEqual([]);
    // Older builds without a device id: only the server's writes, as before.
    expect((await t.query(api.personal.changedSince, { secret, uid, since: 0 })).pages.map((p) => p.path)).toEqual(["wiki/overview.md"]);
  });

  it("is due only once the user opted in, with new phone input that has settled", async () => {
    const { t, uid } = await setup();
    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/notes/a.md", "p1")] });
    const now = Date.now();
    // Opt-in: not asked yet means off.
    expect(await t.query(api.users.get, { secret, uid })).toMatchObject({ consolidate: false, consolidateAsked: false });
    expect(await t.query(api.work.due, { secret, now: now + 120_000, quietMs: 60_000 })).toEqual([]);
    await t.mutation(api.users.setPrefs, { secret, uid, consolidate: true });
    expect(await t.query(api.users.get, { secret, uid })).toMatchObject({ consolidate: true, consolidateAsked: true });
    expect(await t.query(api.work.due, { secret, now, quietMs: 60_000 })).toEqual([]);
    expect(await t.query(api.work.due, { secret, now: now + 120_000, quietMs: 60_000 })).toEqual([{ uid, seq: 1 }]);

    await t.mutation(api.work.save, { secret, uid, done: ["n1"], lastSeq: 1, status: "ok", lint: { orphan: 2 }, now: now + 130_000 });
    expect(await t.query(api.work.due, { secret, now: now + 200_000, quietMs: 60_000 })).toEqual([]);
    const state = await t.query(api.work.get, { secret, uid });
    expect(state).toMatchObject({ done: ["n1"], lastSeq: 1, lastStatus: "ok" });
    expect(state!.lintHistory).toEqual([{ at: now + 130_000, counts: { orphan: 2 } }]);

    // Server writes alone don't make a user due again (no phone input).
    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/overview.md", "s1")], origin: "server" });
    await t.mutation(api.work.save, { secret, uid, done: ["n1"], lastSeq: 2, status: "ok", now: now + 140_000 });
    expect(await t.query(api.work.due, { secret, now: now + 300_000, quietMs: 60_000 })).toEqual([]);

    await t.mutation(api.personal.apply, { secret, uid, ops: [page("wiki/notes/b.md", "p2")] });
    await t.mutation(api.users.setPrefs, { secret, uid, consolidate: false });
    expect(await t.query(api.users.get, { secret, uid })).toMatchObject({ consolidate: false });
    expect(await t.query(api.work.due, { secret, now: Date.now() + 120_000, quietMs: 60_000 })).toEqual([]);
  });
});

describe("teams managed from the app", () => {
  it("creates a team on a pool server, with the creator as owner", async () => {
    const { t, uid } = await setup();
    expect(await t.mutation(api.teams.createOwned, { secret, uid, name: "Ambient Artifacts", peopleSlug: "people/lena-vogel", now: 1 })).toEqual({ ok: false, error: "no_server" });
    await t.mutation(internal.teams.registerServer, { serverId: "srv-1", url: "https://t-pool-1.example.com/" });
    expect(await t.query(api.teams.freeServers, { secret })).toHaveLength(1);
    const made = await t.mutation(api.teams.createOwned, { secret, uid, name: "Ambient Artifacts", peopleSlug: "people/lena-vogel", now: 2 });
    expect(made).toMatchObject({ ok: true, team: { slug: "ambient-artifacts", name: "Ambient Artifacts", role: "owner", serverUrl: "https://t-pool-1.example.com" }, server: { serverId: "srv-1" } });
    expect(await t.query(api.teams.freeServers, { secret })).toHaveLength(0);
    expect((await t.query(api.teams.ofUser, { secret, uid })).map((x) => x.slug)).toEqual(["ambient-artifacts"]);
  });

  it("gives the server back when its claim fails", async () => {
    const { t, uid } = await setup();
    await t.mutation(internal.teams.registerServer, { serverId: "srv-1", url: "https://t-pool-1.example.com" });
    const made = await t.mutation(api.teams.createOwned, { secret, uid, name: "Acme", peopleSlug: "people/lena-vogel", now: 2 });
    if (!made.ok) throw new Error("not created");
    await t.mutation(api.teams.abandonCreate, { secret, teamId: made.team.id });
    expect(await t.query(api.teams.freeServers, { secret })).toHaveLength(1);
    expect(await t.query(api.teams.ofUser, { secret, uid })).toEqual([]);
  });

  it("lets owners and admins invite and remove, and only the owner change roles", async () => {
    const { t, uid: owner } = await setup();
    await t.mutation(internal.teams.registerServer, { serverId: "srv-1", url: "https://t-pool-1.example.com" });
    await t.mutation(api.teams.createOwned, { secret, uid: owner, name: "Acme", peopleSlug: "people/lena-vogel", now: 2 });
    const add = async (sub: string, name: string, code: string) => {
      const u = await t.mutation(api.users.upsertApple, { secret, appleSub: sub, name, now: 3 });
      await t.mutation(api.teams.invite, { secret, uid: owner, slug: "acme", codeHash: code, uses: 1, days: 7, now: 3 });
      await t.mutation(api.teams.joinWithInvite, { secret, uid: u!.uid, codeHash: code, peopleSlug: `people/${sub}`, now: 4 });
      return u!.uid;
    };
    const ben = await add("ben", "Ben Koch", "c1");
    const cara = await add("cara", "Cara Lind", "c2");
    expect((await t.query(api.teams.members, { secret, uid: ben, slug: "acme" }))!.map((m) => [m.name, m.role])).toEqual([
      ["Lena Vogel", "owner"],
      ["Ben Koch", "member"],
      ["Cara Lind", "member"],
    ]);
    // A member can't invite or remove; the owner makes Ben an admin, who then can.
    expect(await t.mutation(api.teams.invite, { secret, uid: ben, slug: "acme", codeHash: "c3", uses: 1, days: 7, now: 5 })).toEqual({ ok: false, error: "forbidden" });
    expect(await t.mutation(api.teams.setRole, { secret, uid: ben, slug: "acme", target: cara, role: "admin" })).toEqual({ ok: false, error: "forbidden" });
    expect(await t.mutation(api.teams.setRole, { secret, uid: owner, slug: "acme", target: ben, role: "admin" })).toEqual({ ok: true });
    expect(await t.mutation(api.teams.removeMemberBy, { secret, uid: ben, slug: "acme", target: owner })).toEqual({ ok: false, error: "forbidden" });
    expect(await t.mutation(api.teams.removeMemberBy, { secret, uid: ben, slug: "acme", target: cara })).toEqual({ ok: true });
    // The owner can't leave; others can.
    expect(await t.mutation(api.teams.leaveBySlug, { secret, uid: owner, slug: "acme" })).toEqual({ ok: false, error: "owner_cannot_leave" });
    expect(await t.mutation(api.teams.leaveBySlug, { secret, uid: ben, slug: "acme" })).toEqual({ ok: true });
    expect((await t.query(api.teams.members, { secret, uid: owner, slug: "acme" }))!.map((m) => m.name)).toEqual(["Lena Vogel"]);
    expect(await t.query(api.teams.members, { secret, uid: cara, slug: "acme" })).toBeNull();
  });
});

describe("team routines and secrets", () => {
  it("are changed only by someone who manages the team now, whatever the gateway passes", async () => {
    const { t, uid } = await setup();
    const teamId = await t.mutation(internal.teams.create, { slug: "crew", name: "Crew" });
    await t.run(async (ctx) => ctx.db.insert("members", { teamId, userId: uid as never, role: "member", peopleSlug: "people/lena", joinedAt: 0 }));
    const set = () => t.mutation(api.routines.setSecret, { secret, uid: uid as never, teamId, name: "TOKEN", valueIv: "iv", valueCt: "ct", now: 1 });
    expect(await set()).toEqual({ ok: false, error: "admins_only" });
    await t.run(async (ctx) => {
      const m = await ctx.db.query("members").withIndex("by_team", (q) => q.eq("teamId", teamId)).first();
      await ctx.db.patch(m!._id, { role: "admin" });
    });
    expect(await set()).toEqual({ ok: true });
  });
});
