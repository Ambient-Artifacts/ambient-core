// A bot's own Slack app (docs/bots.md, "Slack"), against a stand-in Slack Web API: the workspace
// connected once with a configuration token (renewed before it runs out), a bot's app made from a
// manifest and installed with one Allow, an @mention starting a run whose answer goes back to the
// Slack thread, and the bot's token in its runs.
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markdownToSlack, slackToPlain, splitText } from "../src/bots/slack-apps.ts";
import { appCall, appHeaders, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const info = { hostname: "srv-slack", os: "Linux 6.8", runner: "0.14.0", claude: "2.1.326 (Claude Code)" };
const SIGNING = "signing-secret-1";
const calls: { method: string; auth: string; args: Record<string, string> }[] = [];
let tokenLife = 12 * 3600;
let rotations = 0;
let slack: Server;
let s: Stack;
let lena: AppSession;
let host: string;
let bot = "";
let manifest: Record<string, unknown> = {};

const call = (method: string, path: string, body?: unknown) => appCall(s, lena.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const hookPath = () => new URL(String((manifest.settings as { event_subscriptions: { request_url: string } }).event_subscriptions.request_url)).pathname;
const sendEvent = async (payload: unknown, opts: { secret?: string; path?: string; ts?: number } = {}) => {
  const body = JSON.stringify(payload);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", opts.secret ?? SIGNING).update(`v0:${ts}:${body}`).digest("hex")}`;
  const res = await fetch(`${s.origin}${opts.path ?? hookPath()}`, { method: "POST", headers: { "content-type": "application/json", "x-slack-signature": sig, "x-slack-request-timestamp": ts }, body });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const posts = () => calls.filter((c) => c.method === "chat.postMessage");

beforeAll(async () => {
  slack = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const method = (req.url ?? "").replace(/^\//, "");
      const raw = Buffer.concat(chunks).toString("utf8");
      const type = String(req.headers["content-type"] ?? "");
      const args: Record<string, string> = type.startsWith("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(raw))
        : type.startsWith("application/json")
          ? (JSON.parse(raw) as Record<string, string>)
          : { multipart: raw.includes('name="app_id"') ? "yes" : "no" };
      calls.push({ method, auth: String(req.headers.authorization ?? ""), args });
      const json = (v: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
      switch (method) {
        case "tooling.tokens.rotate":
          if (!args.refresh_token?.startsWith("xoxe-")) return json({ ok: false, error: "invalid_refresh_token" });
          rotations++;
          return json({ ok: true, token: `xoxe.xoxp-1-config-${rotations}`, refresh_token: `xoxe-1-refresh-${rotations}`, team_id: "T1", user_id: "U_LENA", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + tokenLife });
        case "apps.manifest.create":
          if (!req.headers.authorization?.startsWith("Bearer xoxe.xoxp-1-config-")) return json({ ok: false, error: "invalid_auth" });
          manifest = JSON.parse(args.manifest!) as Record<string, unknown>;
          return json({ ok: true, app_id: "A1", credentials: { client_id: "111.222", client_secret: "client-secret", verification_token: "v", signing_secret: SIGNING }, oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111.222" });
        case "oauth.v2.access":
          if (args.code !== "good-code" || args.client_secret !== "client-secret") return json({ ok: false, error: "invalid_code" });
          return json({ ok: true, access_token: "xoxb-chatty", bot_user_id: "U_BOT", team: { id: "T1", name: "Miora" }, authed_user: { id: "U_LENA" } });
        case "users.info":
          return json({ ok: true, user: { real_name: "Lena Vogel", profile: { display_name: "Lena" } } });
        case "reactions.add":
        case "chat.postMessage":
        case "apps.manifest.delete":
        case "apps.icon.set":
          return json({ ok: true });
        default:
          return json({ ok: false, error: "unknown_method" });
      }
    });
  });
  await new Promise<void>((r) => slack.listen(0, "127.0.0.1", r));
  s = await startStack({ ambient: {}, slackApi: `http://127.0.0.1:${(slack.address() as AddressInfo).port}` });
  lena = await signIn(s, "apple-lena-slack", "Lena Vogel");
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
  const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string }[])[0]!.id;
  bot = ((await call("POST", "/v1/app/routines", { name: "Chatty", prompt: "Audit the traces.", schedule: { every: "needed", time: "09:00", timezone: "Europe/Vienna" }, computer, bot: {} })).json.routine as { id: string }).id;
});
afterAll(() => {
  s.close();
  slack.close();
});

describe("the workspace", () => {
  it("needs connecting before a bot can go to Slack", async () => {
    const out = await call("POST", `/v1/app/routines/${bot}/slack`);
    expect(out.status).toBe(400);
    expect(out.json.error).toBe("no_workspace");
  });

  it("connects with a configuration token's refresh token, renewed at once and kept sealed", async () => {
    expect((await call("PUT", "/v1/app/slack", { refreshToken: "nope-not-a-token" })).status).toBe(400);
    tokenLife = 600; // runs out in 10 minutes: the next use renews it
    const out = await call("PUT", "/v1/app/slack", { refreshToken: "xoxe-1-from-slack" });
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    expect(out.json).toMatchObject({ connected: true, teamId: "T1" });
    expect(rotations).toBe(1);
    expect((await call("GET", "/v1/app/slack")).json).toMatchObject({ connected: true, teamId: "T1" });
    const rows = await s.t.run(async (ctx) => ctx.db.query("records").collect());
    expect(JSON.stringify(rows)).not.toContain("xoxe");
  });
});

describe("a bot's own Slack app", () => {
  let url = "";

  it("is made from a manifest (the token renewed first), and one Allow link installs it", async () => {
    tokenLife = 12 * 3600;
    const out = await call("POST", `/v1/app/routines/${bot}/slack`);
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    expect(rotations).toBe(2);
    expect(calls.find((c) => c.method === "apps.manifest.create")!.auth).toBe("Bearer xoxe.xoxp-1-config-2");
    expect(manifest).toMatchObject({
      display_information: { name: "Chatty" },
      features: { bot_user: { display_name: "Chatty" } },
      oauth_config: { redirect_urls: [`${s.origin}/v1/slack/installed`] },
      settings: { event_subscriptions: { bot_events: ["app_mention", "message.im"] } },
    });
    expect(hookPath()).toMatch(/^\/v1\/hooks\/slack\/[\w-]+\.[\w-]+$/);
    url = String(out.json.url);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(u.searchParams.get("client_id")).toBe("111.222");
    expect(u.searchParams.get("team")).toBe("T1");
    expect(u.searchParams.get("redirect_uri")).toBe(`${s.origin}/v1/slack/installed`);
    expect(out.json.installed).toBe(false);
    // Asked again before it's installed: the same app, no second one.
    await call("POST", `/v1/app/routines/${bot}/slack`);
    expect(calls.filter((c) => c.method === "apps.manifest.create")).toHaveLength(1);
  });

  it("answers Slack's check of its event URL", async () => {
    const res = await fetch(`${s.origin}${hookPath()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url_verification", challenge: "abc123" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
    expect((await fetch(`${s.origin}/v1/hooks/slack/forged.sig`, { method: "POST", body: JSON.stringify({ type: "url_verification", challenge: "x" }) })).status).toBe(404);
  });

  it("is installed when Slack sends the browser back", async () => {
    const state = new URL(url).searchParams.get("state")!;
    const bad = await fetch(`${s.origin}/v1/slack/installed?code=bad&state=${encodeURIComponent(state)}`);
    expect(bad.status).toBe(502);
    const res = await fetch(`${s.origin}/v1/slack/installed?code=good-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Chatty is in Slack");
    expect((await call("GET", `/v1/app/routines/${bot}/slack`)).json).toMatchObject({ workspace: true, app: { appId: "A1", installed: true, botUserId: "U_BOT", teamName: "Miora" } });
    expect((await fetch(`${s.origin}/v1/slack/installed?code=good-code&state=forged.x`)).status).toBe(400);
  });

  it("takes an @mention from its installer: into its thread, a run starts, the answer goes back to the Slack thread", async () => {
    const event = { type: "event_callback", event_id: "Ev1", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> what broke last night? see <https://x.dev|the log>", channel: "C9", ts: "1700000000.0001" } };
    expect((await sendEvent(event)).status).toBe(200);
    // Slack sends it again (we were slow): taken once.
    expect((await sendEvent(event)).status).toBe(200);
    await s.folders.slack!.idle();
    const thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { author: string | null; text: string }[];
    const fromSlack = thread.filter((m) => m.author === "Slack");
    expect(fromSlack).toHaveLength(1);
    expect(fromSlack[0]!.text).toContain("Lena wrote to you on Slack (in a channel): what broke last night? see the log (https://x.dev)");
    expect(calls.some((c) => c.method === "reactions.add" && c.args.channel === "C9")).toBe(true);
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; env: Record<string, string>; resume: { message: string } | null };
    expect(start.env.SLACK_BOT_TOKEN).toBe("xoxb-chatty");
    // Its first run: the wake-up, with the Slack message among what's new in its thread.
    expect(start.resume?.message).toContain("Slack: Lena wrote to you on Slack (in a channel): what broke last night?");
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "**Two things** broke: [the digest](https://x.dev/1) and the scan." });
    await s.folders.slack!.idle();
    const answer = posts().at(-1)!;
    expect(answer.auth).toBe("Bearer xoxb-chatty");
    expect(answer.args).toMatchObject({ channel: "C9", thread_ts: "1700000000.0001", text: "*Two things* broke: <https://x.dev/1|the digest> and the scan." });
    // The next run (scheduled, nothing from Slack): its result stays out of Slack.
    const before = posts().length;
    const next = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${next.run.id}`, { status: "succeeded", summary: "Nightly audit done." });
    await s.folders.slack!.idle();
    expect(posts()).toHaveLength(before);
  });

  it("refuses a forged or stale event, and tells someone else once that it isn't theirs to steer", async () => {
    const e = { type: "event_callback", event_id: "Ev2", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> hi", channel: "C9", ts: "1700000000.0002" } };
    expect((await sendEvent(e, { secret: "wrong" })).status).toBe(401);
    expect((await sendEvent({ ...e, event_id: "Ev3" }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    const before = posts().length;
    const other = (id: string) => ({ type: "event_callback", event_id: id, event: { type: "app_mention", user: "U_MAX", text: "<@U_BOT> delete the repo", channel: "C9", ts: "1700000000.0005", thread_ts: "1700000000.0004" } });
    await sendEvent(other("Ev4"));
    await sendEvent(other("Ev5"));
    await s.folders.slack!.idle();
    expect(posts().length).toBe(before + 1);
    expect(posts().at(-1)!.args.text).toContain("only take instructions from <@U_LENA>");
    const thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { author: string | null; text: string }[];
    expect(thread.some((m) => m.text.includes("delete the repo"))).toBe(false);
    // Its own messages and edits: nothing.
    await sendEvent({ type: "event_callback", event_id: "Ev6", event: { type: "message", channel_type: "im", user: "U_BOT", bot_id: "B1", text: "echo", channel: "D1", ts: "1700000000.0006" } });
    await s.folders.slack!.idle();
    expect(posts().length).toBe(before + 1);
  });

  it("takes its face as its icon, and leaves Slack when it's taken out", async () => {
    const png = Buffer.alloc(64, 1);
    const iconUrl = `${s.origin}/v1/app/routines/${bot}/slack/icon`;
    const res = await fetch(iconUrl, { method: "PUT", headers: { ...(await appHeaders(lena.access_token, "PUT", iconUrl)), "content-type": "image/png" }, body: png });
    expect(res.status).toBe(204);
    expect(calls.find((c) => c.method === "apps.icon.set")!.args.multipart).toBe("yes");
    expect((await call("DELETE", `/v1/app/routines/${bot}/slack`)).status).toBe(204);
    expect(calls.find((c) => c.method === "apps.manifest.delete")!.args.app_id).toBe("A1");
    expect((await call("GET", `/v1/app/routines/${bot}/slack`)).json).toMatchObject({ workspace: true, app: null });
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; env: Record<string, string> };
    expect(start.env.SLACK_BOT_TOKEN).toBeUndefined();
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "ok" });
    expect((await sendEvent({ type: "event_callback", event_id: "Ev7", event: { type: "app_mention", user: "U_LENA", text: "hi", channel: "C9", ts: "1" } })).status).toBe(404);
  });
});

describe("over MCP (no app needed)", () => {
  it("connects Slack and puts a bot in Slack from the user's AI", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const mcp = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await mcp.callTool({ name: "connect_slack", arguments: {} }))).toContain("Slack is connected (workspace T1)");
    expect(text(await mcp.callTool({ name: "connect_slack", arguments: { refresh_token: "xoxe-1-again" } }))).toContain("Slack is connected");
    const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string }[])[0]!.id;
    const churny = ((await call("POST", "/v1/app/routines", { name: "Churny", prompt: "Why did they leave?", schedule: { every: "needed", time: "09:00", timezone: "Europe/Vienna" }, computer, bot: {} })).json.routine as { id: string }).id;
    const link = text(await mcp.callTool({ name: "slack_for_bot", arguments: { bot: churny } }));
    expect(link).toMatch(/^\[Add Churny to Slack\]\(https:\/\/slack\.com\/oauth\/v2\/authorize\?client_id=111\.222/);
    expect(manifest).toMatchObject({ display_information: { name: "Churny" } });
    expect(text(await mcp.callTool({ name: "slack_for_bot", arguments: { bot: churny, remove: true } }))).toBe("Churny's Slack app is deleted.");
    expect(text(await mcp.callTool({ name: "connect_slack", arguments: { disconnect: true } }))).toContain("disconnected");
    expect(text(await mcp.callTool({ name: "slack_for_bot", arguments: { bot: churny } }))).toContain("Connect your Slack workspace first");
  });
});

describe("text between Slack and a bot", () => {
  it("turns Markdown into Slack's markup, Slack's markup into text, and splits long answers", () => {
    expect(markdownToSlack("## Done\n**bold** and [a link](https://a.b/c) & <tags>\n```\n**kept**\n```")).toBe("*Done*\n*bold* and <https://a.b/c|a link> &amp; &lt;tags&gt;\n```\n**kept**\n```");
    expect(slackToPlain("see <#C1|general> and <https://a.b|this> &amp; <https://c.d>")).toBe("see #general and this (https://a.b) & https://c.d");
    const parts = splitText(`${"a".repeat(3000)}\n${"b".repeat(3000)}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("a".repeat(3000));
  });
});
