// Needs you (docs/bots.md): what waits for the person per bot; a decision can be set aside for
// later (it stays open) or dismissed (the bot hears "Not now."). New bot templates and the
// nightly idea (an automation that starts a bot) ride along.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv", os: "Linux 6.8", runner: "0.7.6", claude: "2.1.326 (Claude Code)" };

const fakeAnthropic: typeof fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.anthropic.com/")) return fetch(input, init);
  return new Response(JSON.stringify({ content: [{ type: "text", text: '{"action":"ask","suggest":"","why":""}' }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
};

let s: Stack;
let lena: AppSession;
let mia: AppSession;
let host: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
type D = { id: string; status: string; question: string; from: { kind: string; id?: string }; snoozedUntil?: number; answer: { text: string; via: string } | null };
type Needs = { items: D[]; snoozed: D[]; counts: Record<string, number> };
const needs = async (who = lena) => (await appCall(s, who.access_token, "GET", "/v1/app/needs-you")).json as unknown as Needs;
const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
  let v = await get();
  for (let i = 0; i < 80 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await get();
  }
  return v;
};

async function botAsks(name: string, question: string) {
  const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name, prompt: "x", schedule: daily, bot: { isolation: "host", delegate: "never" } });
  const id = (made.json.routine as { id: string }).id;
  const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
  await hostCall(String(start.json.runToken), "POST", "/v1/bot/ask", { question, choices: ["Merge", "Changes"] });
  return id;
}

beforeAll(async () => {
  s = await startStack({ ambient: { apiKey: "sk-test", fetchImpl: fakeAnthropic, triageMs: 5000 } });
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  mia = await signIn(s, "apple-mia", "Mia Berg");
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
});
afterAll(() => s.close());

describe("needs you", () => {
  let a: string;
  let b: string;

  it("lists what waits, with a count per bot", async () => {
    a = await botAsks("Builder", "PR #12 is ready. Merge it?");
    b = await botAsks("Reviewer", "Is the migration order right?");
    await botAsks("Builder two", "unused");
    const n = await until(needs, (v) => v.items.length >= 3);
    expect(n.snoozed).toHaveLength(0);
    expect(n.counts[a]).toBe(1);
    expect(n.counts[b]).toBe(1);
    expect(n.items.find((d) => d.from.id === a)?.question).toBe("PR #12 is ready. Merge it?");
  });

  it("sets one aside for later: it stays open, leaves the list and the count, and comes back", async () => {
    const d = (await needs()).items.find((x) => x.from.id === a)!;
    const after = (await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${d.id}/snooze`, { hours: 3 })).json as unknown as Needs;
    expect(after.items.some((x) => x.id === d.id)).toBe(false);
    expect(after.counts[a]).toBeUndefined();
    expect(after.snoozed).toHaveLength(1);
    expect(after.snoozed[0]!.snoozedUntil).toBeGreaterThan(Date.now() + 2.9 * 3600_000);
    // Still an open decision everywhere else.
    expect(((await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as D[]).some((x) => x.id === d.id && x.status === "open")).toBe(true);
    const back = (await appCall(s, lena.access_token, "DELETE", `/v1/app/decisions/${d.id}/snooze`)).json as unknown as Needs;
    expect(back.snoozed).toHaveLength(0);
    expect(back.counts[a]).toBe(1);
  });

  it("refuses a snooze that is too short, too long, or someone else's", async () => {
    const d = (await needs()).items.find((x) => x.from.id === a)!;
    expect((await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${d.id}/snooze`, { hours: 0.01 })).status).toBe(400);
    expect((await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${d.id}/snooze`, { until: Date.now() + 40 * 24 * 3600_000 })).status).toBe(400);
    expect((await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${d.id}/snooze`, {})).status).toBe(400);
    expect((await appCall(s, mia.access_token, "POST", `/v1/app/decisions/${d.id}/snooze`, { hours: 3 })).status).toBe(404);
    expect((await needs(mia)).items).toHaveLength(0);
  });

  it("dismisses one: settled, the bot hears it, and its snooze is gone", async () => {
    const d = (await needs()).items.find((x) => x.from.id === b)!;
    await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${d.id}/snooze`, { hours: 2 });
    const out = await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${d.id}/dismiss`);
    expect(out.status).toBe(200);
    expect((out.json.decision as D).status).toBe("answered");
    const n = await needs();
    expect(n.items.some((x) => x.id === d.id)).toBe(false);
    expect(n.snoozed).toHaveLength(0);
    expect(n.counts[b]).toBeUndefined();
    const thread = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${b}/thread`)).json.messages as { role: string; text: string }[];
    expect(thread.at(-1)).toMatchObject({ role: "user", text: "Not now." });
    expect((await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${d.id}/dismiss`)).status).toBe(409);
  });
});

