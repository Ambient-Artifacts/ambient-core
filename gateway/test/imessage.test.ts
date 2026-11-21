// Amb on iMessage (docs/bots.md, "Channels" and "iMessage"), against a stand-in Linq API: a code
// texted to the line links the number; a text from it is one more message in Amb's one chat and is
// answered on iMessage; a message written in the app is answered only in the app; what Amb says
// first goes to the one place the person chose, never to both; a stranger gets nothing.
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isOptOut, normalizeHandle, toPlainText } from "../src/channels/imessage.ts";
import type { PushMessage } from "../src/push.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const SECRET_BYTES = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const LINE = "+14155550100";
const LENA = "+436601234567";
const CHAT = "8f392755-6865-4b18-880a-227f9d8b458f";
const TOKEN = "b2".repeat(32);

// Fake Anthropic: the chat answers with Markdown; the heartbeat says there's news.
let beatReply = "NOTHING";
const asked: string[] = [];
const fakeAnthropic: typeof fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.anthropic.com/")) return fetch(input, init);
  const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] };
  const last = body.messages[body.messages.length - 1]!;
  const said = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  asked.push(said);
  const reply = said.includes("[Heartbeat") ? beatReply : `**Sure.** See [the page](https://example.com/page).`;
  return new Response(JSON.stringify({ content: [{ type: "text", text: reply }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
};

const calls: { method: string; path: string; auth: string; body: Record<string, unknown> }[] = [];
const pushes: PushMessage[] = [];
let refuseSends = false;
/** Linq's error code for a refused send (2024: they opted out). */
let refuseCode = 2027;
let chatHealth = "HEALTHY";
let lineStatus = "ACTIVE";
let lineReputation = "HEALTHY";
let refusePolls = false;
let polls = 0;
let linq: Server;
let s: Stack;
let lena: AppSession;
let n = 0;

const call = (method: string, path: string, body?: unknown) => appCall(s, lena.access_token, method, path, body);
const texts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).map((c) => ((c.body.message as { parts: { value: string }[] }).parts[0]!.value));
const chat = async () => (await call("GET", "/v1/app/ambient/chat?seen=0")).json.messages as { role: string; text: string; via: string }[];

/** A text arriving at the line, as Linq posts it (Standard Webhooks signature). */
async function inbound(from: string, value: string | null, opts: { secret?: Buffer; ts?: number; id?: string; group?: boolean; media?: boolean } = {}) {
  const id = opts.id ?? `msg-${++n}`;
  const body = JSON.stringify({
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: `evt-${id}`,
    data: {
      id,
      direction: "inbound",
      chat: { id: CHAT, is_group: opts.group ?? false, owner_handle: { handle: LINE, is_me: true } },
      sender_handle: { handle: from, is_me: false, service: "iMessage" },
      parts: [...(value !== null ? [{ type: "text", value }] : []), ...(opts.media ? [{ type: "media", url: "https://example.com/a.jpg" }] : [])],
    },
  });
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRET_BYTES).update(`wh-${id}.${ts}.${body}`).digest("base64");
  const res = await fetch(`${s.origin}/v1/hooks/linq`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": `wh-${id}`, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, body });
  await s.folders.imessage!.idle();
  return res.status;
}

/** What Linq last said about lines and chats is forgotten, so the next send asks again. */
function askLinqAgain() {
  const im = s.folders.imessage as unknown as { lines: unknown; healths: Map<string, unknown> };
  im.lines = undefined;
  im.healths.clear();
}
const tell = (text: string) => s.folders.reach!.tell(lena.user.uid, text, { title: "Ambient", body: text, url: "ambient://ambient", thread: "ambient" });
const firsts = () => calls.filter((c) => c.method === "POST" && c.path === "/v3/messages");

/** Any event, signed as Linq signs it. */
async function event(body: Record<string, unknown>) {
  const id = `evt-${++n}`;
  const raw = JSON.stringify({ api_version: "v3", webhook_version: "2026-02-03", event_id: id, ...body });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", SECRET_BYTES).update(`wh-${id}.${ts}.${raw}`).digest("base64");
  const res = await fetch(`${s.origin}/v1/hooks/linq`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": `wh-${id}`, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, body: raw });
  await s.folders.imessage!.idle();
  return res.status;
}

/** A tap on a poll's option, as Linq posts it. */
async function vote(from: string, messageId: string, optionId: string, eventId = `vote-${++n}`) {
  const body = JSON.stringify({
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "poll.vote.added",
    event_id: eventId,
    data: { message_id: messageId, direction: "inbound", chat: { id: CHAT, is_group: false, owner_handle: null }, sender_handle: { handle: from, is_me: false, service: "iMessage" }, option_id: optionId, service: "iMessage" },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", SECRET_BYTES).update(`wh-${eventId}.${ts}.${body}`).digest("base64");
  const res = await fetch(`${s.origin}/v1/hooks/linq`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": `wh-${eventId}`, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, body });
  await s.folders.imessage!.idle();
  return res.status;
}

beforeAll(async () => {
  linq = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "").split("?")[0]!;
      calls.push({ method: req.method ?? "", path, auth: String(req.headers.authorization ?? ""), body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      if (req.method === "POST" && path.endsWith("/messages") && refuseSends) {
        return res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ success: false, error: { status: 403, code: refuseCode, message: "Refused" } }));
      }
      if (req.method === "POST" && path === "/v3/messages") return res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ chat_id: CHAT, created_new_chat: false, from: LINE, from_selection: { reason: "reused_active_chat" } }));
      if (req.method === "GET" && path === `/v3/chats/${CHAT}`) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: CHAT, health_status: { status: chatHealth } }));
      if (req.method === "GET" && path === "/v3/phone_numbers") {
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ phone_numbers: [{ id: "n1", phone_number: LINE, line_status: lineStatus, line_type: "iMessage", reputation: { state: lineReputation === "CRITICAL" ? "DELIVERY_LIMITED" : "HEALTHY", status: lineReputation, reason_codes: [] } }] }));
      }
      if (req.method === "POST" && (path.endsWith("/typing") || path.endsWith("/read"))) return res.writeHead(204).end();
      if (req.method === "POST" && path.endsWith("/polls")) {
        if (refusePolls) return res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ success: false, error: { status: 403, code: 2018, message: "Polls are iMessage-only" } }));
        polls++;
        const options = ((JSON.parse(raw) as { poll: { options: { text: string }[] } }).poll.options).map((o, i) => ({ option_id: `opt-${polls}-${i}`, text: o.text }));
        return res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ chat_id: CHAT, message_id: `poll-${polls}`, poll: { options } }));
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => linq.listen(0, "127.0.0.1", r));
  s = await startStack({
    ambient: { apiKey: "sk-test", fetchImpl: fakeAnthropic },
    linq: { api: `http://127.0.0.1:${(linq.address() as AddressInfo).port}`, webhookSecret: SECRET, number: LINE },
    push: async (_device, message) => {
      pushes.push(message);
      return "sent";
    },
  });
  lena = await signIn(s, "apple-lena-imessage", "Lena Vogel");
  await call("PUT", "/v1/app/push-device", { token: TOKEN, sandbox: true, platform: "ios" });
});
afterAll(() => {
  s.close();
  linq.close();
});

