// Team settings through the gateway: members read them, owners and admins change them, the
// Microsoft secret never comes back, and transcripts follow the destination (product/sources.md).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, INVITE, mcpClient, signIn, startStack, text, type Stack } from "./helpers.ts";

let s: Stack;
let lena: string;
const note = (id: string) => ({
  schema: "brain.team-note/v1",
  note_id: id,
  team_id: "x",
  recorded_by: "x",
  recorded_at: "2026-10-12T09:00:00+02:00",
  duration_s: 600,
  language: "de-DE",
  kind: "meeting",
  consent: { mode: "all-agreed", confirmed_at: "2026-10-12T09:11:00+02:00" },
  entry_page: { frontmatter: { title: "Planung", summary: "Planung.", people: [], projects: [] }, body_md: "# Planung\n\nWir planen.\n" },
  transcript: { segments: [{ t0: 0, t1: 2, text: "Los geht's.", speaker: "Lena Vogel" }] },
  participants_hint: [],
  client: { app: "1.9 (1)", transcriber: "Parakeet", compiler: "fm-ondevice" },
  meeting: { title: "Planung Q4", attendees: ["Jonas Berg"] },
  speakers: ["Lena Vogel"],
});

beforeAll(async () => {
  s = await startStack();
  lena = (await signIn(s, "apple-lena-team-settings", "Lena Vogel")).access_token;
  await appCall(s, lena, "POST", "/v1/app/teams/join", { code: INVITE });
});
afterAll(() => s.close());

describe("team settings", () => {
  it("members see the defaults: transcripts go to raw/, work logs nowhere", async () => {
    const r = await appCall(s, lena, "GET", "/v1/app/teams/acme/settings");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      settings: { transcripts: { kind: "repo", folder: "raw" }, work: { kind: "none" }, microsoft: null },
      repo_mode: null,
      delivery: { destination: "repo:raw", waiting: 0, failing: false },
    });
  });

  it("only owners and admins change them", async () => {
    const r = await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { transcripts: { kind: "none" } });
    expect(r).toMatchObject({ status: 403, json: { error: "admins_only" } });
  });

  it("a team recording's transcript lands in raw/ of the team repo", async () => {
    const r = await appCall(s, lena, "POST", "/v1/app/teams/acme/notes", note("01JGWSETTINGS0000000000001"));
    expect([200, 201, 202]).toContain(r.status);
    const file = join(s.dataDir, "wiki", "raw", "2026-10", "2026-10-12-planung-q4-000001.md");
    // Delivered after the answer: wait for the commit, not just the file (written a moment before it).
    const committed = () => execFileSync("git", ["-C", join(s.dataDir, "wiki"), "ls-files", "raw"], { encoding: "utf8" });
    for (let i = 0; i < 50 && !committed().includes("planung-q4-000001.md"); i++) await new Promise((res) => setTimeout(res, 100));
    expect(existsSync(file)).toBe(true);
    expect(committed()).toContain("planung-q4-000001.md");
  });

  it("an admin switches transcripts off and gets a message for bad input; unknown fields are dropped", async () => {
    await s.t.run(async (ctx) => {
      for (const m of await ctx.db.query("members").collect()) await ctx.db.patch(m._id, { role: "admin" });
    });
    const off = await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { transcripts: { kind: "none" }, junk: "ignored" });
    expect(off.status).toBe(200);
    expect((off.json.settings as { transcripts: unknown }).transcripts).toEqual({ kind: "none" });
    const bad = await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { transcripts: { kind: "drive", url: "https://x.sharepoint.com/sites/a/b/c" } });
    expect(bad).toMatchObject({ status: 400, json: { error: "settings" } });
    expect(String(bad.json.message)).toContain("Connect Microsoft 365 first");
    expect(readdirSync(s.dataDir)).toContain("settings.json");
  });

  it("an admin leaves out folders and files of the repo that aren't knowledge", async () => {
    const r = await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { ignore: ["./templates/", "CLAUDE.md", "templates"] });
    expect(r.status).toBe(200);
    expect((r.json.settings as { ignore: string[] }).ignore).toEqual(["CLAUDE.md", "templates"]);
    const seen = await appCall(s, lena, "GET", "/v1/app/teams/acme/settings");
    expect((seen.json.settings as { ignore: string[] }).ignore).toEqual(["CLAUDE.md", "templates"]);
    const bad = await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { ignore: ["../secrets"] });
    expect(bad).toMatchObject({ status: 400, json: { error: "settings" } });
    expect((await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { ignore: [] })).status).toBe(200);
  });
});

