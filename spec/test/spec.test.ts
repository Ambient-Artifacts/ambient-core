import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  forgetNote,
  forgetNotes,
  mergeLiving,
  DecisionFrontmatter,
  LivingPageFrontmatter,
  NoteFrontmatter,
  TeamNoteV1,
  appendTimeline,
  foldText,
  parseActionItems,
  parsePage,
  renderPage,
  slugify,
  splitCompiled,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

describe("fixtures match the schemas", () => {
  const files = [...walk(join(FIXTURES, "wiki-personal", "wiki")), ...walk(join(FIXTURES, "wiki-team"))].filter(
    (f) => !f.endsWith("AGENTS.md"),
  );

  it("finds the fixture pages", () => {
    expect(files.length).toBe(11);
  });

  for (const file of files) {
    it(relative(FIXTURES, file), () => {
      const { frontmatter } = parsePage(readFileSync(file, "utf8"));
      const schema =
        frontmatter.type === "note"
          ? NoteFrontmatter
          : frontmatter.type === "decision"
            ? DecisionFrontmatter
            : LivingPageFrontmatter;
      const r = schema.safeParse(frontmatter);
      expect(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2)).toBe(true);
    });
  }
});

describe("page helpers", () => {
  it("folds umlauts so both spellings meet", () => {
    expect(foldText("Anna Müller")).toBe(foldText("Anna Mueller"));
    expect(foldText("Straße Café")).toBe("strasse cafe");
  });

  it("slugifies to file-safe names", () => {
    expect(slugify("Preisgespräch mit Anna!")).toBe("preisgespraech-mit-anna");
  });

  it("splits current truth from the timeline and appends without rewriting", () => {
    const body = "# X\n\n- fact\n\n## Timeline\n- 2026-10-05: later\n- 2026-10-01: earlier\n";
    const split = splitCompiled(body);
    expect(split.currentTruth).toBe("# X\n\n- fact");
    expect(split.timeline).toHaveLength(2);
    const next = appendTimeline(body, ["- 2026-10-03: middle", "- 2026-10-05: later"]);
    expect(splitCompiled(next).timeline).toEqual([
      "- 2026-10-01: earlier",
      "- 2026-10-03: middle",
      "- 2026-10-05: later",
    ]);
    expect(next.startsWith("# X\n\n- fact\n")).toBe(true);
  });

  it("parses action items with owner and due date", () => {
    const body = "## Action items\n- [ ] Anna Müller: send draft (due 2026-10-10)\n- [x] tidy up\n\n## Next\n- [ ] not me\n";
    expect(parseActionItems(body)).toEqual([
      { done: false, owner: "Anna Müller", task: "send draft", due: "2026-10-10" },
      { done: true, owner: null, task: "tidy up", due: null },
    ]);
  });

  it("round-trips front matter", () => {
    const text = readFileSync(join(FIXTURES, "wiki-team", "people", "jonas-becker.md"), "utf8");
    const page = parsePage(text);
    expect(parsePage(renderPage(page))).toEqual(page);
  });
});

describe("team-note/v1", () => {
  it("rejects notes without confirmed consent", () => {
    const base = {
      schema: "brain.team-note/v1",
      note_id: "01JB4D1P6RSTUVWXYZ98765432",
      team_id: "t_acme",
      recorded_by: "u_jonas",
      recorded_at: "2026-10-02T11:00:00+02:00",
      duration_s: 2405,
      language: "de-DE",
      kind: "call",
      entry_page: { frontmatter: {}, body_md: "# x" },
      transcript: null,
      client: { app: "1.0 (1)", transcriber: "SpeechTranscriber de-DE", compiler: "fm-ondevice" },
    };
    expect(TeamNoteV1.safeParse({ ...base, consent: { mode: "unknown", confirmed_at: "2026-10-02T11:41:00+02:00" } }).success).toBe(false);
    expect(TeamNoteV1.safeParse({ ...base, consent: { mode: "all-agreed", confirmed_at: "2026-10-02T11:41:00+02:00" } }).success).toBe(true);
  });
});

