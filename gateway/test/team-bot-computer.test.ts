// A team's bot needs a computer for the team's bots, as a bot of one's own needs one of one's
// computers: without it the bot would sit there asleep, and writing to it would fail (Nikolai's
// Bloggy, 2026-11-20). And switching a bot on before it ever ran doesn't post its first run twice.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIRST_RUN } from "../src/routines/service.ts";
import { appCall, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const needed = { every: "needed", time: "09:00", timezone: "Europe/Vienna" };

let s: Stack;
let lena: AppSession;
let slug: string;

const call = (method: string, path: string, body?: unknown) => appCall(s, lena.access_token, method, path, body);

beforeAll(async () => {
  s = await startStack({});
  lena = await signIn(s, "apple-lena-teamcomputer", "Lena Vogel");
  slug = ((await call("POST", "/v1/app/teams", { name: "Lab" })).json.team as { slug: string }).slug;
});
afterAll(() => s.close());

describe("a team's bot", () => {
  it("is refused while the team has no computer for its bots, saying how to get one", async () => {
    // A code waiting for setup isn't a computer yet.
    expect((await call("POST", "/v1/app/computers", { name: "Lab server", team: slug })).status).toBe(200);
    const made = await call("POST", "/v1/app/routines", { name: "Bloggy", prompt: "Write the blog.", schedule: needed, team: slug, bot: {} });
    expect(made.status).toBe(400);
    expect(made.json).toMatchObject({ error: "team_needs_computer" });
    expect(String(made.json.message)).toContain("team's page");
  });

  it("is made once the team has one, and switched off and on before its first run it doesn't ask twice", async () => {
    await s.t.run(async (ctx) => {
      const team = (await ctx.db.query("teams").collect()).find((t) => t.slug === slug)!;
      await ctx.db.insert("routineHosts", { teamId: team._id, name: "Lab server", tokenHash: "h1:lab", createdAt: Date.now() });
    });
    const made = await call("POST", "/v1/app/routines", { name: "Bloggy", prompt: "Write the blog.", schedule: needed, team: slug, bot: {} });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = (made.json.routine as { id: string }).id;
    expect((await call("PATCH", `/v1/app/routines/${id}`, { enabled: false })).status).toBe(200);
    expect((await call("PATCH", `/v1/app/routines/${id}`, { enabled: true })).status).toBe(200);
    const thread = (await call("GET", `/v1/app/routines/${id}/thread`)).json as { messages: { author: string; text: string }[] };
    expect(thread.messages.filter((m) => m.text === FIRST_RUN)).toHaveLength(1);
  });
});
