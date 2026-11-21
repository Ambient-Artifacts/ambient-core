// Voice fingerprints: a user stores the one their device learned, their other devices fetch it,
// and every active member of their teams gets it to name them in recordings. Sealed at rest; gone
// with a removal, a departure or the account.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, appHeaders, INVITE, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

let s: Stack;
let anna: AppSession;
let ben: AppSession;
let carla: AppSession;
let dan: AppSession;
let olaf: AppSession;

/** A made-up 256-number fingerprint, different per seed. */
const fingerprint = (seed: number, n = 256) => Array.from({ length: n }, (_, i) => Math.sin(seed * 1000 + i) * 0.137);
const MODEL = "fluidaudio-community-1";
const voicesOf = async (u: AppSession, slug = "acme") => appCall(s, u.access_token, "GET", `/v1/app/teams/${slug}/voices`);
const names = (r: { json: Record<string, unknown> }) => (r.json.voices as { name: string }[]).map((v) => v.name);

beforeAll(async () => {
  s = await startStack();
  anna = await signIn(s, "apple-voice-anna", "Anna Berger");
  ben = await signIn(s, "apple-voice-ben", "Ben Kaiser");
  carla = await signIn(s, "apple-voice-carla", "Carla Lind");
  dan = await signIn(s, "apple-voice-dan", "Dan Roth");
  // Olaf is in no team.
  olaf = await signIn(s, "apple-voice-olaf", "Olaf Outside");
  for (const u of [anna, ben, carla, dan]) {
    expect((await appCall(s, u.access_token, "POST", "/v1/app/teams/join", { code: INVITE })).status).toBe(200);
  }
  // Anna owns team acme, so she can remove people.
  await s.t.run(async (ctx) => {
    const m = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", anna.user.uid as never)).unique();
    await ctx.db.patch(m!._id, { role: "owner" });
  });
});
afterAll(() => s.close());

describe("your own voice", () => {
  it("is stored, read back exactly, replaced, and deleted (twice is fine)", async () => {
    expect(await appCall(s, anna.access_token, "GET", "/v1/app/me/voice")).toEqual({ status: 404, json: { error: "no_voice" } });

    const first = fingerprint(1);
    expect((await appCall(s, anna.access_token, "PUT", "/v1/app/me/voice", { embedding: first, model: MODEL })).status).toBe(204);
    const got = await appCall(s, anna.access_token, "GET", "/v1/app/me/voice");
    expect(got.status).toBe(200);
    expect(got.json).toEqual({ embedding: first, model: MODEL, updatedAt: expect.any(Number) });

    const second = fingerprint(2, 512);
    expect((await appCall(s, anna.access_token, "PUT", "/v1/app/me/voice", { embedding: second, model: "fluidaudio-community-2" })).status).toBe(204);
    expect((await appCall(s, anna.access_token, "GET", "/v1/app/me/voice")).json).toMatchObject({ embedding: second, model: "fluidaudio-community-2" });
    const rows = await s.t.run(async (ctx) => ctx.db.query("voices").withIndex("by_user", (q) => q.eq("userId", anna.user.uid as never)).collect());
    expect(rows.length).toBe(1);

    expect((await appCall(s, anna.access_token, "DELETE", "/v1/app/me/voice")).status).toBe(204);
    expect((await appCall(s, anna.access_token, "GET", "/v1/app/me/voice")).status).toBe(404);
    expect((await appCall(s, anna.access_token, "DELETE", "/v1/app/me/voice")).status).toBe(204);
  });

  it("reaches the user's other devices", async () => {
    const embedding = fingerprint(3);
    expect((await appCall(s, anna.access_token, "PUT", "/v1/app/me/voice", { embedding, model: MODEL })).status).toBe(204);
    // Another device: its own sign-in, its own key, the same account.
    const mac = await signIn(s, "apple-voice-anna", "Anna Berger");
    expect(mac.user.uid).toBe(anna.user.uid);
    expect((await appCall(s, mac.access_token, "GET", "/v1/app/me/voice")).json).toMatchObject({ embedding, model: MODEL });
  });

  it("is sealed at rest: the database holds no numbers", async () => {
    const embedding = fingerprint(4);
    await appCall(s, anna.access_token, "PUT", "/v1/app/me/voice", { embedding, model: MODEL });
    const row = await s.t.run(async (ctx) => ctx.db.query("voices").withIndex("by_user", (q) => q.eq("userId", anna.user.uid as never)).unique());
    expect(row).toMatchObject({ model: MODEL, iv: expect.any(String), ciphertext: expect.any(String) });
    expect(Object.keys(row!)).not.toContain("embedding");
    expect(Buffer.from(row!.ciphertext, "base64").toString("latin1")).not.toContain(String(embedding[1]).slice(0, 8));
  });

  it("refuses what isn't a fingerprint", async () => {
    const put = (body: unknown) => appCall(s, ben.access_token, "PUT", "/v1/app/me/voice", body);
    const bad = [
      { embedding: fingerprint(5, 63), model: MODEL },
      { embedding: fingerprint(5, 1025), model: MODEL },
      { embedding: [], model: MODEL },
      // NaN goes into JSON as null.
      { embedding: [...fingerprint(5, 255), NaN], model: MODEL },
      { embedding: [...fingerprint(5, 255), "0.1"], model: MODEL },
      { embedding: fingerprint(5), model: "" },
      { embedding: fingerprint(5), model: "m".repeat(81) },
      { embedding: fingerprint(5) },
      { model: MODEL },
    ];
    for (const body of bad) {
      const r = await put(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(r.json.error).toBe("bad_request");
    }
    // A number too big for a double arrives as Infinity.
    const url = `${s.origin}/v1/app/me/voice`;
    const infinite = await fetch(url, {
      method: "PUT",
      headers: { ...(await appHeaders(ben.access_token, "PUT", url)), "content-type": "application/json" },
      body: `{"model":"${MODEL}","embedding":[${[...fingerprint(5, 255), "1e999"].join(",")}]}`,
    });
    expect(infinite.status).toBe(400);
    expect((await appCall(s, ben.access_token, "GET", "/v1/app/me/voice")).status).toBe(404);
    // The edges are fine.
    expect((await put({ embedding: fingerprint(5, 64), model: MODEL })).status).toBe(204);
    expect((await put({ embedding: fingerprint(5, 1024), model: "m".repeat(80) })).status).toBe(204);
  });

  it("needs a signed-in user", async () => {
    const res = await fetch(`${s.origin}/v1/app/me/voice`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ embedding: fingerprint(6), model: MODEL }) });
    expect(res.status).toBe(401);
    expect((await fetch(`${s.origin}/v1/app/teams/acme/voices`)).status).toBe(401);
  });
});

