// "Connect Microsoft 365" with Ambient's own Microsoft app, against a fake Microsoft: an admin
// approves the app, signs in, picks the folder, Ambient gives its app write access to that folder
// with the sign-in, and the team's server writes there with tokens the gateway pushes.
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MicrosoftConnector } from "../src/microsoft-connect.ts";
import { appCall, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

const CONNECT_CLIENT = "00000000-0000-4000-8000-00000000c0de";
const TENANT = "00000000-0000-4000-8000-0000000000dd";
const LINK = "https://example-my.sharepoint.com/personal/office_example_com/Documents/Company/Meetings";
let publicKey: CryptoKey;
let s: Stack;
let lena: string;

// The fake Microsoft: token endpoint (checks the app's signed assertion), Graph.
const ms = {
  grants: [] as { drive: string; item: string; body: Record<string, unknown> }[],
  challenge: "",
  calls: [] as { method: string; url: string; auth?: string }[],
};
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const msFetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  const auth = (init.headers as Record<string, string> | undefined)?.authorization;
  ms.calls.push({ method, url, auth });
  const token = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url);
  if (token && method === "POST") {
    const form = new URLSearchParams(String(init.body));
    try {
      await jwtVerify(form.get("client_assertion") ?? "", publicKey, { issuer: CONNECT_CLIENT, subject: CONNECT_CLIENT, audience: url });
    } catch {
      return json(401, { error_description: "AADSTS700027: Client assertion failed signature validation." });
    }
    if (form.get("grant_type") === "client_credentials") return json(200, { access_token: `app-token-${token[1]}`, expires_in: 3600 });
    const { createHash } = await import("node:crypto");
    if (form.get("code") !== "the-code" || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== ms.challenge) {
      return json(400, { error_description: "AADSTS70008: The provided authorization code is invalid." });
    }
    return json(200, { access_token: "admin-signin", id_token: `${b64({ alg: "none" })}.${b64({ tid: TENANT, preferred_username: "admin@example.com" })}.` });
  }
  const folder = { id: "01MEETINGS", name: "Meetings", folder: {}, parentReference: { driveId: "b!drive-ex", path: "/drives/b!drive-ex/root:/Company" } };
  if (url.startsWith("https://graph.microsoft.com/v1.0/shares/") && auth === "Bearer admin-signin") return json(200, folder);
  if (url.startsWith("https://graph.microsoft.com/v1.0/organization") && auth === "Bearer admin-signin") return json(200, { value: [{ displayName: "Example Ltd" }] });
  const perm = /\/drives\/([^/]+)\/items\/([^/]+)\/permissions$/.exec(url);
  if (perm && method === "POST" && auth === "Bearer admin-signin") {
    ms.grants.push({ drive: decodeURIComponent(perm[1]!), item: decodeURIComponent(perm[2]!), body: JSON.parse(String(init.body)) });
    return json(201, { id: "perm1", roles: ["write"] });
  }
  // The team server, with the app's own token: sees the folder only once it was granted.
  if (url.startsWith("https://graph.microsoft.com/v1.0/drives/b!drive-ex/items/01MEETINGS?") && auth === `Bearer app-token-${TENANT}`) {
    return ms.grants.length ? json(200, folder) : json(403, { error: { message: "Access denied" } });
  }
  return json(404, { error: { message: `not faked: ${method} ${url}` } });
}) as typeof fetch;

const go = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", ...init });
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  publicKey = kp.publicKey;
  const connector = new MicrosoftConnector({ clientId: CONNECT_CLIENT, privateKey: await exportPKCS8(kp.privateKey), x5t: "dGVzdC10aHVtYnByaW50" }, msFetch);
  s = await startStack({ microsoftConnect: { connector, propagationDelayMs: 10 }, microsoftFetch: msFetch });
  lena = (await signIn(s, "apple-lena-m365", "Lena Vogel")).access_token;
  await appCall(s, lena, "POST", "/v1/app/teams/join", { code: INVITE });
});
afterAll(() => s.close());

