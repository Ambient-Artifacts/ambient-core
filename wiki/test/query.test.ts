// Pages of a connected repo open by the name the repo gives them: a customer wiki's CLAUDE.md, README.md
// and pipelines/README.md showed in the app's file list, but opening them failed ("Couldn't load this page"),
// because a ref had to be lowercase.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchQuery, LocalReader, QueryRequest, WikiStore } from "../src/index.ts";

describe("page refs as the repo names them", () => {
  const dir = mkdtempSync(join(tmpdir(), "query-"));
  mkdirSync(join(dir, "pipelines"));
  mkdirSync(join(dir, "Unternehmen"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Acme Wiki – Instructions for Claude\n\nRead index.md first.\n");
  writeFileSync(join(dir, "pipelines", "README.md"), "# Pipelines\n\nYAML pipelines.\n");
  writeFileSync(join(dir, "Unternehmen", "Über uns.md"), "---\ntitle: Über uns\ntype: topic\n---\n# Über uns\n");
  const reader = new LocalReader(WikiStore.fromDirectory(dir, "team", "acme"));
  const get = async (ref: string) => dispatchQuery(reader, QueryRequest.parse({ op: "getByRef", ref })) as Promise<{ title: string } | null>;

  it("opens pages with capitals, spaces and umlauts in their path", async () => {
    expect((await get("CLAUDE"))?.title).toBe("Acme Wiki – Instructions for Claude");
    expect((await get("pipelines/README"))?.title).toBe("Pipelines");
    expect((await get("Unternehmen/Über uns"))?.title).toBe("Über uns");
    expect(QueryRequest.safeParse({ op: "listing", folder: "Unternehmen/" }).success).toBe(true);
  });

  it("still refuses refs that aren't a page path", () => {
    for (const ref of ["", "/etc/passwd", "../secrets", "people/../../x", "a//b", "a/./b", "a\u0000b", "a\\b", "x".repeat(301)]) {
      expect(QueryRequest.safeParse({ op: "getByRef", ref }).success, JSON.stringify(ref)).toBe(false);
    }
    expect(QueryRequest.safeParse({ op: "listing", folder: "../" }).success).toBe(false);
  });
});
