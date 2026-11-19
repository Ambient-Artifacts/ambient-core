// Wake-ups (docs/bots.md, "Wake-ups"): a bot books times for itself; at its time the note goes
// into its thread and a run starts with it. A bot without a schedule starts right after it's made.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIRST_RUN } from "../src/routines/service.ts";
import { appCall, INVITE, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const needed = { every: "needed", time: "09:00", timezone: "Europe/Vienna" };
const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-wakes", os: "Linux 6.8", runner: "0.14.0", claude: "2.1.326 (Claude Code)" };

let s: Stack;
let lena: AppSession;
let host: string;
let botId: string;

type R = { id: string; runRequested: boolean; nextRunAt: number | null; scheduleText: string };
type W = { id: string; at: number; when: string; note: string; byBot: boolean };

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};

/** A local "YYYY-MM-DD HH:MM" in Vienna, `hours` from now (whole minutes). */
const vienna = (hours: number) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(Date.now() + hours * 3_600_000))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

const routine = async () => ((await appCall(s, lena.access_token, "GET", "/v1/app/routines")).json.routines as R[]).find((r) => r.id === botId)!;

const startRun = async () => {
  const start = await hostCall(host, "POST", `/v1/host/routines/${botId}/runs`);
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  return { token: String(start.json.runToken), runId: (start.json.run as { id: string }).id, json: start.json };
};
const finish = (runId: string) => hostCall(host, "POST", `/v1/host/runs/${runId}`, { status: "succeeded", summary: "Planned the week." });

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] } });
  lena = await signIn(s, "apple-lena-wakes", "Lena Vogel");
  s.config.bots!.users.push(lena.user.uid);
  await appCall(s, lena.access_token, "POST", "/v1/app/teams/join", { code: INVITE });
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
});
afterAll(() => s.close());

describe("a bot without a schedule", () => {
  it("starts right after it's made, with no timer on its computer", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Linki", prompt: "Post on LinkedIn every Thursday; drafts reviewed by Lena first.", schedule: needed, bot: {} });
    const r = made.json.routine as R;
    botId = r.id;
    expect(r).toMatchObject({ scheduleText: "When it needs to", runRequested: true, nextRunAt: null });
    const sync = await hostCall(host, "POST", "/v1/host/sync", { info });
    expect(sync.json.routines).toMatchObject([{ id: botId, onCalendar: "", runRequested: true }]);
    const thread = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${botId}/thread`)).json as { messages: { author: string; text: string }[] };
    expect(thread.messages.at(-1)).toMatchObject({ author: "Wake-up", text: FIRST_RUN });
  });

  it("one with a schedule waits for it", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Digest", prompt: "Write the morning digest.", schedule: daily, bot: {} });
    expect((made.json.routine as R).runRequested).toBe(false);
  });
});

describe("wake-ups", () => {
  let first: W;

  it("are booked by a run, with guardrails, and shown as the bot's next run", async () => {
    const { token, runId, json } = await startRun();
    expect((json.resume as { message: string }).message).toMatch(new RegExp(`^Wake-up: Your first run[^]*It.s now .* in Europe/Vienna`));
    expect(JSON.stringify(json)).toContain("You have no wake-ups booked.");
    expect(JSON.stringify(json)).toContain("wake_me");

    expect((await hostCall(token, "POST", "/v1/bot/wakes", { at: vienna(0.05), note: "Too soon." })).json).toMatchObject({ error: "too_soon" });
    expect((await hostCall(token, "POST", "/v1/bot/wakes", { at: vienna(24 * 40), note: "Too far." })).json).toMatchObject({ error: "too_far" });
    expect((await hostCall(token, "POST", "/v1/bot/wakes", { at: "next tuesday", note: "?" })).json).toMatchObject({ error: "bad_time" });

    const booked = await hostCall(token, "POST", "/v1/bot/wakes", { at: vienna(3), note: "Draft post 2 in /home/bot/drafts/post-2.md so Lena can review it before Thursday." });
    expect(booked.status, JSON.stringify(booked.json)).toBe(200);
    first = booked.json.wake as W;
    expect(first.note).toContain("Draft post 2");
    expect(booked.json.booked).toHaveLength(1);

    const close = await hostCall(token, "POST", "/v1/bot/wakes", { at: vienna(3.5), note: "Another." });
    expect(close.json).toMatchObject({ error: "too_close" });
    expect(String(close.json.message)).toContain("Draft post 2");

    await hostCall(token, "POST", "/v1/bot/wakes", { at: vienna(48), note: "Publish post 2 once Lena said yes." });
    const later = ((await hostCall(token, "GET", "/v1/bot/wakes")).json.wakes as W[]).find((w) => w.note.startsWith("Publish"))!;
    expect((await hostCall(token, "DELETE", `/v1/bot/wakes/${later.id}`)).status).toBe(204);
    await finish(runId);

    // The app sees it, and its next run is that wake-up.
    const list = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${botId}/wakes`)).json as { timezone: string; wakes: W[] };
    expect(list).toMatchObject({ timezone: "Europe/Vienna", wakes: [{ id: first.id, byBot: true }] });
    const r = await routine();
    expect(r.nextRunAt).toBe(first.at);
  });

  it("fire at their time: the note in the thread, and a run that starts with it", async () => {
    // Its time comes.
    await s.t.run(async (ctx) => {
      const w = (await ctx.db.query("botWakes").collect()).find((x) => String(x._id) === first.id)!;
      await ctx.db.patch(w._id, { at: Date.now() - 1_000 });
    });
    expect(await s.folders.wakes!.tick()).toBe(1);
    expect(await s.folders.wakes!.tick()).toBe(0);
    const thread = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${botId}/thread`)).json as { messages: { author: string; text: string }[] };
    expect(thread.messages.at(-1)).toMatchObject({ author: "Wake-up", text: first.note });
    expect((await routine()).runRequested).toBe(true);

    const { runId, json } = await startRun();
    expect((json.resume as { message: string }).message).toContain(`Wake-up: ${first.note}`);
    await finish(runId);
    expect(((await appCall(s, lena.access_token, "GET", `/v1/app/routines/${botId}/wakes`)).json as { wakes: W[] }).wakes).toEqual([]);
  });

  it("are booked and cancelled by the owner too, in the app and over MCP", async () => {
    const booked = await appCall(s, lena.access_token, "POST", `/v1/app/routines/${botId}/wakes`, { at: vienna(5), note: "Check the post's numbers." });
    expect(booked.status, JSON.stringify(booked.json)).toBe(200);
    const w = booked.json.wake as W;
    expect(w.byBot).toBe(false);
    expect((await appCall(s, lena.access_token, "DELETE", `/v1/app/routines/${botId}/wakes/${w.id}`)).status).toBe(204);

    const pat = String((await appCall(s, lena.access_token, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const mcp = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await mcp.callTool({ name: "bot_wake_ups", arguments: { id: botId, action: "book", at: vienna(6), note: "Look at the comments." } }))).toContain("Booked for");
    expect(text(await mcp.callTool({ name: "bot_wake_ups", arguments: { id: botId } }))).toContain("Look at the comments.");
  });

  it("go with their bot", async () => {
    expect((await appCall(s, lena.access_token, "DELETE", `/v1/app/routines/${botId}`)).status).toBe(204);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("botWakes").collect()).filter((w) => String(w.routineId) === botId).length)).toBe(0);
  });
});
