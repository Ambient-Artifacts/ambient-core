// Pages worth reading: sections by kind of page, a capture policy in the prompt, the recorder's
// own notes kept out of their page's timeline, and one page per person (the Ambient team wiki
// had four pages for its founder, one of them listing server IPs).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePage, renderPage, splitCompiled, type TeamNoteV1 } from "@brain/spec";
import { WikiStore } from "@brain/wiki";
import { pagePrompt } from "../src/anthropic.ts";
import { composePage, consolidate, consolidatePages, headParts, normalizeUpdate, type PageUpdateInput, type PageUpdater } from "../src/consolidate.ts";
import { dedupe, dedupPlan, relinkPage } from "../src/dedup.ts";
import { ingestNote } from "../src/ingest.ts";
import { TeamWiki } from "../src/wiki.ts";

function living(type: string, title: string, body: string, aliases: string[] = []) {
  return renderPage({
    frontmatter: { title, type, summary: `${title} summary.`, aliases, update_mode: "compiled", status: "active", compiled_through: "N0", updated: "2026-10-10" },
    body: `\n${body}`,
  });
}

function noteText(id: string, title: string, fm: Record<string, unknown>, body = "") {
  return renderPage({
    frontmatter: { id, type: "note", title, summary: `${title}.`, kind: "session", recorded_at: "2026-10-14T10:00:00Z", duration_s: 0, language: "en", scope: "team", team_id: "t1", consent: { mode: "solo" }, updated: "2026-10-14", ...fm },
    body: `\n# ${title}\n\n${body}`,
  });
}

class Recorder implements PageUpdater {
  model = "claude-haiku-4-5";
  seen: PageUpdateInput[] = [];
  constructor(private reply: (input: PageUpdateInput) => unknown = () => ({})) {}
  async update(input: PageUpdateInput) {
    this.seen.push(input);
    return { update: this.reply(input), usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 } };
  }
}

describe("sections by kind of page", () => {
  it("lays out a person page in its sections, in order, within their limits", () => {
    const upd = normalizeUpdate(
      {
        title: "Anna Müller",
        summary: "Head of sales at Bergmann Logistik.",
        aliases: ["Anna"],
        sections: { contact: ["anna@bergmann.example"], who: ["Head of sales at Bergmann Logistik."], workingOn: ["- The SSO rollout.", "", "a", "b", "c", "d"], unknown: ["dropped"] },
        openQuestions: [],
        timeline: [],
      },
      "person",
    );
    expect(upd.sections.map((s) => s.heading)).toEqual(["Who they are", "Working on", "Contact"]);
    expect(upd.sections[1]!.bullets).toEqual(["The SSO rollout.", "a", "b", "c"]);
    const page = composePage("people/anna-mueller", "person", undefined, upd, new Map(), "N1");
    const body = parsePage(page.text).body;
    expect(body).toContain("# Anna Müller\n\n### Who they are\n- Head of sales at Bergmann Logistik.\n\n### Working on\n- The SSO rollout.");
    expect(body).toContain("## Open questions\n- (none)\n\n## Timeline");
    expect(headParts(body).sections.map((s) => s.bullets.length)).toEqual([1, 4, 1]);
  });

  it("keeps a page's head when the model has nothing true to say, and gives a new page its summary", () => {
    const prev = living("person", "Anna Müller", "# Anna Müller\n\n### Who they are\n- Head of sales.\n\n## Open questions\n- (none)\n\n## Timeline\n- 2026-10-01: Met. ([note](../notes/a.md))\n");
    const s = new WikiStore("team", "t1");
    s.upsert("people/anna-mueller.md", prev);
    const empty = normalizeUpdate({ title: "Anna", summary: "Someone.", aliases: [], sections: {}, openQuestions: [], timeline: [] }, "person");
    const kept = parsePage(composePage("people/anna-mueller", "person", s.getByRef("people/anna-mueller"), empty, new Map(), "N2").text);
    expect(kept.frontmatter.title).toBe("Anna Müller");
    expect(kept.body).toContain("### Who they are\n- Head of sales.");
    expect(splitCompiled(kept.body).timeline).toHaveLength(1);
    const fresh = parsePage(composePage("people/ben-koch", "person", undefined, empty, new Map(), "N2").text);
    expect(fresh.body).toContain("# Anna\n\n- Someone.");
  });

  it("keeps the old title as an alias when the name gets fuller", () => {
    const s = new WikiStore("team", "t1");
    s.upsert("people/ben.md", living("person", "Ben", "# Ben\n\n- Designer.\n\n## Timeline\n"));
    const upd = normalizeUpdate({ title: "Ben Koch", summary: "Designer.", aliases: [], sections: { who: ["Designer."] }, openQuestions: [], timeline: [] }, "person");
    const fm = parsePage(composePage("people/ben", "person", s.getByRef("people/ben"), upd, new Map(), "N3").text).frontmatter;
    expect(fm).toMatchObject({ title: "Ben Koch", aliases: ["Ben"] });
  });
});

