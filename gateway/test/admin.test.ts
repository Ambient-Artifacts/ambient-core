// The self-hosted admin CLI: accounts without the apps, AI-app codes, tokens that work over
// MCP, teams on pool servers, members, session rules, team servers.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminError, runAdmin } from "../src/admin.ts";
import { Pairing } from "../src/auth/pairing.ts";
import { loadConfig } from "../src/config.ts";
import { loginPage } from "../src/oauth/pages.ts";
import { mcpClient, startStack, text, type Stack } from "./helpers.ts";
import { CodeHasher } from "../src/auth/codes.ts";

let s: Stack;
const admin = (...args: string[]) => runAdmin(args, { config: s.config, control: s.control });
const withToken = (token: string, ...args: string[]) => runAdmin(args, { config: s.config, control: s.control, readSecret: async () => token });
const bare = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), "ambient-admin-")), `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
  return `file://${dir}`;
};
const branches = (url: string) => execFileSync("git", ["-C", url.slice("file://".length), "branch", "--list"], { encoding: "utf8" });

beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

describe("admin CLI", () => {
  it("creates a local account once, renames it, refuses a non-email", async () => {
    expect(await admin("user", "add", "Ada@Example.com", "--name", "Ada Lovelace", "--upkeep")).toMatch(/^Created Ada Lovelace <ada@example.com> \(.+\), Claude upkeep on\.$/);
    expect(await admin("user", "add", "ada@example.com", "--name", "Ada King")).toMatch(/^Updated Ada King <ada@example.com>/);
    await expect(admin("user", "add", "not-an-email")).rejects.toThrow(AdminError);
    const list = await admin("list");
    expect(list).toMatch(/Ada King <ada@example.com>\s+local, upkeep/);
    expect(list).toMatch(/pool-1\s+http:\/\/127\.0\.0\.1:\d+\s+free/);
  });

  it("gives a code an AI app's sign-in page takes once", async () => {
    const out = await admin("connect-code", "ada@example.com");
    const code = /: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out)?.[1];
    expect(code).toBeDefined();
    expect(out).toContain(`${s.origin}/mcp`);
    const pairing = new Pairing(s.control, new CodeHasher(s.config.masterKey));
    expect(await pairing.consume(code!)).toMatch(/.+/);
    expect(await pairing.consume(code!)).toBeNull();
    await expect(admin("connect-code", "nobody@example.com")).rejects.toThrow(/No account for nobody@example.com/);
  });

  it("makes a personal token that reads and writes the personal wiki over MCP", async () => {
    const token = (await admin("token", "ada@example.com", "--claude-code")).split("\n")[0]!;
    expect(token).toMatch(/^ambient_pat_/);
    const client = await mcpClient(`${s.origin}/mcp`, token);
    const saved = await client.callTool({ name: "save_note", arguments: { title: "Engine notes", content: "The analytical engine weaves algebraic patterns." } });
    expect(saved.isError ?? false).toBe(false);
    expect(text(await client.callTool({ name: "search", arguments: { query: "analytical engine" } }))).toContain("Engine notes");
    await client.close();
  });

  it("creates a team on the free pool server, adds a member, and team tokens reach it", async () => {
    await expect(admin("team", "create", "Analytical", "--owner", "nobody@example.com")).rejects.toThrow(/No account/);
    const made = await admin("team", "create", "Analytical Engines", "--owner", "ada@example.com");
    expect(made).toContain('Created team "Analytical Engines" (slug analytical-engines) on pool-1');
    expect(made).toContain(`${s.origin}/t/analytical-engines/mcp`);
    // The pool is empty now.
    await expect(admin("team", "create", "Second", "--owner", "ada@example.com")).rejects.toThrow(/No free team server/);

    await admin("user", "add", "charles@example.com", "--name", "Charles Babbage");
    await expect(admin("token", "charles@example.com", "--team", "analytical-engines")).rejects.toThrow(/isn't in a team/);
    expect(await admin("team", "add", "analytical-engines", "charles@example.com")).toBe("Charles Babbage is now in analytical-engines, as member.");
    expect(await admin("team", "add", "analytical-engines", "charles@example.com", "--role", "admin")).toBe("Charles Babbage is still in analytical-engines, as admin.");
    await expect(admin("team", "add", "analytical-engines", "charles@example.com", "--role", "boss")).rejects.toThrow(/--role/);

    const token = (await admin("token", "charles@example.com", "--team", "analytical-engines")).split("\n")[0]!;
    const client = await mcpClient(`${s.origin}/t/analytical-engines/mcp`, token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("search");
    expect((await client.callTool({ name: "search", arguments: { query: "anything" } })).isError ?? false).toBe(false);
    await client.close();
    expect(await admin("list")).toMatch(/analytical-engines\s+Analytical Engines\s+active, 2 member\(s\)/);
  });

  it("maps a folder's work sessions to a team", async () => {
    await expect(admin("share", "charles@example.com", "~/git/engines-*", "acme")).rejects.toThrow(/isn't in a team "acme"/);
    expect(await admin("share", "charles@example.com", "~/git/engines-*", "analytical-engines")).toContain("~/git/engines-* → analytical-engines");
    const uid = /\((.+)\)/.exec(await admin("user", "add", "charles@example.com"))![1]!;
    expect(await s.t.query(s.api.sessions.rules, { secret: s.config.serviceSecret, uid: uid as never })).toEqual([{ match: "~/git/engines-*", team: "analytical-engines" }]);
  });

  it("registers team servers idempotently and gives computer setup codes with this server's URL", async () => {
    expect(await admin("server", "add", "pool-2", "http://team-2:8090/")).toBe("Added team server pool-2 at http://team-2:8090 (free).");
    expect(await admin("server", "add", "pool-2", "http://team-2:8090")).toBe("Updated team server pool-2 at http://team-2:8090 (free).");
    await expect(admin("server", "add", "pool-3", "team-3")).rejects.toThrow(/isn't a URL/);
    const out = await admin("computer-code", "ada@example.com", "--name", "Build box");
    expect(out).toContain(`curl -fsSL ${s.origin}/runner/ambient-runner.mjs -o ambient-runner.mjs`);
    expect(out).toMatch(/sudo node ambient-runner\.mjs setup [A-Z2-9]{4}-[A-Z2-9]{4}/);
  });

  it("takes people out of a team, but never its last owner", async () => {
    await admin("user", "add", "mary@example.com", "--name", "Mary Somerville");
    await admin("team", "add", "analytical-engines", "mary@example.com");
    expect(await admin("team", "remove", "analytical-engines", "mary@example.com")).toBe("Mary Somerville is out of analytical-engines.");
    expect(await admin("team", "remove", "analytical-engines", "mary@example.com")).toBe("Mary Somerville wasn't in analytical-engines.");
    await expect(admin("team", "remove", "analytical-engines", "ada@example.com")).rejects.toThrow(/only owner/);
    await expect(admin("team", "remove", "no-such-team", "ada@example.com")).rejects.toThrow(/No team/);
  });

  it("connects a personal wiki and a team wiki to their own repos, with the token from stdin", async () => {
    const personal = bare("ada-wiki");
    await expect(admin("repo", "ada@example.com", personal)).rejects.toThrow(/Pipe the repo's access token in on stdin/);
    expect(await withToken("t0ken\n", "repo", "ada@example.com", personal)).toMatch(/^Ada King's personal wiki is connected to file:\/\/.+ada-wiki\.git \(main\)/);
    expect(branches(personal)).toContain("main");

    const team = bare("acme-wiki");
    expect(await withToken("t0ken", "team", "repo", "acme", team)).toBe(`The acme team wiki is connected to ${team}. Every change is pushed there.`);
    expect(branches(team)).toContain("main");
    await expect(withToken("t0ken", "team", "repo", "nope", team)).rejects.toThrow(/No active team "nope"/);
  });

  it("tells people where their sign-in code comes from: the app, the admin, or either", () => {
    const page = (codes?: "app" | "admin" | "both") => loginPage({ uid: "u1", clientName: "Claude", redirectHost: "claude.ai", codes });
    expect(page("admin")).toContain("<b>admin connect-code</b>");
    expect(page("admin")).not.toContain("Settings → Connect an AI app");
    expect(page()).toContain("Settings → Connect an AI app");
    expect(page()).not.toContain("whoever runs this server");
    expect(page("both")).toContain("Settings → Connect an AI app");
    expect(page("both")).toContain("No Ambient app? Ask whoever runs this server for a code.");
  });

  it("refuses a flag without its value instead of guessing", async () => {
    await expect(admin("token", "ada@example.com", "--team")).rejects.toThrow(/--team needs a value/);
    await expect(admin("user", "add", "ada@example.com", "--name", "--upkeep")).rejects.toThrow(/--name needs a value/);
  });

  it("reads app sign-in settings: Apple's bundle ids, \"none\" for no Apple, and admin codes", async () => {
    const env = { BRAIN_ORIGIN: "https://ambient.example.com", BRAIN_SIGNING_JWKS: JSON.stringify({ keys: s.config.signingKeys }), BRAIN_COOKIE_KEYS: "c", BRAIN_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), BRAIN_SERVICE_SECRET: "x".repeat(32), CONVEX_URL: "http://convex:3210" };
    expect(loadConfig({ ...env }).appleAudiences).toEqual([]);
    expect(loadConfig({ ...env, BRAIN_APPLE_AUDIENCES: "si.ambientartifacts.brain" }).appleAudiences).toEqual(["si.ambientartifacts.brain"]);
    expect(loadConfig({ ...env, BRAIN_APPLE_AUDIENCES: "none" }).appleAudiences).toEqual([]);
    expect(loadConfig({ ...env, BRAIN_ADMIN_CODES: "true" }).adminCodes).toBe(true);
    expect(loadConfig({ ...env }).adminCodes).toBe(false);
  });

  it("explains itself", async () => {
    expect(await admin()).toContain("Usage: admin <command>");
    await expect(admin("frobnicate")).rejects.toThrow(/Unknown command "frobnicate"/);
  });
});
