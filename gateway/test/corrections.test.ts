// suggest_correction: a team member says what the team wiki got wrong, as an attributed, dated
// note for whoever keeps the page. The MCP server with stand-ins for the team servers; the
// path through a real team server is in mcp.test.ts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { TeamNoteV1 } from "@brain/spec";
import type { Principal } from "../src/auth/bearer.ts";
import type { Team } from "../src/directory.ts";
import { buildMcpServer, type ReaderSource } from "../src/mcp/tools.ts";
import { TeamServerError } from "../src/teams.ts";
import { text } from "./helpers.ts";

const ACME: Team = { id: "team-acme", slug: "acme", name: "Acme", status: "active", serverUrl: "https://acme.example.com", peopleSlug: "people/lena-vogel" };
const NORD: Team = { id: "team-nord", slug: "nord", name: "Nordlicht", status: "active", serverUrl: "https://nord.example.com" };

function principal(o: Partial<Principal> = {}): Principal {
  return { uid: "u_lena", scopes: new Set(["team:read", "team:write"]), via: "oauth", clientId: "claude", personal: false, teams: [ACME], ...o };
}

/** The MCP server for `p`, with team servers that keep what they're sent (or throw `fail`). */
async function connect(p: Principal, fail?: Error) {
  const sent: { team: Team; uid: string; note: TeamNoteV1 }[] = [];
  const readers: ReaderSource = {
    personal: async () => undefined,
    team: () => undefined,
    userName: async () => "Lena Vogel",
    deliverToTeam: async (team, uid, note) => {
      if (fail) throw fail;
      sent.push({ team, uid, note });
      return { status: "stored", path: `corrections/2026-11/${note.note_id.slice(-6).toLowerCase()}.md` };
    },
  };
  const server = buildMcpServer({ principal: p, readers, version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "brain-test", version: "0.0.0" });
  await client.connect(b);
  return { client, sent };
}

const ask = { wrong: "Anna Mueller leads sales.", right: "Anna leads support since October; Petra leads sales.", app: "Claude" };

describe("suggest_correction", () => {
  it("is offered only to connections that may write to a team", async () => {
    const names = async (p: Principal) => (await (await connect(p)).client.listTools()).tools.map((t) => t.name);
    expect(await names(principal())).toContain("suggest_correction");
    expect(await names(principal({ scopes: new Set(["team:read"]) }))).not.toContain("suggest_correction");
    // Personal only: no team to correct.
    expect(await names(principal({ personal: true, teams: [], scopes: new Set(["personal:read", "personal:write", "team:read", "team:write"]) }))).not.toContain("suggest_correction");
    const { client } = await connect(principal());
    const tool = (await client.listTools()).tools.find((t) => t.name === "suggest_correction")!;
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.description).toContain("save_note");
    expect(tool.description).toContain("doesn't change right away");
  });

  it("sends a dated, signed note to the only team, right away, with the pages it came from", async () => {
    const { client, sent } = await connect(principal());
    const r = await client.callTool({
      name: "suggest_correction",
      arguments: { ...ask, how_known: "I was in the reorg meeting (Org chart 2026-10).", pages: ["team:acme:people/anna-mueller", "projects/sales-push.md", "ambient://team/acme/people/anna-mueller", "decisions/0004-sales-lead"] },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Sent the correction to the Acme team wiki as corrections/2026-11/");
    expect(text(r)).toContain("The page isn't changed yet");
    expect(sent).toHaveLength(1);
    const { team, uid, note } = sent[0]!;
    expect([team.slug, uid]).toEqual(["acme", "u_lena"]);
    expect(TeamNoteV1.parse(note)).toEqual(note);
    expect(note).toMatchObject({
      team_id: "team-acme",
      recorded_by: "u_lena",
      recorded_by_name: "Lena Vogel",
      kind: "correction",
      duration_s: 0,
      language: "en",
      consent: { mode: "solo" },
      transcript: null,
      client: { app: "ai:claude", transcriber: "none", compiler: "none" },
    });
    expect(note.entry_page.frontmatter).toMatchObject({
      title: "Correction: Anna Mueller",
      people: ["people/anna-mueller"],
      projects: ["projects/sales-push"],
      orgs: [],
      topics: [],
    });
    expect(String(note.entry_page.frontmatter.summary).length).toBeLessThanOrEqual(200);
    const day = note.recorded_at.slice(0, 10);
    expect(note.entry_page.body_md).toBe(
      "# Correction: Anna Mueller\n\n## What the wiki says\n> Anna Mueller leads sales.\n\n## What is true\nAnna leads support since October; Petra leads sales." +
        "\n\n## How I know\nI was in the reorg meeting (Org chart 2026-10)." +
        "\n\n## Pages\n- `people/anna-mueller`\n- `projects/sales-push`\n- `decisions/0004-sales-lead`" +
        `\n\nSuggested by Lena Vogel on ${day} through Claude.`,
    );
  });

  it("needs the team when there are several, unless the pages name it", async () => {
    const { client, sent } = await connect(principal({ teams: [ACME, NORD] }));
    const r = await client.callTool({ name: "suggest_correction", arguments: ask });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Pass team: acme, nord");
    expect((await client.callTool({ name: "suggest_correction", arguments: { ...ask, team: "other" } })).isError).toBe(true);
    expect((await client.callTool({ name: "suggest_correction", arguments: { ...ask, pages: ["team:nord:people/anna-mueller"] } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "suggest_correction", arguments: { ...ask, team: "acme" } })).isError).toBeFalsy();
    expect(sent.map((s) => s.team.slug)).toEqual(["nord", "acme"]);
    // A page of another team's wiki isn't this one's.
    const mixed = await client.callTool({ name: "suggest_correction", arguments: { ...ask, team: "acme", pages: ["team:nord:people/anna-mueller"] } });
    expect(text(mixed)).toContain("isn't a page of the Acme team wiki");
  });

  it("refuses the personal wiki's pages: those are fixed with save_note", async () => {
    const { client, sent } = await connect(principal({ personal: true, scopes: new Set(["personal:read", "personal:write", "team:read", "team:write"]) }));
    const r = await client.callTool({ name: "suggest_correction", arguments: { ...ask, pages: ["personal:people/anna-mueller"] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("save_note");
    expect(sent).toEqual([]);
  });

  it("says what an admin can do when another tool keeps the team's brain, and when to try again", async () => {
    const ro = await connect(principal(), new TeamServerError(409, "team server answered 409"));
    const r = await ro.client.callTool({ name: "suggest_correction", arguments: ask });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      "Acme's brain is kept by another tool and Ambient may not write into it. An admin can let Ambient write one folder (change_team_settings repo_writes one_folder); corrections then land there for the team's own upkeep.",
    );
    const down = await connect(principal(), new TeamServerError(503, "team server unreachable"));
    expect(text(await down.client.callTool({ name: "suggest_correction", arguments: ask }))).toContain("isn't available right now. Try again later.");
  });
});
