// The "this repo already has files" question shows a few names: pages people recognise, not
// the hidden folders git happens to list first.
import { describe, expect, it } from "vitest";
import { HasContent, sampleFiles } from "../src/index.ts";

describe("sampleFiles", () => {
  it("shows pages from different folders first and hidden files last", () => {
    const files = [
      ".azuredevops/pull_request_template.md", ".claude/commands/cleanup.md", ".claude/skills/wiki/SKILL.md",
      "CLAUDE.md", "README.md", "clients/acme.md", "clients/bergmann.md", "decisions/0001-pricing.md",
      "people/lena-vogel.md", "pipelines/sync.yml", "products/brain.md", "scripts/sync.py",
    ];
    expect(sampleFiles(files)).toEqual(["clients/acme.md", "decisions/0001-pricing.md", "people/lena-vogel.md", "products/brain.md", "CLAUDE.md"]);
    expect(HasContent.of(files)).toMatchObject({ files: 12, sample: sampleFiles(files), code: "has_content" });
  });

  it("fills up from the same folder, and falls back to other and hidden files", () => {
    expect(sampleFiles(["wiki/a.md", "wiki/b.md", "wiki/c.md"])).toEqual(["wiki/a.md", "wiki/b.md", "wiki/c.md"]);
    expect(sampleFiles([".github/x.yml", "main.py", "README.md"])).toEqual(["README.md", "main.py", ".github/x.yml"]);
    expect(sampleFiles([])).toEqual([]);
  });
});
