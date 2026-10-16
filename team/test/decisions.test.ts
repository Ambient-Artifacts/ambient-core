// Decision pages: only significant decisions, affects limited to the note's links,
// and a superseded decision is marked as such with a pointer to its successor.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionFrontmatter, parsePage } from "@brain/spec";
import { WikiStore } from "@brain/wiki";
import { decisionInput, decisionPages } from "../src/decisions.ts";

const store = WikiStore.fromDirectory(join(import.meta.dirname, "..", "..", "spec", "fixtures", "wiki-team"), "team", "acme");

describe("decision pages", () => {
  const note = store.ofType("note").find((n) => decisionInput(n, store) !== null)!;

  it("gives the model the note's decisions, links and the current decisions", () => {
    const input = decisionInput(note, store)!;
    expect(input.note.decisions.length).toBeGreaterThan(0);
    expect(input.existing.map((d) => d.ref)).toContain("decisions/0001-annual-billing-for-large-teams");
  });

  it("writes significant decisions, numbered, and supersedes the old one", () => {
    const links = decisionInput(note, store)!.note.links;
    let n = 1;
    const pages = decisionPages(
      {
        decisions: [
          { significant: true, title: "Annual billing from 10 seats", statement: "Teams with 10+ seats are billed annually from 2026-11-01.", affects: [links[0]!, "projects/not-linked"], supersedes: "decisions/0001-annual-billing-for-large-teams" },
          { significant: false, title: "Send the deck", statement: "Jonas sends the deck.", affects: [], supersedes: null },
        ],
      },
      note,
      store,
      "2026-10-07",
      () => ++n,
    );
    expect(pages.map((p) => p.path)).toEqual(["decisions/0002-annual-billing-from-10-seats.md", "decisions/0001-annual-billing-for-large-teams.md"]);
    const created = parsePage(pages[0]!.text);
    expect(DecisionFrontmatter.safeParse(created.frontmatter).success).toBe(true);
    expect(created.frontmatter).toMatchObject({ status: "accepted", supersedes: "decisions/0001-annual-billing-for-large-teams", source: note.ref, affects: [links[0]] });
    expect(created.body).toContain(`(../${note.ref}.md)`);
    const old = parsePage(pages[1]!.text);
    expect(old.frontmatter.status).toBe("superseded");
    expect(old.body).toContain("Superseded on 2026-10-07 by [Annual billing from 10 seats](../decisions/0002-annual-billing-from-10-seats.md)");
  });
});