describe("text helpers", () => {
  it("one spelling per number, and Markdown becomes a plain text", () => {
    expect(normalizeHandle("+43 660 123-4567")).toBe(LENA);
    expect(normalizeHandle(" Lena@Example.com ")).toBe("lena@example.com");
    expect(toPlainText("## Today\n**Two** things, see [the page](https://example.com/p) and `npm ci`:\n- one\n- [Open](ambient://routine/1)")).toBe("Today\nTwo things, see the page: https://example.com/p and npm ci:\n• one\n• Open (in the Ambient app)");
  });
});

describe("connecting", () => {
  let code = "";

  it("gives a code and the line's number, the same one while it's good", async () => {
    const before = await call("GET", "/v1/app/imessage");
    expect(before.json).toMatchObject({ connected: false, number: LINE, code: null });
    const started = await call("POST", "/v1/app/imessage");
    code = String(started.json.code);
    expect(code).toMatch(/^AMB-[A-Z2-9]{6}$/);
    expect(started.json).toMatchObject({ connected: false, number: LINE, link: `sms:${LINE}&body=${encodeURIComponent(code)}` });
    expect((await call("POST", "/v1/app/imessage")).json.code).toBe(code);
  });

  it("a text nobody signed, an old one, a group's and a stranger's all do nothing", async () => {
    expect(await inbound(LENA, code, { secret: Buffer.from("someone-else") })).toBe(401);
    expect(await inbound(LENA, code, { ts: Math.floor(Date.now() / 1000) - 3600 })).toBe(401);
    expect(await inbound(LENA, code, { group: true })).toBe(200);
    expect(await inbound("+15550000001", "hi, who is this?")).toBe(200);
    expect(await inbound("+15550000001", "AMB-ZZZZZZ")).toBe(200);
    expect(texts()).toEqual([]);
    expect((await call("GET", "/v1/app/imessage")).json.connected).toBe(false);
    expect(await chat()).toEqual([]);
  });

  it("reach can't be iMessage before it's connected", async () => {
    const out = await call("PUT", "/v1/app/ambient/settings", { reach: "imessage" });
    expect(out.status).toBe(400);
    expect(out.json.message).toContain("isn't connected");
  });

  it("the code texted to the line links that number, once", async () => {
    expect(await inbound("+43 660 1234567", `my code is ${code.toLowerCase()}`)).toBe(200);
    expect(texts()).toEqual(["You're connected, Lena. Write to me here like in the app: it's one conversation."]);
    expect(calls.at(-2)).toMatchObject({ path: `/v3/chats/${CHAT}/messages`, auth: "Bearer linq-test-key" });
    // Its contact card follows, so the thread shows a name instead of a number.
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: `/v3/chats/${CHAT}/share_contact_card` });
    expect((await call("GET", "/v1/app/imessage")).json).toMatchObject({ connected: true, handle: "+43 ••• 4567", code: null });
    // The code is used up: a second number can't take the account with it.
    await inbound("+15550000002", code);
    expect(texts()).toHaveLength(1);
    // Linking isn't a message to Amb.
    expect(await chat()).toEqual([]);
  });
});

