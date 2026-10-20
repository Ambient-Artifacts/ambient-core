// A repo Ambient didn't write: files that aren't knowledge stay out (templates, a README), and a
// folder's own `_index.md` says what the folder holds. The index Ambient generates for it keeps
// those words, instead of "3 pages." alone.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildListing, headline, ignoring, LocalReader, normalizeIgnore, purposeOf, renderIndexFiles, renderListing, WikiStore } from "../src/index.ts";
import { fileLinks } from "../src/indexes.ts";

const STRATEGY = `# strategy

Company goals, positioning, target markets, references and partners.

**Look here for:** who we are and who we sell to.
**Not here:** product details, see [products](../products/_index.md).

## Pages

| Page | Description | Updated |
|---|---|---|
| [company-overview.md](company-overview.md) | What we are | 2026-09-24 |
`;

describe("what a folder says about itself", () => {
  it("is the text between its heading and its first section", () => {
    expect(purposeOf(STRATEGY)).toBe(
      "Company goals, positioning, target markets, references and partners.\n\n**Look here for:** who we are and who we sell to.\n**Not here:** product details, see [products](../products/_index.md).",
    );
    expect(purposeOf("---\ntitle: x\n---\n\n# Clients\n\nOne page per client.\n\n## Pages\n")).toBe("One page per client.");
    expect(purposeOf("# empty\n\nNothing yet.\n\n_No pages yet_\n")).toBe("Nothing yet.");
  });

  it("is nothing in an index Ambient generated", () => {
    const generated = "# People\n\n[Back to the index](../index.md)\n\n5 pages: the people in your conversations.\n\n## Pages\n- [Anna](anna.md)\n";
    expect(purposeOf(generated)).toBe("");
    expect(purposeOf("# notes/2026\n\n[Back to the index](../../index.md)\n\n12 pages.\n\n## Folders\n")).toBe("");
  });

  it("stays short, and a headline is one plain line", () => {
    expect(purposeOf(`# a\n\n${"word ".repeat(300).trim()}\n\n## Pages\n`).length).toBeLessThanOrEqual(1200);
    expect(headline("**Look here** for the `thing`.\nMore.")).toBe("Look here for the thing");
    expect(headline("x ".repeat(100))).toMatch(/…$/);
  });
});

describe("what stays out of the brain", () => {
  it("names folders and files, however they are written", () => {
    expect(normalizeIgnore(["./templates/", "/templates", "CLAUDE.md", " tools/wiki-sync/ ", "../etc", "a/../b", ""])).toEqual(["CLAUDE.md", "templates", "tools/wiki-sync"]);
    const out = ignoring(["templates", "tools/wiki-sync", "CLAUDE.md"]);
    expect(out("templates/client.md")).toBe(true);
    expect(out("templates")).toBe(true);
    expect(out("tools/wiki-sync/README.md")).toBe(true);
    expect(out("CLAUDE.md")).toBe(true);
    // A name, not a prefix of one.
    expect(out("templates-old/x.md")).toBe(false);
    expect(out("tools/other/README.md")).toBe(false);
    expect(out("notes/CLAUDE.md")).toBe(false);
    expect(ignoring([])("anything.md")).toBe(false);
  });
});

describe("a connected repo with its own indexes and plumbing", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-files-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const page = (title: string, type = "topic") => `---\ntitle: ${title}\ntype: ${type}\nsummary: ${title}.\nupdated: 2026-10-01\n---\n# ${title}\n`;
  write("strategy/company-overview.md", page("Company overview"));
  write("strategy/_index.md", STRATEGY);
  write("people/anna.md", page("Anna", "person"));
  write("people/_index.md", "# People\n\n[Back to the index](../index.md)\n\n1 page: the people in your conversations.\n\n## Pages\n");
  write("clients/acme.md", page("Acme", "client"));
  write("templates/client.md", page("<Client name>", "client"));
  write("templates/_index.md", "# templates\n\nBlueprints.\n");
  write("tools/wiki-sync/README.md", "# wiki-sync\n\nA sync tool.\n");
  write("tools/other/README.md", "# other\n");
  write("CLAUDE.md", "# Instructions\n");
  write("README.md", "# Readme\n");

  it("shows what a folder holds in the words of its own index, in the folder and in the top index", () => {
    const store = WikiStore.fromDirectory(dir, "team", "acme");
    expect([...store.folderNotes.keys()].sort()).toEqual(["strategy", "templates"]);
    const folder = renderListing(store.listing("strategy"), "Acme wiki", fileLinks);
    expect(folder).toContain("Company goals, positioning, target markets, references and partners.\n");
    expect(folder).toContain("**Look here for:** who we are and who we sell to.");
    expect(folder).toContain("\n1 page.\n");
    expect(folder).not.toContain("1 page: ");
    const top = renderListing(store.listing(""), "Acme wiki", fileLinks);
    expect(top).toContain("[strategy](strategy/_index.md): 1 page, Company goals, positioning, target markets, references and partners\n");
    // Ambient's own sections keep their line unless the repo says something else.
    expect(top).toContain("[People](people/_index.md): 1 page, the people in your conversations\n");
    expect(renderListing(store.listing("people"), "Acme wiki", fileLinks)).toContain("1 page: the people in your conversations.");
  });

  it("keeps those words in the index files Ambient writes (two-way)", () => {
    const store = WikiStore.fromDirectory(dir, "team", "acme");
    const files = renderIndexFiles(store.entries(), "Acme wiki", undefined, store.folderNotes);
    expect(files.get("strategy/_index.md")).toContain("Company goals, positioning, target markets, references and partners.");
    // Written again from that file, it says the same: no drift, nothing doubled.
    expect(purposeOf(files.get("strategy/_index.md")!)).toBe(purposeOf(STRATEGY));
  });

  it("leaves out what the team says isn't knowledge", async () => {
    const all = WikiStore.fromDirectory(dir, "team", "acme");
    expect(all.getByRef("templates/client")).toBeDefined();
    expect(all.getByRef("CLAUDE")).toBeDefined();
    const store = WikiStore.fromDirectory(dir, "team", "acme", { ignore: ["templates/", "tools/wiki-sync", "CLAUDE.md"] });
    expect(store.getByRef("templates/client")).toBeUndefined();
    expect(store.getByRef("tools/wiki-sync/README")).toBeUndefined();
    expect(store.getByRef("CLAUDE")).toBeUndefined();
    expect(store.getByRef("tools/other/README")).toBeDefined();
    expect(store.getByRef("README")).toBeDefined();
    expect(store.folderNotes.has("templates")).toBe(false);
    expect((await new LocalReader(store).listing()).folders.map((f) => f.path).sort()).toEqual(["clients", "people", "strategy", "tools"]);
    expect(buildListing(store.entries(), "").folders.some((f) => f.path === "templates")).toBe(false);
  });
});
