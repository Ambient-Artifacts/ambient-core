// Team settings through the gateway: members read them, owners and admins change them, the
// Microsoft secret never comes back, and transcripts follow the destination (product/sources.md).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

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
    for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((res) => setTimeout(res, 100));
    expect(existsSync(file)).toBe(true);
    expect(execFileSync("git", ["-C", join(s.dataDir, "wiki"), "ls-files", "raw"], { encoding: "utf8" })).toContain("planung-q4-000001.md");
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
});
