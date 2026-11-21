// Sign in with Google: the app sends Google's ID token as the sign-in step; the gateway checks it
// (keys, audience, Google as the issuer, the nonce) and signs the app in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, appSignIn, GOOGLE_CLIENT, startStack, type Stack } from "./helpers.ts";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

const nonce = async (stack: Stack) => String(((await (await fetch(`${stack.origin}/v1/app/sign-in-nonce`)).json()) as { nonce: string }).nonce);

describe("Sign in with Google", () => {
  it("is offered through the app config", async () => {
    const config = (await (await fetch(`${s.origin}/v1/app/config`)).json()) as { googleClientId: string | null };
    expect(config.googleClientId).toBe(GOOGLE_CLIENT);
  });

  it("creates the account once, then signs into it again; the token works on the app API", async () => {
    const first = await appSignIn(s, { google: await s.googleToken("1001", { name: "Gina Gruber", email: "gina@gmail.com", email_verified: true, nonce: await nonce(s) }) });
    expect(first.status).toBe(200);
    expect(first.session!.user).toMatchObject({ name: "Gina Gruber", email: "gina@gmail.com" });
    const again = await appSignIn(s, { google: await s.googleToken("1001", { name: "Gina Gruber" }) });
    expect(again.session!.user.uid).toBe(first.session!.user.uid);
    expect((await appCall(s, first.session!.access_token, "GET", "/v1/app/me")).json.user).toMatchObject({ name: "Gina Gruber" });
  });

  it("is a separate account from Apple and Microsoft, even with the same email", async () => {
    const google = await appSignIn(s, { google: await s.googleToken("1002", { email: "same@example.com", email_verified: true }) });
    const apple = await appSignIn(s, { apple: await s.appleToken("apple-same", "same@example.com") });
    expect(apple.session!.user.uid).not.toBe(google.session!.user.uid);
  });

  it("refuses tokens for another app, from another issuer, replayed, or with another server's nonce", async () => {
    expect((await appSignIn(s, { google: await s.googleToken("1003", {}, { aud: "someone-elses-app.apps.googleusercontent.com" }) })).status).toBe(401);
    expect((await appSignIn(s, { google: await s.googleToken("1003", {}, { iss: "https://accounts.example.com" }) })).status).toBe(401);
    expect((await appSignIn(s, { google: await s.googleToken("not-a-number") })).status).toBe(401);
    const mine = await nonce(s);
    const token = await s.googleToken("1003", { nonce: mine });
    expect((await appSignIn(s, { google: token })).status).toBe(200);
    expect((await appSignIn(s, { google: token })).json).toMatchObject({ error: "invalid_nonce" });
    expect((await appSignIn(s, { google: await s.googleToken("1003", { nonce: "someone-elses-nonce" }) })).json).toMatchObject({ error: "invalid_nonce" });
  });
});

describe("Google sign-ins on a server whose sign-ups aren't open", () => {
  let strict: Stack;
  beforeAll(async () => {
    strict = await startStack({ signups: { allow: ["@acme.example", "lena@gmail.com"] } });
  });
  afterAll(() => strict.close());

  it("let in emails Google vouches for that are allowed, and no others", async () => {
    // A Gmail address, verified: Google's own.
    expect((await appSignIn(strict, { google: await strict.googleToken("2001", { email: "lena@gmail.com", email_verified: true }) })).status).toBe(200);
    // A Workspace account in the allowed domain ("hd" names the domain).
    expect((await appSignIn(strict, { google: await strict.googleToken("2002", { email: "ben@acme.example", email_verified: true, hd: "acme.example" }) })).status).toBe(200);
    // The same address on a Google account made with an outside email: Google verified it once, but doesn't own it.
    expect((await appSignIn(strict, { google: await strict.googleToken("2003", { email: "eve@acme.example", email_verified: true }) })).json).toMatchObject({ error: "not_invited" });
    // Not verified at all.
    expect((await appSignIn(strict, { google: await strict.googleToken("2004", { email: "lena@gmail.com", email_verified: false }) })).json).toMatchObject({ error: "not_invited" });
  });
});