describe("a team's voices", () => {
  it("go to every member, admins or not, the requester's own included; members without one are left out", async () => {
    await appCall(s, anna.access_token, "PUT", "/v1/app/me/voice", { embedding: fingerprint(10), model: MODEL });
    await appCall(s, ben.access_token, "PUT", "/v1/app/me/voice", { embedding: fingerprint(11), model: MODEL });
    await appCall(s, carla.access_token, "PUT", "/v1/app/me/voice", { embedding: fingerprint(12), model: MODEL });
    // Dan has none.
    for (const u of [anna, ben, carla, dan]) {
      const r = await voicesOf(u);
      expect(r.status).toBe(200);
      expect(names(r)).toEqual(["Anna Berger", "Ben Kaiser", "Carla Lind"]);
    }
    const r = await voicesOf(dan);
    expect((r.json.voices as unknown[])[1]).toEqual({ uid: ben.user.uid, name: "Ben Kaiser", embedding: fingerprint(11), model: MODEL, updatedAt: expect.any(Number) });
  });

  it("show the name the member has in Ambient now", async () => {
    expect((await appCall(s, ben.access_token, "POST", "/v1/app/me/name", { name: "Ben K. Kaiser" })).status).toBe(204);
    expect(names(await voicesOf(anna))).toContain("Ben K. Kaiser");
    await appCall(s, ben.access_token, "POST", "/v1/app/me/name", { name: "Ben Kaiser" });
  });

  it("are refused to anyone outside the team, and for a team that doesn't exist", async () => {
    expect(await voicesOf(olaf)).toEqual({ status: 403, json: { error: "not_a_member" } });
    expect((await voicesOf(anna, "no-such-team")).status).toBe(403);
  });

  it("drop someone who leaves, and they stop getting the others'", async () => {
    expect((await appCall(s, carla.access_token, "POST", "/v1/app/teams/acme/leave")).status).toBe(204);
    expect(names(await voicesOf(anna))).toEqual(["Anna Berger", "Ben Kaiser"]);
    expect((await voicesOf(carla)).status).toBe(403);
  });

  it("drop someone who was removed, and they stop getting the others'", async () => {
    expect((await appCall(s, anna.access_token, "DELETE", `/v1/app/teams/acme/members/${ben.user.uid}`)).status).toBe(204);
    expect(names(await voicesOf(anna))).toEqual(["Anna Berger"]);
    expect(names(await voicesOf(dan))).toEqual(["Anna Berger"]);
    expect((await voicesOf(ben)).status).toBe(403);
    // Their own copy stays theirs.
    expect((await appCall(s, ben.access_token, "GET", "/v1/app/me/voice")).json).toMatchObject({ embedding: fingerprint(11) });
  });

  it("drop a fingerprint its owner deleted", async () => {
    await appCall(s, dan.access_token, "PUT", "/v1/app/me/voice", { embedding: fingerprint(13), model: MODEL });
    expect(names(await voicesOf(anna))).toEqual(["Anna Berger", "Dan Roth"]);
    await appCall(s, dan.access_token, "DELETE", "/v1/app/me/voice");
    expect(names(await voicesOf(anna))).toEqual(["Anna Berger"]);
  });
});