describe("one conversation, answered where it was asked", () => {
  it("a text is answered on iMessage, as plain text, and is in the app's chat", async () => {
    const before = texts().length;
    expect(await inbound(LENA, "What's on today?")).toBe(200);
    expect(texts().slice(before)).toEqual(["Sure. See the page: https://example.com/page."]);
    expect(calls.some((c) => c.path === `/v3/chats/${CHAT}/typing`)).toBe(true);
    expect(calls.some((c) => c.path === `/v3/chats/${CHAT}/read`)).toBe(true);
    // Amb was told where it's answering.
    expect(asked.at(-1)).toContain("wrote this on iMessage");
    expect(asked.at(-1)).toContain("What's on today?");
    expect(await chat()).toMatchObject([
      { role: "user", text: "What's on today?", via: "imessage" },
      { role: "ambient", text: "**Sure.** See [the page](https://example.com/page).", via: "imessage" },
    ]);
    expect(pushes).toEqual([]);
  });

  it("two texts in a row are answered one after the other", async () => {
    const before = (await chat()).length;
    await Promise.all([inbound(LENA, "First", { id: "burst-1" }), inbound(LENA, "Second", { id: "burst-2" })]);
    await s.folders.imessage!.idle();
    expect((await chat()).slice(before).map((m) => m.role)).toEqual(["user", "ambient", "user", "ambient"]);
  });

  it("the same text delivered twice is taken once", async () => {
    const before = (await chat()).length;
    await inbound(LENA, "And tomorrow?", { id: "dup-1" });
    await inbound(LENA, "And tomorrow?", { id: "dup-1" });
    expect((await chat()).length).toBe(before + 2);
  });

  it("a message written in the app is answered in the app only, and knows what was texted", async () => {
    const before = texts().length;
    const sent = await call("POST", "/v1/app/ambient/chat", { text: "Thanks!" });
    expect(sent.status).toBe(200);
    for (let i = 0; i < 50 && (await call("GET", "/v1/app/ambient/chat?seen=0")).json.pending; i++) await new Promise((r) => setTimeout(r, 50));
    expect(texts().length).toBe(before);
    const all = await chat();
    expect(all.slice(-2)).toMatchObject([
      { role: "user", text: "Thanks!", via: "app" },
      { role: "ambient", via: "app" },
    ]);
    // One history: the model got the texted turns with the app's message.
    expect(asked.at(-1)).not.toContain("wrote this on iMessage");
  });

  it("a photo without words gets a short note, not a turn", async () => {
    const before = (await chat()).length;
    await inbound(LENA, null, { media: true });
    expect(texts().at(-1)).toContain("only read text here");
    expect((await chat()).length).toBe(before);
  });
});

