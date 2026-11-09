// A team's bot in Microsoft Teams: reading waiting corrections off the pages, checking the Bot
// Framework's signature, telling the owner once (not at night), taking the owner's click as a
// correction note, and the morning report. Teams itself is faked; the bot's logic is real.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { WikiReader } from "@brain/wiki";
import { MsTeamsBot, plainText, type CorrectionInput } from "../src/msteams/bot.ts";
import { InboundVerifier, type Activity, type BotClient, type Member } from "../src/msteams/botframework.ts";
import { parseMsTeamsBots } from "../src/msteams/config.ts";
import { msteamsRouter } from "../src/msteams/route.ts";
import { MemoryBotStore } from "../src/msteams/store.ts";
import { waitingOnPage } from "../src/msteams/waiting.ts";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const APP = "00000000-0000-4000-8000-0000000000bb";
const SERVICE = "https://smba.example.com/emea/";
const TEAM = "19:team@thread.tacv2";
const CHANNEL = "19:brain@thread.tacv2";

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
      ref: "products/kudo",
      corrector: "Anna Müller",
      date: "2026-11-05",
      says: "Kudo no longer exists and the product is called Praise",
      documents: "the interactive deck and the Kudo papers still say Kudo",
      owner: "Ben Weber",
    });
    expect(w!.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores questions that aren't corrections, and pages without open questions", () => {
    expect(waitingOnPage({ ref: "a", title: "A", body: "## Open questions\n- Which is current isn't stated." })).toEqual([]);
    expect(waitingOnPage({ ref: "a", title: "A", body: "Anna Müller says x (correction of 2026-11-05). Ben Weber to decide." })).toEqual([]);
  });

  it("plain text from a channel message", () => {
    expect(plainText("<at>Brain</at>&nbsp;hallo <b>hier</b>")).toBe("hallo hier");
  });
});

describe("configuration", () => {
  it("takes a list of bots and refuses one listed twice", () => {
    const one = { team: "acme", tenantId: TENANT, appId: APP, secret: "s3cret-value", readAs: "u1" };
    expect(parseMsTeamsBots(JSON.stringify([one]))[0]).toMatchObject({ language: "en", reportHour: 8, quietFrom: "19:00" });
    expect(parseMsTeamsBots(undefined)).toEqual([]);
    expect(() => parseMsTeamsBots(JSON.stringify([one, one]))).toThrow(/twice/);
  });
});

// A fake Teams: what the bot sent, and a roster.
function fakeTeams(members: Member[]) {
  const sent: { conversation: string; activity: Record<string, unknown> }[] = [];
  const updated: { conversation: string; id: string; activity: Record<string, unknown> }[] = [];
  let n = 0;
  const client = {
    botId: `28:${APP}`,
    send: async (_s: string, conversation: string, activity: Record<string, unknown>) => {
      sent.push({ conversation, activity });
      return `msg-${++n}`;
    },
    update: async (_s: string, conversation: string, id: string, activity: Record<string, unknown>) => {
      updated.push({ conversation, id, activity });
    },
    directChat: async (_s: string, memberId: string) => `a:dm-${memberId}`,
    members: async () => members,
  } as unknown as BotClient;
  return { client, sent, updated };
}

function fakeReader(pages: { ref: string; title: string; body: string; updated?: string; type?: string; sortDate?: string }[]): WikiReader {
  const full = pages.map((p) => ({ path: `${p.ref}.md`, frontmatter: {}, summary: "", type: p.type ?? "product", updated: p.updated ?? "2026-11-01", sortDate: p.sortDate ?? p.updated ?? "2026-11-01", ...p }));
  return {
    search: async (q: string) => full.filter((p) => q.split(" ").every((t) => p.body.toLowerCase().includes(t))).map((page) => ({ page, snippet: "" })),
    recent: async () => full.filter((p) => p.type === "note"),
    entries: async () => full,
  } as unknown as WikiReader;
}

const ANNA: Member = { id: "29:anna", name: "Anna Müller", aadObjectId: "aad-anna", email: "anna@example.com" };
const BEN: Member = { id: "29:ben", name: "Ben Weber", aadObjectId: "aad-ben", email: "Ben.Weber@example.com" };

