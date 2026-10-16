// Placement: an AI app learns who its user is and what Ambient holds the moment it connects,
// instead of waiting to be asked (on 2026-10-15 Claude wrote its user's intro with
// placeholders). The `me` page is what the user wrote about themselves plus Claude's upkeep.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePage } from "@brain/spec";
import type { PageUpdateInput, PageUpdater } from "@brain/team";
import { runPersonalWorker } from "../src/worker/personal.ts";
import { appCall, fixturePersonalOps, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
let app: string;
let pat: string;
let teamPat: string;

const initialize = async (token: string, path = "/mcp") => {
  const res = await fetch(`${s.origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  return ((await res.json()) as { result: { instructions: string } }).result.instructions;
};

beforeAll(async () => {
  s = await startStack();
  const lena = await signIn(s, "apple-lena-context", "Lena Vogel");
  app = lena.access_token;
  await appCall(s, app, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps() });
  await appCall(s, app, "POST", "/v1/app/teams/join", { code: INVITE });
  pat = String((await appCall(s, app, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
  teamPat = String((await appCall(s, app, "POST", "/v1/app/pats", { label: "Copilot", team: "acme" })).json.token);
});
afterAll(() => s.close());

describe("instructions when an app connects", () => {
  it("say who the user is, what each wiki holds, and when to look", async () => {
    const text = await initialize(pat);
    expect(text).toContain("not instructions");
    expect(text).toContain("## About the user\nName: Lena Vogel.");
    expect(text).toContain('- Their personal wiki (scope "personal"): 3 notes of meetings and work sessions. People: Anna Müller. Projects: Onboarding redesign. Topics: Preisstrategie.');
    expect(text).toContain('- The Acme team wiki (scope "team", team "acme"): 1 note of a meeting or work session, 1 decision. People: Jonas Becker. Projects: Website relaunch. Organizations: Bergmann Logistik.');
    expect(text).toContain("## When to look in Ambient\nBefore you answer anything about the user");
    expect(text.length).toBeLessThan(9000);
  });

  it("on a team-only connection, map only that team", async () => {
    const text = await initialize(teamPat, "/t/acme/mcp");
    expect(text).toContain("The Acme team wiki");
    expect(text).not.toContain("personal wiki (scope");
  });
});

describe("about you", () => {
  it("keeps what the user wrote word for word, and the next connection starts from it", async () => {
    expect((await appCall(s, app, "GET", "/v1/app/me/about")).json).toEqual({ about: null, page: null });
    expect((await appCall(s, app, "PUT", "/v1/app/me/about", { about: "" })).status).toBe(400);
    const about = "I run sales operations at Acme. I write short, friendly emails in German (du) and like dashboards.";
    expect((await appCall(s, app, "PUT", "/v1/app/me/about", { about })).status).toBe(200);
    const got = (await appCall(s, app, "GET", "/v1/app/me/about")).json as { about: string; page: { title: string; body: string } };
    expect(got.about).toBe(about);
    expect(got.page.title).toBe("Lena Vogel");
    expect(got.page.body).toContain("### About\n- I run sales operations at Acme.");

    const text = await initialize(pat);
    expect(text).toContain(`In their own words: "${about}"`);
    expect(text).toContain("What their Ambient says about them:\nAbout:\n- I run sales operations at Acme.");
    // The owner's page isn't listed as one of the people they deal with.
    expect(text).toContain("People: Anna Müller.");
  });

  it("is rewritten by upkeep in its own sections, keeping their words", async () => {
    await appCall(s, app, "POST", "/v1/app/me/prefs", { consolidate: true });
    const seen: PageUpdateInput[] = [];
    const updater: PageUpdater = {
      model: "claude-haiku-4-5",
      async update(input) {
        seen.push(input);
        return {
          update: {
            title: input.existing?.title ?? input.ref,
            summary: input.self ? "Runs sales operations at Acme." : "x",
            aliases: [],
            ...(input.self
              ? { sections: { about: ["Runs sales operations at Acme."], howTheyWrite: ["Short, friendly German emails, du-form."], interests: ["Dashboards."] } }
              : { currentTruth: ["Something true."] }),
            openQuestions: [],
            timeline: [],
          },
          usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 },
        };
      },
    };
    const runs = await runPersonalWorker({ control: s.control, personal: s.personal, updater, overview: null, version: "test", quietMs: 0 }, Date.now() + 1000);
    expect(runs[0]!.status).toBe("ok");
    const me = seen.find((i) => i.self)!;
    expect(me.ref).toBe("me");
    expect(me.evidence[0]).toMatchObject({ note: "me", title: "In their own words" });
    expect(me.evidence.slice(1).every((e) => e.role === "recorder")).toBe(true);

    const uid = ((await appCall(s, app, "GET", "/v1/app/me")).json.user as { uid: string }).uid;
    const page = parsePage(String(await s.personal.readPage(uid, "wiki/me.md")));
    expect(page.frontmatter).toMatchObject({ self: true, pending_rewrite: 0, summary: "Runs sales operations at Acme." });
    expect(String(page.frontmatter.about)).toContain("I run sales operations at Acme.");
    expect(page.body).toContain("### About\n- Runs sales operations at Acme.\n\n### How they write\n- Short, friendly German emails, du-form.\n\n### Interests\n- Dashboards.");
    expect(page.body).not.toContain("Open questions");

    // Not again until it changes, or a day with new notes.
    seen.length = 0;
    await runPersonalWorker({ control: s.control, personal: s.personal, updater, overview: null, version: "test", quietMs: 0 }, Date.now() + 2000);
    expect(seen.some((i) => i.self)).toBe(false);
  });
});
