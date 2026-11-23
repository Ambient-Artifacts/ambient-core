// Decisions (docs/bots.md): a bot's question goes to Ambient first; Ambient answers in the thread
// when the brain makes it clear, or brings it to the person as a decision in its chat; answering
// anywhere settles it; and the heartbeat speaks up only about what's new.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv", os: "Linux 6.8", runner: "0.7.6", claude: "2.1.326 (Claude Code)" };

// Fake Anthropic: answers by what the turn is (a bot's question to look at, the heartbeat, a chat).
let triageReply = '{"action":"ask","suggest":"","why":""}';
let beatReply = "NOTHING";
const prompts: string[] = [];
const fakeAnthropic: typeof fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.anthropic.com/")) return fetch(input, init);
  const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] };
  const last = body.messages[body.messages.length - 1]!;
  const said = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  prompts.push(said);
  const reply = said.includes("[Not from") ? triageReply : said.includes("[Heartbeat") ? beatReply : "Sure.";
  return new Response(JSON.stringify({ content: [{ type: "text", text: reply }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
};

let s: Stack;
let lena: AppSession;
let host: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
type Msg = { role: string; kind: string; text: string; author: string | null };
type Decision = { id: string; status: string; question: string; options: string[]; recommendation: { option: string; why: string } | null; answer: { text: string; via: string } | null; from: { kind: string; name?: string } };
const thread = async (id: string) => ((await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/thread`)).json.messages as Msg[]);
const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
  let v = await get();
  for (let i = 0; i < 60 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await get();
  }
  return v;
};

/** A bot that's running and asks `question`; returns its id and run token. */
async function botAsks(name: string, question: string, choices: string[], delegate?: string, details?: string) {
  const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name, prompt: "x", schedule: daily, bot: { isolation: "host", ...(delegate ? { delegate } : {}) } });
  const id = (made.json.routine as { id: string }).id;
  const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
  const token = String(start.json.runToken);
  const asked = await hostCall(token, "POST", "/v1/bot/ask", { question, choices, ...(details ? { details } : {}) });
  return { id, token, questionId: String(asked.json.id), runId: String((start.json.run as { id: string }).id) };
}

beforeAll(async () => {
  s = await startStack({ ambient: { apiKey: "sk-test", fetchImpl: fakeAnthropic, triageMs: 5000 } });
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
});
afterAll(() => s.close());

describe("a bot's question goes to Ambient first", () => {
  it("is answered by Ambient in the thread when the brain makes it clear", async () => {
    triageReply = '{"action":"answer","answer":"AI is multiplayer","why":"You wanted more variety (decision 2026-10-16)."}';
    const b = await botAsks("Blog draft", "Which topic for Monday?", ["Wiki in git", "AI is multiplayer"]);
    const t = await until(() => thread(b.id), (m) => m.some((x) => x.role === "ambient"));
    expect(t.at(-1)).toMatchObject({ role: "ambient", kind: "answer", author: "Ambient, for Lena Vogel", text: "AI is multiplayer (You wanted more variety (decision 2026-10-16).)" });
    // The run that asked takes it.
    expect((await hostCall(b.token, "GET", `/v1/bot/questions/${b.questionId}`)).json).toMatchObject({ answer: "AI is multiplayer (You wanted more variety (decision 2026-10-16).)", author: "Ambient, for Lena Vogel" });
    expect(prompts.find((p) => p.includes("[Not from"))).toContain("Answer it yourself only when Lena Vogel's brain makes the answer clear");
  });

  it("comes to the person as a decision in the chat, with Ambient's suggestion, and an answer there reaches the bot", async () => {
    triageReply = '{"action":"ask","suggest":"Publish on Monday","why":"It is ready and nothing else is planned."}';
    const b = await botAsks("Release bot", "Publish the release notes now or on Monday?", ["Now", "Publish on Monday"]);
    const open = await until(async () => (await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as Decision[], (d) => d.length > 0);
    expect(open[0]).toMatchObject({ status: "open", question: "Publish the release notes now or on Monday?", options: ["Now", "Publish on Monday"], recommendation: { option: "Publish on Monday" }, from: { kind: "bot", name: "Release bot" } });
    const chat = (await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json.messages as { role: string; text: string; decision: Decision | null }[];
    expect(chat.at(-1)).toMatchObject({ role: "ambient", decision: { id: open[0]!.id, status: "open" } });
    expect(chat.at(-1)!.text).toContain("Release bot asks: Publish the release notes now or on Monday?");
    expect(chat.at(-1)!.text).toContain("I'd go with “Publish on Monday”");

    const answered = await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${open[0]!.id}`, { option: "Now" });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    expect(answered.json.decision).toMatchObject({ status: "answered", answer: { text: "Now", via: "thread" } });
    expect((await hostCall(b.token, "GET", `/v1/bot/questions/${b.questionId}`)).json).toMatchObject({ answer: "Now", author: "Lena Vogel" });
    expect((await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions).toEqual([]);
  });

  it("with delegate never, goes straight to the person; an answer in the thread settles the decision", async () => {
    const before = prompts.length;
    const b = await botAsks("Careful bot", "Delete the old drafts?", ["Yes", "No"], "never");
    const open = await until(async () => (await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as Decision[], (d) => d.length > 0);
    expect(prompts.slice(before).some((p) => p.includes("[Not from"))).toBe(false);
    expect(open[0]!.recommendation).toBeNull();
    await appCall(s, lena.access_token, "POST", `/v1/app/routines/${b.id}/thread`, { text: "No" });
    const chat = (await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json.messages as { decision: Decision | null }[];
    expect(chat.at(-1)!.decision).toMatchObject({ status: "answered", answer: { text: "No", via: "thread" } });
  });

  it("an older card answers its own question, though a newer one is open, and goes away", async () => {
    const b = await botAsks("Nightly bot", "Keep going with the idea?", ["Keep going", "Drop it"], "never");
    const first = await until(async () => (await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as Decision[], (d) => d.some((x) => x.question === "Keep going with the idea?"));
    const older = first.find((x) => x.question === "Keep going with the idea?")!;
    // The bot asks something newer: that's its open question now.
    const later = await hostCall(b.token, "POST", "/v1/bot/ask", { question: "Merge the pull request?", choices: ["Merge", "Changes"] });
    const newerId = String(later.json.id);
    await until(async () => (await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as Decision[], (d) => d.some((x) => x.question === "Merge the pull request?"));

    const answered = await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${older.id}`, { option: "Keep going" });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    expect(answered.json.decision).toMatchObject({ status: "answered", answer: { text: "Keep going" } });
    // The run that asked gets it for that question; the newer one is still open, and its card stays.
    expect((await hostCall(b.token, "GET", `/v1/bot/questions/${b.questionId}`)).json).toMatchObject({ answer: expect.stringContaining("Keep going") });
    expect((await hostCall(b.token, "GET", `/v1/bot/questions/${newerId}`)).json).toMatchObject({ answer: null });
    const left = (await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as Decision[];
    expect(left.map((x) => x.question)).toContain("Merge the pull request?");
    expect(left.map((x) => x.question)).not.toContain("Keep going with the idea?");
    // In the thread it says which question it answers.
    const t = await thread(b.id);
    // In the thread it's an inline reply to that question; the bot reads it with the question in front.
    expect(t.at(-1)).toMatchObject({ kind: "answer", text: "Keep going", replyTo: { id: b.questionId, text: "Keep going with the idea?" } });
    expect((await hostCall(b.token, "GET", `/v1/bot/questions/${b.questionId}`)).json).toMatchObject({ answer: "Answer to your question “Keep going with the idea?”:\nKeep going" });
    expect((await appCall(s, lena.access_token, "POST", `/v1/app/routines/${b.id}/thread`, { text: "Again", question: b.questionId })).status).toBe(409);

    // A choice tapped under the newer question in the thread answers that one, as the open one: no prefix.
    const tapped = await appCall(s, lena.access_token, "POST", `/v1/app/routines/${b.id}/thread`, { text: "Merge", question: newerId });
    expect(tapped.status, JSON.stringify(tapped.json)).toBe(200);
    expect(tapped.json.message).toMatchObject({ kind: "answer", text: "Merge", replyTo: null });
    expect((await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as Decision[]).toEqual([]);
  });

  it("can be answered in words through Ambient's tools", async () => {
    triageReply = '{"action":"ask","suggest":"","why":""}';
    await botAsks("Word bot", "Which day?", ["Monday", "Tuesday"]);
    const open = await until(async () => (await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as Decision[], (d) => d.length > 0);
    const pat = String((await appCall(s, lena.access_token, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await client.callTool({ name: "open_decisions", arguments: {} }))).toContain("Word bot asks");
    const filed = await client.callTool({ name: "answer_decision", arguments: { id: open[0]!.id, answer: "Tuesday" } });
    expect(text(filed)).toContain("Word bot carries on with it");
    await client.close();
  });
});

describe("a question shows the work", () => {
  it("carries the draft to the thread, Ambient's look and the decision, and the run's result shows before it", async () => {
    triageReply = '{"action":"ask","suggest":"Approved","why":"The draft follows the voice rules."}';
    const draft = "207 cancellations read since October.\n\nThe churn bot reads every one...\n\n[PR #412](https://github.com/acme/app/pull/412)";
    const before = prompts.length;
    const b = await botAsks("Linki", "Post 1 is ready. Approve it?", ["Approved", "Changes"], "brain", draft);
    // Ambient looked at the work itself before suggesting anything.
    const look = await until(async () => prompts.slice(before).find((p) => p.includes("[Not from")) ?? "", (p) => p.length > 0);
    expect(look).toContain("207 cancellations read since October.");
    const open = await until(async () => (await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as (Decision & { details: string | null })[], (d) => d.length > 0);
    expect(open[0]).toMatchObject({ question: "Post 1 is ready. Approve it?", details: draft });
    const chat = (await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json.messages as { text: string }[];
    expect(chat.at(-1)!.text).toContain("[PR #412](https://github.com/acme/app/pull/412)");
    const q = (await thread(b.id)).find((m) => m.kind === "question") as Msg & { details: string | null };
    expect(q.details).toBe(draft);

    // The run finishes with a long result: it shows too, before the question it may be about.
    const report = `Post 1 draft:\n\n${"A plain short sentence. ".repeat(30)}`;
    await hostCall(host, "POST", `/v1/host/runs/${b.runId}`, { status: "succeeded", summary: report });
    const t = await thread(b.id);
    const result = t.findIndex((m) => m.kind === "result");
    expect(result, JSON.stringify(t.map((m) => m.kind))).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(t.findIndex((m) => m.kind === "question"));
    await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${open[0]!.id}`, { option: "Approved" });
  });

  it("without the work, Ambient is told not to suggest approving it; a short result stays held back", async () => {
    triageReply = JSON.stringify({ action: "ask", suggest: "", why: "I haven't seen the draft." });
    const before = prompts.length;
    const b = await botAsks("Vague bot", "The draft is in my last message. Approve it?", ["Approved", "Changes"]);
    const look = await until(async () => prompts.slice(before).find((p) => p.includes("[Not from")) ?? "", (p) => p.length > 0);
    expect(look).toContain("don't suggest approving work you haven't seen");
    await hostCall(host, "POST", `/v1/host/runs/${b.runId}`, { status: "succeeded", summary: "Asked for approval." });
    expect((await thread(b.id)).some((m) => m.kind === "result")).toBe(false);
    const open = await until(async () => (await appCall(s, lena.access_token, "GET", "/v1/app/decisions")).json.decisions as Decision[], (d) => d.length > 0);
    await appCall(s, lena.access_token, "POST", `/v1/app/decisions/${open[0]!.id}`, { option: "Changes" });
  });
});

describe("the heartbeat", () => {
  it("speaks up about something new once, and stays quiet otherwise", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Flaky bot", prompt: "x", schedule: daily, bot: { isolation: "host" } });
    const id = (made.json.routine as { id: string }).id;
    const run = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    await hostCall(host, "POST", `/v1/host/runs/${(run.json.run as { id: string }).id}`, { status: "failed", summary: "npm ci failed." });

    beatReply = "Flaky bot failed its run: npm ci broke. Want me to look at its thread?";
    expect(await s.heartbeat.beat(lena.user.uid, { force: true })).toBe("sent");
    const chat = (await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json.messages as { role: string; text: string }[];
    expect(chat.at(-1)).toMatchObject({ role: "ambient", text: "Flaky bot failed its run: npm ci broke. Want me to look at its thread?" });
    expect(prompts.at(-1)).toContain('The bot "Flaky bot" failed its last run');
    // Already told: nothing new, no model call.
    const calls = prompts.length;
    expect(await s.heartbeat.beat(lena.user.uid, { force: true })).toBe("quiet");
    expect(prompts.length).toBe(calls);
  });

  it("says nothing when Ambient finds nothing worth saying", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Other bot", prompt: "x", schedule: daily, bot: { isolation: "host" } });
    const id = (made.json.routine as { id: string }).id;
    const run = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    await hostCall(host, "POST", `/v1/host/runs/${(run.json.run as { id: string }).id}`, { status: "failed", summary: "flake" });
    beatReply = "NOTHING";
    const before = ((await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json.messages as unknown[]).length;
    expect(await s.heartbeat.beat(lena.user.uid, { force: true })).toBe("quiet");
    expect(((await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json.messages as unknown[]).length).toBe(before);
  });
});