describe("what Amb says first goes to one place", () => {
  /** A bot whose last run failed: news for the heartbeat. */
  async function failedBot(name: string) {
    const code = String((await call("POST", "/v1/app/computers", { name: `Server for ${name}` })).json.code);
    const host = String(((await (await fetch(`${s.origin}/v1/host/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, info: { hostname: "srv", os: "Linux 6.8", runner: "0.14.0", claude: "2.1.326 (Claude Code)" } }) })).json()) as { token: string }).token);
    const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string; name: string }[]).find((c) => c.name === `Server for ${name}`)!.id;
    const id = ((await call("POST", "/v1/app/routines", { name, prompt: "x", schedule: { every: "day", time: "09:00", timezone: "Europe/Vienna" }, computer, bot: { isolation: "host" } })).json.routine as { id: string }).id;
    const hostCall = (method: string, path: string, body?: unknown) => fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${host}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const run = (await (await hostCall("POST", `/v1/host/routines/${id}/runs`)).json()) as { run: { id: string } };
    await hostCall("POST", `/v1/host/runs/${run.run.id}`, { status: "failed", summary: "npm ci broke" });
  }

  it("the app by default: a push, no text", async () => {
    await failedBot("Flaky");
    beatReply = "Flaky failed its run: npm ci broke.";
    pushes.length = 0;
    const before = texts().length;
    expect(await s.heartbeat.beat(lena.user.uid, { force: true })).toBe("sent");
    await new Promise((r) => setTimeout(r, 100));
    expect(pushes.filter((p) => p.collapseId === "ambient-heartbeat")).toHaveLength(1);
    expect(texts().length).toBe(before);
  });

  it("iMessage once chosen: a text, no push", async () => {
    const set = await call("PUT", "/v1/app/ambient/settings", { reach: "imessage" });
    expect(set.json).toMatchObject({ notify: "important", reach: "imessage" });
    await failedBot("Wobbly");
    beatReply = "**Wobbly** failed its run too.";
    pushes.length = 0;
    const before = texts().length;
    expect(await s.heartbeat.beat(lena.user.uid, { force: true })).toBe("sent");
    await new Promise((r) => setTimeout(r, 100));
    expect(texts().slice(before)).toEqual(["Wobbly failed its run too."]);
    expect(pushes.filter((p) => p.collapseId === "ambient-heartbeat")).toEqual([]);
    expect((await chat()).at(-1)).toMatchObject({ role: "ambient", text: "**Wobbly** failed its run too." });
  });

  it("with the chat open in the app, the text is left out and the push goes", async () => {
    await failedBot("Shaky");
    beatReply = "Shaky failed.";
    await call("GET", "/v1/app/ambient/chat");
    pushes.length = 0;
    const before = texts().length;
    expect(await s.heartbeat.beat(lena.user.uid, { force: true })).toBe("sent");
    await new Promise((r) => setTimeout(r, 100));
    expect(texts().length).toBe(before);
    expect(pushes.filter((p) => p.collapseId === "ambient-heartbeat")).toHaveLength(1);
  });

  it("when Linq refuses, the push goes out instead", async () => {
    // The chat isn't on screen anymore.
    s.folders.reach!.appActive(lena.user.uid);
    (s.folders.reach as unknown as { appSeen: Map<string, number> }).appSeen.clear();
    refuseSends = true;
    try {
      pushes.length = 0;
      expect(await s.folders.reach!.tell(lena.user.uid, "Something needs you.", { title: "Ambient", body: "Something needs you.", url: "ambient://ambient", thread: "ambient" })).toBe("app");
      expect(pushes).toHaveLength(1);
    } finally {
      refuseSends = false;
    }
  });
});

describe("a decision on iMessage is a poll", () => {
  type Decision = { id: string; status: string; answer: { text: string; via: string } | null };
  const open = async () => (await call("GET", "/v1/app/decisions")).json.decisions as Decision[];
  let host = "";

  /** A bot that's running and asks its owner `question`. */
  async function botAsks(name: string, question: string, choices: string[]) {
    if (!host) {
      const code = String((await call("POST", "/v1/app/computers", { name: "Poll server" })).json.code);
      host = String(((await (await fetch(`${s.origin}/v1/host/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, info: { hostname: "srv", os: "Linux 6.8", runner: "0.14.0", claude: "2.1.326 (Claude Code)" } }) })).json()) as { token: string }).token);
    }
    const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string; name: string }[]).find((c) => c.name === "Poll server")!.id;
    const id = ((await call("POST", "/v1/app/routines", { name, prompt: "x", schedule: { every: "day", time: "09:00", timezone: "Europe/Vienna" }, computer, bot: { isolation: "host", delegate: "never" } })).json.routine as { id: string }).id;
    const start = (await (await fetch(`${s.origin}/v1/host/routines/${id}/runs`, { method: "POST", headers: { authorization: `Bearer ${host}` } })).json()) as { runToken: string };
    await fetch(`${s.origin}/v1/bot/ask`, { method: "POST", headers: { authorization: `Bearer ${start.runToken}`, "content-type": "application/json" }, body: JSON.stringify({ question, choices }) });
    for (let i = 0; i < 50 && !calls.some((c) => c.path.endsWith("/polls") || (c.body.message as { parts?: { value: string }[] } | undefined)?.parts?.[0]?.value.includes(question)); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
  }

  it("the question comes as a text and its answers as a poll; a tap settles it", async () => {
    const before = texts().length;
    await botAsks("Picky", "Which headline?", ["Bold one", "Calm one"]);
    expect(texts().slice(before)).toEqual(["Picky asks: Which headline?"]);
    const poll = calls.filter((c) => c.path === `/v3/chats/${CHAT}/polls`).at(-1)!;
    expect((poll.body.poll as { options: { text: string }[] }).options.map((o) => o.text)).toEqual(["Bold one", "Calm one"]);
    const waiting = await open();
    expect(waiting).toHaveLength(1);
    // A stranger's tap, and a tap on an option that isn't the poll's, change nothing.
    await vote("+15550000009", `poll-${polls}`, `opt-${polls}-1`);
    await vote(LENA, `poll-${polls}`, "opt-unknown");
    expect(await open()).toHaveLength(1);
    await vote(LENA, `poll-${polls}`, `opt-${polls}-1`);
    expect(texts().at(-1)).toBe("Got it: Calm one.");
    expect(await open()).toEqual([]);
    // A second tap: it's said once that it's settled, and nothing changes.
    await vote(LENA, `poll-${polls}`, `opt-${polls}-0`);
    expect(texts().at(-1)).toContain("already answered");
  });

  it("when the poll can't be sent, the answers go as numbered text", async () => {
    refusePolls = true;
    try {
      const before = texts().length;
      await botAsks("Fussy", "Ship it?", ["Yes", "Not yet"]);
      expect(texts().slice(before)).toEqual(["Fussy asks: Ship it?", "1. Yes\n2. Not yet\n\nAnswer with the number or in your own words."]);
    } finally {
      refusePolls = false;
    }
  });
});

