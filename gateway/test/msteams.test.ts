// A team's bot in Microsoft Teams: reading a waiting correction off a page, checking the Bot
// Framework's signature, taking the owner's click as their own correction, and answering a
// question with Claude over the team's real MCP tools (built in-process for the person who asked).
// Teams and Anthropic are faked; the bot, the route and the MCP server are real.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { WikiReader } from "@brain/wiki";
import { buildMcpServer } from "../src/mcp/tools.ts";
import { TEAM_MCP_SCOPES } from "../src/mcp/route.ts";
import { BOT_TOOLS } from "../src/msteams/ask.ts";
import { MsTeamsBot, plainText, type CorrectionInput } from "../src/msteams/bot.ts";
import { InboundVerifier, type Activity, type BotClient, type Member } from "../src/msteams/botframework.ts";
import { parseMsTeamsBots } from "../src/msteams/config.ts";
import { msteamsRouter } from "../src/msteams/route.ts";
import { waitingOnPage } from "../src/msteams/waiting.ts";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const APP = "00000000-0000-4000-8000-0000000000bb";
const SERVICE = "https://smba.example.com/emea/";
const TEAM = "19:team@thread.tacv2";
const CHANNEL = "19:brain@thread.tacv2";
const TEAM_OBJ = { id: "team-1", slug: "acme", name: "Acme", status: "active" as const, serverUrl: "https://team.example.com", peopleSlug: null };

const QUESTION_PAGE = `Kudo is the team's praise tool.

## Open questions
- **Name:** the website says Praise, the deck says Kudo. Anna Müller says Kudo no longer exists and the product is called Praise (correction of 2026-11-05); the interactive deck and the Kudo papers still say Kudo. Ben Weber to decide.
- **Pilot length:** the deck says 4 weeks, the paper 8 weeks. Which is current isn't stated.

## Change log
- 2026-11-05: Correction by Anna Müller waits for the owner.
`;

describe("waiting corrections on a page", () => {
  it("reads who corrected, what they say, what the documents say and who decides", () => {
    const [w, ...rest] = waitingOnPage({ ref: "products/kudo", title: "Kudo", body: QUESTION_PAGE });
    expect(rest).toEqual([]);
    expect(w).toMatchObject({
      corrector: "Anna Müller",
      date: "2026-11-05",
      says: "Kudo no longer exists and the product is called Praise",
      documents: "the interactive deck and the Kudo papers still say Kudo",
      owner: "Ben Weber",
    });
  });

  it("ignores questions that aren't corrections, and text outside open questions", () => {
    expect(waitingOnPage({ ref: "a", title: "A", body: "## Open questions\n- Which is current isn't stated." })).toEqual([]);
    expect(waitingOnPage({ ref: "a", title: "A", body: "Anna Müller says x (correction of 2026-11-05). Ben Weber to decide." })).toEqual([]);
  });

  it("plain text from a channel message", () => {
    expect(plainText("<at>Brain</at>&nbsp;hallo <b>hier</b>")).toBe("hallo hier");
  });
});

describe("configuration", () => {
  it("takes a list of bots and refuses one listed twice", () => {
    const one = { team: "acme", tenantId: TENANT, appId: APP, secret: "s3cret-value" };
    expect(parseMsTeamsBots(JSON.stringify([one]))[0]).toMatchObject({ language: "en", model: "claude-sonnet-5-5" });
    expect(parseMsTeamsBots(undefined)).toEqual([]);
    expect(() => parseMsTeamsBots(JSON.stringify([one, one]))).toThrow(/twice/);
  });
});

const ANNA: Member = { id: "29:anna", name: "Anna Müller", aadObjectId: "aad-anna", email: "anna@example.com" };
const BEN: Member = { id: "29:ben", name: "Ben Weber", aadObjectId: "aad-ben", email: "Ben.Weber@example.com" };
const CARL: Member = { id: "29:carl", name: "Carl Guest", email: "carl@elsewhere.example.com" };

function fakeTeams() {
  const sent: { conversation: string; activity: Record<string, unknown> }[] = [];
  const updated: { conversation: string; id: string; activity: Record<string, unknown> }[] = [];
  const client = {
    botId: `28:${APP}`,
    send: async (_s: string, conversation: string, activity: Record<string, unknown>) => {
      sent.push({ conversation, activity });
      return "msg";
    },
    update: async (_s: string, conversation: string, id: string, activity: Record<string, unknown>) => {
      updated.push({ conversation, id, activity });
    },
    typing: async () => undefined,
    member: async (_s: string, _c: string, id: string) => [ANNA, BEN, CARL].find((m) => m.id === id)!,
  } as unknown as BotClient;
  return { client, sent, updated };
}