describe("the page prompt", () => {
  const input: PageUpdateInput = {
    ref: "people/nikolai",
    type: "person",
    existing: null,
    evidence: [
      { note: "sessions/a", date: "2026-10-14", title: "Deploy", summary: "Deployed.", body: "Deployed to 10.0.0.1.", role: "recorder" },
      { note: "notes/b", date: "2026-10-14", title: "Call", summary: "Call.", body: "Nikolai leads sales." },
    ],
  };

  it("tells the model what to keep and what to leave out, and how the page is laid out", () => {
    const { system, user } = pagePrompt(input, "team");
    expect(system).toContain("The page is about its subject only");
    expect(system).toContain("server names and IP addresses");
    expect(system).toContain("Supersede, don't append");
    expect(system).toContain('"workingOn" (Working on, at most 4)');
    expect(system).toContain("how they relate to the team");
    expect(system).toContain('role="recorder"');
    expect(user).toContain('<evidence note="sessions/a" date="2026-10-14" role="recorder">');
    expect(user).toContain('<evidence note="notes/b" date="2026-10-14">');
  });

  it("asks topics for one list, and personal pages for no timeline", () => {
    expect(pagePrompt({ ...input, ref: "topics/pricing", type: "topic" }, "team").system).toContain('"currentTruth": at most 10');
    const personal = pagePrompt(input, "personal").system;
    expect(personal).toContain('return "timeline" as an empty list');
    expect(personal).toContain("how they relate to the wiki's owner");
  });
});

describe("consolidation", () => {
  it("marks the notes a page's subject recorded, and rewrites a page from its latest notes without new timeline lines", async () => {
    const s = new WikiStore("team", "t1");
    s.upsert("people/lena.md", living("person", "Lena Vogel", "# Lena Vogel\n\n- Sales.\n\n## Timeline\n- 2026-10-01: Old. ([note](../notes/old.md))\n"));
    s.upsert("notes/old.md", noteText("N-OLD-000001", "Old", { recorded_by: "people/lena", people: ["people/lena"] }));
    s.upsert("notes/new.md", noteText("N-NEW-000002", "New", { recorded_by: "people/lena", people: ["people/lena", "people/petra"] }));
    const updater = new Recorder((i) => ({ title: i.ref === "people/lena" ? "Lena Vogel" : "Petra", summary: "x", aliases: [], sections: { who: ["Someone."] }, openQuestions: [], timeline: i.evidence.map((e) => ({ note: e.note, date: e.date, fact: "A fact." })) }));
    const pages: { path: string; text: string }[] = [];
    const out = await consolidatePages({ store: s, updater, done: new Set(["N-OLD-000001"]), mode: "team", rewrite: ["people/petra-unknown"], write: async (p) => (pages.push(...p), null) });
    expect(out.requests).toBe(2);
    const lena = updater.seen.find((i) => i.ref === "people/lena")!;
    expect(lena.evidence).toEqual([expect.objectContaining({ note: "notes/new", role: "recorder" })]);
    expect(updater.seen.find((i) => i.ref === "people/petra")!.evidence[0]!.role).toBeUndefined();

    // A rewrite: the latest notes are the evidence, the timeline gets nothing twice.
    const s2 = new WikiStore("team", "t1");
    for (const p of [...pages]) s2.upsert(p.path, p.text);
    s2.upsert("notes/old.md", noteText("N-OLD-000001", "Old", { recorded_by: "people/lena", people: ["people/lena"] }));
    s2.upsert("notes/new.md", noteText("N-NEW-000002", "New", { recorded_by: "people/lena", people: ["people/lena", "people/petra"] }));
    const before = splitCompiled(s2.getByRef("people/lena")!.body).timeline;
    const again: { path: string; text: string }[] = [];
    const r2 = await consolidatePages({ store: s2, updater, done: new Set(["N-OLD-000001", "N-NEW-000002"]), mode: "team", rewrite: ["people/lena"], write: async (p) => (again.push(...p), null) });
    expect(r2.fresh).toBe(0);
    expect(updater.seen.at(-1)!.evidence.map((e) => e.note)).toEqual(["notes/old", "notes/new"]);
    const after = parsePage(again[0]!.text);
    expect(splitCompiled(after.body).timeline).toEqual(before);
    expect(after.body).toContain("### Who they are\n- Someone.");
  });
});

