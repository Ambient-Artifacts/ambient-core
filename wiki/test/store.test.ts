// The store loads repositories Ambient didn't write: one bad front matter must not stop the team server.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WikiStore } from "../src/index.ts";

describe("front matter that isn't valid YAML", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  mkdirSync(join(dir, "people"));
  writeFileSync(join(dir, "people", "anna.md"), "---\ntitle: Anna\ntype: person\nsummary: Designer\n---\n# Anna\n");
  writeFileSync(join(dir, "people", "bert.md"), "---\ntitle: Bert\ntitle: Bert again\ntype: person\n---\n# Bert Huber\n\nSales lead.\n");
  writeFileSync(join(dir, "people", "carl.md"), "---\ntitle: [Carl\n---\n# Carl\n");

  it("loads the wiki anyway and indexes those pages without front matter", () => {
    const store = WikiStore.fromDirectory(dir, "team", "acme");
    expect(store.getByRef("people/anna")?.type).toBe("person");
    const bert = store.getByRef("people/bert");
    expect(bert?.type).toBe("other");
    expect(bert?.title).toBe("Bert Huber");
    expect(store.search("Sales lead").map((h) => h.page.ref)).toContain("people/bert");
    expect([...store.invalid.keys()].sort()).toEqual(["people/bert.md", "people/carl.md"]);
  });

  it("forgets the problem once the page is fixed or removed", () => {
    const store = WikiStore.fromDirectory(dir, "team", "acme");
    store.upsert("people/bert.md", "---\ntitle: Bert\ntype: person\n---\n# Bert\n");
    store.remove("people/carl.md");
    expect(store.invalid.size).toBe(0);
  });
});
