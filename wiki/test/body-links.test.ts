// Links in a page's text count for the graph and backlinks: wikis people or other tools write
// (a team's own repo) link there, not in front matter.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bodyLinks, LocalReader, WikiStore } from "../src/index.ts";

describe("bodyLinks", () => {
  it("resolves relative and root links to refs, and skips everything that isn't a page", () => {
    const body = [
      "See [Anna](../people/anna-muster.md) and [the plan](./plan.md#next) and [Acme](/companies/acme.md).",
      "[Spaced](../people/ben%20koch.md), [angle](<../people/cara.md>), [titled](../people/dora.md \"Dora\").",
      "Not pages: [site](https://example.com/a.md), [mail](mailto:a@example.com), [img](../assets/logo.png), [anchor](#top).",
      "Out of the wiki: [up](../../secrets.md), [hidden](../.github/x.md).",
      "```",
      "[in code](../people/ignored.md)",
      "```",
      "Twice: [Anna again](../people/anna-muster.md)",
    ].join("\n");
    expect(bodyLinks("projects/launch.md", body)).toEqual(["people/anna-muster", "projects/plan", "companies/acme", "people/ben koch", "people/cara", "people/dora"]);
  });

  it("works in a personal store, under wiki/", () => {
    expect(bodyLinks("wiki/people/anna.md", "[x](../projects/p.md) [y](../../raw/2026/10/t.md)", "wiki/")).toEqual(["projects/p"]);
  });
});

describe("the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "body-links-"));
  for (const f of ["people", "companies", "meetings"]) mkdirSync(join(dir, f));
  writeFileSync(join(dir, "people", "anna.md"), "---\ntitle: Anna\ntype: person\n---\n# Anna\n\nWorks with [Acme](../companies/acme.md).\n");
  writeFileSync(join(dir, "companies", "acme.md"), "---\ntitle: Acme\n---\n# Acme\n");
  writeFileSync(join(dir, "meetings", "kickoff.md"), "---\ntitle: Kickoff\n---\n# Kickoff\n\nWith [Anna](../people/anna.md) and [someone gone](../people/gone.md).\n");

  it("draws text links in the graph and backlinks, and keeps them out of the broken-link check", async () => {
    const store = WikiStore.fromDirectory(dir, "team", "acme");
    const reader = new LocalReader(store);
    expect((await reader.links()).sort((a, b) => a.src.localeCompare(b.src))).toEqual([
      { src: "meetings/kickoff", dst: "people/anna" },
      { src: "people/anna", dst: "companies/acme" },
    ]);
    expect((await reader.backlinks("people/anna")).map((b) => b.ref)).toEqual(["meetings/kickoff"]);
    expect(store.lint().issues.filter((i) => i.kind === "broken_link")).toEqual([]);
  });
});
