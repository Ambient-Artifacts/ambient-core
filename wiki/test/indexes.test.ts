// Index pages: listings per folder, the files written into wiki repos, and the
// AGENTS.md agents read first.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDoc, buildListing, renderIndexFiles, WikiStore } from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "spec", "fixtures");
const personal = WikiStore.fromDirectory(join(FIXTURES, "wiki-personal"), "personal");
const team = WikiStore.fromDirectory(join(FIXTURES, "wiki-team"), "team", "acme");

describe("listing", () => {
  it("lists the sections at the top with counts, recent pages and the latest notes", () => {
    const top = personal.listing();
    expect(top.folder).toBe("");
    expect(top.folders.map((f) => f.path)).toEqual(["people", "projects", "topics", "notes"]);
    expect(top.folders.find((f) => f.path === "notes")?.pages).toBe(3);
    expect(top.total).toBe(personal.size);
    expect(top.latestNotes?.[0]?.ref).toBe("notes/2026/10/2026-10-05-onboarding-review-with-anna-3c9n5q");
    expect(top.recentlyUpdated?.every((e) => e.type !== "note")).toBe(true);
  });

  it("walks down the note folders, newest first", () => {
    expect(personal.listing("notes").folders.map((f) => f.path)).toEqual(["notes/2026"]);
    const month = personal.listing("notes/2026/10");
    expect(month.folders).toEqual([]);
    expect(month.pages.map((p) => p.date)).toEqual(["2026-10-05", "2026-10-02", "2026-10-01"]);
  });

  it("lists living pages alphabetically with their summary", () => {
    const people = team.listing("people");
    expect(people.pages.map((p) => p.title)).toEqual([...people.pages.map((p) => p.title)].sort((a, b) => a.localeCompare(b)));
    expect(people.pages.every((p) => p.summary.length > 0)).toBe(true);
    expect(buildListing(team.entries(), "/people/")).toEqual(people);
  });

  it("says who recorded each note, for the apps' Mine filter, and nothing on other pages", () => {
    const entries = team.entries();
    expect(entries.find((e) => e.ref === "notes/2026-10/2026-10-02-kundencall-bergmann-logistik-4d1p6r")?.recordedBy).toBe("people/jonas-becker");
    expect(entries.filter((e) => e.type !== "note").every((e) => e.recordedBy === undefined)).toBe(true);
  });
});

describe("index files", () => {
  const files = renderIndexFiles(personal.entries(), "Ambient wiki");

  it("writes index.md plus an _index.md for every folder that holds pages", () => {
    expect([...files.keys()].sort()).toEqual(
      ["index.md", "notes/2026/10/_index.md", "notes/2026/_index.md", "notes/_index.md", "people/_index.md", "projects/_index.md", "topics/_index.md"].sort(),
    );
  });

  it("links with relative paths that resolve from each file", () => {
    const top = files.get("index.md")!;
    expect(top).toContain("# Ambient wiki");
    expect(top).toContain("[People](people/_index.md): 1 page, the people in your conversations");
    expect(top).toContain("(notes/2026/10/2026-10-05-onboarding-review-with-anna-3c9n5q.md)");
    const month = files.get("notes/2026/10/_index.md")!;
    expect(month).toContain("[Back to the index](../../../index.md)");
    expect(month).toContain("(2026-10-01-preisgespraech-mit-anna-1xq7zk.md)");
    expect(files.get("notes/_index.md")).toContain("[2026](2026/_index.md): 3 pages");
  });

  it("is stable: same pages, same bytes (no timestamps)", () => {
    expect(renderIndexFiles(personal.entries(), "Ambient wiki")).toEqual(files);
  });

  it("generated files are not pages", () => {
    const keys = personal.entries().map((e) => e.ref);
    expect(keys.some((k) => k.endsWith("_index") || k === "index")).toBe(false);
  });
});

describe("AGENTS.md", () => {
  it("tells agents where to start and what they may edit", () => {
    const doc = agentsDoc({ kind: "team", name: "Acme wiki" });
    expect(doc).toContain("Start with `index.md`");
    expect(doc).toContain("Rewrite only the part above `## Timeline`");
    expect(doc).toContain("`decisions/`");
    expect(agentsDoc({ kind: "personal", name: "Ambient wiki" })).toContain("`notes/YYYY/MM/`");
  });
});