describe("deleting the account", () => {
  it("deletes the voice with it, and the team stops getting it", async () => {
    const eva = await signIn(s, "apple-voice-eva", "Eva Sommer");
    // The removal above ended the older invites: Anna makes a new one.
    const code = String((await appCall(s, anna.access_token, "POST", "/v1/app/teams/acme/invites", {})).json.code);
    expect((await appCall(s, eva.access_token, "POST", "/v1/app/teams/join", { code })).status).toBe(200);
    await appCall(s, eva.access_token, "PUT", "/v1/app/me/voice", { embedding: fingerprint(20), model: MODEL });
    expect(names(await voicesOf(anna))).toContain("Eva Sommer");

    const del = await appCall(s, eva.access_token, "DELETE", "/v1/app/me", {});
    expect(del.json).toMatchObject({ deleted: true });
    const left = await s.t.run(async (ctx) => ctx.db.query("voices").withIndex("by_user", (q) => q.eq("userId", eva.user.uid as never)).collect());
    expect(left).toEqual([]);
    expect(names(await voicesOf(anna))).not.toContain("Eva Sommer");
    expect((await appCall(s, eva.access_token, "PUT", "/v1/app/me/voice", { embedding: fingerprint(20), model: MODEL })).status).toBe(401);
  });
});

describe("through an AI app", () => {
  it("get_settings says whether a fingerprint is stored and which teams get it; forget_my_voice deletes it", async () => {
    const pat = String((await appCall(s, anna.access_token, "POST", "/v1/app/pats", { label: "Codex" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    await appCall(s, anna.access_token, "PUT", "/v1/app/me/voice", { embedding: fingerprint(30), model: MODEL });

    const before = await client.callTool({ name: "get_settings", arguments: {} });
    expect(text(before)).toContain("Voice fingerprint (lets the apps name you in recordings): stored");
    expect(text(before)).toContain("your teams' apps get it: Acme");
    expect((before.structuredContent as { voice: unknown }).voice).toMatchObject({ stored: true, model: MODEL, shared_with: [{ slug: "acme", name: "Acme" }] });

    const forgot = await client.callTool({ name: "forget_my_voice", arguments: {} });
    expect(forgot.isError).toBeFalsy();
    expect(forgot.structuredContent).toEqual({ deleted: true });
    expect((await appCall(s, anna.access_token, "GET", "/v1/app/me/voice")).status).toBe(404);
    expect(names(await voicesOf(dan))).toEqual([]);
    expect((await client.callTool({ name: "forget_my_voice", arguments: {} })).structuredContent).toEqual({ deleted: false });
    expect(text(await client.callTool({ name: "get_settings", arguments: {} }))).toContain("Voice fingerprint (lets the apps name you in recordings): none stored");
    await client.close();
  });

  it("a team's own connection can't reach anyone's voice", async () => {
    const pat = String((await appCall(s, anna.access_token, "POST", "/v1/app/pats", { label: "Copilot", team: "acme" })).json.token);
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, pat);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("forget_my_voice");
    await client.close();
  });
});
