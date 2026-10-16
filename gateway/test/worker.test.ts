// The personal worker end to end: phone sync → Claude upkeep (fake) → the phone pulls
// the server's writes; an older phone copy is merged, not lost; opting out stops it.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePage, splitCompiled } from "@brain/spec";
import type { OverviewWriter, PageUpdateInput, PageUpdater } from "@brain/team";
import { runPersonalWorker } from "../src/worker/personal.ts";
import { appCall, fixturePersonalOps, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
let token: string;
let uid: string;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

class FakeUpdater implements PageUpdater {
  model = "claude-haiku-4-5";
  seen: PageUpdateInput[] = [];
  async update(input: PageUpdateInput) {
    this.seen.push(input);
    return {
      update: {
        title: input.existing?.title ?? input.ref,
        summary: `Claude's summary of ${input.ref}`,
        aliases: [],
        currentTruth: [`Current truth for ${input.ref}, from ${input.evidence.length} notes.`],
        openQuestions: [],
        timeline: [{ note: input.evidence[0]!.note, date: input.evidence[0]!.date, fact: "should be ignored in personal mode" }],
      },
      usage: { input_tokens: 800, output_tokens: 150, cache_read_tokens: 0 },
    };
  }
}

const overview: OverviewWriter = {
  model: "claude-haiku-4-5",
  async write() {
    return {
      overview: { headline: "Pricing work with Anna.", now: ["Pricing page draft due."], activeProjects: [], keyPeople: [{ ref: "people/anna-mueller", why: "Leads pricing." }], openLoops: [], recentDecisions: [] },
      usage: { input_tokens: 400, output_tokens: 80, cache_read_tokens: 0 },
    };
  },
};

const run = (updater: PageUpdater) =>
  runPersonalWorker({ control: s.control, personal: s.personal, updater, overview, version: "test", quietMs: 0 }, Date.now() + 1000);

beforeAll(async () => {
  s = await startStack();
  const lena = await signIn(s, "apple-lena-worker", "Lena Vogel");
  token = lena.access_token;
  uid = lena.user.uid;
  // Claude upkeep is opt-in.
  expect((await appCall(s, token, "GET", "/v1/app/me")).json.prefs).toEqual({ consolidate: false, consolidateAsked: false, digest: true });
  await appCall(s, token, "POST", "/v1/app/me/prefs", { consolidate: true });
  await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps(), since_seq: 0 });
});
afterAll(() => s.close());

describe("personal worker", () => {
  it("rewrites living page heads, writes the overview, lints, and records the run", async () => {
    const updater = new FakeUpdater();
    const runs = await run(updater);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ uid, status: "ok", notes: 3, overview: true, error: null });
    expect(runs[0]!.pagesUpdated).toBeGreaterThan(0);
    expect(updater.seen.map((i) => i.ref)).toContain("people/anna-mueller");
    const state = await s.control.q(s.api.work.get, { uid: uid as never });
    expect(state?.done).toHaveLength(3);
    expect(state?.lintHistory).toHaveLength(1);
    // Nothing new: not due again.
    expect(await run(new FakeUpdater())).toEqual([]);
  });

  it("hands the phone the server's pages on its next sync", async () => {
    const res = await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: [], since_seq: 0 });
    const changes = res.json.changes as { path: string; hash: string; content: string }[];
    const anna = changes.find((c) => c.path === "wiki/people/anna-mueller.md")!;
    expect(anna.hash).toBe(sha(anna.content));
    const page = parsePage(anna.content);
    expect(page.body).toContain("Current truth for people/anna-mueller");
    expect(page.body).not.toContain("should be ignored");
    expect(page.frontmatter.pending_rewrite).toBe(0);
    const ov = changes.find((c) => c.path === "wiki/overview.md")!;
    expect(ov.content).toContain("- [Anna Müller](people/anna-mueller.md): Leads pricing.");
    // Since the latest seq: nothing.
    const again = await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: [], since_seq: res.json.seq as number });
    expect(again.json.changes).toEqual([]);
  });

  it("merges an older phone copy that gained a timeline line instead of overwriting Claude's head", async () => {
    const original = fixturePersonalOps().find((o) => o.path === "wiki/people/anna-mueller.md")!;
    const line = "- 2026-10-08: Sent the pricing draft ([note](../notes/2026/10/x.md))";
    const content = original.content.replace(/\n*$/, `\n${line}\n`);
    const res = await appCall(s, token, "POST", "/v1/app/personal/sync", {
      device_id: "iphone",
      ops: [{ op: "upsert", path: original.path, hash: sha(content), content, updated: "2026-10-08" }],
      since_seq: 0,
    });
    const merged = (res.json.changes as { path: string; content: string }[]).find((c) => c.path === original.path)!;
    const { currentTruth, timeline } = splitCompiled(parsePage(merged.content).body);
    expect(currentTruth).toContain("Current truth for people/anna-mueller");
    expect(timeline).toContain(line);
    expect(timeline.length).toBeGreaterThan(1);
  });

  it("deleting a recording strips its lines from Claude's copy, so the merge can't bring them back", async () => {
    // The previous test left a server-rewritten Anna page with a line pointing at notes/2026/10/x.md.
    const path = "wiki/people/anna-mueller.md";
    const before = (await s.personal.pages(uid)).pages.find((p) => p.path === path)!.content;
    expect(before).toContain("/x.md");
    // The phone deletes the recording and pushes its own copy without the line.
    const phoneCopy = fixturePersonalOps().find((o) => o.path === path)!.content;
    const res = await appCall(s, token, "POST", "/v1/app/personal/sync", {
      device_id: "iphone",
      ops: [
        { op: "delete", path: "wiki/notes/2026/10/x.md" },
        { op: "upsert", path, hash: sha(phoneCopy), content: phoneCopy, updated: "2026-10-08" },
      ],
      since_seq: 0,
    });
    expect(res.status).toBe(200);
    const after = (await s.personal.pages(uid)).pages.find((p) => p.path === path)!.content;
    expect(after).not.toContain("/x.md");
    expect(after).toContain("Current truth for people/anna-mueller");  // Claude's head stays
    expect(Number(parsePage(after).frontmatter.pending_rewrite)).toBeGreaterThanOrEqual(1);
  });

  it("stores and serves transcripts, keeps them out of search, and stops when the user opts out", async () => {
    const raw = "---\nid: 01RAW\nscope: personal\n---\n[00:00:01] Anna: Hallo zusammen.\n";
    const sync = await appCall(s, token, "POST", "/v1/app/personal/sync", {
      device_id: "iphone",
      ops: [{ op: "upsert", path: "raw/2026/10/01JBRAWTRANSCRIPT0000000001.md", hash: sha(raw), content: raw, updated: "2026-10-08" }],
    });
    expect(sync.json.applied).toBe(1);
    expect(await s.personal.transcript(uid, "raw/2026/10/01JBRAWTRANSCRIPT0000000001.md")).toBe(raw);
    expect((await (await s.personal.reader(uid)).search("Hallo zusammen")).length).toBe(0);

    expect((await appCall(s, token, "POST", "/v1/app/me/prefs", { consolidate: false })).json).toEqual({ prefs: { consolidate: false, consolidateAsked: true, digest: true } });
    expect((await appCall(s, token, "GET", "/v1/app/me")).json.prefs).toEqual({ consolidate: false, consolidateAsked: true, digest: true });
    expect(await run(new FakeUpdater())).toEqual([]);
  });
});
