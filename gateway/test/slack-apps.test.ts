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
/** What Slack grants at Allow: an app from before channel names got none of the read scopes. */
let granted = "app_mentions:read,chat:write";
/** Slack's refusal for the next posts (a channel it was removed from). */
let postError = "";
let posted = 0;
let slackBase = "";
/** What the bot uploaded into Slack (files.getUploadURLExternal's URL). */
const uploads: { bytes: number; type: string }[] = [];
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082", "hex");

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
      // A file someone sent: only with the bot's token (Slack answers a sign-in page otherwise).
      if (method === "files/screenshot.png") {
        if (req.headers.authorization !== "Bearer xoxb-chatty") return res.writeHead(200, { "content-type": "text/html" }).end("<!DOCTYPE html><html>sign in</html>");
        return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
      }
      if (method === "upload/F1") {
        uploads.push({ bytes: Buffer.concat(chunks).length, type: type });
        return res.writeHead(200).end("OK");
      }
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
          if (args.code === "no-user") return json({ ok: true, access_token: "xoxb-x", bot_user_id: "U_BOT", team: { id: "T1", name: "Miora" } });
          if (args.code !== "good-code" || args.client_secret !== "client-secret") return json({ ok: false, error: "invalid_code" });
          return json({ ok: true, access_token: "xoxb-chatty", scope: granted, bot_user_id: "U_BOT", team: { id: "T1", name: "Miora" }, authed_user: { id: "U_LENA" } });
        case "apps.manifest.update":
          manifest = JSON.parse(args.manifest!) as Record<string, unknown>;
          return json({ ok: true, app_id: "A1" });
        case "conversations.info":
          return json({ ok: true, channel: { id: args.channel, name: args.channel === "C7" ? "anomalies" : "general" } });
        case "chat.postMessage":
          if (postError) return json({ ok: false, error: postError });
          return json({ ok: true, ts: `1800000000.000${++posted}` });
        case "users.info":
          if (args.user === "U_GUEST") return json({ ok: true, user: { real_name: "Gus", is_restricted: true, team_id: "T1", profile: { display_name: "Gus" } } });
          if (args.user === "U_EXT") return json({ ok: true, user: { real_name: "Eve", team_id: "T2", profile: { display_name: "Eve" } } });
          return json({ ok: true, user: { team_id: "T1", real_name: args.user === "U_LENA" ? "Lena Vogel" : "Max", profile: { display_name: args.user === "U_LENA" ? "Lena" : "Max", email: args.user === "U_LENA" ? "apple-lena-slack@example.com" : "max@other.example" } } });
        case "users.list":
          return json({ ok: true, members: [{ id: "U_LENA", real_name: "Lena Vogel", profile: { display_name: "Lena" } }, { id: "U_MAX", real_name: "Max", profile: { display_name: "Max" } }, { id: "U_GUEST", real_name: "Gus", is_restricted: true }, { id: "B_X", is_bot: true }, { id: "U_GONE", deleted: true }] });
        case "files.getUploadURLExternal":
          return json({ ok: true, upload_url: `${slackBase}/upload/F1`, file_id: "F1" });
        case "files.completeUploadExternal":
          return json({ ok: true, files: [{ id: "F1" }] });
        case "conversations.replies":
          return json({
            ok: true,
            messages: [
              { user: "U_MAX", text: "the export is broken again", ts: "1700000000.5" },
              { user: "U_LENA", text: "since this morning, see the screenshot", ts: "1700000000.6", files: [{ name: "error.png" }] },
              { user: "U_BOT", text: "I looked at it yesterday", ts: "1700000000.65" },
              { user: "U_LENA", text: "<@U_BOT> can you check again?", ts: "1700000000.7" },
            ],
          });
        case "chat.getPermalink":
          return json({ ok: true, permalink: `https://acme.slack.example/archives/${args.channel}/p${String(args.message_ts).replace(".", "")}` });
        case "chat.update":
          return json({ ok: true });
        case "reactions.add":
        case "apps.manifest.delete":
        case "apps.icon.set":
          return json({ ok: true });
        default:
          return json({ ok: false, error: "unknown_method" });
      }
    });
  });
  await new Promise<void>((r) => slack.listen(0, "127.0.0.1", r));
  slackBase = `http://127.0.0.1:${(slack.address() as AddressInfo).port}`;
  s = await startStack({ ambient: {}, slackApi: slackBase });
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
      settings: { event_subscriptions: { bot_events: ["app_mention", "message.im", "message.channels", "message.groups"] } },
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
    // Slack doesn't say who allowed it: not installed (it wouldn't know whom to listen to).
    expect((await fetch(`${s.origin}/v1/slack/installed?code=no-user&state=${encodeURIComponent(state)}`)).status).toBe(502);
    expect((await call("GET", `/v1/app/routines/${bot}/slack`)).json).toMatchObject({ app: { installed: false } });
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
    expect(fromSlack[0]!.text).toContain("Lena (your owner) wrote to you on Slack (in a channel): what broke last night? see the log (https://x.dev)");
    expect(calls.some((c) => c.method === "reactions.add" && c.args.channel === "C9")).toBe(true);
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; env: Record<string, string>; resume: { message: string } | null };
    expect(start.env.SLACK_BOT_TOKEN).toBe("xoxb-chatty");
    // Its first run: the wake-up, with the Slack message among what's new in its thread.
    expect(start.resume?.message).toContain("Slack: Lena (your owner) wrote to you on Slack (in a channel): what broke last night?");
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

  it("answers only from the run that took the Slack message: a run already going stays out of Slack", async () => {
    // A scheduled run is going when the mention comes in.
    const going = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await sendEvent({ type: "event_callback", event_id: "Ev10", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> status?", channel: "C7", ts: "1700000000.0010" } });
    await s.folders.slack!.idle();
    const before = posts().length;
    await hostCall(host, "POST", `/v1/host/runs/${going.run.id}`, { status: "succeeded", summary: "Private review of PR #12: …" });
    await s.folders.slack!.idle();
    expect(posts()).toHaveLength(before);
    // The next run takes it, and answers it there.
    const next = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${next.run.id}`, { status: "succeeded", summary: "All quiet." });
    await s.folders.slack!.idle();
    expect(posts()).toHaveLength(before + 1);
    expect(posts().at(-1)!.args).toMatchObject({ channel: "C7", thread_ts: "1700000000.0010", text: "All quiet." });
  });

  it("refuses a forged or stale event, and tells someone else once that it isn't theirs to steer", async () => {
    const e = { type: "event_callback", event_id: "Ev2", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> hi", channel: "C9", ts: "1700000000.0002" } };
    expect((await sendEvent(e, { secret: "wrong" })).status).toBe(401);
    expect((await sendEvent({ ...e, event_id: "Ev3" }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    // Only picked people (none): someone else is told who it listens to.
    await call("PUT", `/v1/app/routines/${bot}/askers`, { mode: "selected", people: [] });
    const before = posts().length;
    const other = (id: string) => ({ type: "event_callback", event_id: id, event: { type: "app_mention", user: "U_MAX", text: "<@U_BOT> delete the repo", channel: "C9", ts: "1700000000.0005", thread_ts: "1700000000.0004" } });
    await sendEvent(other("Ev4"));
    await sendEvent(other("Ev5"));
    await s.folders.slack!.idle();
    expect(posts().length).toBe(before + 1);
    expect(posts().at(-1)!.args.text).toContain("only take instructions from <@U_LENA>");
    const thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { author: string | null; text: string }[];
    expect(thread.some((m) => m.text.includes("delete the repo"))).toBe(false);
    await call("PUT", `/v1/app/routines/${bot}/askers`, { mode: "everyone" });
    // Its own messages and edits: nothing.
    await sendEvent({ type: "event_callback", event_id: "Ev6", event: { type: "message", channel_type: "im", user: "U_BOT", bot_id: "B1", text: "echo", channel: "D1", ts: "1700000000.0006" } });
    await s.folders.slack!.idle();
    expect(posts().length).toBe(before + 1);
  });

  type News = { channel: { id: string; name?: string } | null; channels: { id: string; name?: string }[]; names: boolean; files: boolean; broken: string | null };
  const news = async () => (await call("GET", `/v1/app/routines/${bot}/slack`)).json.news as News;
  /** A run of the bot's, with the gateway's MCP as the run sees it. */
  const asBot = async () => {
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; runToken: string; routine: { prompt: string }; resume: { message: string } | null };
    const mcp = await mcpClient(`${s.origin}/mcp`, start.runToken);
    return { start, mcp, end: async () => (await mcp.close(), await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "" }), await s.folders.slack!.idle()) };
  };

  it("posts news of its own in the channel it was first mentioned in, and hears replies under that post", async () => {
    // Mentioned in C9 above: that's where its news goes, by its id while the name can't be read.
    expect(await news()).toMatchObject({ channel: { id: "C9" }, names: false, broken: null });
    expect((await news()).channels[0]).toEqual({ id: "C9" });
    const run = await asBot();
    // The run is told it's in Slack and how to post.
    expect(run.start.routine.prompt).toContain("You're in Slack as @Chatty (Miora)");
    expect(run.start.routine.prompt).toContain("post_to_slack");
    const before = posts().length;
    const out = await run.mcp.callTool({ name: "post_to_slack", arguments: { text: "**Sign-ups dropped** to 4 yesterday." } });
    expect(text(out)).toContain("Posted in your Slack channel");
    expect(posts()).toHaveLength(before + 1);
    const post = posts().at(-1)!;
    expect(post.auth).toBe("Bearer xoxb-chatty");
    expect(post.args).toMatchObject({ channel: "C9", text: "*Sign-ups dropped* to 4 yesterday." });
    expect(post.args.thread_ts).toBeUndefined();
    // The bot's own tools only: nothing of its owner's.
    const names = (await run.mcp.listTools()).tools.map((t) => t.name);
    expect(names).toContain("post_to_slack");
    expect(names).not.toContain("slack_for_bot");
    await run.end();
    // A reply in the thread under its post reaches it without a mention; one elsewhere doesn't.
    const ts = `1800000000.000${posted}`;
    await sendEvent({ type: "event_callback", event_id: "EvN1", event: { type: "message", channel_type: "channel", user: "U_LENA", text: "since when?", channel: "C9", ts: "1800000001.0001", thread_ts: ts } });
    await sendEvent({ type: "event_callback", event_id: "EvN2", event: { type: "message", channel_type: "channel", user: "U_LENA", text: "lunch anyone?", channel: "C9", ts: "1800000002.0001" } });
    await sendEvent({ type: "event_callback", event_id: "EvN3", event: { type: "message", channel_type: "channel", user: "U_LENA", text: "unrelated thread", channel: "C9", ts: "1800000003.0001", thread_ts: "1700000000.9999" } });
    await s.folders.slack!.idle();
    const thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { author: string | null; text: string }[];
    expect(thread.some((m) => m.text.includes("Lena (your owner) wrote to you on Slack (in the thread under your post): since when?"))).toBe(true);
    expect(thread.some((m) => m.text.includes("lunch anyone?") || m.text.includes("unrelated thread"))).toBe(false);
    // Its answer to that goes back under its post.
    const answering = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${answering.run.id}`, { status: "succeeded", summary: "Since Friday." });
    await s.folders.slack!.idle();
    expect(posts().at(-1)!.args).toMatchObject({ channel: "C9", thread_ts: ts, text: "Since Friday." });
  });

  it("its owner picks the channel, or none; a channel that's gone is said, not retried silently", async () => {
    await sendEvent({ type: "event_callback", event_id: "EvN4", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> you're in here now", channel: "C7", ts: "1800000004.0001" } });
    await s.folders.slack!.idle();
    const drain = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${drain.run.id}`, { status: "succeeded", summary: "Hello." });
    await s.folders.slack!.idle();
    expect((await news()).channels.map((c) => c.id)).toEqual(["C9", "C7"]);
    // Still the first one until another is chosen; a channel it was never in can't be.
    expect((await news()).channel).toMatchObject({ id: "C9" });
    expect((await call("PUT", `/v1/app/routines/${bot}/slack/news`, { channel: "CX" })).status).toBe(400);
    expect(((await call("PUT", `/v1/app/routines/${bot}/slack/news`, { channel: "C7" })).json.news as News).channel).toMatchObject({ id: "C7" });
    // None: the tool says so, and nothing goes to Slack.
    await call("PUT", `/v1/app/routines/${bot}/slack/news`, { channel: null });
    expect((await news()).channel).toBe(null);
    let run = await asBot();
    expect(run.start.routine.prompt).toContain("No channel is chosen for news of your own");
    let before = posts().length;
    const refused = await run.mcp.callTool({ name: "post_to_slack", arguments: { text: "anything" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("No Slack channel is chosen");
    expect(posts()).toHaveLength(before);
    await run.end();
    // Removed from the channel: the bot hears why, and its page says it until one works or another is chosen.
    await call("PUT", `/v1/app/routines/${bot}/slack/news`, { channel: "C7" });
    postError = "not_in_channel";
    run = await asBot();
    const gone = await run.mcp.callTool({ name: "post_to_slack", arguments: { text: "an alert" } });
    postError = "";
    expect(gone.isError).toBe(true);
    expect(text(gone)).toContain("can't post");
    expect((await news()).broken).toBe("not_in_channel");
    await run.end();
    run = await asBot();
    expect(run.start.routine.prompt).toContain("No channel is chosen for news of your own");
    await run.end();
    // Choosing again clears it.
    expect(((await call("PUT", `/v1/app/routines/${bot}/slack/news`, { channel: "C7" })).json.news as News).broken).toBe(null);
  });

  it("an app from before channel names is brought up to date with one more Allow, and then names its channels", async () => {
    const allow = await call("POST", `/v1/app/routines/${bot}/slack/allow`);
    expect(allow.status).toBe(200);
    expect(calls.find((c) => c.method === "apps.manifest.update")!.args.app_id).toBe("A1");
    expect((manifest.oauth_config as { scopes: { bot: string[] } }).scopes.bot).toEqual(expect.arrayContaining(["channels:read", "groups:read"]));
    const link = new URL(String(allow.json.url));
    expect(link.searchParams.get("scope")).toContain("channels:read");
    granted = "app_mentions:read,chat:write,channels:read,groups:read";
    const back = await fetch(`${s.origin}/v1/slack/installed?code=good-code&state=${encodeURIComponent(link.searchParams.get("state")!)}`, { redirect: "manual" });
    expect(back.status).toBeLessThan(400);
    // What it had (its channels, its choice) is kept, and names can be read now.
    expect(await news()).toMatchObject({ channel: { id: "C7" }, names: true });
    await sendEvent({ type: "event_callback", event_id: "EvN5", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> hi again", channel: "C7", ts: "1800000005.0001" } });
    await s.folders.slack!.idle();
    const drain = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; routine: { prompt: string }; resume: { message: string } | null };
    await hostCall(host, "POST", `/v1/host/runs/${drain.run.id}`, { status: "succeeded", summary: "Hi." });
    await s.folders.slack!.idle();
    expect((await news()).channel).toEqual({ id: "C7", name: "anomalies" });
    // From the owner's AI: the same choice, by the same function.
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const mcp = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await mcp.callTool({ name: "slack_for_bot", arguments: { bot, news_channel: "none" } }))).toContain("stays in the Ambient app");
    expect(text(await mcp.callTool({ name: "slack_for_bot", arguments: { bot, news_channel: "C7" } }))).toContain("posts its news in #anomalies");
    expect(text(await mcp.callTool({ name: "slack_for_bot", arguments: { bot } }))).toContain("Its own news goes to #anomalies");
    await mcp.close();
  });

  it("takes the files sent with a message once it may (a screenshot reaches its run), and sends its own into the thread", async () => {
    const shot = { id: "F9", name: "screenshot.png", mimetype: "image/png", size: PNG.length, url_private_download: `${slackBase}/files/screenshot.png` };
    // An app from before files: the bot hears there was a file, and why it didn't get it.
    await sendEvent({ type: "event_callback", event_id: "EvF1", event: { type: "message", subtype: "file_share", channel_type: "im", user: "U_LENA", text: "look at this", channel: "D1", ts: "1800000010.0001", files: [shot] } });
    await s.folders.slack!.idle();
    let thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { author: string | null; text: string; files: { id: string; name: string }[] }[];
    expect(thread.at(-1)!.text).toContain("look at this");
    expect(thread.at(-1)!.text).toContain("screenshot.png (this bot's Slack app may not open files yet");
    expect(thread.at(-1)!.files).toEqual([]);
    let drain = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${drain.run.id}`, { status: "succeeded", summary: "I can't see it." });
    await s.folders.slack!.idle();
    // One more Allow, with the files scopes: the next one arrives.
    expect((await news()).files).toBe(false);
    const allow = await call("POST", `/v1/app/routines/${bot}/slack/allow`);
    expect((manifest.oauth_config as { scopes: { bot: string[] } }).scopes.bot).toEqual(expect.arrayContaining(["files:read", "files:write"]));
    granted = "app_mentions:read,chat:write,channels:read,groups:read,files:read,files:write";
    await fetch(`${s.origin}/v1/slack/installed?code=good-code&state=${encodeURIComponent(new URL(String(allow.json.url)).searchParams.get("state")!)}`, { redirect: "manual" });
    expect((await news()).files).toBe(true);
    // A screenshot with no text at all still reaches it.
    await sendEvent({ type: "event_callback", event_id: "EvF2", event: { type: "message", subtype: "file_share", channel_type: "im", user: "U_LENA", text: "", channel: "D1", ts: "1800000011.0001", files: [shot] } });
    await s.folders.slack!.idle();
    thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as typeof thread;
    const last = thread.at(-1)!;
    expect(last.text).toContain("Lena (your owner) wrote to you on Slack (in a direct message): sent a file");
    expect(last.files).toMatchObject([{ name: "screenshot.png" }]);
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; runToken: string; resume: { files?: { id: string; name: string }[] } | null };
    expect(start.resume?.files).toMatchObject([{ name: "screenshot.png" }]);
    const bytes = await fetch(`${s.origin}/v1/bot/files/${start.resume!.files![0]!.id}`, { headers: { authorization: `Bearer ${start.runToken}` } });
    expect(Buffer.from(await bytes.arrayBuffer()).equals(PNG)).toBe(true);
    // A file it sends (send_file) goes into that Slack thread, as an upload.
    const sent = await hostCall(start.runToken, "POST", "/v1/bot/reply", { text: "Here's the chart.", files: [{ name: "chart.png", type: "image/png", data: PNG.toString("base64") }] });
    expect(sent.status, JSON.stringify(sent.json)).toBe(204);
    await s.folders.slack!.idle();
    expect(uploads).toEqual([{ bytes: PNG.length, type: "image/png" }]);
    expect(calls.find((c) => c.method === "files.completeUploadExternal")!.args).toMatchObject({ channel_id: "D1", thread_ts: "1800000011.0001" });
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "Done." });
    await s.folders.slack!.idle();
  });

  it("reads the thread it's tagged in: what people said before, also to each other", async () => {
    await sendEvent({ type: "event_callback", event_id: "EvT1", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> can you check again?", channel: "C7", ts: "1700000000.7", thread_ts: "1700000000.5" } });
    await s.folders.slack!.idle();
    const thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { text: string }[];
    const last = thread.at(-1)!.text;
    expect(last).toContain("Lena (your owner) wrote to you on Slack (in #anomalies): can you check again?");
    expect(last).toContain("The thread so far (oldest first):\n- Max: the export is broken again\n- Lena: since this morning, see the screenshot [error.png]\n- you: I looked at it yesterday");
    expect(last).not.toContain("- Lena: @you can you check again?");
    const drain = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${drain.run.id}`, { status: "succeeded", summary: "Checked." });
    await s.folders.slack!.idle();
  });

  it("keeps a thread as a lane: the next mention there resumes that thread's session, with only what's new", async () => {
    await sendEvent({ type: "event_callback", event_id: "EvL1", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> and the totals?", channel: "C7", ts: "1700000000.8", thread_ts: "1700000000.5" } });
    await s.folders.slack!.idle();
    let start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; resume: { sessionId: string | null; message: string } | null };
    // A thread it answered before lanes has no session of its own yet: it starts fresh, with the thread.
    expect(start.resume?.sessionId ?? null).toBe(null);
    expect(start.resume?.message).toContain("The thread so far");
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "Totals look right.", sessionId: "thread-session-1" });
    await s.folders.slack!.idle();
    await sendEvent({ type: "event_callback", event_id: "EvL2", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> thanks, and March?", channel: "C7", ts: "1700000000.9", thread_ts: "1700000000.5" } });
    await s.folders.slack!.idle();
    start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as typeof start;
    expect(start.resume?.sessionId).toBe("thread-session-1");
    expect(start.resume?.message).toContain("thanks, and March?");
    expect(start.resume?.message).not.toContain("The thread so far");
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "March too.", sessionId: "thread-session-1" });
    await s.folders.slack!.idle();
    // In the app, the thread's messages and the bot's answers there carry its place: one card.
    const thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { role: string; text: string; lane: string | null; place: { label: string; url: string | null } | null }[];
    const inLane = thread.filter((m) => m.lane === "slack:C7:1700000000.5");
    // The mention in the test before was in this thread too: three asks, three answers.
    expect(inLane.map((m) => m.role)).toEqual(["user", "bot", "user", "bot", "user", "bot"]);
    expect(inLane[0]!.place).toEqual({ label: "#anomalies › the export is broken again", url: "https://acme.slack.example/archives/C7/p17000000005" });
    expect(inLane[1]!.place?.label).toBe("#anomalies › the export is broken again");
    // Its DM is the main lane: it resumes the bot's last conversation, as before.
    await sendEvent({ type: "event_callback", event_id: "EvL3", event: { type: "message", channel_type: "im", user: "U_LENA", text: "one more thing", channel: "D5", ts: "1800000040.0001" } });
    await s.folders.slack!.idle();
    start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as typeof start;
    expect(start.resume?.message).toContain("one more thing");
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "Ok." });
    await s.folders.slack!.idle();
  });

  it("asks with buttons: a click answers as its owner, the buttons then say so; a reply in the thread answers too", async () => {
    await sendEvent({ type: "event_callback", event_id: "EvQ1", event: { type: "message", channel_type: "im", user: "U_LENA", text: "ship the release?", channel: "D5", ts: "1800000030.0001" } });
    await s.folders.slack!.idle();
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; runToken: string };
    const q = String((await hostCall(start.runToken, "POST", "/v1/bot/ask", { question: "Ship **2.3** today?", choices: ["Yes", "Not yet"] })).json.id);
    await s.folders.slack!.idle();
    // Bots from before buttons get today's manifest first (no Allow needed).
    expect((manifest.settings as { interactivity?: { is_enabled: boolean; request_url: string } }).interactivity).toMatchObject({ is_enabled: true });
    const interactPath = new URL((manifest.settings as { interactivity: { request_url: string } }).interactivity.request_url).pathname;
    const question = posts().at(-1)!;
    expect(question.args).toMatchObject({ channel: "D5", thread_ts: "1800000030.0001" });
    const blocks = question.args.blocks as unknown as { type: string; elements?: { text: { text: string }; value: string }[] }[];
    expect(blocks[1]!.elements!.map((e) => e.text.text)).toEqual(["Yes", "Not yet"]);
    const click = async (user: string, value: string) => {
      const body = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", user: { id: user }, channel: { id: "D5" }, message: { ts: "1800000031.0001", thread_ts: "1800000030.0001", text: "Ship 2.3 today?" }, actions: [{ action_id: "choice-0", value }] }) }).toString();
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = `v0=${createHmac("sha256", SIGNING).update(`v0:${ts}:${body}`).digest("hex")}`;
      const res = await fetch(`${s.origin}${interactPath}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-signature": sig, "x-slack-request-timestamp": ts }, body });
      await s.folders.slack!.idle();
      return res.status;
    };
    // Someone else clicks: told who answers; still open.
    expect(await click("U_MAX", blocks[1]!.elements![0]!.value)).toBe(200);
    expect(String(posts().at(-1)!.args.text)).toContain("Only <@U_LENA> answers my questions");
    expect((await hostCall(start.runToken, "GET", `/v1/bot/questions/${q}`)).json).toEqual({ answer: null, author: null });
    // Lena clicks Yes.
    expect(await click("U_LENA", blocks[1]!.elements![0]!.value)).toBe(200);
    expect((await hostCall(start.runToken, "GET", `/v1/bot/questions/${q}`)).json).toEqual({ answer: "Yes", author: "Lena Vogel" });
    const update = calls.filter((c) => c.method === "chat.update").at(-1)!;
    expect(JSON.stringify(update.args)).toContain("✓ *Yes*");
    // A forged click: refused.
    const forged = await fetch(`${s.origin}${interactPath}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-signature": "v0=00", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)) }, body: "payload=%7B%7D" });
    expect(forged.status).toBe(401);
    // The next question, answered by a reply in the thread.
    const q2 = String((await hostCall(start.runToken, "POST", "/v1/bot/ask", { question: "Release notes channel?", choices: [] })).json.id);
    await s.folders.slack!.idle();
    await sendEvent({ type: "event_callback", event_id: "EvQ2", event: { type: "message", channel_type: "im", user: "U_LENA", text: "#releases", channel: "D5", ts: "1800000032.0001", thread_ts: "1800000030.0001" } });
    await s.folders.slack!.idle();
    expect((await hostCall(start.runToken, "GET", `/v1/bot/questions/${q2}`)).json).toEqual({ answer: "#releases", author: "Lena Vogel" });
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "Shipped." });
    await s.folders.slack!.idle();
  });

  it("everyone in the workspace can ask it by default; guests and other workspaces only once picked", async () => {
    const said = async (t: string) => ((await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { author: string | null; text: string }[]).filter((m) => m.author === "Slack" && m.text.includes(t));
    await sendEvent({ type: "event_callback", event_id: "EvW1", event: { type: "app_mention", user: "U_MAX", text: "<@U_BOT> what broke?", channel: "C9", ts: "1800000030.0001" } });
    await s.folders.slack!.idle();
    const max = await said("what broke?");
    expect(max).toHaveLength(1);
    expect(max[0]!.text).toContain("Max wrote to you on Slack");
    // A guest and someone from another workspace (Slack Connect): told, and nothing reaches it.
    await sendEvent({ type: "event_callback", event_id: "EvW2", event: { type: "app_mention", user: "U_GUEST", text: "<@U_BOT> guest hi", channel: "C9", ts: "1800000031.0001" } });
    await sendEvent({ type: "event_callback", event_id: "EvW3", event: { type: "app_mention", user: "U_EXT", text: "<@U_BOT> ext hi", channel: "C9", ts: "1800000032.0001" } });
    await s.folders.slack!.idle();
    expect(await said("guest hi")).toHaveLength(0);
    expect(await said("ext hi")).toHaveLength(0);
    expect(String(posts().at(-1)!.args.text)).toContain("I only take instructions from <@U_LENA>");
    // The picker: Slack's people (no bots, no deactivated, not its owner), who's picked, who added it.
    const page = (await call("GET", `/v1/app/routines/${bot}/askers`)).json as { mode: string; owners: unknown[]; candidates: { via: string; id: string; name: string; guest?: boolean }[] };
    expect(page.mode).toBe("everyone");
    expect(page.owners).toEqual([{ via: "slack", id: "U_LENA", name: "Lena" }]);
    expect(page.candidates.filter((c) => c.via === "slack").map((c) => c.id)).toEqual(["U_GUEST", "U_MAX"]);
    expect(page.candidates.find((c) => c.id === "U_GUEST")!.guest).toBe(true);
    // Picked: the guest can ask; with only picked people, Max can't any more.
    await call("PUT", `/v1/app/routines/${bot}/askers`, { mode: "selected", people: [{ via: "slack", id: "U_GUEST", name: "Gus" }] });
    await sendEvent({ type: "event_callback", event_id: "EvW4", event: { type: "app_mention", user: "U_GUEST", text: "<@U_BOT> guest now?", channel: "C9", ts: "1800000033.0001" } });
    await sendEvent({ type: "event_callback", event_id: "EvW5", event: { type: "app_mention", user: "U_MAX", text: "<@U_BOT> and me?", channel: "C9", ts: "1800000034.0001" } });
    await s.folders.slack!.idle();
    expect(await said("guest now?")).toHaveLength(1);
    expect(await said("and me?")).toHaveLength(0);
    expect(String(posts().at(-1)!.args.text)).toContain("<@U_LENA> and <@U_GUEST>");
    // Over MCP too.
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude askers" })).json.token);
    const mcp = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await mcp.callTool({ name: "who_can_ask_bot", arguments: { bot, mode: "everyone" } }))).toContain("Everyone in the company can ask Chatty");
    await mcp.close();
    // Drain what's waiting, for the tests after.
    const drain = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${drain.run.id}`, { status: "succeeded", summary: "Looked." });
    await s.folders.slack!.idle();
  });

  it("posts an answer once: a result that repeats what the run already said isn't posted again", async () => {
    await sendEvent({ type: "event_callback", event_id: "EvD1", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> status?", channel: "C9", ts: "1800000040.0001" } });
    await s.folders.slack!.idle();
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; runToken: string };
    const before = posts().length;
    await hostCall(start.runToken, "POST", "/v1/bot/reply", { text: "All green since Friday." });
    await s.folders.slack!.idle();
    expect(posts()).toHaveLength(before + 1);
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "All green since Friday." });
    await s.folders.slack!.idle();
    expect(posts()).toHaveLength(before + 1);
    // Something new at the end still goes.
    await sendEvent({ type: "event_callback", event_id: "EvD2", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> and now?", channel: "C9", ts: "1800000041.0001" } });
    await s.folders.slack!.idle();
    const next = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; runToken: string };
    await hostCall(next.runToken, "POST", "/v1/bot/reply", { text: "Checking." });
    await hostCall(host, "POST", `/v1/host/runs/${next.run.id}`, { status: "succeeded", summary: "Export fixed." });
    await s.folders.slack!.idle();
    expect(posts().slice(-2).map((p) => p.args.text)).toEqual(["Checking.", "Export fixed."]);
  });

  it("puts Ambient itself in the workspace: a direct message is the writer's own Amb chat, answered there", async () => {
    const add = await call("POST", "/v1/app/slack/ambient", { name: "Acme Brain" });
    expect(add.status, JSON.stringify(add.json)).toBe(200);
    expect(manifest).toMatchObject({ display_information: { name: "Acme Brain" } });
    expect((manifest.oauth_config as { scopes: { bot: string[] } }).scopes.bot).toContain("users:read.email");
    const ambHook = hookPath();
    expect(new URL(String(add.json.url)).searchParams.get("scope")).toContain("users:read.email");
    await fetch(`${s.origin}/v1/slack/installed?code=good-code&state=${encodeURIComponent(new URL(String(add.json.url)).searchParams.get("state")!)}`, { redirect: "manual" });
    expect((await call("GET", "/v1/app/slack/ambient")).json).toMatchObject({ workspace: true, app: { name: "Acme Brain", installed: true } });
    // Lena writes to it directly: her own Amb chat takes it, and the answer comes back in that DM.
    const before = posts().length;
    await sendEvent({ type: "event_callback", event_id: "EvA1", event: { type: "message", channel_type: "im", user: "U_LENA", text: "what's waiting on me?", channel: "DA", ts: "1800000020.0001" } }, { path: ambHook });
    await s.folders.slack!.idle();
    const answer = posts().slice(before).find((p) => p.args.channel === "DA");
    expect(answer, JSON.stringify(posts().slice(before))).toBeDefined();
    expect(answer!.args.thread_ts).toBeUndefined();
    const chat = (await call("GET", "/v1/app/ambient/chat")).json as { messages: { role: string; text: string; via?: string | null }[] };
    expect(chat.messages.some((m) => m.role === "user" && m.text.includes("what's waiting on me?"))).toBe(true);
    // "new chat" typed in the DM starts over, as New chat in the app.
    await sendEvent({ type: "event_callback", event_id: "EvA0", event: { type: "message", channel_type: "im", user: "U_LENA", text: "new chat", channel: "DA", ts: "1800000020.0002" } }, { path: ambHook });
    await s.folders.slack!.idle();
    expect(String(posts().at(-1)!.args.text)).toContain("New chat: I'm starting fresh");
    const after = (await call("GET", "/v1/app/ambient/chat")).json as { messages: { role: string; text: string }[] };
    expect(after.messages.some((m) => m.text.includes("what's waiting on me?"))).toBe(false);
    // Someone with no Ambient account: told so once, and nothing reaches anyone's chat.
    await sendEvent({ type: "event_callback", event_id: "EvA2", event: { type: "message", channel_type: "im", user: "U_MAX", text: "hi", channel: "DM2", ts: "1800000021.0001" } }, { path: ambHook });
    await s.folders.slack!.idle();
    expect(String(posts().at(-1)!.args.text)).toContain("no Ambient account here has the email max@other.example");
    // In a channel of a workspace connected for one person: no team brain to answer from.
    await sendEvent({ type: "event_callback", event_id: "EvA3", event: { type: "app_mention", user: "U_LENA", text: "<@U_BOT> what's new?", channel: "C9", ts: "1800000022.0001" } }, { path: ambHook });
    await s.folders.slack!.idle();
    expect(String(posts().at(-1)!.args.text)).toContain("connected for one person");
    // Its Slack door can be where Amb writes first.
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude amb" })).json.token);
    const mcp = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await mcp.callTool({ name: "connect_slack", arguments: { ambient: "status" } }))).toContain("Acme Brain");
    await mcp.close();
    expect((await call("DELETE", "/v1/app/slack/ambient")).status).toBe(204);
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
