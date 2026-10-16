// Sign-ups on a self-hosted server (BRAIN_SIGNUPS): the apps make new accounts only for people the
// admin added (matched by the email Apple confirms) or whose email is on the allow list.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAdmin } from "../src/admin.ts";
import { parseSignups } from "../src/config.ts";
import { appSignIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
const admin = (...args: string[]) => runAdmin(args, { config: s.config, control: s.control });
/** An Apple identity token whose email Apple confirmed, as it is for most sign-ins. */
const apple = (sub: string, email?: string, claims: Record<string, unknown> = {}) => s.appleToken(sub, email, { email_verified: "true", ...claims });
const message = (r: { json?: unknown }) => (r.json as { message?: string }).message ?? "";

beforeAll(async () => {
  s = await startStack({ signups: { allow: ["@acme.example"] } });
});
afterAll(() => s.close());

describe("sign-ups that aren't open", () => {
  it("reads BRAIN_SIGNUPS: open by default, none, or emails and domains", () => {
    expect(parseSignups(undefined)).toBeUndefined();
    expect(parseSignups("open")).toBeUndefined();
    expect(parseSignups("none")).toEqual({ allow: [] });
    expect(parseSignups(" acme.example , Anna@Example.com ,@b.example")).toEqual({ allow: ["@acme.example", "anna@example.com", "@b.example"] });
  });

  it("refuses a stranger with a sentence the app shows", async () => {
    const r = await appSignIn(s, { apple: await apple("apple-eve", "eve@example.com") });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "not_invited", message: "This server only lets in people its admin added. Ask them to add eve@example.com." });
  });

  it("lets in someone who hides their email once the admin adds Apple's relay address", async () => {
    const relay = "x7k2@privaterelay.appleid.com";
    const token = async () => apple("apple-hidden", relay, { is_private_email: "true" });
    const refused = await appSignIn(s, { apple: await token() });
    expect(refused.status).toBe(403);
    expect(message(refused)).toBe(`This server only lets in people its admin added. Ask them to add ${relay}.`);
    await admin("user", "add", relay, "--name", "Kim");
    expect((await appSignIn(s, { apple: await token() })).status).toBe(200);
  });

  it("lets in someone the admin added, by the email Apple confirms, and only that Apple account", async () => {
    await admin("user", "add", "anna@example.com");
    expect((await appSignIn(s, { apple: await s.appleToken("apple-anna", "anna@example.com", { email_verified: false }) })).status).toBe(403);
    const first = await appSignIn(s, { apple: await apple("apple-anna", "Anna@Example.com"), name: "Anna Müller" });
    expect(first.status).toBe(200);
    // Apple's name replaces the one `user add` made from the email.
    expect(await admin("list")).toMatch(/Anna Müller <anna@example.com>\s+apple/);
    // From now on the account is found by Apple's id, whatever email comes with it.
    expect((await appSignIn(s, { apple: await s.appleToken("apple-anna") })).status).toBe(200);
    // Another Apple account with the same email gets neither this account nor a new one.
    expect((await appSignIn(s, { apple: await apple("apple-impostor", "anna@example.com") })).status).toBe(403);
    expect((await admin("list")).match(/anna@example.com/g)).toHaveLength(1);
  });

  it("makes accounts for emails on the allow list", async () => {
    const r = await appSignIn(s, { apple: await apple("apple-bob", "bob@acme.example"), name: "Bob Weber" });
    expect(r.status).toBe(200);
    expect(await admin("list")).toMatch(/Bob Weber <bob@acme.example>\s+apple/);
  });

  it("makes no new Microsoft accounts, whose emails nobody vouches for", async () => {
    const token = await s.microsoftToken("00000000-0000-4000-8000-0000000000aa", "oid-carol", { email: "carol@acme.example", nonce: "n0nce-carol" });
    const r = await appSignIn(s, { microsoft: token, nonce: "n0nce-carol" });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "not_invited", message: "This server only lets in people its admin added. Ask them to add you." });
  });
});
