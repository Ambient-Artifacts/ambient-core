// What changed, for the apps: each user's revisions (personal pages, routines, each team's
// wiki), at once and live as a server-sent event stream, and a team server's own changes
// picked up from its git head.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRevisions } from "../src/revisions.ts";
import { MAX_STREAMS } from "../src/app-api.ts";
import { appCall, appHeaders, fixturePersonalOps, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ revisionPollMs: 20, streamMaxMs: 60_000 });
});
afterAll(() => s.close());

const note = (id: string, title: string) => ({
  schema: "brain.team-note/v1",
  note_id: id,
  team_id: "ignored",
  recorded_by: "ignored",
  recorded_at: "2026-10-13T09:00:00+02:00",
  duration_s: 600,
  language: "en-US",
  kind: "meeting",
  consent: { mode: "all-agreed", confirmed_at: "2026-10-13T09:11:00+02:00" },
  entry_page: { frontmatter: { title, summary: "A short sync.", people: [] }, body_md: `# ${title}\n\nShort.\n` },
  transcript: null,
  participants_hint: [],
  client: { app: "1.0 (1)", transcriber: "test", compiler: "test" },
});

async function revisions(token: string): Promise<UserRevisions> {
  const r = await appCall(s, token, "GET", "/v1/app/revisions");
  expect(r.status).toBe(200);
  return r.json.revisions as UserRevisions;
}

/** Reads server-sent events from the stream, one `revisions` event at a time. */
function eventReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async function (timeoutMs = 3_000): Promise<UserRevisions> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = block.split("\n");
        if (lines.includes("event: revisions")) return JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) as UserRevisions;
        continue;
      }
      if (Date.now() > deadline) throw new Error("no event in time");
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return { next, close: () => reader.cancel() };
}

describe("revisions", () => {
  it("move with a personal sync, a note stored in a team's wiki and a routine change", async () => {
    const u = await signIn(s, "apple-rev-1", "Rita Revision");
    expect((await appCall(s, u.access_token, "POST", "/v1/app/teams/join", { code: INVITE })).status).toBe(200);
    const r0 = await revisions(u.access_token);
    expect(r0.teams.map((t) => t.slug)).toEqual(["acme"]);

    expect((await appCall(s, u.access_token, "POST", "/v1/app/personal/sync", { device_id: "mac", ops: fixturePersonalOps() })).status).toBe(200);
    const r1 = await revisions(u.access_token);
    expect(r1.personal).toBeGreaterThan(r0.personal);
    expect(r1.teams).toEqual(r0.teams);

    const stored = await appCall(s, u.access_token, "POST", "/v1/app/teams/acme/notes", note("01JBREVISIONNOTE0000000001", "Revision sync"));
    expect(stored.json.status).toBe("stored");
    const r2 = await revisions(u.access_token);
    expect(r2.teams[0]!.wiki).toBe(r1.teams[0]!.wiki + 1);
    expect(r2.personal).toBe(r1.personal);

    // The same note again changes nothing in the wiki, so nothing moves.
    expect((await appCall(s, u.access_token, "POST", "/v1/app/teams/acme/notes", note("01JBREVISIONNOTE0000000001", "Revision sync"))).json.status).toBe("duplicate");
    expect((await revisions(u.access_token)).teams[0]!.wiki).toBe(r2.teams[0]!.wiki);

    expect((await appCall(s, u.access_token, "POST", "/v1/app/computers", { name: "Build box" })).status).toBe(200);
    const r3 = await revisions(u.access_token);
    expect(r3.routines).not.toBe(r2.routines);
  });

  it("stream live to every open app of the user, and stop with the last one", async () => {
    const u = await signIn(s, "apple-rev-2", "Sami Stream");
    const open = async () =>
      fetch(`${s.origin}/v1/app/events`, { headers: await appHeaders(u.access_token, "GET", `${s.origin}/v1/app/events`), signal: AbortSignal.timeout(10_000) });
    const a = await open();
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toContain("text/event-stream");
    const streamA = eventReader(a.body!);
    const first = await streamA.next();
    const b = await open();
    const streamB = eventReader(b.body!);
    expect(await streamB.next()).toEqual(first);

    expect((await appCall(s, u.access_token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps() })).status).toBe(200);
    const [fromA, fromB] = await Promise.all([streamA.next(), streamB.next()]);
    expect(fromA.personal).toBeGreaterThan(first.personal);
    expect(fromB).toEqual(fromA);
    expect(s.events.size).toBeGreaterThan(0);

    await streamA.close();
    await streamB.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.events.size).toBe(0);
  });

  it("close the oldest stream once an account has more than MAX_STREAMS open", async () => {
    const u = await signIn(s, "apple-rev-4", "Many Tabs");
    const open = async () =>
      fetch(`${s.origin}/v1/app/events`, { headers: await appHeaders(u.access_token, "GET", `${s.origin}/v1/app/events`), signal: AbortSignal.timeout(10_000) });
    const all = [];
    for (let i = 0; i <= MAX_STREAMS; i++) all.push(await open());
    const drained = async (res: Response) => {
      const reader = res.body!.getReader();
      for (;;) if ((await reader.read()).done) return true;
    };
    expect(await drained(all[0]!)).toBe(true);
    for (const res of all.slice(1)) await res.body!.cancel();
  });

  it("refuse a stream without sign-in", async () => {
    expect((await fetch(`${s.origin}/v1/app/events`)).status).toBe(401);
    expect((await fetch(`${s.origin}/v1/app/revisions`)).status).toBe(401);
  });

  it("count a team server's own changes once its git head moves", async () => {
    const u = await signIn(s, "apple-rev-3", "Hera Head");
    expect((await appCall(s, u.access_token, "POST", "/v1/app/teams/join", { code: INVITE })).status).toBe(200);
    const before = (await revisions(u.access_token)).teams[0]!.wiki;
    // A fresh head is only recorded; the same head again is no change; a new one is.
    const fresh = s.teamId;
    expect(await s.revisions.teamHead(fresh, "head-a")).toBe(false);
    expect(await s.revisions.teamHead(fresh, "head-a")).toBe(false);
    expect((await revisions(u.access_token)).teams[0]!.wiki).toBe(before);
    expect(await s.revisions.teamHead(fresh, "head-b")).toBe(true);
    expect((await revisions(u.access_token)).teams[0]!.wiki).toBe(before + 1);
  });
});