describe("Linq's rules: stop means stop, and Amb doesn't keep texting into silence", () => {
  it("knows a stop when it reads one, and an answer when it isn't", () => {
    for (const yes of ["STOP", "stop", "Stop.", "UNSUBSCRIBE", "opt out", "OPT-OUT", "optout", "CANCEL", "QUIT", "END", "please stop texting me", "Stop messaging me", "don't text me again", "Do not message me anymore.", "leave me alone", "Schreib mir nicht mehr", "keine Nachrichten mehr bitte"]) {
      expect(isOptOut(yes), yes).toBe(true);
    }
    for (const no of ["cancel", "end", "quit", "Stop the Chatty bot", "Please stop Bloggy from posting on Thursday", "Don't text Lena about it", "2", "Not now", "", "The end of the week works"]) {
      expect(isOptOut(no), no).toBe(false);
    }
  });

  it("what Amb writes first goes to the person, so Linq picks the line", async () => {
    await inbound(LENA, "ok, back to work");
    askLinqAgain();
    const before = firsts().length;
    expect(await tell("One thing needs you.")).toBe("imessage");
    const sent = firsts().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ to: [LENA], message: { parts: [{ type: "text", value: "One thing needs you." }] } });
    expect(sent[0]!.body).not.toHaveProperty("from");
    // The chat's health and the line's state were asked first.
    expect(calls.some((c) => c.method === "GET" && c.path === `/v3/chats/${CHAT}`)).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.path === "/v3/phone_numbers")).toBe(true);
  });

  it("after two that went unanswered it waits, and the push goes; a reply starts it again", async () => {
    pushes.length = 0;
    expect(await tell("A second thing.")).toBe("imessage");
    const before = texts().length;
    expect(await tell("A third thing.")).toBe("app");
    expect(texts().length).toBe(before);
    expect(pushes).toHaveLength(1);
    await inbound(LENA, "got them, thanks");
    expect(await tell("A fourth thing.")).toBe("imessage");
  });

  it("a critical chat or a flagged line gets nothing first, until Linq says otherwise", async () => {
    await inbound(LENA, "still here");
    chatHealth = "CRITICAL";
    askLinqAgain();
    expect(await tell("Held back by the chat.")).toBe("app");
    chatHealth = "HEALTHY";
    lineStatus = "FLAGGED";
    askLinqAgain();
    expect(await tell("Held back by the line.")).toBe("app");
    // Linq says the line is back: asked again at once, not after the 15 minutes.
    lineStatus = "ACTIVE";
    expect(await event({ event_type: "phone_number.status_updated", data: { phone_number: LINE, previous_status: "FLAGGED", new_status: "ACTIVE", previous_reputation: "CRITICAL", new_reputation: "HEALTHY" } })).toBe(200);
    (s.folders.imessage as unknown as { healths: Map<string, unknown> }).healths.clear();
    expect(await tell("The line is back.")).toBe("imessage");
    // An answer to what they wrote isn't held back by any of it.
    lineStatus = "FLAGGED";
    askLinqAgain();
    const before = texts().length;
    await inbound(LENA, "and now?");
    expect(texts().length).toBe(before + 1);
    lineStatus = "ACTIVE";
    askLinqAgain();
  });

  it("STOP: no answer from Amb, one line with the override, and nothing more by text", async () => {
    await call("PUT", "/v1/app/ambient/settings", { reach: "imessage" });
    const chatBefore = (await chat()).length;
    const before = calls.length;
    await inbound(LENA, "STOP");
    const after = calls.slice(before).filter((c) => c.path.endsWith("/messages"));
    expect(after).toHaveLength(1);
    expect(after[0]!.body).toMatchObject({ override_optout: true, message: { parts: [{ value: "Okay, I won't text you here anymore. Write to me here any time and I'll answer again." }] } });
    // Not a message to Amb: no turn, nothing in the chat.
    expect((await chat()).length).toBe(chatBefore);
    expect((await call("GET", "/v1/app/imessage")).json).toMatchObject({ connected: true, optedOut: true });
    expect((await call("GET", "/v1/app/ambient/settings")).json).toMatchObject({ reach: "app" });
    // A second STOP isn't confirmed again, and Amb writes first as a push even when asked for iMessage.
    await inbound(LENA, "stop texting me");
    expect(calls.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(1);
    await call("PUT", "/v1/app/ambient/settings", { reach: "imessage" });
    pushes.length = 0;
    expect(await tell("You should know this.")).toBe("app");
    expect(pushes).toHaveLength(1);
    expect(calls.slice(before).filter((c) => c.path.endsWith("/messages"))).toHaveLength(1);
  });

  it("writing again ends it", async () => {
    const before = texts().length;
    await inbound(LENA, "ok, text me again");
    expect(texts().length).toBe(before + 1);
    expect((await call("GET", "/v1/app/imessage")).json).toMatchObject({ optedOut: false });
    expect(await tell("Back on iMessage.")).toBe("imessage");
  });

  it("a send Linq refuses because they opted out there is remembered, not tried again", async () => {
    await inbound(LENA, "one more question");
    refuseSends = true;
    refuseCode = 2024;
    try {
      expect(await tell("Refused by Linq.")).toBe("app");
    } finally {
      refuseSends = false;
      refuseCode = 2027;
    }
    expect((await call("GET", "/v1/app/imessage")).json).toMatchObject({ optedOut: true });
    const before = calls.length;
    await call("PUT", "/v1/app/ambient/settings", { reach: "imessage" });
    expect(await tell("Not even tried.")).toBe("app");
    expect(calls.slice(before).filter((c) => c.path.endsWith("/messages"))).toEqual([]);
    // They write again: over, and the next tests start from iMessage.
    await inbound(LENA, "hello again");
    await call("PUT", "/v1/app/ambient/settings", { reach: "imessage" });
    expect((await call("GET", "/v1/app/imessage")).json).toMatchObject({ optedOut: false });
  });
});

