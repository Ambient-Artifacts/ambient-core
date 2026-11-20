// Unread, as in Messages (the Bots list's dots): a bot said something since the person last opened
// its thread, or Ambient wrote since they last opened its chat. Opening reads it; a fetch ahead
// (`?seen=0`, the app's prefetch) doesn't. Reading moves the revision, so other devices follow.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const info = { hostname: "srv-unread", os: "Linux 6.8", runner: "0.15.0", claude: "2.1.330 (Claude Code)" };
const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };

let s: Stack;
let lena: AppSession;
let host = "";

const call = (method: string, path: string, body?: unknown) => appCall(s, lena.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const unread = async (id: string) => ((await call("GET", "/v1/app/routines")).json.routines as { id: string; bot: { unread: boolean } }[]).find((r) => r.id === id)!.bot.unread;
const revision = async () => ((await call("GET", "/v1/app/revisions")).json.revisions as { routines: string }).routines;

beforeAll(async () => {
  s = await startStack({});
  lena = await signIn(s, "apple-lena-unread", "Lena Vogel");
  const code = String((await call("POST", "/v1/app/computers", { name: "Lena's server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
});
afterAll(() => s.close());

describe("a bot", () => {
  it("is unread once it said something, stays so for a fetch ahead, and is read once opened", async () => {
    const id = ((await call("POST", "/v1/app/routines", { name: "Digest", prompt: "Write the digest.", schedule: daily, bot: { isolation: "host" } })).json.routine as { id: string }).id;
    expect(await unread(id)).toBe(false);
    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    await hostCall(host, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Here's today's digest." });
    expect(await unread(id)).toBe(true);
    expect((await call("GET", `/v1/app/routines/${id}/thread?seen=0`)).status).toBe(200);
    expect(await unread(id)).toBe(true);
    const before = await revision();
    const opened = (await call("GET", `/v1/app/routines/${id}/thread`)).json as { routine: { bot: { unread: boolean } } };
    expect(opened.routine.bot.unread).toBe(false);
    expect(await unread(id)).toBe(false);
    expect(await revision()).not.toBe(before);
  });
});

describe("Ambient's chat", () => {
  it("is unread once Ambient wrote, stays so for a fetch ahead, and is read once opened", async () => {
    expect((await call("GET", "/v1/app/ambient/summary")).json).toEqual({ unread: false, last: null });
    const before = await revision();
    await s.ambient.say(lena.user.uid, "Bloggy published the half-marathon post.");
    expect(await revision()).not.toBe(before);
    expect((await call("GET", "/v1/app/ambient/summary")).json).toMatchObject({ unread: true, last: { text: "Bloggy published the half-marathon post." } });
    expect((await call("GET", "/v1/app/ambient/chat?seen=0")).status).toBe(200);
    expect((await call("GET", "/v1/app/ambient/summary")).json).toMatchObject({ unread: true });
    expect((await call("GET", "/v1/app/ambient/chat")).status).toBe(200);
    expect((await call("GET", "/v1/app/ambient/summary")).json).toMatchObject({ unread: false, last: { text: "Bloggy published the half-marathon post." } });
  });
});