// Agents first: what the app changes, an AI app can change for its user (product/architecture.md).
describe("settings over MCP", () => {
  it("a personal connection reads them and changes the user's preferences, but not a team's (no team:write)", async () => {
    const pat = String((await appCall(s, lena, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const read = text(await client.callTool({ name: "get_settings", arguments: {} }));
    expect(read).toContain("Your preferences");
    expect(read).toContain("Acme (team \"acme\"");
    expect(read).toContain("- Meeting notes written by: Ambient");
    const off = await client.callTool({ name: "change_preferences", arguments: { morning_digest: false } });
    expect(text(off)).toContain("What's waiting on you, each morning: off");
    expect((await appCall(s, lena, "GET", "/v1/app/me")).json.prefs).toMatchObject({ digest: false });
    const team = await client.callTool({ name: "change_team_settings", arguments: { team: "acme", meeting_notes: "own_pipeline" } });
    expect(team.isError).toBe(true);
    expect(text(team)).toContain("no team:write");
  });

  it("a team connection changes the team's settings, with the app's rules, and not the user's preferences", async () => {
    const pat = String((await appCall(s, lena, "POST", "/v1/app/pats", { label: "Copilot", team: "acme" })).json.token);
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, pat);
    // By name too; meeting notes by the team's own pipeline need transcripts that reach it.
    await appCall(s, lena, "PUT", "/v1/app/teams/acme/settings", { transcripts: { kind: "repo" } });
    const own = await client.callTool({ name: "change_team_settings", arguments: { team: "Acme", meeting_notes: "own_pipeline" } });
    expect(own.isError).toBeFalsy();
    expect(text(own)).toContain("- Meeting notes written by: the team's own pipeline");
    expect((await appCall(s, lena, "GET", "/v1/app/teams/acme/settings")).json.settings).toMatchObject({ notes: { by: "own" } });
    // The server's own rules and sentences come back as they are.
    const nowhere = await client.callTool({ name: "change_team_settings", arguments: { team: "acme", transcripts: "nowhere" } });
    expect(nowhere.isError).toBe(true);
    expect(text(nowhere)).toContain("choose where transcripts go first");
    expect((await client.callTool({ name: "change_team_settings", arguments: { team: "acme", transcripts: "folder" } })).isError).toBe(true);
    const noRepo = await client.callTool({ name: "change_team_settings", arguments: { team: "acme", repo_writes: "one_folder" } });
    expect(noRepo.isError).toBe(true);
    expect(text(noRepo)).toContain("Connect the repo first");
    expect((await client.callTool({ name: "change_team_settings", arguments: { team: "acme" } })).isError).toBe(true);
    await client.callTool({ name: "change_team_settings", arguments: { team: "acme", meeting_notes: "ambient" } });
    // A team connection has no say over the user's own preferences.
    expect((await client.callTool({ name: "change_preferences", arguments: { morning_digest: true } })).isError).toBe(true);
  });

  it("a member who isn't an owner or admin can't change them", async () => {
    const ben = (await signIn(s, "apple-ben-team-settings-mcp", "Ben Koch")).access_token;
    await appCall(s, ben, "POST", "/v1/app/teams/join", { code: INVITE });
    const pat = String((await appCall(s, ben, "POST", "/v1/app/pats", { label: "Copilot", team: "acme" })).json.token);
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, pat);
    const r = await client.callTool({ name: "change_team_settings", arguments: { team: "acme", meeting_notes: "own_pipeline" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Only team owners and admins");
    expect(text(await client.callTool({ name: "get_settings", arguments: {} }))).toContain("you're a member");
  });
});
