// Before a meeting: the attendees' pages, what's open with them, the last decisions and
// meetings. Every workday morning: what's waiting on you, as a push with counts only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localTime, runDigest } from "../src/digest.ts";
import { digestMessage, sameName } from "../src/briefs.ts";
import type { PushMessage, PushSender } from "../src/push.ts";
import { appCall, fixturePersonalOps, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
let app: string;
let uid: string;
const pushed: PushMessage[] = [];
const sender: PushSender = async (_device, message) => {
  pushed.push(message);
  return "sent";
};

beforeAll(async () => {
  s = await startStack({ push: sender });
  const lena = await signIn(s, "apple-briefs", "Lena Vogel");
  app = lena.access_token;
  uid = lena.user.uid;
  await appCall(s, app, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps() });
  await appCall(s, app, "POST", "/v1/app/teams/join", { code: INVITE });
});
afterAll(() => s.close());

describe("names", () => {
  it("matches a first name to a full name, and nothing looser", () => {
    expect(sameName("Nikolai", "Nikolai Madlener")).toBe(true);
    expect(sameName("anna müller", "Anna Müller")).toBe(true);
    expect(sameName("Anna", "Annabelle Schmidt")).toBe(false);
    expect(sameName("Anna Schmidt", "Anna Müller")).toBe(false);
  });
});

describe("the brief before a meeting", () => {
  it("brings each attendee's page from whichever wiki has it, and what's open with them", async () => {
    const res = await appCall(s, app, "POST", "/v1/app/briefs", { title: "Pricing sync", attendees: ["Anna Müller", "Jonas Becker", "Petra Nobody"] });
    expect(res.status).toBe(200);
    const b = res.json as { title: string; people: { name: string; found: boolean; id?: string; where?: string; truth?: string }[]; openActions: { owner: string; task: string; due: string | null }[]; recentNotes: { title: string }[] };
    expect(b.title).toBe("Pricing sync");
    expect(b.people.map((p) => [p.name, p.found, p.id ?? null])).toEqual([
      ["Anna Müller", true, "personal:people/anna-mueller"],
      ["Jonas Becker", true, "team:acme:people/jonas-becker"],
      ["Petra Nobody", false, null],
    ]);
    expect(b.people[1]!.where).toBe("Acme brain");
    expect(b.people[1]!.truth).toContain("Sales lead.");
    const tasks = b.openActions.map((a) => a.task);
    expect(tasks).toEqual(expect.arrayContaining(["Entwurf der Preisseite schicken", "redesign the paywall step", "Angebot mit Jahrespreis schicken", "SSO-Zeitplan mit dem Dev-Team klären"]));
    expect(tasks).not.toContain("Kundenliste exportieren");
    expect(b.openActions[0]!.due).toBe("2026-10-09");
    expect(b.recentNotes.map((n) => n.title)).toContain("Kundencall Bergmann Logistik");
  });

  it("refuses a request without attendees", async () => {
    expect((await appCall(s, app, "POST", "/v1/app/briefs", { attendees: [] })).status).toBe(400);
  });
});

describe("what's waiting on you", () => {
  it("lists what the user owes and what others owe in their notes", async () => {
    const res = await appCall(s, app, "GET", "/v1/app/actions?tz=Europe/Vienna");
    const w = res.json as { name: string; mine: { task: string }[]; theirs: { owner: string; task: string }[]; overdue: number };
    expect(w.name).toBe("Lena Vogel");
    expect(w.mine.map((a) => a.task)).toEqual(["add a recurring Friday block"]);
    expect(w.theirs.map((a) => `${a.owner}: ${a.task}`)).toEqual(["Anna Müller: Entwurf der Preisseite schicken", "Anna Müller: redesign the paywall step"]);
    // Jonas's items are in a team note Lena wasn't part of.
    expect(w.theirs.some((a) => a.owner === "Jonas Becker")).toBe(false);
    expect(digestMessage({ ...w, dueToday: 0 } as never)).toEqual({ title: "Waiting on you", body: "1 open action item (1 overdue) · 2 things others owe you." });
  });
});

describe("the morning push", () => {
  it("goes once on a workday morning in the user's time zone, with counts only", async () => {
    await appCall(s, app, "PUT", "/v1/app/push-device", { token: "ab".repeat(32), sandbox: true, platform: "ios", timeZone: "Europe/Vienna" });
    // Thursday 2026-10-15, 06:30 UTC = 08:30 in Vienna.
    const thursday = new Date("2026-10-15T06:30:00Z");
    expect(localTime(thursday, "Europe/Vienna")).toEqual({ day: "2026-10-15", hour: 8, weekday: 4 });
    const early = await runDigest({ control: s.control, personal: s.personal, teams: s.teams, directory: s.directory, notifier: s.notifier, now: new Date("2026-10-15T04:30:00Z") });
    expect(early.find((r) => r.uid === uid)?.status).toBe("not_now");
    const runs = await runDigest({ control: s.control, personal: s.personal, teams: s.teams, directory: s.directory, notifier: s.notifier, now: thursday });
    expect(runs.find((r) => r.uid === uid)?.status).toBe("sent");
    expect(pushed).toEqual([{ title: "Waiting on you", body: "1 open action item (1 overdue) · 2 things others owe you.", url: "ambient://actions", thread: "actions", collapseId: "actions-2026-10-15" }]);
    // Once a day.
    const again = await runDigest({ control: s.control, personal: s.personal, teams: s.teams, directory: s.directory, notifier: s.notifier, now: new Date("2026-10-15T07:30:00Z") });
    expect(again.find((r) => r.uid === uid)?.status).toBe("not_now");
    // Not on a Saturday, and not once it's turned off.
    const saturday = await runDigest({ control: s.control, personal: s.personal, teams: s.teams, directory: s.directory, notifier: s.notifier, now: new Date("2026-10-17T06:30:00Z") });
    expect(saturday.find((r) => r.uid === uid)?.status).toBe("not_now");
    expect((await appCall(s, app, "POST", "/v1/app/me/prefs", { digest: false })).json.prefs).toMatchObject({ digest: false });
    const off = await runDigest({ control: s.control, personal: s.personal, teams: s.teams, directory: s.directory, notifier: s.notifier, now: new Date("2026-10-16T06:30:00Z") });
    expect(off.find((r) => r.uid === uid)?.status).toBe("off");
    expect(pushed).toHaveLength(1);
  });
});