describe("one page per person", () => {
  async function ambientLikeWiki() {
    const wiki = await TeamWiki.open(join(mkdtempSync(join(tmpdir(), "brain-dedup-")), "wiki"), "t1", "Ambient");
    await wiki.write(async (put) => {
      await put("people/nikolai.md", living("person", "Nikolai Madlener", "# Nikolai Madlener\n\n- Builds Ambient.\n\n## Open questions\n- (none)\n\n## Timeline\n- 2026-10-07: Built the MVP. ([note](../sessions/2026-10/a.md))\n", ["Nikolai"]));
      await put("people/nikolai-madlener.md", living("person", "Nikolai Madlener", "# Nikolai Madlener\n\n- Provisioned servers at 10.0.0.1.\n- Builds Ambient.\n\n## Open questions\n- Which CSS framework?\n\n## Timeline\n- 2026-10-14: Set the ICP. ([note](../sessions/2026-10/b.md))\n", ["Nikolai"]));
      await put("people/nikolai-person-working-testing-on-mac.md", living("person", "Nikolai", "# Nikolai\n\n- Tests on the Mac.\n\n## Timeline\n- 2026-10-08: Tested calendar. ([note](../sessions/2026-10/c.md))\n"));
      await put("sessions/2026-10/a.md", noteText("N-A-00000001", "MVP", { recorded_by: "people/nikolai", people: ["people/nikolai"] }, "## Related\n- [Nikolai Madlener](../../people/nikolai.md)\n"));
      await put(
        "sessions/2026-10/b.md",
        noteText("N-B-00000002", "ICP", { recorded_by: "people/nikolai", people: ["people/nikolai", "people/nikolai-madlener"] }, "Talked to [Nikolai](../../people/nikolai-madlener.md).\n\n## Related\n- [Nikolai Madlener](../../people/nikolai.md)\n- [Nikolai Madlener](../../people/nikolai-madlener.md)\n"),
      );
      await put(
        "sessions/2026-10/c.md",
        noteText("N-C-00000003", "Calendar", { recorded_by: "people/nikolai", people: ["people/nikolai", "people/nikolai-person-working-testing-on-mac", "people/dorfuchs-youtuber-test-case-for-comment-preservation"] }, "## Related\n- [Nikolai](../../people/nikolai-person-working-testing-on-mac.md)\n- [Dorfuchs](../../people/dorfuchs-youtuber-test-case-for-comment-preservation.md)\n- [Brain iOS](../../projects/brain-ios.md)\n"),
      );
      await put("projects/brain-ios.md", living("project", "Brain iOS", "# Brain iOS\n\n- The app.\n\n## Timeline\n"));
      return { message: "test: setup", result: {} };
    });
    return wiki;
  }

  it("plans the merge into the page notes are recorded by, and drops links to descriptions", async () => {
    const wiki = await ambientLikeWiki();
    const plan = dedupPlan(wiki.store);
    expect(plan.groups).toEqual([["people/nikolai", "people/nikolai-madlener", "people/nikolai-person-working-testing-on-mac"]]);
    expect(plan.map.get("people/nikolai-madlener")).toBe("people/nikolai");
    expect(plan.map.get("people/dorfuchs-youtuber-test-case-for-comment-preservation")).toBeNull();
    expect(plan.titles.get("people/nikolai")).toBe("Nikolai Madlener");
  });

  it("merges the pages, repoints every link and commits once", async () => {
    const wiki = await ambientLikeWiki();
    const out = await dedupe(wiki, "2026-10-15");
    expect(out.merged).toEqual([{ into: "people/nikolai", from: ["people/nikolai-madlener", "people/nikolai-person-working-testing-on-mac"] }]);
    expect(out.commit).toBeTruthy();
    expect(existsSync(join(wiki.dir, "people/nikolai-madlener.md"))).toBe(false);
    expect(existsSync(join(wiki.dir, "people/nikolai-person-working-testing-on-mac.md"))).toBe(false);

    const kept = parsePage(readFileSync(join(wiki.dir, "people/nikolai.md"), "utf8"));
    expect(kept.frontmatter).toMatchObject({ title: "Nikolai Madlener", updated: "2026-10-15" });
    expect(kept.frontmatter.aliases).toEqual(["Nikolai"]);
    expect(headParts(kept.body).openQuestions).toEqual(["Which CSS framework?"]);
    expect(splitCompiled(kept.body).timeline.map((l) => l.slice(2, 12))).toEqual(["2026-10-07", "2026-10-08", "2026-10-14"]);

    const b = parsePage(readFileSync(join(wiki.dir, "sessions/2026-10/b.md"), "utf8"));
    expect(b.frontmatter.people).toEqual(["people/nikolai"]);
    expect(b.body).toContain("Talked to [Nikolai](../../people/nikolai.md).");
    expect(b.body).toContain("## Related\n- [Nikolai Madlener](../../people/nikolai.md)\n");
    expect(b.body.match(/people\/nikolai\.md/g)).toHaveLength(2);

    const c = parsePage(readFileSync(join(wiki.dir, "sessions/2026-10/c.md"), "utf8"));
    expect(c.frontmatter.people).toEqual(["people/nikolai"]);
    expect(c.body).not.toContain("Dorfuchs");
    expect(c.body).toContain("- [Brain iOS](../../projects/brain-ios.md)");
    expect(wiki.store.lint().counts.broken_link).toBe(0);
    expect(readFileSync(join(wiki.dir, "log.md"), "utf8")).toContain("dedup | merged people/nikolai-madlener, people/nikolai-person-working-testing-on-mac into people/nikolai (1 links to descriptions dropped)");

    // Nothing left to do the second time.
    expect((await dedupe(wiki)).commit).toBeNull();
  });

  it("runs before consolidation, which rewrites the merged page", async () => {
    const wiki = await ambientLikeWiki();
    const updater = new Recorder((i) => ({ title: "Nikolai Madlener", summary: "Founder of Ambient.", aliases: [], sections: { who: ["Founder of Ambient."] }, openQuestions: [], timeline: [] }));
    const result = await consolidate(wiki, updater, { outDir: join(wiki.dir, "..", "out"), version: "test" });
    expect(result.checks.find((c) => c.name === "dedup")).toMatchObject({ ok: true });
    expect(updater.seen.find((i) => i.ref === "people/nikolai")).toBeTruthy();
    expect(updater.seen.some((i) => i.ref === "people/nikolai-madlener")).toBe(false);
    expect(readFileSync(join(wiki.dir, "people/nikolai.md"), "utf8")).toContain("### Who they are\n- Founder of Ambient.");
  });

  it("leaves a page alone that links nothing merged", () => {
    const s = new WikiStore("team", "t1");
    const text = noteText("N-X-00000009", "X", { people: ["people/anna"] }, "## Related\n- [Anna](../people/anna.md)\n");
    s.upsert("notes/x.md", text);
    expect(relinkPage(s.getByRef("notes/x")!, text, new Map([["people/ben", "people/ben-koch"]]))).toBeNull();
  });
});

