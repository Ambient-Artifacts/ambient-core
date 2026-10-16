// One page per entity: refs a summarizer made up map to the page the wiki has, and pages that
// are one person twice are found (the Ambient team wiki had four pages for its founder).
import { describe, expect, it } from "vitest";
import { descriptiveRef, entityName, personName, renderPage } from "@brain/spec";
import { EntityIndex, WikiStore } from "../src/index.ts";

function living(type: string, title: string, aliases: string[] = [], body = "- Something true.") {
  return renderPage({
    frontmatter: { title, type, summary: `${title}.`, aliases, update_mode: "compiled", status: "active", updated: "2026-10-10" },
    body: `\n# ${title}\n\n${body}\n\n## Timeline\n`,
  });
}

function store(pages: Record<string, string>): WikiStore {
  const s = new WikiStore("team", "t1");
  for (const [path, text] of Object.entries(pages)) s.upsert(path, text);
  return s;
}

describe("names", () => {
  it("takes names and turns away descriptions", () => {
    expect(personName("Anna Müller")).toBe("Anna Müller");
    expect(personName("Maria de la Cruz")).toBe("Maria de la Cruz");
    expect(personName("Nikolai (person working/testing on Mac)")).toBeNull();
    expect(personName("the new designer")).toBeNull();
    expect(personName("Klaus from the Bergmann sales team today")).toBeNull();
    expect(entityName("projects", "Ambient")).toBe("Ambient");
    expect(entityName("projects", "Ambient Mac app (brain-ios repo): recording, wiki")).toBeNull();
    expect(descriptiveRef("people/nikolai-person-working-testing-on-mac")).toBe(true);
    expect(descriptiveRef("people/anna-mueller")).toBe(false);
  });
});

describe("canonical refs", () => {
  const s = store({
    "people/nikolai.md": living("person", "Nikolai Madlener", ["Nikolai"]),
    "people/anna-mueller.md": living("person", "Anna Müller"),
    "people/ben.md": living("person", "Ben"),
    "orgs/bergmann-logistik.md": living("org", "Bergmann Logistik", ["Bergmann"]),
    "projects/brain-ios.md": living("project", "Brain iOS"),
  });
  const index = new EntityIndex(s);

  it("keeps refs to pages that exist, and new entities", () => {
    expect(index.canonical("people/anna-mueller")).toBe("people/anna-mueller");
    expect(index.canonical("people/petra-schaefer")).toBe("people/petra-schaefer");
    expect(index.canonical("notes/2026-10/x")).toBe("notes/2026-10/x");
  });

  it("maps another spelling to the page that goes by it", () => {
    expect(index.canonical("people/nikolai-madlener")).toBe("people/nikolai");
    expect(index.canonical("orgs/bergmann")).toBe("orgs/bergmann-logistik");
    expect(index.canonical("people/anna")).toBe("people/anna-mueller");
    // The only Ben has no last name yet.
    expect(index.canonical("people/ben-koch")).toBe("people/ben");
  });

  it("maps the recorder's full name to their own page, even before it exists", () => {
    const empty = new EntityIndex(store({}));
    expect(empty.canonical("people/lena-vogel", { recorder: { ref: "people/lena", name: "Lena Vogel" } })).toBe("people/lena");
    expect(empty.canonical("people/petra-schaefer", { recorder: { ref: "people/lena", name: "Lena Vogel" } })).toBe("people/petra-schaefer");
  });

  it("maps a description to the one page it names, and drops it when it names none", () => {
    expect(index.canonical("people/nikolai-person-working-testing-on-mac")).toBe("people/nikolai");
    expect(index.canonical("people/dorfuchs-youtuber-test-case-for-comment-preservation")).toBeNull();
    expect(index.canonical("projects/brain-ios-ios-app-now-synced-with-mac")).toBe("projects/brain-ios");
  });
});

describe("duplicates", () => {
  it("groups one person's pages with the page notes are recorded by first", () => {
    const s = store({
      "people/nikolai.md": living("person", "Nikolai Madlener", ["Nikolai"]),
      "people/nikolai-madlener.md": living("person", "Nikolai Madlener", ["Nikolai"]),
      "people/nikolai-person-working-testing-on-mac.md": living("person", "Nikolai"),
      "people/anna-mueller.md": living("person", "Anna Müller", ["Anna"]),
      "people/anna-schmidt.md": living("person", "Anna Schmidt", ["Anna"]),
      "orgs/bergmann-logistik.md": living("org", "Bergmann Logistik"),
      "orgs/bergmann.md": living("org", "Bergmann", ["Bergmann Logistik"]),
    });
    const groups = new EntityIndex(s).duplicates({ recorders: new Set(["people/nikolai"]) });
    expect(groups).toContainEqual(["people/nikolai", "people/nikolai-madlener", "people/nikolai-person-working-testing-on-mac"]);
    // Two Annas who share a first name stay two people.
    expect(groups.flat()).not.toContain("people/anna-mueller");
    expect(groups.find((g) => g.includes("orgs/bergmann"))?.sort()).toEqual(["orgs/bergmann", "orgs/bergmann-logistik"]);
  });

  it("doesn't merge a first-name page when two people have that first name", () => {
    const s = store({
      "people/anna.md": living("person", "Anna"),
      "people/anna-mueller.md": living("person", "Anna Müller"),
      "people/anna-schmidt.md": living("person", "Anna Schmidt"),
    });
    expect(new EntityIndex(s).duplicates()).toEqual([]);
  });

  it("merges two pages with the same email", () => {
    const s = store({
      "people/petra.md": living("person", "Petra S.", [], "### Contact\n- petra@bergmann.example"),
      "people/petra-schaefer.md": living("person", "Petra Schäfer", [], "### Contact\n- Petra@Bergmann.example"),
    });
    expect(new EntityIndex(s).duplicates()).toEqual([["people/petra-schaefer", "people/petra"]]);
  });
});
