// The apps' sign-in through our OAuth server: the authorization request without a browser,
// Sign in with Apple as the sign-in step, the code traded for DPoP-bound tokens, refresh,
// sign-out; and what nobody else gets: AI apps can't reach the app API, the apps can't use
// the pairing code or MCP, and a token is useless without its key.
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CLIENT_ID, APP_REDIRECT_URI } from "../src/oauth/provider.ts";
import {
  appCall,
  appRefresh,
  appSignIn,
  CookieJar,
  dpopKey,
  dpopProof,
  get,
  pkce,
  signIn,
  startStack,
  tokenRequest,
  type Stack,
} from "./helpers.ts";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

describe("signing in", () => {
  it("creates a user from an Apple token, and the same Apple account signs into it again", async () => {
    const lena = await signIn(s, "apple-lena", "Lena Vogel");
    expect(lena.user.name).toBe("Lena Vogel");
    expect(await appCall(s, lena.access_token, "GET", "/v1/app/me")).toMatchObject({ status: 200, json: { user: { name: "Lena Vogel" }, teams: [] } });
    const again = await signIn(s, "apple-lena", "Ignored Name");
    expect(again.user.uid).toBe(lena.user.uid);

    // An app-API token: bound to the app's key, for the app API only, an hour.
    const claims = decodeJwt(lena.access_token);
    expect(claims).toMatchObject({ aud: `${s.origin}/v1/app`, client_id: APP_CLIENT_ID, scope: "app", sub: lena.user.uid });
    expect((claims.cnf as { jkt?: string }).jkt).toBeTruthy();
    expect(claims.exp! - claims.iat!).toBe(3600);
  });

  it("refuses a forged Apple token, and the old sign-in endpoints are gone", async () => {
    const forged = await appSignIn(s, { apple: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.forged-signature" });
    expect(forged).toMatchObject({ status: 401, step: "sign-in" });
    for (const path of ["/v1/app/auth/apple", "/v1/app/auth/refresh"]) {
      expect((await fetch(`${s.origin}${path}`, { method: "POST" })).status).toBe(404);
    }
  });

  it("needs a DPoP proof for the code", async () => {
    const jar = new CookieJar();
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ client_id: APP_CLIENT_ID, response_type: "code", redirect_uri: APP_REDIRECT_URI, scope: "app", code_challenge: challenge, code_challenge_method: "S256" });
    const start = await get(`${s.origin}/oauth/authorize?${q}`, jar);
    const step = await fetch(`${s.origin}${start.headers.get("location")}/apple`, {
      method: "POST",
      headers: { cookie: jar.header(), "content-type": "application/json" },
      body: JSON.stringify({ identityToken: await s.appleToken("apple-nokey") }),
    });
    jar.store(step);
    const code = new URL((await get(((await step.json()) as { next: string }).next, jar)).headers.get("location")!).searchParams.get("code")!;
    const res = await fetch(`${s.origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: APP_CLIENT_ID, grant_type: "authorization_code", code, redirect_uri: APP_REDIRECT_URI, code_verifier: verifier }),
    });
    expect(res.status).toBe(400);
  });
});

describe("the app's tokens", () => {
  it("work only with their key, on the address and method they were signed for", async () => {
    const ben = await signIn(s, "apple-ben", "Ben Fischer");
    const me = `${s.origin}/v1/app/me`;
    const call = (headers: Record<string, string>, method = "GET") => fetch(me, { method, headers }).then((r) => r.status);
    expect(await call({ authorization: `DPoP ${ben.access_token}`, dpop: await dpopProof(ben.key, "GET", me, ben.access_token) })).toBe(200);
    // No proof, or sent as a plain bearer token.
    expect(await call({ authorization: `DPoP ${ben.access_token}` })).toBe(401);
    expect(await call({ authorization: `Bearer ${ben.access_token}` })).toBe(401);
    // Someone else's key, another address, another method, another token's hash.
    expect(await call({ authorization: `DPoP ${ben.access_token}`, dpop: await dpopProof(await dpopKey(), "GET", me, ben.access_token) })).toBe(401);
    expect(await call({ authorization: `DPoP ${ben.access_token}`, dpop: await dpopProof(ben.key, "GET", `${s.origin}/v1/app/teams`, ben.access_token) })).toBe(401);
    expect(await call({ authorization: `DPoP ${ben.access_token}`, dpop: await dpopProof(ben.key, "DELETE", me, ben.access_token) })).toBe(401);
    expect(await call({ authorization: `DPoP ${ben.access_token}`, dpop: await dpopProof(ben.key, "GET", me, "another-token") })).toBe(401);
  });

  it("refresh with the same refresh token, again after a lost answer, but not with another key", async () => {
    const mia = await signIn(s, "apple-mia", "Mia Roth");
    const first = await appRefresh(s, mia);
    expect(first.status).toBe(200);
    expect(first.json.token_type).toBe("DPoP");
    // The refresh token isn't replaced: an answer lost on the way costs nothing.
    expect(first.json.refresh_token).toBe(mia.refresh_token);
    const second = await appRefresh(s, mia);
    expect(second.status).toBe(200);
    expect((await appCall(s, second.json.access_token!, "GET", "/v1/app/me")).status).toBe(200);
    // A stolen refresh token without the device's key gets nothing.
    expect((await tokenRequest(s, await dpopKey(), { grant_type: "refresh_token", refresh_token: mia.refresh_token })).status).toBe(400);
  });

  it("stop refreshing after sign-out, which ends the whole sign-in", async () => {
    const ida = await signIn(s, "apple-ida", "Ida Lang");
    const revoke = await fetch(`${s.origin}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: APP_CLIENT_ID, token: ida.refresh_token, token_type_hint: "refresh_token" }),
    });
    expect(revoke.status).toBe(200);
    expect((await appRefresh(s, ida)).status).toBe(400);
  });

  it("stop working when the account is deleted", async () => {
    const tom = await signIn(s, "apple-tom", "Tom Weber");
    expect((await appCall(s, tom.access_token, "DELETE", "/v1/app/me", {})).status).toBe(200);
    expect((await appCall(s, tom.access_token, "GET", "/v1/app/me")).status).toBe(401);
    expect((await appRefresh(s, tom)).status).toBe(400);
  });
});