function activity(over: Partial<Activity>): Activity {
  return {
    type: "message",
    serviceUrl: SERVICE,
    channelId: "msteams",
    from: { id: "29:anna", name: "Anna Müller", aadObjectId: "aad-anna" },
    recipient: { id: `28:${APP}` },
    conversation: { id: `${CHANNEL};messageid=1`, conversationType: "channel", tenantId: TENANT },
    channelData: { tenant: { id: TENANT }, team: { id: TEAM, name: "Acme" }, channel: { id: CHANNEL, name: "Company Brain" } },
    ...over,
  } as Activity;
}

function setup(clock: { now: Date }) {
  const teams = fakeTeams([ANNA, BEN]);
  const store = new MemoryBotStore();
  const corrections: CorrectionInput[] = [];
  const reader = fakeReader([
    { ref: "products/kudo", title: "Kudo", body: QUESTION_PAGE, updated: "2026-11-05" },
    { ref: "meetings/2026-11/2026-11-09-team-meeting", title: "Team meeting (2026-11-09)", body: "…", type: "note", sortDate: "2026-11-09T07:00:00Z" },
  ]);
  const bot = new MsTeamsBot({
    config: parseMsTeamsBots(JSON.stringify([{ team: "acme", tenantId: TENANT, appId: APP, secret: "s3cret-value", readAs: "u-reader", language: "en" }]))[0]!,
    client: teams.client,
    store,
    reader: async () => reader,
    accounts: async () => [
      { uid: "u-anna", name: "Anna Müller", email: "anna@example.com" },
      { uid: "u-ben", name: "Ben Weber", email: "ben.weber@example.com" },
    ],
    correct: async (c) => {
      corrections.push(c);
      return { path: "ambient/corrections/x.md" };
    },
    now: () => clock.now,
    log: () => undefined,
  });
  return { bot, store, corrections, ...teams };
}