describe("mergeLiving (server head + both timelines)", () => {
  const server = `---
title: Anna Müller
type: person
summary: Product designer, leads the pricing page.
aliases: [Anna]
update_mode: compiled
status: active
compiled_through: 01A
pending_rewrite: 0
updated: 2026-10-06
---
# Anna Müller

- Leads the pricing page redesign.

## Open questions
- (none)

## Timeline
- 2026-10-01: Talked pricing ([note](../notes/a.md))
`;
  const phone = `---
title: Anna Mueller
type: person
summary: old summary
aliases: []
update_mode: compiled
status: active
compiled_through: 00Z
pending_rewrite: 1
updated: 2026-10-07
---
# Anna Mueller

- old truth

## Timeline
- 2026-10-01: Talked pricing ([note](../notes/a.md))
- 2026-10-07: Reviewed onboarding ([note](../notes/b.md))
`;

  it("keeps the server's head and adds the phone's new timeline lines", () => {
    const merged = mergeLiving(server, phone);
    const page = parsePage(merged);
    expect(page.body).toContain("- Leads the pricing page redesign.");
    expect(page.body).not.toContain("old truth");
    expect(splitCompiled(page.body).timeline).toEqual([
      "- 2026-10-01: Talked pricing ([note](../notes/a.md))",
      "- 2026-10-07: Reviewed onboarding ([note](../notes/b.md))",
    ]);
    expect(page.frontmatter).toMatchObject({ title: "Anna Müller", summary: "Product designer, leads the pricing page.", compiled_through: "01A", updated: "2026-10-07", pending_rewrite: 1 });
  });

  it("returns the server text untouched when the phone added nothing new", () => {
    const stale = phone.replace("- 2026-10-07: Reviewed onboarding ([note](../notes/b.md))\n", "");
    expect(mergeLiving(server, stale)).toBe(server);
  });

  it("is stable: merging the result again changes nothing", () => {
    const once = mergeLiving(server, phone);
    expect(mergeLiving(once, phone)).toBe(once);
  });
});

describe("forgetNote", () => {
  const anna = renderPage({
    frontmatter: { title: "Anna Müller", type: "person", pending_rewrite: 0, updated: "2026-10-08" },
    body: "\n# Anna Müller\n\n- Owns pricing.\n\n## Timeline\n- 2026-10-01: Owns pricing ([note](../notes/2026/10/2026-10-01-pricing-aaaaaa.md))\n- 2026-10-08: In a test ([note](../notes/2026/10/2026-10-08-test-bbbbbb.md))\n",
  });
  const solo = renderPage({
    frontmatter: { title: "Johann Beurich", type: "person", updated: "2026-10-08" },
    body: "\n# Johann Beurich\n\n- YouTuber.\n\n## Timeline\n- 2026-10-08: YouTuber ([note](../notes/2026/10/2026-10-08-test-bbbbbb.md))\n",
  });
  const note = renderPage({ frontmatter: { type: "note", raw: "raw/2026/10/01K7TEST.md" }, body: "\n# Test\n" });
  const pages = new Map([
    ["wiki/people/anna-mueller.md", anna],
    ["wiki/people/johann-beurich.md", solo],
    ["wiki/notes/2026/10/2026-10-08-test-bbbbbb.md", note],
  ]);
  const r = forgetNote("wiki/notes/2026/10/2026-10-08-test-bbbbbb.md", pages);

  it("removes the note, its transcript and pages that only it created", () => {
    expect(r.deletes).toEqual(["wiki/notes/2026/10/2026-10-08-test-bbbbbb.md", "raw/2026/10/01K7TEST.md", "wiki/people/johann-beurich.md"]);
  });
  it("keeps other recordings' lines and marks the page for a rewrite", () => {
    const page = parsePage(r.writes.find((w) => w.path === "wiki/people/anna-mueller.md")!.content);
    expect(splitCompiled(page.body).timeline).toEqual(["- 2026-10-01: Owns pricing ([note](../notes/2026/10/2026-10-01-pricing-aaaaaa.md))"]);
    expect(splitCompiled(page.body).currentTruth).toContain("- Owns pricing.");
    expect(page.frontmatter.pending_rewrite).toBe(1);
  });
  it("does several at once, as one after another would", () => {
    const both = forgetNotes(["wiki/notes/2026/10/2026-10-08-test-bbbbbb.md", "wiki/notes/2026/10/2026-10-01-pricing-aaaaaa.md", "wiki/notes/2026/10/2026-10-08-test-bbbbbb.md"], pages);
    expect(both.writes).toEqual([]);
    expect(both.deletes).toEqual([
      "wiki/notes/2026/10/2026-10-08-test-bbbbbb.md",
      "raw/2026/10/01K7TEST.md",
      "wiki/notes/2026/10/2026-10-01-pricing-aaaaaa.md",
      "wiki/people/anna-mueller.md",
      "wiki/people/johann-beurich.md",
    ]);
  });
  it("reads each page once, however many recordings go", () => {
    const many = new Map(pages);
    for (let i = 0; i < 3000; i++) many.set(`wiki/topics/t${i}.md`, solo.replace("2026-10-08-test-bbbbbb", `2026-10-08-t-${String(i).padStart(6, "0")}`));
    const gone = Array.from({ length: 500 }, (_, i) => `wiki/notes/2026/10/made-up-${i}.md`);
    const started = performance.now();
    forgetNotes(gone, many);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