describe("new bot templates", () => {
  it("lists them with a tagline and a category", async () => {
    const t = (await appCall(s, lena.access_token, "GET", "/v1/app/bot-templates")).json.templates as { id: string; tagline: string; category: string; connections?: string[] }[];
    expect(t.map((x) => x.id)).toEqual(["review_bot", "builder", "wiki_keeper", "code_health", "anomaly_watcher"]);
    expect(t.every((x) => x.tagline.length > 0 && x.tagline.length <= 40 && x.category)).toBe(true);
    expect(t.find((x) => x.id === "anomaly_watcher")!.connections).toEqual(["posthog", "stripe", "sentry"]);
  });

  it("makes an anomaly watcher without repos, and says which services it works through", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/bots/from-template", { template: "anomaly_watcher", answers: { numbers: "sign-ups, payments" } });
    expect(made.status).toBe(200);
    expect(made.json.needs).toMatchObject({ secrets: [], webhook: false, connections: ["posthog", "stripe", "sentry"] });
    const r = made.json.routine as { id: string; name: string; prompt: string; schedule: { every: string } };
    expect(r.name).toBe("Anomaly watcher");
    expect(r.prompt).toContain("sign-ups, payments");
    expect(r.prompt).toContain("Report only big changes");
    expect(r.schedule.every).toBe("day");
    expect((await appCall(s, lena.access_token, "POST", "/v1/app/bots/from-template", { template: "anomaly_watcher", answers: {} })).status).toBe(400);
  });

  it("makes a code health bot that runs on weekdays", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/bots/from-template", { template: "code_health", answers: { repos: ["acme/app"], focus: "the iOS build" } });
    expect(made.status).toBe(200);
    const r = made.json.routine as { prompt: string; schedule: { every: string } };
    expect(r.schedule.every).toBe("weekday");
    expect(r.prompt).toContain("Look especially closely at: the iOS build.");
    expect(r.prompt).toContain("Never skip, retry-wrap or delete a test");
  });
});

describe("the nightly idea", () => {
  it("needs a bot of the person's own, and starts it with the instructions", async () => {
    const no = await appCall(s, lena.access_token, "POST", "/v1/app/automations", { template: "nightly_idea" });
    expect(no.status).toBe(400);
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Idea bot", prompt: "x", schedule: daily, bot: { isolation: "host" } });
    const id = (made.json.routine as { id: string }).id;
    expect((await appCall(s, mia.access_token, "POST", "/v1/app/automations", { template: "nightly_idea", bot: id })).status).toBeGreaterThanOrEqual(400);
    const auto = await appCall(s, lena.access_token, "POST", "/v1/app/automations", { template: "nightly_idea", bot: id });
    expect(auto.status).toBe(200);
    const a = auto.json.automation as { id: string; delivery: string; bot: string; when: string };
    expect(a).toMatchObject({ delivery: "bot", bot: id });
    const run = await appCall(s, lena.access_token, "POST", `/v1/app/automations/${a.id}/run`);
    expect(run.status).toBe(202);
    const runs = await until(async () => (await appCall(s, lena.access_token, "GET", `/v1/app/automations/${a.id}/runs`)).json.runs as { result: string }[], (r) => r.length > 0);
    expect(runs[0]!.result).toBe("sent");
    const thread = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/thread`)).json.messages as { role: string; text: string }[];
    expect(thread.at(-1)!.role).toBe("ambient");
    expect(thread.at(-1)!.text).toContain("tonight you may bring one idea of your own");
    // An event trigger can't start a bot.
    expect((await appCall(s, lena.access_token, "PATCH", `/v1/app/automations/${a.id}`, { trigger: { kind: "event", events: ["meeting_note"] } })).status).toBe(400);
  });
});