describe("through MCP, and disconnecting", () => {
  it("connect_imessage and ambient_settings say and change the same things", async () => {
    const mcp = await mcpClient(`${s.origin}/mcp`, String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token));
    expect(text(await mcp.callTool({ name: "connect_imessage", arguments: {} }))).toContain("iMessage is connected (+43 ••• 4567)");
    expect(text(await mcp.callTool({ name: "ambient_settings", arguments: {} }))).toContain("first on iMessage");
    expect(text(await mcp.callTool({ name: "ambient_settings", arguments: { reach: "app" } }))).toContain("first in the app");
    expect(text(await mcp.callTool({ name: "ambient_settings", arguments: { reach: "imessage" } }))).toContain("first on iMessage");
    expect(text(await mcp.callTool({ name: "connect_imessage", arguments: { disconnect: true } }))).toContain("disconnected");
    // Nothing to text anymore: Amb writes first in the app again, and the number is a stranger's.
    expect((await call("GET", "/v1/app/ambient/settings")).json).toMatchObject({ reach: "app" });
    const before = (await chat()).length;
    await inbound(LENA, "Still there?");
    expect((await chat()).length).toBe(before);
    const again = text(await mcp.callTool({ name: "connect_imessage", arguments: {} }));
    expect(again).toMatch(/They text AMB-[A-Z2-9]{6} to \+14155550100/);
    await mcp.close();
  });

  it("answers 404 where no line is set up", async () => {
    const plain = await startStack({ ambient: {} });
    try {
      const ben = await signIn(plain, "apple-ben-imessage", "Ben Kraus");
      expect((await appCall(plain, ben.access_token, "GET", "/v1/app/imessage")).status).toBe(404);
      expect((await fetch(`${plain.origin}/v1/hooks/linq`, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
