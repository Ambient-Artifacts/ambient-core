// Sign in with Microsoft: the app sends Microsoft's ID token as the sign-in step; the gateway
// checks it (keys, audience, the issuer of the token's own tenant, the nonce) and signs the app in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, appSignIn, MICROSOFT_CLIENT, startStack, type Stack } from "./helpers.ts";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const PERSONAL = "9188040d-6c67-4c5b-b112-36a304b66dad";  // personal Microsoft accounts' tenant

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

async function signIn(body: { idToken: string; nonce?: string }) {
  const r = await appSignIn(s, { microsoft: body.idToken, nonce: body.nonce });
  return { status: r.status, session: r.session };
}

describe("Sign in with Microsoft", () => {
  it("is offered through the app config", async () => {
    const config = (await (await fetch(`${s.origin}/v1/app/config`)).json()) as { microsoftClientId: string | null };
    expect(config.microsoftClientId).toBe(MICROSOFT_CLIENT);
  });

  it("creates the account once, then signs into it again; the token works on the app API", async () => {
    const token = await s.microsoftToken(TENANT, "oid-lena", { name: "Lena Vogel", email: "lena@acme.example", nonce: "n0nce-123" });
    const first = await signIn({ idToken: token, nonce: "n0nce-123" });
    expect(first.status).toBe(200);
    expect(first.session!.user).toMatchObject({ name: "Lena Vogel", email: "lena@acme.example" });
    const again = await signIn({ idToken: await s.microsoftToken(TENANT, "oid-lena", { name: "Lena Vogel" }) });
    expect(again.session!.user.uid).toBe(first.session!.user.uid);
    expect((await appCall(s, first.session!.access_token, "GET", "/v1/app/me")).json.user).toMatchObject({ name: "Lena Vogel" });
  });

  it("keeps people in different tenants apart, and personal accounts too", async () => {
    const work = await signIn({ idToken: await s.microsoftToken(TENANT, "same-oid") });
    const personal = await signIn({ idToken: await s.microsoftToken(PERSONAL, "same-oid") });
    expect(work.session!.user.uid).not.toBe(personal.session!.user.uid);
  });

  it("is a separate account from Sign in with Apple, even with the same email", async () => {
    const ms = await signIn({ idToken: await s.microsoftToken(TENANT, "oid-ben", { email: "apple-ben@example.com" }) });
    const apple = await appSignIn(s, { apple: await s.appleToken("apple-ben", "apple-ben@example.com") });
    expect(apple.session!.user.uid).not.toBe(ms.session!.user.uid);
  });

  it("refuses tokens for another app, from another tenant's issuer, or with a different nonce", async () => {
    expect((await signIn({ idToken: await s.microsoftToken(TENANT, "x", {}, { aud: "someone-elses-app" }) })).status).toBe(401);
    expect((await signIn({ idToken: await s.microsoftToken(TENANT, "x", {}, { iss: `https://login.microsoftonline.com/${PERSONAL}/v2.0` }) })).status).toBe(401);
    expect((await signIn({ idToken: await s.microsoftToken(TENANT, "x", { nonce: "nonce-one-1" }), nonce: "nonce-other-2" })).status).toBe(401);
    expect((await signIn({ idToken: "nope" })).status).toBe(400);
  });
});
