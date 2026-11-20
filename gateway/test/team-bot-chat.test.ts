// A team bot's thread is a group chat (docs/bots.md, "A team bot's thread is a group chat"):
// everyone in the team writes to it and sees what the others wrote; the others get a push for each
// message; the bot's answer reaches whoever wrote to it; its questions reach the whole team, and
// whoever answers first answers them; read is each person's own. Its settings stay with the team's
// owners and admins.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PushDevice, PushMessage, PushOutcome } from "../src/push.ts";
import { appCall, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const info = { hostname: "brain-team-lab", os: "Linux 6.8", runner: "0.14.0", claude: "2.1.326 (Claude Code)" };
const sent: { token: string; message: PushMessage }[] = [];
const push = async (device: PushDevice, message: PushMessage): Promise<PushOutcome> => {
  sent.push({ token: device.token, message });
  return "sent";
};

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let nora: AppSession;
let teamHost: string;
let bot: string;
const tokens: Record<string, string> = {};

type Msg = { author: string | null; text: string; mine: boolean; kind: string };
const call = (who: AppSession, method: string, path: string, body?: unknown) => appCall(s, who.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const pushesTo = (who: AppSession) => sent.filter((p) => p.token === tokens[who.user.uid]).map((p) => p.message);

beforeAll(async () => {
  s = await startStack({ push, bots: { users: [], teams: [] } });
  lena = await signIn(s, "apple-lena-groupchat", "Lena Vogel");
  ben = await signIn(s, "apple-ben-groupchat", "Ben Weiss");
  nora = await signIn(s, "apple-nora-groupchat", "Nora Ost");
  const slug = ((await call(lena, "POST", "/v1/app/teams", { name: "Lab" })).json.team as { slug: string }).slug;
  s.config.bots!.teams.push(slug);
  for (const who of [ben, nora]) {
    const code = String((await call(lena, "POST", `/v1/app/teams/${slug}/invites`, { role: "member" })).json.code);
    expect((await call(who, "POST", "/v1/app/teams/join", { code })).status).toBe(200);
  }
  // The team's server.
  const codeHash = createHash("sha256").update("host-setup:TEAM-CHAT1").digest("hex");
  await s.t.mutation(s.internal.routines.staffAddHost, { team: slug, name: "Team server", codeHash, expiresAt: Date.now() + 60_000 });
  teamHost = String((await hostCall("", "POST", "/v1/host/setup", { code: "TEAM-CHAT1", info })).json.token);
  // Everyone's phone.
  for (const [i, who] of [lena, ben, nora].entries()) {
    tokens[who.user.uid] = String(i + 1).repeat(64);
    expect((await call(who, "PUT", "/v1/app/push-device", { token: tokens[who.user.uid], sandbox: true, platform: "ios" })).status).toBe(204);
  }
  const made = await call(lena, "POST", "/v1/app/routines", { name: "Helper", prompt: "Help the team.", schedule: { every: "day", time: "09:00", timezone: "Europe/Vienna" }, team: slug, bot: {} });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  bot = (made.json.routine as { id: string }).id;
});
afterAll(() => s.close());

describe("a team bot's thread", () => {
  it("is open to everyone in the team to write to; its settings stay with the owners and admins", async () => {
    const asBen = ((await call(ben, "GET", "/v1/app/routines")).json.routines as { id: string; canEdit: boolean; canMessage: boolean }[]).find((r) => r.id === bot)!;
    expect(asBen).toMatchObject({ canEdit: false, canMessage: true });
    const posted = await call(ben, "POST", `/v1/app/routines/${bot}/thread`, { text: "Can you look at the login bug?" });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    expect((await call(ben, "PATCH", `/v1/app/routines/${bot}`, { enabled: false })).status).toBe(403);
  });

  it("shows everyone what the others wrote, by name", async () => {
    const seenByLena = ((await call(lena, "GET", `/v1/app/routines/${bot}/thread`)).json.messages as Msg[]).at(-1)!;
    expect(seenByLena).toMatchObject({ author: "Ben Weiss", text: "Can you look at the login bug?", mine: false });
    const seenByBen = ((await call(ben, "GET", `/v1/app/routines/${bot}/thread`)).json.messages as Msg[]).at(-1)!;
    expect(seenByBen.mine).toBe(true);
  });

  it("tells the others with a push, not the one who wrote", async () => {
    await vi.waitFor(() => expect(pushesTo(lena).length + pushesTo(nora).length).toBe(2));
    for (const who of [lena, nora]) expect(pushesTo(who).at(-1)).toMatchObject({ title: "Helper · Lab", body: "Ben Weiss: Can you look at the login bug?", url: `ambient://routine/${bot}?thread=1` });
    expect(pushesTo(ben)).toEqual([]);
  });

  it("keeps read per person: Lena reading it doesn't make it read for Nora", async () => {
    const reads = await s.t.run(async (ctx) => (await ctx.db.query("botReads").collect()).filter((r) => String(r.routineId) === bot).map((r) => String(r.userId)).sort());
    // Ben wrote (read), Lena opened it (read); Nora hasn't.
    expect(reads).toEqual([ben.user.uid, lena.user.uid].sort());
  });

  it("sends the bot's answer to whoever wrote to it", async () => {
    const before = { lena: pushesTo(lena).length, ben: pushesTo(ben).length, nora: pushesTo(nora).length };
    const start = await hostCall(teamHost, "POST", `/v1/host/routines/${bot}/runs`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    await hostCall(teamHost, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Found it: the retry never resets. PR #12 fixes it." });
    await vi.waitFor(() => expect(pushesTo(ben).length).toBe(before.ben + 1));
    expect(pushesTo(ben).at(-1)).toMatchObject({ title: "Helper · Lab", body: "Found it: the retry never resets. PR #12 fixes it." });
    expect(pushesTo(lena).length).toBe(before.lena);
    expect(pushesTo(nora).length).toBe(before.nora);
  });

  it("asks the whole team, and whoever answers first answers it", async () => {
    const start = await hostCall(teamHost, "POST", `/v1/host/routines/${bot}/runs`);
    const token = String(start.json.runToken);
    expect((await hostCall(token, "POST", "/v1/bot/ask", { question: "Merge PR #12?", choices: ["Merge", "Wait"] })).status).toBe(200);
    await vi.waitFor(() => {
      expect(pushesTo(ben).some((m) => m.body.includes("Merge PR #12?"))).toBe(true);
      expect(pushesTo(nora).some((m) => m.body.includes("Merge PR #12?"))).toBe(true);
    });
    expect((await call(nora, "POST", `/v1/app/routines/${bot}/thread`, { text: "Merge" })).status).toBe(200);
    const last = ((await call(lena, "GET", `/v1/app/routines/${bot}/thread`)).json.messages as Msg[]).at(-1)!;
    expect(last).toMatchObject({ author: "Nora Ost", kind: "answer", text: "Merge" });
    await hostCall(teamHost, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Merged." });
  });
});
