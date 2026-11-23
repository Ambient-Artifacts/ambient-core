// Where save_note and log_work write when no team is named: on a connection with a personal wiki and
// a team it may write to, the team, unless the conversation is in a private project (or the project
// isn't given). The MCP server with stand-ins for the stores; the paths through real servers are in
// mcp.test.ts and sessions.test.ts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { TeamNoteV1 } from "@brain/spec";
import type { Principal } from "../src/auth/bearer.ts";
import type { Team } from "../src/directory.ts";
import { buildMcpServer, type ReaderSource } from "../src/mcp/tools.ts";
import type { NoteSpec } from "../src/sessions/service.ts";
import { text } from "./helpers.ts";

const ACME: Team = { id: "team-acme", slug: "acme", name: "Acme", status: "active", serverUrl: "https://acme.example.com" };
const NORD: Team = { id: "team-nord", slug: "nord", name: "Nordlicht", status: "active", serverUrl: "https://nord.example.com" };
const ALL = new Set(["personal:read", "personal:write", "team:read", "team:write"]);

function principal(o: Partial<Principal> = {}): Principal {
  return { uid: "u_lena", scopes: ALL, via: "oauth", clientId: "claude", personal: true, teams: [ACME], ...o };
}

async function connect(p: Principal) {
  const logged: NoteSpec[] = [];
  const toTeams: { team: Team; note: TeamNoteV1 }[] = [];
  const personal: string[] = [];
  const readers: ReaderSource = {
    personal: async () => undefined,
    team: () => undefined,
    userName: async () => "Lena Vogel",
    savePersonal: async (_uid, path) => {
      personal.push(path);
    },
    logWork: async (_uid, spec) => {
      logged.push(spec);
      return { path: spec.personal ? "wiki/sessions/2026/11/x.md" : "", share: spec.team ? "delivered" : null, ...(spec.team ? { teamPath: "sessions/2026-11/x.md" } : {}) };
    },
    deliverToTeam: async (team, _uid, note) => {
      toTeams.push({ team, note });
      return { status: "stored", path: `notes/2026-11/${note.note_id.slice(-6).toLowerCase()}.md` };
    },
  };
  const server = buildMcpServer({ principal: p, readers, version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "brain-test", version: "0.0.0" });
  await client.connect(b);
  const tool = async (name: string) => (await client.listTools()).tools.find((t) => t.name === name)!;
  const fields = async (name: string) => Object.keys(((await tool(name)).inputSchema.properties ?? {}) as object);
  return { client, logged, toTeams, personal, tool, fields };
}

const work = { title: "Pricing page", summary: "Drafted the pricing page.", app: "Claude" };
const memo = { title: "Hosting", content: "The site runs behind a CDN." };

describe("a personal connection with one team", () => {
  it("tells the model the rule and to always pass the project", async () => {
    const { client, tool, fields } = await connect(principal());
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Where writes go");
    expect(instructions).toContain("Always\npass project");
    expect(instructions).not.toContain("more than one team");
    expect(await fields("save_note")).toContain("project");
    expect(await fields("save_note")).not.toContain("team");
    expect((await tool("log_work")).description).toContain("team brain (Acme) at once");
    expect((await tool("save_note")).description).toContain("team brain (Acme) at once");
  });

  it("logs work outside a private project to the team (and the user's own wiki), with no team named", async () => {
    const { client, logged } = await connect(principal());
    for (const project of ["none", "Sales 2027"]) {
      const r = await client.callTool({ name: "log_work", arguments: { ...work, project } });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain("to the Acme team wiki");
    }
    expect(logged.map((l) => [l.team?.slug, l.personal, l.immediate])).toEqual([
      ["acme", true, true],
      ["acme", true, true],
    ]);
  });

  it("keeps work from a private project personal, and refuses to share it", async () => {
    const { client, logged } = await connect(principal());
    for (const project of ["HR - Privat Test", "PRIVATE", "private: Verrechnung"]) {
      const r = await client.callTool({ name: "log_work", arguments: { ...work, project } });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain("to the user's Ambient wiki");
    }
    expect(logged.every((l) => l.team === null && !l.immediate)).toBe(true);
    const shared = await client.callTool({ name: "log_work", arguments: { ...work, project: "Privat", share_with_team: "acme" } });
    expect(shared.isError).toBe(true);
    expect(text(shared)).toContain("is a private project");
    expect(logged).toHaveLength(3);
  });

  it("treats a Claude Code working folder like a project: team, unless the path says private", async () => {
    const { client, logged } = await connect(principal());
    const cc = { ...work, app: "Claude Code" };
    const team = await client.callTool({ name: "log_work", arguments: { ...cc, project: "/Users/lena/Code/pricing-site" } });
    expect(text(team)).toContain("to the Acme team wiki");
    for (const project of ["/Users/lena/Privat/steuern", "/Users/lena/Code/PRIVATE-notes", "C:\\Users\\lena\\private\\cv"]) {
      const r = await client.callTool({ name: "log_work", arguments: { ...cc, project } });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain("to the user's Ambient wiki");
    }
    expect(logged.map((l) => l.team?.slug ?? null)).toEqual(["acme", null, null, null]);
    const shared = await client.callTool({ name: "log_work", arguments: { ...cc, project: "/Users/lena/Privat/steuern", share_with_team: "acme" } });
    expect(shared.isError).toBe(true);
    expect(text(shared)).toContain("is a private project");
  });

  it("tells Claude Code to pass its working folder as the project", async () => {
    const { client, tool } = await connect(principal());
    expect(client.getInstructions() ?? "").toContain("In Claude Code the project\nis the folder it works in");
    expect(JSON.stringify((await tool("log_work")).inputSchema)).toContain("its working directory");
  });

  it("keeps it personal when the project isn't given, and says how to send it to the team", async () => {
    const { client, logged, toTeams, personal } = await connect(principal());
    const r = await client.callTool({ name: "log_work", arguments: work });
    expect(text(r)).toContain("No project was given, so it stayed personal");
    expect(logged[0]).toMatchObject({ team: null });
    const n = await client.callTool({ name: "save_note", arguments: memo });
    expect(text(n)).toContain("No project was given");
    expect(personal).toHaveLength(1);
    expect(toTeams).toEqual([]);
  });

  it("saves a note to the team wiki, or to the personal one in a private project", async () => {
    const { client, toTeams, personal } = await connect(principal());
    const r = await client.callTool({ name: "save_note", arguments: { ...memo, project: "none" } });
    expect(text(r)).toContain("to the Acme team wiki");
    expect(toTeams[0]!.note.entry_page.body_md).toContain("Saved by Lena Vogel");
    const own = await client.callTool({ name: "save_note", arguments: { ...memo, project: "Privat" } });
    expect(own.isError).toBeFalsy();
    expect(text(own)).toContain("to the user's Ambient wiki");
    expect(personal).toHaveLength(1);
    expect(toTeams).toHaveLength(1);
  });
});