/** A team wiki with one page, for the bot's checks and for the real MCP tools. */
function fakeReader(body = QUESTION_PAGE): WikiReader {
  const page = { path: "products/kudo.md", ref: "products/kudo", type: "product", title: "Kudo", summary: "The praise tool", updated: "2026-11-05", sortDate: "2026-11-05", frontmatter: {}, body };
  return {
    getByRef: async (ref: string) => (ref === page.ref ? page : undefined),
    search: async (q: string) => (/kudo|praise/i.test(q) ? [{ page, snippet: "Kudo is the team's praise tool." }] : []),
  } as unknown as WikiReader;
}

/** Anthropic, faked: first a search, then an answer that quotes what the tool returned. */
function fakeAnthropic() {
  const requests: { tools: { name: string }[]; messages: { role: string; content: unknown }[]; system: string }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init!.body));
    requests.push(body);
    const last = body.messages.at(-1);
    if (typeof last.content === "string") {
      return new Response(JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "search", input: { query: "Kudo", scope: "team" } }] }));
    }
    const result = (last.content as { content: string }[])[0]!.content;
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: `Kudo is the praise tool. ${result.includes("Kudo") ? "(found in the wiki)" : "(not found)"}` }] }));
  }) as typeof fetch;
  return { f, requests };
}

function setup(o: { reader?: WikiReader; apiKey?: string } = {}) {
  const teams = fakeTeams();
  const corrections: CorrectionInput[] = [];
  const anthropic = fakeAnthropic();
  const reader = o.reader ?? fakeReader();
  const logs: string[] = [];
  const bot = new MsTeamsBot({
    config: parseMsTeamsBots(JSON.stringify([{ team: "acme", tenantId: TENANT, appId: APP, secret: "s3cret-value" }]))[0]!,
    client: teams.client,
    apiKey: "apiKey" in o ? o.apiKey : "sk-test",
    fetchImpl: anthropic.f,
    accounts: async () => [
      { uid: "u-anna", name: "Anna Müller", email: "anna@example.com" },
      { uid: "u-ben", name: "Ben Weber", email: "ben.weber@example.com" },
    ],
    reader: async () => reader,
    // The real MCP server, as /t/acme/mcp would build it for this person.
    mcp: async (uid) =>
      buildMcpServer({
        principal: { uid, scopes: new Set(TEAM_MCP_SCOPES), via: "pat", clientId: "msteams", personal: false, teams: [TEAM_OBJ] },
        readers: { personal: async () => undefined, team: () => reader, deliverToTeam: async () => ({ status: "stored", path: "x" }) },
        version: "test",
      }),
    correct: async (c) => {
      corrections.push(c);
      return { path: "ambient/corrections/x.md" };
    },
    log: (m) => logs.push(m),
  });
  return { bot, corrections, anthropic, logs, ...teams };
}