describe("keeping the apps and AI apps apart", () => {
  async function registerAiApp() {
    const res = await fetch(`${s.origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Some AI app", redirect_uris: ["http://127.0.0.1:9/cb"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    return ((await res.json()) as { client_id: string }).client_id;
  }

  const authorize = (clientId: string, redirect: string, resource: string, scope: string) =>
    `${s.origin}/oauth/authorize?${new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirect, scope, resource, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "x" })}`;

  it("an AI app can't ask for the app API", async () => {
    const clientId = await registerAiApp();
    const res = await get(authorize(clientId, "http://127.0.0.1:9/cb", `${s.origin}/v1/app`, "app"), new CookieJar());
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("an AI app can't use the Apple step, and the app can't use the pairing-code page", async () => {
    const jar = new CookieJar();
    const ai = await get(authorize(await registerAiApp(), "http://127.0.0.1:9/cb", `${s.origin}/mcp`, "personal:read"), jar);
    const step = await fetch(`${s.origin}${ai.headers.get("location")}/apple`, {
      method: "POST",
      headers: { cookie: jar.header(), "content-type": "application/json" },
      body: JSON.stringify({ identityToken: await s.appleToken("apple-lena") }),
    });
    expect(step.status).toBe(400);

    const appJar = new CookieJar();
    const app = await get(authorize(APP_CLIENT_ID, APP_REDIRECT_URI, `${s.origin}/v1/app`, "app"), appJar);
    expect((await get(`${s.origin}${app.headers.get("location")}`, appJar)).status).toBe(400);
  });

  it("the app can't ask for MCP", async () => {
    const res = await get(authorize(APP_CLIENT_ID, APP_REDIRECT_URI, `${s.origin}/mcp`, "personal:read"), new CookieJar());
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});
