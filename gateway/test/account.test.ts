// Deleting an account from the app (App Store 5.1.1(v)), the launch config, team invite links,
// and revoking the Apple token.
import { exportPKCS8, generateKeyPair, decodeJwt, decodeProtectedHeader } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appleRevoker } from "../src/auth/apple-revoke.ts";
import { appCall, fixturePersonalOps, INVITE, MICROSOFT_CLIENT, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

describe("deleting an account", () => {
  it("removes the user's data, hands owned teams on, cancels solo teams, and frees the Apple account", async () => {
    const owner = await signIn(s, "apple-del-owner", "Olga Owner");
    const member = await signIn(s, "apple-del-member", "Max Member");
    for (const u of [owner, member]) {
      expect((await appCall(s, u.access_token, "POST", "/v1/app/teams/join", { code: INVITE })).status).toBe(200);
    }
    const ownerId = owner.user.uid as never;
    const memberId = member.user.uid as never;
    // Olga owns Acme (Max is a member) and a team of her own.
    await s.t.run(async (ctx) => {
      const mine = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", ownerId)).unique();
      await ctx.db.patch(mine!._id, { role: "owner" });
      const solo = await ctx.db.insert("teams", { slug: "solo", name: "Solo", status: "active", createdAt: Date.now() });
      await ctx.db.insert("members", { teamId: solo, userId: ownerId, role: "owner", peopleSlug: "people/olga-owner", joinedAt: Date.now() });
      // An AI app she connected.
      await ctx.db.insert("oauth", { model: "Grant", key: "grant-olga", payload: JSON.stringify({ accountId: owner.user.uid }), expiresAt: Date.now() + 3_600_000 });
    });
    const synced = await appCall(s, owner.access_token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps() });
    expect(synced.status).toBe(200);

    const del = await appCall(s, owner.access_token, "DELETE", "/v1/app/me", {});
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ deleted: true, apple: "skipped" });
    expect(del.json.teams).toEqual(expect.arrayContaining([
      { slug: "acme", outcome: "handed_over" },
      { slug: "solo", outcome: "canceled" },
    ]));

    // Her tokens stop working at once.
    expect((await appCall(s, owner.access_token, "GET", "/v1/app/me")).status).toBe(401);
    const left = await s.t.run(async (ctx) => ({
      user: await ctx.db.get(ownerId),
      pages: (await ctx.db.query("personalPages").withIndex("by_user_path", (q) => q.eq("userId", ownerId)).collect()).length,
      keys: (await ctx.db.query("userKeys").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect()).length,
      sessions: (await ctx.db.query("appSessions").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect()).length,
      memberships: (await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect()).length,
      grants: (await ctx.db.query("oauth").withIndex("by_model_key", (q) => q.eq("model", "Grant").eq("key", "grant-olga")).collect()).length,
      maxInAcme: (await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", memberId)).unique())?.role,
      solo: (await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", "solo")).unique())?.status,
    }));
    expect(left).toEqual({ user: null, pages: 0, keys: 0, sessions: 0, memberships: 0, grants: 0, maxInAcme: "owner", solo: "canceled" });

    // Max keeps Acme, now as its owner.
    const maxMe = await appCall(s, member.access_token, "GET", "/v1/app/me");
    expect(maxMe.json.teams).toEqual([expect.objectContaining({ slug: "acme", role: "owner" })]);

    // The same Apple account can sign up again, as a new, empty account.
    const again = await signIn(s, "apple-del-owner", "Olga Owner");
    expect(again.user.uid).not.toBe(owner.user.uid);
    expect((await appCall(s, again.access_token, "GET", "/v1/app/me")).json.teams).toEqual([]);
  });

  it("knows whether an AI app is connected yet (the app's setup reminder)", async () => {
    const u = await signIn(s, "apple-setup", "Sam Setup");
    expect((await appCall(s, u.access_token, "GET", "/v1/app/me")).json.setup).toEqual({ aiAppConnected: false });
    expect((await appCall(s, u.access_token, "POST", "/v1/app/pats", { label: "Codex" })).status).toBe(200);
    expect((await appCall(s, u.access_token, "GET", "/v1/app/me")).json.setup).toEqual({ aiAppConnected: true });

    // An account from before the field, with an AI app already approved: found once.
    const old = await signIn(s, "apple-setup-old", "Olli Older");
    await s.t.run(async (ctx) => {
      await ctx.db.insert("oauth", { model: "Grant", key: "grant-olli", payload: JSON.stringify({ accountId: old.user.uid }), expiresAt: Date.now() + 3_600_000 });
      // Signing in already looked once (the app loads /me); an account from before never did.
      await ctx.db.patch(old.user.uid as never, { aiAppCheckedAt: undefined });
    });
    expect((await appCall(s, old.access_token, "GET", "/v1/app/me")).json.setup).toEqual({ aiAppConnected: true });
  });

  it("asks before Claude reads notes: upkeep is off until the user says yes", async () => {
    const u = await signIn(s, "apple-consent", "Clara Consent");
    expect((await appCall(s, u.access_token, "GET", "/v1/app/me")).json.prefs).toEqual({ consolidate: false, consolidateAsked: false, digest: true });
    expect((await appCall(s, u.access_token, "POST", "/v1/app/me/prefs", { consolidate: true })).json).toEqual({ prefs: { consolidate: true, consolidateAsked: true, digest: true } });
    expect((await appCall(s, u.access_token, "GET", "/v1/app/me")).json.prefs).toEqual({ consolidate: true, consolidateAsked: true, digest: true });
    // The morning push is its own switch; turning it off leaves upkeep as it was.
    expect((await appCall(s, u.access_token, "POST", "/v1/app/me/prefs", { digest: false })).json).toEqual({ prefs: { consolidate: true, consolidateAsked: true, digest: false } });
  });
});