const dm = (from: Member, over: Partial<Activity> = {}): Activity =>
  ({
    type: "message",
    serviceUrl: SERVICE,
    channelId: "msteams",
    from: { id: from.id, name: from.name },
    recipient: { id: `28:${APP}` },
    conversation: { id: `a:dm-${from.id}`, conversationType: "personal", tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    ...over,
  }) as Activity;

const inChannel = (text: string): Activity =>
  ({
    type: "message",
    serviceUrl: SERVICE,
    channelId: "msteams",
    text,
    from: { id: ANNA.id, name: ANNA.name },
    recipient: { id: `28:${APP}` },
    conversation: { id: `${CHANNEL};messageid=1`, conversationType: "channel", tenantId: TENANT },
    channelData: { tenant: { id: TENANT }, team: { id: TEAM, name: "Acme" }, channel: { id: CHANNEL, name: "Company Brain" } },
  }) as Activity;

const CLICK = { ref: "products/kudo", corrector: "Anna Müller", date: "2026-11-05", owner: "Ben Weber" };

describe("the bot", () => {
  it("says hello in a channel and logs the ids the team's loops need", async () => {
    const { bot, sent, logs } = setup();
    await bot.handle(inChannel("<at>Brain</at> hallo"));
    expect(sent.pop()!.activity.text).toMatch(/^Hi! I'm the team's brain/);
    expect(logs.pop()).toBe(`greeted in a channel: serviceUrl=${SERVICE} team=${TEAM} channel=${CHANNEL}`);
  });

  it("files the owner's click as their correction, once; others can't decide", async () => {
    const { bot, corrections, sent, updated } = setup();
    await bot.handle(dm(ANNA, { value: { ambient: "accept", ...CLICK }, replyToId: "card-1" }));
    expect(corrections).toEqual([]);
    expect(sent.pop()!.activity.text).toBe("Only Ben Weber decides for this page.");

    await bot.handle(dm(BEN, { value: { ambient: "accept", ...CLICK }, replyToId: "card-1" }));
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ uid: "u-ben", right: "Kudo no longer exists and the product is called Praise", refs: ["products/kudo"], subject: "Kudo" });
    expect(corrections[0]!.howKnown).toMatch(/Ben Weber decides for this page .* Anna Müller is right/);
    expect(updated.pop()).toMatchObject({ id: "card-1", activity: { text: expect.stringMatching(/^Done: you confirmed/) } });

    // The page still shows the question until the next sync: a second click does nothing.
    await bot.handle(dm(BEN, { value: { ambient: "keep", ...CLICK }, replyToId: "card-1" }));
    expect(corrections).toHaveLength(1);
    expect(updated.pop()!.activity.text).toBe("This question is already answered.");
  });

  it("keeping the document files the owner's decision the other way", async () => {
    const { bot, corrections } = setup();
    await bot.handle(dm(BEN, { value: { ambient: "keep", ...CLICK } }));
    expect(corrections[0]).toMatchObject({ uid: "u-ben", wrong: "Anna Müller says Kudo no longer exists and the product is called Praise" });
    expect(corrections[0]!.howKnown).toMatch(/the documents are right/);
  });

  it("a card whose question is gone from the page changes nothing", async () => {
    const { bot, corrections, sent } = setup({ reader: fakeReader("Kudo is the praise tool.\n") });
    await bot.handle(dm(BEN, { value: { ambient: "accept", ...CLICK } }));
    expect(corrections).toEqual([]);
    expect(sent.pop()!.activity.text).toBe("This question is already answered.");
  });

  it("answers a question with Claude over the team's MCP tools, as the person who asked", async () => {
    const { bot, sent, anthropic } = setup();
    await bot.handle(dm(ANNA, { text: "What is Kudo?" }));
    expect(sent.pop()!.activity).toMatchObject({ text: "Kudo is the praise tool. (found in the wiki)", textFormat: "markdown" });
    const first = anthropic.requests[0]!;
    expect(first.tools.map((t) => t.name).every((n) => BOT_TOOLS.has(n))).toBe(true);
    expect(first.tools.map((t) => t.name)).toContain("search");
    expect(first.tools.map((t) => t.name)).not.toContain("save_note");
    expect(first.system).toMatch(/answering Anna Müller in Microsoft Teams/);
    // Claude gets the tool's structured result (front matter and all), not only its text.
    const toolResult = (anthropic.requests[1]!.messages.at(-1)!.content as { content: string }[])[0]!.content;
    expect(JSON.parse(toolResult).results[0]).toMatchObject({ id: "team:acme:products/kudo", title: "Kudo" });

    // A follow-up has the earlier turn.
    await bot.handle(dm(ANNA, { text: "And who decides?" }));
    const followUp = anthropic.requests[2]!;
    expect(followUp.messages.slice(0, 3).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(followUp.messages[0]!.content).toBe("What is Kudo?");
  });

  it("answers only people with an Ambient account, and only with an AI key", async () => {
    const { bot, sent } = setup();
    await bot.handle(dm(CARL, { text: "What is Kudo?" }));
    expect(sent.pop()!.activity.text).toMatch(/couldn't find your Ambient account/);
    const noKey = setup({ apiKey: undefined });
    await noKey.bot.handle(dm(ANNA, { text: "What is Kudo?" }));
    expect(noKey.sent.pop()!.activity.text).toMatch(/no AI key/);
  });
});

describe("POST /teams/messages", () => {
  it("takes only activities the Bot Framework signed for this bot, from its tenant", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", endorsements: ["msteams"] };
    const verifier = new InboundVerifier((async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch);
    const { bot, logs } = setup();
    const app = express().use(msteamsRouter([bot], verifier));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/teams/messages`;
    const sign = (claims: Record<string, unknown>, aud = APP) =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://api.botframework.com").setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const post = async (body: unknown, token?: string) =>
      (await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).status;
    try {
      const a = inChannel("hallo");
      expect(await post(a)).toBe(401);
      expect(await post(a, await sign({ serviceUrl: SERVICE }, "00000000-0000-4000-8000-0000000000cc"))).toBe(401);
      expect(await post(a, await sign({ serviceUrl: "https://elsewhere.example.com/" }))).toBe(401);
      expect(await post({ ...a, recipient: { id: "28:someone-else" } }, await sign({ serviceUrl: SERVICE }))).toBe(401);
      expect(await post({ ...a, channelData: { ...a.channelData, tenant: { id: "other" } }, conversation: { ...a.conversation, tenantId: "other" } }, await sign({ serviceUrl: SERVICE }))).toBe(403);
      expect(logs).toEqual([]);
      expect(await post(a, await sign({ serviceUrl: SERVICE }))).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(logs.pop()).toMatch(/^greeted in a channel/);
    } finally {
      server.close();
    }
  });
});