describe("ingest", () => {
  function teamNote(people: string[], name = "Lena Vogel"): TeamNoteV1 {
    return {
      schema: "brain.team-note/v1",
      note_id: `01JBINGEST${String(people.length).padStart(16, "0")}`,
      team_id: "t1",
      recorded_by: "u_lena",
      recorded_by_name: name,
      recorded_at: "2026-10-14T10:00:00Z",
      duration_s: 60,
      language: "en",
      kind: "session",
      consent: { mode: "solo", confirmed_at: "2026-10-14T10:01:00Z" },
      entry_page: { frontmatter: { title: "Pricing", summary: "Pricing work.", people }, body_md: "# Pricing\n\nWork." },
      transcript: null,
      participants_hint: [],
      client: { app: "claude-code", transcriber: "none", compiler: "session-summary" },
    };
  }

  it("links the pages the wiki has, the recorder by their own page, and no description", async () => {
    const wiki = await TeamWiki.open(join(mkdtempSync(join(tmpdir(), "brain-ingest-")), "wiki"), "t1", "Acme");
    await wiki.write(async (put) => {
      await put("people/anna-mueller.md", living("person", "Anna Müller", "# Anna Müller\n\n- Sales.\n\n## Timeline\n", ["Anna"]));
      return { message: "test: setup", result: {} };
    });
    const out = await ingestNote(wiki, teamNote(["people/lena-vogel", "people/anna", "people/klaus-from-the-bergmann-sales-team-today"]), { rawDir: join(wiki.dir, "..", "raw"), recordedBySlug: "people/lena" });
    const fm = parsePage(readFileSync(join(wiki.dir, out.path), "utf8")).frontmatter;
    expect(fm.people).toEqual(["people/lena", "people/anna-mueller"]);
  });
});