describe("Connect Microsoft 365", () => {
  it("is offered, but only owners and admins start it", async () => {
    expect((await appCall(s, lena, "GET", "/v1/app/config")).json.microsoftConnect).toBe(true);
    expect(await appCall(s, lena, "POST", "/v1/app/teams/acme/microsoft/connect", { for: "transcripts" })).toMatchObject({ status: 403, json: { error: "admins_only" } });
    await s.t.run(async (ctx) => {
      for (const m of await ctx.db.query("members").collect()) await ctx.db.patch(m._id, { role: "admin" });
    });
  });

  it("approval, sign-in, folder, access: the team's server then writes there with the app's token", async () => {
    const start = await appCall(s, lena, "POST", "/v1/app/teams/acme/microsoft/connect", { for: "transcripts" });
    expect(start.status).toBe(200);
    const url = String(start.json.url);
    expect(url).toMatch(new RegExp(`^${s.origin}/connect/microsoft\\?state=`));

    // 1. First time for this company: Microsoft's admin consent.
    const toConsent = await go(url);
    expect(toConsent.status).toBe(302);
    const consent = new URL(toConsent.headers.get("location")!);
    expect(consent.origin + consent.pathname).toBe("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
    expect(consent.searchParams.get("client_id")).toBe(CONNECT_CLIENT);
    const state = consent.searchParams.get("state")!;
    const callback = consent.searchParams.get("redirect_uri")!;
    expect(callback).toBe(`${s.origin}/connect/microsoft/callback`);

    // 2. Approved: on to signing in, in that tenant, with PKCE.
    const toSignIn = await go(`${callback}?admin_consent=True&tenant=${TENANT}&state=${state}`);
    const authorize = new URL(toSignIn.headers.get("location")!);
    expect(authorize.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(authorize.searchParams.get("scope")).toContain("Sites.FullControl.All");
    expect(authorize.searchParams.get("scope")).not.toContain("offline_access");
    ms.challenge = authorize.searchParams.get("code_challenge")!;

    // 3. Signed in: the folder page.
    const folderPage = await go(`${callback}?code=the-code&state=${state}`);
    expect(folderPage.status).toBe(200);
    const html = await folderPage.text();
    expect(html).toContain("admin@example.com");
    expect(folderPage.headers.get("content-security-policy")).toContain("default-src 'none'");

    // 4. The folder, then who gets what.
    const confirm = await go(`${s.origin}/connect/microsoft/folder`, form({ state, link: LINK }));
    const confirmHtml = await confirm.text();
    expect(confirm.status).toBe(200);
    expect(confirmHtml).toContain("Company / Meetings");
    expect(confirmHtml).toContain("Acme");
    expect(confirmHtml).toContain("Lena Vogel");

    // 5. Access given; back to the app.
    const done = await go(`${s.origin}/connect/microsoft/grant`, form({ state }));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("ambient://team-settings/acme?microsoft=connected");
    expect(ms.grants).toEqual([{ drive: "b!drive-ex", item: "01MEETINGS", body: { roles: ["write"], grantedToV2: { application: { id: CONNECT_CLIENT } } } }]);

    const settings = await appCall(s, lena, "GET", "/v1/app/teams/acme/settings");
    expect(settings.json.settings).toMatchObject({
      microsoft: { kind: "ambient", tenant_id: TENANT, tenant_name: "Example Ltd" },
      transcripts: { kind: "drive", drive_id: "b!drive-ex", folder_id: "01MEETINGS", label: "Company / Meetings" },
    });
    expect(JSON.stringify(settings.json)).not.toContain("admin-signin");
    await s.t.run(async (ctx) => {
      const team = await ctx.db.query("teams").withIndex("by_slug", (q) => q.eq("slug", "acme")).unique();
      expect(team?.microsoftTenantId).toBe(TENANT);
    });
    // The team server never asked Microsoft for a token itself: only the gateway did.
    expect(ms.calls.filter((c) => c.url.includes("/oauth2/v2.0/token")).length).toBe(2);
    // The link is used up.
    expect((await go(`${s.origin}/connect/microsoft/grant`, form({ state }))).status).toBe(400);
  });

  it("pushes fresh tokens to connected teams, and a second folder skips the approval", async () => {
    expect(await s.microsoftConnect!.pushTokens()).toEqual([{ slug: "acme", ok: true }]);
    expect(s.graphTokens.get(TENANT)).toBe(`app-token-${TENANT}`);
    const again = await appCall(s, lena, "POST", "/v1/app/teams/acme/microsoft/connect", { for: "work" });
    const next = await go(String(again.json.url));
    expect(new URL(next.headers.get("location")!).pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
  });

  it("the app can't name Ambient's app itself; disconnecting stops the tokens", async () => {
    const forged = await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { microsoft: { kind: "ambient", tenant_id: "00000000-0000-4000-8000-0000000000ee" } });
    expect(forged).toMatchObject({ status: 400, json: { error: "settings" } });
    const off = await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { transcripts: { kind: "none" }, microsoft: null });
    expect(off.status).toBe(200);
    expect(await s.microsoftConnect!.pushTokens()).toEqual([]);
  });

  it("a declined approval or an unknown link ends with a message, not a broken page", async () => {
    const start = await appCall(s, lena, "POST", "/v1/app/teams/acme/microsoft/connect", { for: "transcripts" });
    const state = new URL(String(start.json.url)).searchParams.get("state")!;
    const declined = await go(`${s.origin}/connect/microsoft/callback?error=access_denied&error_description=AADSTS65004&state=${state}`);
    expect(declined.status).toBe(303);
    expect(declined.headers.get("location")).toMatch(/^ambient:\/\/team-settings\/acme\?microsoft=error&message=.*declined/);
    expect((await go(`${s.origin}/connect/microsoft?state=nope`)).status).toBe(400);
  });
});
