// Lint: every kind of finding on a small personal wiki built for it.
import { describe, expect, it } from "vitest";
import { attention, renderIndexFiles, WikiStore } from "../src/index.ts";

const living = (title: string, type: string, extra = "", body = "- fact") =>
  `---\ntitle: ${title}\ntype: ${type}\nsummary: About ${title}\nupdated: 2026-10-01\n${extra}---\n# ${title}\n\n${body}\n\n## Timeline\n- 2026-10-01: met ([note](../notes/a.md))\n`;

function wiki(): WikiStore {
  const s = new WikiStore("personal");
  s.upsert("wiki/people/anna.md", living("Anna", "person"));
  s.upsert("wiki/people/anna-mueller.md", living("Anna Müller", "person", "", "- designer\n\n## Open questions\n- Is the launch in May or June?"));
  s.upsert("wiki/projects/old-thing.md", living("Old Thing", "project").replace("updated: 2026-10-01", "updated: 2026-01-02"));
  s.upsert(
    "wiki/notes/2026/10/a.md",
    "---\ntitle: Kickoff\ntype: note\nsummary: We met.\nrecorded_at: 2026-10-01T09:00:00Z\npeople: [people/anna, people/anna-mueller, people/ghost]\nprojects: [projects/old-thing]\ncompile:\n  engine: fm-ondevice\n  fallback: none\n---\nbody\n",
  );
  s.upsert(
    "wiki/notes/2026/10/b.md",
    "---\ntitle: Call\ntype: note\nsummary: First words only.\nrecorded_at: 2026-10-02T09:00:00Z\ncompile:\n  engine: extractive\n  fallback: model_unavailable\n---\nbody\n",
  );
  return s;
}

describe("lint", () => {
  const report = wiki().lint({ today: "2026-10-07" });
  const of = (kind: string) => report.issues.filter((i) => i.kind === kind);

  it("finds broken links, duplicates, weak notes, open questions and stale pages", () => {
    expect(of("broken_link").map((i) => [i.ref, i.refs[0]])).toEqual([["notes/2026/10/a", "people/ghost"]]);
    expect(of("possible_duplicate").map((i) => [i.ref, i.refs[0]])).toEqual([["people/anna", "people/anna-mueller"]]);
    expect(of("weak_note").map((i) => i.ref)).toEqual(["notes/2026/10/b"]);
    expect(of("open_question")[0]).toMatchObject({ ref: "people/anna-mueller", detail: "Is the launch in May or June?" });
    expect(of("stale").map((i) => i.ref)).toEqual(["projects/old-thing"]);
    expect(of("orphan")).toEqual([]);
    expect(report.counts).toMatchObject({ broken_link: 1, possible_duplicate: 1, weak_note: 1, open_question: 1, stale: 1, orphan: 0 });
    expect(report.checked).toEqual({ pages: 5, notes: 2, living: 3 });
  });

  it("flags living pages nothing links to", () => {
    const s = wiki();
    s.upsert("wiki/topics/lonely.md", living("Lonely", "topic"));
    expect(s.lint({ today: "2026-10-07" }).issues.filter((i) => i.kind === "orphan").map((i) => i.ref)).toEqual(["topics/lonely"]);
  });

  it("puts the most important findings on the top-level index", () => {
    const top = attention(report, 3);
    expect(top.map((t) => t.label)).toEqual(["Broken link", "Possible duplicate", "Weak note"]);
    const index = renderIndexFiles(wiki().entries(), "Ambient wiki", top).get("index.md")!;
    expect(index).toContain("## Needs attention");
    expect(index).toContain("- Possible duplicate: [people/anna](people/anna.md) / [people/anna-mueller](people/anna-mueller.md).");
    expect(wiki().listing().attention?.length).toBeGreaterThan(0);
  });
});
