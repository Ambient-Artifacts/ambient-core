// The iOS app's API end to end: encrypted personal sync, joining a team, sharing a
// Team note to the team server. Signing in is app-sign-in.test.ts.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, fixturePersonalOps, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

describe("personal sync", () => {
  it("stores pages encrypted, restores them, and rejects bad input", async () => {
    const lena = await signIn(s, "apple-lena", "Lena Vogel");
    const ops = fixturePersonalOps();
    const res = await appCall(s, lena.access_token, "POST", "/v1/app/personal/sync", { device_id: "iphone-1", ops });
    expect(res).toMatchObject({ status: 200, json: { applied: ops.length, rejected: [] } });

    // Convex holds ciphertext only.
    const rows = await s.t.run((ctx) => ctx.db.query("personalPages").collect());
    expect(rows.length).toBe(ops.length);
    for (const r of rows) {
      expect(r.ciphertext).not.toMatch(/Anna|Preis|Onboarding/);
      expect(Buffer.from(r.ciphertext, "base64").toString("utf8")).not.toMatch(/Anna|Preis/);
    }
    const keys = await s.t.run((ctx) => ctx.db.query("userKeys").collect());
    expect(keys).toHaveLength(1);

    const restored = await appCall(s, lena.access_token, "GET", "/v1/app/personal/pages");
    const pages = restored.json.pages as { path: string; content: string }[];
    expect(pages.map((p) => p.path).sort()).toEqual(ops.map((o) => o.path).sort());
    expect(pages.find((p) => p.path === "wiki/people/anna-mueller.md")!.content).toBe(ops.find((o) => o.path === "wiki/people/anna-mueller.md")!.content);

    // Idempotent, and the hash must match the content.
    expect((await appCall(s, lena.access_token, "POST", "/v1/app/personal/sync", { device_id: "iphone-1", ops })).json.applied).toBe(0);
    const bad = { ...ops[0]!, content: `${ops[0]!.content}\nedited` };
    const team = "---\nid: 01JTEAMNOTE000000000000000\ntype: note\nscope: team\n---\n# x\n";
    const out = await appCall(s, lena.access_token, "POST", "/v1/app/personal/sync", {
      device_id: "iphone-1",
      ops: [
        bad,
        { op: "upsert", path: "wiki/notes/2026/10/team.md", hash: createHash("sha256").update(team).digest("hex"), content: team, updated: "2026-10-07" },
      ],
    });
    expect(out.json.rejected).toEqual([
      { path: bad.path, reason: "hash_mismatch" },
      { path: "wiki/notes/2026/10/team.md", reason: "team_scope" },
    ]);
    expect((await appCall(s, lena.access_token, "POST", "/v1/app/personal/sync", { device_id: "x", ops: [{ ...ops[0]!, path: "../etc/passwd" }] })).status).toBe(400);
  });
});

describe("teams", () => {
  it("joins with an invite and shares a Team note to the team server", async () => {
    const lena = await signIn(s, "apple-lena", "Lena Vogel");
    expect((await appCall(s, lena.access_token, "POST", "/v1/app/teams/join", { code: "WRONG-CODE" })).status).toBe(400);
    const joined = await appCall(s, lena.access_token, "POST", "/v1/app/teams/join", { code: INVITE.toLowerCase() });
    expect(joined).toMatchObject({ status: 200, json: { team: { slug: "acme", role: "member", peopleSlug: "people/lena-vogel" } } });

    const note = {
      schema: "brain.team-note/v1",
      note_id: "01JBGATEWAYNOTE00000000001",
      team_id: "ignored-the-gateway-fills-this",
      recorded_by: "ignored",
      recorded_at: "2026-10-07T09:00:00+02:00",
      duration_s: 900,
      language: "en-US",
      kind: "meeting",
      consent: { mode: "all-agreed", confirmed_at: "2026-10-07T09:16:00+02:00" },
      entry_page: {
        frontmatter: { title: "Pricing sync with Jonas", summary: "Agreed the 20-seat threshold for annual billing.", people: ["people/jonas-becker"], projects: ["projects/website-relaunch"] },
        body_md: "# Pricing sync with Jonas\n\n## Decisions\n- Annual billing starts at 20 seats.\n",
      },
      transcript: null,
      participants_hint: [],
      client: { app: "1.0 (1)", transcriber: "SpeechTranscriber en-US", compiler: "fm-ondevice" },
    };
    const shared = await appCall(s, lena.access_token, "POST", "/v1/app/teams/acme/notes", note);
    expect(shared).toMatchObject({ status: 200, json: { status: "stored", path: "notes/2026-10/2026-10-07-pricing-sync-with-jonas-000001.md" } });

    // The app's wiki browser: the whole tree in one call, then one page.
    const tree = (await appCall(s, lena.access_token, "POST", "/v1/app/teams/acme/query", { op: "entries" })).json.result as { ref: string; title: string }[];
    expect(tree.map((e) => e.ref)).toContain("orgs/bergmann-logistik");
    expect(tree.some((e) => e.ref.endsWith("_index") || e.ref === "index")).toBe(false);
    // The graph view: every link between existing pages, once.
    const links = (await appCall(s, lena.access_token, "POST", "/v1/app/teams/acme/query", { op: "links" })).json.result as { src: string; dst: string }[];
    const refs = new Set(tree.map((e) => e.ref));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => refs.has(l.src) && refs.has(l.dst) && l.src !== l.dst)).toBe(true);
    expect(new Set(links.map((l) => `${l.src}>${l.dst}`)).size).toBe(links.length);
    const page = (await appCall(s, lena.access_token, "POST", "/v1/app/teams/acme/query", { op: "getByRef", ref: "orgs/bergmann-logistik" })).json.result as { title: string; body: string };
    expect(page.title).toBe("Bergmann Logistik");
    const found = await appCall(s, lena.access_token, "POST", "/v1/app/teams/acme/query", { op: "search", query: "20-seat threshold" });
    const hits = found.json.result as { page: { ref: string; frontmatter: Record<string, unknown> } }[];
    const hit = hits.find((h) => h.page.ref === "notes/2026-10/2026-10-07-pricing-sync-with-jonas-000001")!;
    expect(hit.page.frontmatter).toMatchObject({ recorded_by: "people/lena-vogel", team_id: s.teamId });

    // Non-members can't share or read.
    const eve = await signIn(s, "apple-eve", "Eve Outsider");
    expect((await appCall(s, eve.access_token, "POST", "/v1/app/teams/acme/notes", note)).status).toBe(403);
    expect((await appCall(s, eve.access_token, "POST", "/v1/app/teams/acme/query", { op: "recent" })).status).toBe(403);
  });

  it("reports a down team server as 503 so the phone keeps the note queued", async () => {
    const lena = await signIn(s, "apple-lena", "Lena Vogel");
    await s.t.mutation(s.internal.teams.setServerUrl, { slug: "acme", serverUrl: "http://127.0.0.1:9" });
    const res = await appCall(s, lena.access_token, "POST", "/v1/app/teams/acme/query", { op: "recent" });
    expect(res.status).toBe(503);
    const addr = s.teamServer.address() as { port: number };
    await s.t.mutation(s.internal.teams.setServerUrl, { slug: "acme", serverUrl: `http://127.0.0.1:${addr.port}` });
  });
});