describe("launch config and invite links", () => {
  it("serves the minimum app version without sign-in", async () => {
    const res = await fetch(`${s.origin}/v1/app/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ minimumVersion: null, updateUrl: null, microsoftClientId: MICROSOFT_CLIENT, appleSignIn: true, microsoftConnect: false });
  });

  it("serves a page that opens the app on a team invite, and nothing for junk", async () => {
    const res = await fetch(`${s.origin}/join/acme-abcd-efgh`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain(`href="ambient://join/ACME-ABCD-EFGH"`);
    expect(html).toContain("Join your team on Ambient");
    expect((await fetch(`${s.origin}/join/${encodeURIComponent("<script>")}`)).status).toBe(404);
  });
});

describe("revoking the Apple token", () => {
  it("trades the fresh code for a token and revokes it, signed with the Sign in with Apple key", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const calls: { url: string; form: URLSearchParams }[] = [];
    const fakeApple = (async (url: string | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      calls.push({ url: String(url), form });
      if (String(url).endsWith("/auth/token")) return new Response(JSON.stringify({ refresh_token: "apple-refresh" }), { status: 200 });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const revoke = appleRevoker({ teamId: "TEAM123456", keyId: "KEY1234567", privateKey: await exportPKCS8(privateKey), clientId: "com.example.brain" }, fakeApple);

    expect(await revoke(undefined)).toBe("skipped");
    expect(await revoke("fresh-authorization-code")).toBe("revoked");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/auth/token", "/auth/revoke"]);
    expect(calls[0]!.form.get("code")).toBe("fresh-authorization-code");
    expect(calls[1]!.form.get("token")).toBe("apple-refresh");
    const secret = calls[0]!.form.get("client_secret")!;
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect(decodeJwt(secret)).toMatchObject({ iss: "TEAM123456", sub: "com.example.brain", aud: "https://appleid.apple.com" });

    const failing = appleRevoker({ teamId: "T", keyId: "K", privateKey: await exportPKCS8(privateKey), clientId: "c" }, (async () => new Response("", { status: 400 })) as typeof fetch);
    expect(await failing("code-that-apple-refuses")).toBe("failed");
    expect(await appleRevoker(undefined)("anything-at-all")).toBe("skipped");
  });
});