describe("the bot", () => {
  it("remembers the channel it was greeted in, tells the owner once, reports once, and stays quiet at night", async () => {
    // Monday 2026-11-09, 09:10 in Vienna.
    const clock = { now: new Date("2026-11-09T08:10:00Z") };
    const { bot, store, sent } = setup(clock);
    expect(await bot.tick()).toEqual({ told: 0, reported: false }); // Not in a team yet.

    await bot.handle(activity({ text: "<at>Brain</at> hallo" }));
    expect(store.state.channel).toEqual({ id: CHANNEL, name: "Company Brain" });
    expect(sent.pop()!.activity.text).toMatch(/workday morning/);

    expect(await bot.tick()).toEqual({ told: 1, reported: true });
    const dm = sent.find((m) => m.conversation === "a:dm-29:ben")!;
    const card = (dm.activity.attachments as { content: { body: { text: string }[]; actions: { title: string; data?: unknown }[] } }[])[0]!.content;
    expect(card.body[0]!.text).toBe('Anna Müller corrected "Kudo"');
    expect(card.actions.map((a) => a.title)).toEqual(["Anna is right", "The document is right"]);
    const report = sent.find((m) => m.conversation === CHANNEL)!.activity.text as string;
    expect(report).toContain("**Yesterday in the brain**");
    expect(report).toContain("Team meeting (2026-11-09)");
    expect(report).toContain("Ben Weber: Anna Müller's correction on \"Kudo\" (since 2026-11-05)");

    sent.length = 0;
    clock.now = new Date("2026-11-09T08:20:00Z");
    expect(await bot.tick()).toEqual({ told: 0, reported: false });
    expect(sent).toEqual([]);

    // A new question at 20:30: nobody is messaged until the morning.
    store.state.told = {};
    clock.now = new Date("2026-11-09T19:30:00Z");
    expect(await bot.tick()).toEqual({ told: 0, reported: false });
    clock.now = new Date("2026-11-10T06:35:00Z"); // 07:35 Tuesday
    expect((await bot.tick()).told).toBe(1);
  });

  it("files the owner's choice as their correction and replaces the card; others can't decide", async () => {
    const clock = { now: new Date("2026-11-09T08:10:00Z") };
    const { bot, store, corrections, sent, updated } = setup(clock);
    await bot.handle(activity({ text: "hallo" }));
    await bot.tick();
    const key = store.state.waiting![0]!.key;
    const dm = { conversation: { id: "a:dm-29:ben", conversationType: "personal", tenantId: TENANT }, channelData: { tenant: { id: TENANT } } };

    await bot.handle(activity({ ...dm, from: { id: "29:anna", name: "Anna Müller" }, value: { ambient: "accept", key }, replyToId: "msg-9" }));
    expect(corrections).toEqual([]);
    expect(sent.pop()!.activity.text).toBe("Only Ben Weber decides for this page.");

    await bot.handle(activity({ ...dm, from: { id: "29:ben", name: "Ben Weber", aadObjectId: "aad-ben" }, value: { ambient: "accept", key }, replyToId: "msg-9" }));
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ uid: "u-ben", right: "Kudo no longer exists and the product is called Praise", refs: ["products/kudo"], subject: "Kudo" });
    expect(corrections[0]!.howKnown).toMatch(/Ben Weber decides for this page .* Anna Müller is right/);
    expect(updated.pop()).toMatchObject({ id: "msg-9", activity: { text: expect.stringMatching(/^Done: you confirmed/) } });

    // A second click on the same card does nothing more.
    await bot.handle(activity({ ...dm, from: { id: "29:ben", name: "Ben Weber" }, value: { ambient: "keep", key }, replyToId: "msg-9" }));
    expect(corrections).toHaveLength(1);
    expect(updated.pop()!.activity.text).toBe("This question is already answered.");
    // Answered questions aren't in the next report.
    expect(await bot.report(fakeReader([]), store.state, clock.now)).toBeUndefined();
  });

  it("answers 'open' in a direct chat with what waits for that person", async () => {
    const clock = { now: new Date("2026-11-09T08:10:00Z") };
    const { bot, sent } = setup(clock);
    await bot.handle(activity({ text: "hallo" }));
    await bot.tick();
    sent.length = 0;
    const dm = { conversation: { id: "a:dm-29:ben", conversationType: "personal", tenantId: TENANT }, channelData: { tenant: { id: TENANT } } };
    await bot.handle(activity({ ...dm, from: { id: "29:ben", name: "Ben Weber" }, text: "open" }));
    expect(sent.map((m) => m.activity.text ?? "card")).toEqual(["One correction waits for your decision:", "card"]);
    await bot.handle(activity({ ...dm, from: { id: "29:anna", name: "Anna Müller" }, text: "open" }));
    expect(sent.pop()!.activity.text).toBe("Nothing waits for you right now.");
  });
});

describe("POST /teams/messages", () => {
  it("takes only activities the Bot Framework signed for this bot, from its tenant", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", endorsements: ["msteams"] };
    const verifier = new InboundVerifier((async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch);
    const clock = { now: new Date("2026-11-09T08:10:00Z") };
    const { bot, store } = setup(clock);
    const app = express().use(msteamsRouter([bot], verifier));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/teams/messages`;
    const sign = (claims: Record<string, unknown>, aud = APP) =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://api.botframework.com").setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const post = async (body: unknown, token?: string) =>
      (await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).status;
    try {
      const a = activity({ text: "hallo" });
      expect(await post(a)).toBe(401);
      expect(await post(a, await sign({ serviceUrl: SERVICE }, "00000000-0000-4000-8000-0000000000cc"))).toBe(401);
      expect(await post(a, await sign({ serviceUrl: "https://elsewhere.example.com/" }))).toBe(401);
      expect(await post({ ...a, recipient: { id: "28:someone-else" } }, await sign({ serviceUrl: SERVICE }))).toBe(401);
      expect(await post({ ...a, channelData: { ...a.channelData, tenant: { id: "other" } }, conversation: { ...a.conversation, tenantId: "other" } }, await sign({ serviceUrl: SERVICE }))).toBe(403);
      expect(await post(a, await sign({ serviceUrl: SERVICE }))).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(store.state.channel?.id).toBe(CHANNEL);
    } finally {
      server.close();
    }
  });
});
