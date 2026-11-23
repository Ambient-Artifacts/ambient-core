// A bot's own Microsoft Teams app (docs/bots.md, "Microsoft Teams"), against a stand-in Microsoft:
// an admin connects the company once (sign-in, Azure subscription, resource group), a bot gets
// its app registration, Azure Bot and Teams app in one call, a message from its owner starts a
// run whose answer goes back to the Teams thread, and news goes to the one channel chosen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InboundError, type Activity } from "../src/msteams/botframework.ts";
import { pngSize, teamsManifest, unzip, zip } from "../src/bots/teams-package.ts";
import { teamsToPlain } from "../src/bots/teams-apps.ts";
import { appCall, appHeaders, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const info = { hostname: "srv-teams", os: "Linux 6.8", runner: "0.14.0", claude: "2.1.326 (Claude Code)" };
const TENANT = "aaaaaaaa-0000-0000-0000-000000000001";
const ADMIN = "bbbbbbbb-0000-0000-0000-000000000001";
const LENA = "cccccccc-0000-0000-0000-000000000001";
const STRANGER = "dddddddd-0000-0000-0000-000000000001";
const SERVICE = "https://smba.trafficmanager.net/emea/";
const BOT_APP = "eeeeeeee-0000-0000-0000-000000000001";

interface Seen {
  method: string;
  url: string;
  auth: string;
  body: string | Buffer | null;
}
const seen: Seen[] = [];
let refreshes = 0;
/** Graph's answer to publishing in the app catalog (403: the admin isn't a Teams admin). */
let catalogStatus = 201;
/** Azure says the new app registration isn't there yet, this many times. */
let armNotYet = 1;
let published: Map<string, Buffer> | null = null;
let sent: { conv: string; body: Record<string, unknown> }[] = [];
let updated: { conv: string; id: string; body: Record<string, unknown> }[] = [];

const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The stand-in Microsoft: login, Graph, Azure Resource Manager, and Teams' Bot Connector. */
const microsoft: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const raw = init?.body;
  const body = raw instanceof Uint8Array ? Buffer.from(raw) : typeof raw === "string" ? raw : null;
  const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
  seen.push({ method, url: url.toString(), auth, body });
  if (url.hostname === "login.microsoftonline.com") {
    const form = new URLSearchParams(String(body));
    if (form.get("client_id") === BOT_APP) return json(200, { access_token: "bot-token", expires_in: 3600 });
    if (form.get("grant_type") === "authorization_code") {
      if (form.get("code") !== "good-code" || form.get("client_secret") !== "setup-app-secret") return json(400, { error: "invalid_grant", error_description: "AADSTS70000: bad code" });
      return json(200, { access_token: "graph-1", refresh_token: "refresh-1", expires_in: 3600, id_token: idToken({ tid: TENANT, oid: ADMIN, name: "Heiko Admin", preferred_username: "heiko@aleas.example" }) });
    }
    refreshes++;
    const scope = form.get("scope") ?? "";
    return json(200, { access_token: scope.includes("management.azure.com") ? `arm-${refreshes}` : `graph-r${refreshes}`, refresh_token: `refresh-${refreshes + 1}`, expires_in: 3600 });
  }
  if (url.hostname === "management.azure.com") {
    if (!auth.startsWith("Bearer arm-")) return json(401, { error: { code: "InvalidAuthenticationToken" } });
    if (url.pathname === "/subscriptions" && method === "GET") return json(200, { value: [{ subscriptionId: "sub-off", displayName: "Old", state: "Disabled" }, { subscriptionId: "sub-1", displayName: "ALEAS Production", state: "Enabled" }] });
    if (url.pathname.endsWith("/providers/Microsoft.BotService/register")) return json(200, { registrationState: "Registered" });
    if (/\/resourcegroups\/ambient-bots$/.test(url.pathname)) return json(201, { name: "ambient-bots" });
    if (/\/botServices\/[^/]+$/.test(url.pathname) && method === "PUT") {
      if (armNotYet-- > 0) return json(400, { error: { code: "InvalidBotData", message: "Msa app id not found" } });
      return json(201, { name: url.pathname.split("/").pop() });
    }
    if (url.pathname.endsWith("/channels/MsTeamsChannel")) return json(200, {});
    if (method === "DELETE") return json(200, {});
    return json(404, { error: { code: "NotFound" } });
  }
  if (url.hostname === "graph.microsoft.com") {
    if (!auth.startsWith("Bearer graph-")) return json(401, { error: { code: "InvalidAuthenticationToken" } });
    const path = url.pathname.replace(/^\/v1\.0/, "");
    if (path === "/applications" && method === "POST") return json(201, { id: "app-object-1", appId: BOT_APP });
    if (path === "/applications/app-object-1/addPassword") return json(200, { secretText: "bot-secret", endDateTime: "2028-11-23T00:00:00Z" });
    if (path === "/servicePrincipals") return json(201, { id: "sp-1" });
    if (path === "/appCatalogs/teamsApps" && method === "POST") {
      if (catalogStatus !== 201) return json(catalogStatus, { error: { code: "Forbidden", message: "Insufficient privileges" } });
      published = unzip(body as Buffer);
      return json(201, { id: "catalog-1" });
    }
    if (path === "/appCatalogs/teamsApps/catalog-1/appDefinitions") {
      published = unzip(body as Buffer);
      return json(201, { id: "def-2" });
    }
    if (path.startsWith("/users/")) {
      const who = decodeURIComponent(path.slice(7));
      return who === "apple-lena-teams@example.com" ? json(200, { id: LENA, displayName: "Lena Vogel" }) : json(404, { error: { code: "Request_ResourceNotFound" } });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json(404, { error: { code: "NotFound" } });
  }
  if (url.origin + "/" === new URL(SERVICE).origin + "/" && url.pathname.startsWith("/emea/v3/conversations/")) {
    if (auth !== "Bearer bot-token") return json(401, {});
    const conv = decodeURIComponent(url.pathname.split("/")[4]!);
    const b = JSON.parse(String(body)) as Record<string, unknown>;
    if (method === "PUT") {
      updated.push({ conv, id: decodeURIComponent(url.pathname.split("/")[6]!), body: b });
      return json(200, { id: "updated" });
    }
    if (b.type === "message") sent.push({ conv, body: b });
    return json(201, { id: `msg-${sent.length}` });
  }
  return json(404, {});
};

/** Signed for the bot when the header says so (the Bot Framework's JWT is checked in msteams.test.ts). */
const verifier = {
  async verify(authorization: string | undefined, appId: string): Promise<void> {
    if (authorization !== `Bearer bf-for-${appId}`) throw new InboundError("bad token");
  },
};

let s: Stack;
let lena: AppSession;
let host: string;
let bot = "";
let hook = "";
const call = (method: string, path: string, body?: unknown) => appCall(s, lena.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const activity = (a: Partial<Activity> & { text?: string }): Activity => ({
  type: "message",
  id: `act-${Math.random().toString(36).slice(2)}`,
  serviceUrl: SERVICE,
  channelId: "msteams",
  from: { id: "29:lena", name: "Lena Vogel", aadObjectId: LENA },
  conversation: { id: "a:dm-lena", conversationType: "personal", tenantId: TENANT },
  recipient: { id: `28:${BOT_APP}`, name: "Chatty" },
  ...a,
});
const send = async (a: Activity, auth = `Bearer bf-for-${BOT_APP}`, path = hook) => {
  const res = await fetch(`${s.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(a) });
  await s.folders.teams!.idle();
  return res.status;
};

beforeAll(async () => {
  s = await startStack({ ambient: {}, teamsApps: { fetchImpl: microsoft, verifier } });
  lena = await signIn(s, "apple-lena-teams", "Lena Vogel");
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
  const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string }[])[0]!.id;
  bot = ((await call("POST", "/v1/app/routines", { name: "Chatty", prompt: "Audit the traces.", schedule: { every: "needed", time: "09:00", timezone: "Europe/Vienna" }, computer, bot: {} })).json.routine as { id: string }).id;
});
afterAll(() => s.close());

describe("the package", () => {
  it("is a zip Teams reads: the manifest and two icons of the right sizes", () => {
    const m = teamsManifest({ manifestId: "11111111-2222-3333-4444-555555555555", version: "1.0.1", botAppId: BOT_APP, name: "A bot with a rather long name indeed", website: "https://ambient.example/" });
    expect(m).toMatchObject({ manifestVersion: "1.17", id: "11111111-2222-3333-4444-555555555555", developer: { privacyUrl: "https://ambient.example/privacy" }, bots: [{ botId: BOT_APP, scopes: ["personal", "team", "groupChat"] }] });
    expect((m.name as { short: string }).short.length).toBeLessThanOrEqual(30);
    const files = unzip(zip([{ name: "a.txt", data: Buffer.from("hello") }]));
    expect(files.get("a.txt")!.toString()).toBe("hello");
  });

  it("reads Teams' HTML as plain text", () => {
    expect(teamsToPlain("<p><at>Chatty</at>&nbsp;what broke? see <a href=\"https://x.dev\">the log</a></p><p>thanks &amp; bye</p>")).toBe("what broke? see the log (https://x.dev)\nthanks & bye");
  });
});

describe("connecting the company", () => {
  it("needs connecting before a bot can go to Teams", async () => {
    const out = await call("POST", `/v1/app/routines/${bot}/teams`);
    expect(out.status).toBe(400);
    expect(out.json.error).toBe("no_tenant");
  });

  it("an admin signs in once: tenant, the first subscription that's on, a resource group for the bots", async () => {
    const out = await call("POST", "/v1/app/teams/connect");
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    const u = new URL(String(out.json.url));
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe(`${s.origin}/v1/teams/connected`);
    expect(u.searchParams.get("scope")).toContain("https://management.azure.com/user_impersonation");
    expect(u.searchParams.get("scope")).toContain("AppCatalog.ReadWrite.All");
    const state = u.searchParams.get("state")!;
    expect((await fetch(`${s.origin}/v1/teams/connected?code=bad&state=${encodeURIComponent(state)}`)).status).toBe(400);
    expect((await fetch(`${s.origin}/v1/teams/connected?code=good-code&state=forged.x`)).status).toBe(400);
    const res = await fetch(`${s.origin}/v1/teams/connected?code=good-code&state=${encodeURIComponent(state)}`);
    const page = await res.text();
    expect(res.status, page).toBe(200);
    expect(page).toContain("ALEAS Production");
    expect(seen.some((c) => c.method === "PUT" && c.url.includes("/subscriptions/sub-1/resourcegroups/ambient-bots"))).toBe(true);
    expect(seen.some((c) => c.url.includes("/subscriptions/sub-1/providers/Microsoft.BotService/register"))).toBe(true);
    expect((await call("GET", "/v1/app/teams")).json).toMatchObject({ connected: true, tenantId: TENANT, admin: "Heiko Admin", subscription: { id: "sub-1", name: "ALEAS Production" } });
    const rows = await s.t.run(async (ctx) => ctx.db.query("records").collect());
    expect(JSON.stringify(rows)).not.toContain("refresh-");
  });
});

describe("a bot's own Teams app", () => {
  it("is refused with the role the admin lacks when Teams won't take the app", async () => {
    catalogStatus = 403;
    const out = await call("POST", `/v1/app/routines/${bot}/teams`);
    expect(out.status).toBe(403);
    expect(String(out.json.message)).toContain("Teams admin");
    catalogStatus = 201;
  });

  it("goes on where it stopped: app registration, secret, Azure Bot and Teams app made once each", async () => {
    const out = await call("POST", `/v1/app/routines/${bot}/teams`);
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    expect(out.json).toMatchObject({ ready: true, installed: false, installer: "Lena Vogel", chatUrl: `https://teams.microsoft.com/l/chat/0/0?users=28:${BOT_APP}` });
    expect(String(out.json.url)).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/app\/[0-9a-f-]{36}$/);
    expect(seen.filter((c) => c.method === "POST" && c.url.endsWith("/v1.0/applications"))).toHaveLength(1);
    expect(seen.filter((c) => c.url.includes("/addPassword"))).toHaveLength(1);
    // Azure didn't know the new app yet: asked again.
    const botPut = seen.filter((c) => c.method === "PUT" && /\/botServices\/ambient-chatty-[0-9a-f]{8}\?/.test(c.url));
    expect(botPut).toHaveLength(2);
    const props = (JSON.parse(String(botPut[1]!.body)) as { properties: { endpoint: string; msaAppType: string; msaAppTenantId: string; msaAppId: string } }).properties;
    expect(props).toMatchObject({ msaAppType: "SingleTenant", msaAppTenantId: TENANT, msaAppId: BOT_APP });
    hook = new URL(props.endpoint).pathname;
    expect(hook).toMatch(/^\/v1\/hooks\/teams\/[\w-]+\.[\w-]+$/);
    const manifest = JSON.parse(published!.get("manifest.json")!.toString()) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: { short: "Chatty" }, version: "1.0.1", bots: [{ botId: BOT_APP }] });
    expect(pngSize(published!.get("color.png")!)).toEqual({ width: 192, height: 192 });
    expect(pngSize(published!.get("outline.png")!)).toEqual({ width: 32, height: 32 });
    // Asked again: nothing new is made.
    const before = seen.length;
    expect((await call("POST", `/v1/app/routines/${bot}/teams`)).status).toBe(200);
    expect(seen.slice(before).filter((c) => c.method !== "GET" && !c.url.includes("login."))).toHaveLength(0);
    const rows = await s.t.run(async (ctx) => ctx.db.query("records").collect());
    expect(JSON.stringify(rows)).not.toContain("bot-secret");
  });

  it("takes only activities signed for it, from its own company", async () => {
    expect(await send(activity({ text: "hi" }), "Bearer forged")).toBe(401);
    expect(await send(activity({ text: "hi" }), undefined, "/v1/hooks/teams/forged.sig")).toBe(404);
    expect(await send(activity({ text: "hi", conversation: { id: "a:x", conversationType: "personal", tenantId: "other-tenant" } }))).toBe(403);
  });

  it("says hello when its owner adds it, and counts as installed", async () => {
    sent = [];
    expect(await send(activity({ type: "conversationUpdate", membersAdded: [{ id: `28:${BOT_APP}` }] }))).toBe(200);
    expect(sent[0]).toMatchObject({ conv: "a:dm-lena", body: { textFormat: "markdown" } });
    expect(String(sent[0]!.body.text)).toContain("I'm Chatty");
    expect((await call("GET", `/v1/app/routines/${bot}/teams`)).json).toMatchObject({ tenant: true, app: { ready: true, installed: true, installer: "Lena Vogel" } });
  });

  it("tells anyone else it only listens to its owner, once per chat", async () => {
    sent = [];
    const other = { from: { id: "29:x", name: "Max", aadObjectId: STRANGER }, conversation: { id: "a:dm-max", conversationType: "personal", tenantId: TENANT } };
    await send(activity({ ...other, text: "do my taxes" }));
    await send(activity({ ...other, text: "please" }));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.body.text)).toBe("I only take instructions from Lena Vogel for now.");
  });

  it("takes an @mention in a channel from its owner: a run starts, the answer goes back to that thread", async () => {
    sent = [];
    const mention = activity({
      id: "root-1",
      text: "<at>Chatty</at> what broke last night?",
      conversation: { id: "19:chan@thread.tacv2", conversationType: "channel", tenantId: TENANT },
      entities: [{ type: "mention", mentioned: { id: `28:${BOT_APP}` } }],
      channelData: { tenant: { id: TENANT }, team: { id: "19:team@thread.tacv2", name: "Engineering" }, channel: { id: "19:chan@thread.tacv2", name: "anomalies" } },
    });
    expect(await send(mention)).toBe(200);
    // Teams sends it again: taken once.
    expect(await send(mention)).toBe(200);
    const thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { author: string | null; text: string }[];
    const fromTeams = thread.filter((m) => m.author === "Teams");
    expect(fromTeams).toHaveLength(1);
    expect(fromTeams[0]!.text).toContain("Lena Vogel wrote to you on Microsoft Teams (in a channel): what broke last night?");
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; prompt?: string; resume: { message: string } | null };
    expect(JSON.stringify(start)).toContain("You're in Microsoft Teams as Chatty");
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "**Two things** broke." });
    await s.folders.teams!.idle();
    expect(sent.at(-1)).toMatchObject({ conv: "19:chan@thread.tacv2;messageid=root-1", body: { text: "**Two things** broke.", textFormat: "markdown" } });
    // The next run (nothing from Teams): its result stays out of Teams.
    const before = sent.length;
    const next = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string } };
    await hostCall(host, "POST", `/v1/host/runs/${next.run.id}`, { status: "succeeded", summary: "Nightly audit done." });
    await s.folders.teams!.idle();
    expect(sent).toHaveLength(before);
  });

  it("asks with a card: a button answers as its owner, the card shows the answer, others can't", async () => {
    sent = [];
    await send(activity({ text: "can we ship the release?" }));
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; runToken: string };
    const asked = await hostCall(start.runToken, "POST", "/v1/bot/ask", { question: "Ship 2.3 today?", choices: ["Yes", "Not yet"], details: "PR #12 is green." });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const q = String(asked.json.id);
    await s.folders.teams!.idle();
    const card = sent.at(-1)!;
    expect(card.conv).toBe("a:dm-lena");
    const content = (card.body.attachments as { contentType: string; content: { body: { text?: string }[]; actions: { title: string; data: Record<string, string> }[] } }[])[0]!;
    expect(content.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(content.content.body[0]!.text).toBe("Ship 2.3 today?");
    expect(content.content.body[1]!.text).toBe("PR #12 is green.");
    expect(content.content.actions.map((x) => x.title)).toEqual(["Yes", "Not yet", "Send"]);
    expect(content.content.actions[0]!.data).toEqual({ ambient: "answer", q, o: "Yes" });
    const cardId = `msg-${sent.length}`;
    // Someone else clicks: told who answers, and it stays open.
    await send(activity({ from: { id: "29:x", name: "Max", aadObjectId: STRANGER }, value: { ambient: "answer", q, o: "Yes" }, replyToId: cardId }));
    expect(String(sent.at(-1)!.body.text)).toBe("Only Lena Vogel answers my questions.");
    expect((await hostCall(start.runToken, "GET", `/v1/bot/questions/${q}`)).json).toEqual({ answer: null, author: null });
    // Its owner clicks Yes: the run gets the answer, and the card says so.
    updated = [];
    await send(activity({ value: { ambient: "answer", q, o: "Yes" }, replyToId: cardId }));
    expect((await hostCall(start.runToken, "GET", `/v1/bot/questions/${q}`)).json).toEqual({ answer: "Yes", author: "Lena Vogel" });
    expect(updated[0]).toMatchObject({ conv: "a:dm-lena", id: cardId });
    expect(JSON.stringify(updated[0]!.body)).toContain("✓ Yes");
    expect(JSON.stringify(updated[0]!.body)).not.toContain("Action.Submit");
    // A second click: already answered, nothing posted to the bot.
    await send(activity({ value: { ambient: "answer", q, o: "Not yet" }, replyToId: cardId }));
    expect(JSON.stringify(updated.at(-1)!.body)).toContain("Already answered");
    expect((await hostCall(start.runToken, "GET", `/v1/bot/questions/${q}`)).json).toEqual({ answer: "Yes", author: "Lena Vogel" });
    // A typed reply in the chat answers the next question.
    const again = await hostCall(start.runToken, "POST", "/v1/bot/ask", { question: "Which channel for the notes?", choices: [] });
    const q2 = String(again.json.id);
    await s.folders.teams!.idle();
    await send(activity({ text: "<p>#releases please</p>" }));
    expect((await hostCall(start.runToken, "GET", `/v1/bot/questions/${q2}`)).json).toEqual({ answer: "#releases please", author: "Lena Vogel" });
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "Shipped." });
    await s.folders.teams!.idle();
    expect(sent.at(-1)).toMatchObject({ conv: "a:dm-lena", body: { text: "Shipped." } });
  });

  it("posts news in the channel it was mentioned in, and hears replies under that post", async () => {
    const st = (await call("GET", `/v1/app/routines/${bot}/teams`)).json as { news: { channel: { id: string; name: string } } };
    expect(st.news.channel).toMatchObject({ id: "19:chan@thread.tacv2", name: "anomalies" });
    sent = [];
    const start = (await hostCall(host, "POST", `/v1/host/routines/${bot}/runs`)).json as { run: { id: string }; runToken: string; routine: { prompt: string } };
    expect(start.routine.prompt).toContain("post_to_teams");
    expect(start.routine.prompt).toContain("Engineering › anomalies");
    const mcp = await mcpClient(`${s.origin}/mcp`, start.runToken);
    expect(text(await mcp.callTool({ name: "post_to_teams", arguments: { text: "Error rate tripled at 03:10." } }))).toContain("Posted in anomalies");
    await mcp.close();
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "" });
    await s.folders.teams!.idle();
    expect(sent[0]).toMatchObject({ conv: "19:chan@thread.tacv2", body: { text: "Error rate tripled at 03:10." } });
    const postId = "msg-1";
    await send(activity({ text: "why?", conversation: { id: `19:chan@thread.tacv2;messageid=${postId}`, conversationType: "channel", tenantId: TENANT }, channelData: { tenant: { id: TENANT }, channel: { id: "19:chan@thread.tacv2" } } }));
    const thread = (await call("GET", `/v1/app/routines/${bot}/thread`)).json.messages as { author: string | null; text: string }[];
    expect(thread.filter((m) => m.author === "Teams").at(-1)!.text).toContain("(in the thread under your post): why?");
    // Only the app: no channel.
    const none = await call("PUT", `/v1/app/routines/${bot}/teams/news`, { channel: null });
    expect(none.json).toMatchObject({ news: { channel: null } });
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const mcp2 = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await mcp2.callTool({ name: "teams_for_bot", arguments: { bot, news_channel: "19:chan@thread.tacv2" } }))).toContain("posts its news in anomalies");
    await mcp2.close();
  });

  it("gets its face as a new version of its app, and only at Teams' size", async () => {
    const { defaultColorIcon } = await import("../src/bots/teams-package.ts");
    const put = async (png: Buffer) => {
      const url = `${s.origin}/v1/app/routines/${bot}/teams/icon`;
      return (await fetch(url, { method: "PUT", headers: { ...(await appHeaders(lena.access_token, "PUT", url)), "content-type": "image/png" }, body: new Uint8Array(png) })).status;
    };
    const small = Buffer.from(defaultColorIcon());
    small.writeUInt32BE(64, 16);
    expect(await put(small)).toBe(400);
    expect(await put(defaultColorIcon())).toBe(204);
    expect(JSON.parse(published!.get("manifest.json")!.toString())).toMatchObject({ version: "1.0.2" });
  });

  it("is offered to Ambient's chat and bots as tools", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude 2" })).json.token);
    const mcp = await mcpClient(`${s.origin}/mcp`, pat);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["connect_teams", "teams_for_bot"]));
    const status = await mcp.callTool({ name: "connect_teams", arguments: { status: true } });
    expect(text(status)).toContain("Microsoft Teams is connected (by Heiko Admin");
    await mcp.close();
  });

  it("is taken out of Teams: its app, Azure Bot and app registration deleted", async () => {
    const out = await call("DELETE", `/v1/app/routines/${bot}/teams`);
    expect(out.status).toBe(204);
    const deletes = seen.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname);
    expect(deletes).toEqual(expect.arrayContaining(["/v1.0/appCatalogs/teamsApps/catalog-1", "/v1.0/applications/app-object-1"]));
    expect(deletes.some((p) => /\/botServices\/ambient-chatty-/.test(p))).toBe(true);
    expect((await call("GET", `/v1/app/routines/${bot}/teams`)).json).toMatchObject({ app: null });
  });
});
