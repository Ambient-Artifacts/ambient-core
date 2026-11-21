// The Bots list's search (GET /v1/app/bots/search): words across the person's chat with Ambient and
// the threads of the bots they see, newest first, each hit saying which bot (null: Ambient's chat)
// and which message, so the app opens it there. Someone else's bots aren't searched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const info = { hostname: "srv-search", os: "Linux 6.8", runner: "0.15.0", claude: "2.1.330 (Claude Code)" };
const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };

type Hit = { at: number; who: string; where: string; text: string; botId?: string | null; messageId?: string };

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let bot = "";

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const search = async (who: AppSession, q: string) => {
  const r = await appCall(s, who.access_token, "GET", `/v1/app/bots/search?q=${encodeURIComponent(q)}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.hits as Hit[];
};

beforeAll(async () => {
  s = await startStack({});
  lena = await signIn(s, "apple-lena-search", "Lena Vogel");
  ben = await signIn(s, "apple-ben-search", "Ben Weiss");
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "Lena's server" })).json.code);
  const host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
  bot = ((await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Fixer", prompt: "Fix bugs.", schedule: daily, bot: { isolation: "host" } })).json.routine as { id: string }).id;
  await appCall(s, lena.access_token, "POST", `/v1/app/routines/${bot}/thread`, { text: "Can you look at the login bug?" });
  const start = await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`);
  await hostCall(host, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Found it: the retry never resets." });
  await s.ambient.say(lena.user.uid, "Bloggy published the half-marathon post.");
});
afterAll(() => s.close());

describe("searching the bots", () => {
  it("finds words in a bot's thread, with the bot and the message to open (not its handoff)", async () => {
    const hits = await search(lena, "retry resets");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ who: "Fixer", where: "Fixer's thread", botId: bot, text: "Found it: the retry never resets." });
    const thread = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${bot}/thread?seen=0`)).json as { messages: { id: string; text: string }[] };
    expect(thread.messages.find((m) => m.id === hits[0]!.messageId)?.text).toBe("Found it: the retry never resets.");
  });

  it("finds words in the chat with Ambient (no bot), what the person wrote too, accents and case aside", async () => {
    expect((await search(lena, "HALF-marathon"))[0]).toMatchObject({ where: "chat", who: "Ambient", botId: null });
    expect((await search(lena, "login"))[0]).toMatchObject({ botId: bot, who: "Lena Vogel" });
  });

  it("doesn't search someone else's bots, and an empty query finds nothing", async () => {
    expect(await search(ben, "retry")).toEqual([]);
    expect(await search(lena, "  ")).toEqual([]);
  });
});