describe("with more than one team", () => {
  it("asks which team, writes to the one named, and needs none in a private project", async () => {
    const { client, logged, toTeams, fields } = await connect(principal({ teams: [ACME, NORD] }));
    expect(client.getInstructions()).toContain("more than one team (acme (Acme), nord (Nordlicht))");
    expect(await fields("save_note")).toContain("team");

    const unclear = await client.callTool({ name: "log_work", arguments: { ...work, project: "none" } });
    expect(unclear.isError).toBe(true);
    expect(text(unclear)).toContain("Pass share_with_team with the one this belongs to");
    const unclearNote = await client.callTool({ name: "save_note", arguments: { ...memo, project: "none" } });
    expect(text(unclearNote)).toContain("Pass team with the one this belongs to");
    expect(logged).toEqual([]);

    await client.callTool({ name: "log_work", arguments: { ...work, project: "none", share_with_team: "nord" } });
    expect(logged[0]).toMatchObject({ team: { slug: "nord" } });
    await client.callTool({ name: "save_note", arguments: { ...memo, project: "none", team: "acme" } });
    expect(toTeams[0]!.team.slug).toBe("acme");
    const other = await client.callTool({ name: "save_note", arguments: { ...memo, project: "none", team: "elsewhere" } });
    expect(text(other)).toContain('isn\'t in a team "elsewhere"');

    await client.callTool({ name: "log_work", arguments: { ...work, project: "Privat" } });
    expect(logged[1]).toMatchObject({ team: null });
  });
});

describe("connections without a team default", () => {
  it("no team:write: personal, as before", async () => {
    const { client, logged, toTeams, personal, tool } = await connect(principal({ scopes: new Set(["personal:read", "personal:write", "team:read"]) }));
    expect(client.getInstructions()).not.toContain("Where writes go");
    expect((await tool("log_work")).description).toContain("It goes to the user's personal wiki.");
    await client.callTool({ name: "log_work", arguments: { ...work, project: "none" } });
    expect(logged[0]).toMatchObject({ team: null });
    await client.callTool({ name: "save_note", arguments: { ...memo, project: "none" } });
    expect(personal).toHaveLength(1);
    expect(toTeams).toEqual([]);
  });

  it("no team: personal", async () => {
    const { client, logged } = await connect(principal({ teams: [] }));
    expect(client.getInstructions()).not.toContain("Where writes go");
    await client.callTool({ name: "log_work", arguments: { ...work, project: "none" } });
    expect(logged[0]).toMatchObject({ team: null });
  });

  it("a team's own connection writes to its team, never from a private project", async () => {
    const { client, logged, toTeams } = await connect(principal({ personal: false, scopes: new Set(["team:read", "team:write"]) }));
    await client.callTool({ name: "log_work", arguments: { ...work, project: "none" } });
    expect(logged[0]).toMatchObject({ team: { slug: "acme" }, personal: false });
    await client.callTool({ name: "save_note", arguments: { ...memo, project: "none" } });
    expect(toTeams[0]!.team.slug).toBe("acme");
    const priv = await client.callTool({ name: "save_note", arguments: { ...memo, project: "Privat" } });
    expect(priv.isError).toBe(true);
  });
});
