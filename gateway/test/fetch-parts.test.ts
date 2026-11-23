// A long page or transcript is read in parts: fetch and transcript return about 20,000 characters and
// say where to continue. Before, everything past 25,000 characters was cut off for good.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/bearer.ts";
import { buildMcpServer, part, PART_CHARS, type ReaderSource } from "../src/mcp/tools.ts";
import { text } from "./helpers.ts";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${String(i).padStart(5, "0")}: ${"x".repeat(80)}`).join("\n");
const LONG = `${lines(600)}\n## The STAGILE Agent talk\nSlide 13: data protection in Azure.`;

const page = { ref: "services/top-event/agenda", title: "TOP.Event 2026", type: "service", summary: "", updated: "2026-10-28", frontmatter: {}, body: LONG };

async function connect() {
  const store = { getByRef: async (ref: string) => (ref === page.ref ? page : undefined), backlinks: async () => [] };
  const readers = { personal: async () => store, team: () => undefined, userName: async () => "Martin" } as unknown as ReaderSource;
  const principal: Principal = { uid: "u_martin", scopes: new Set(["personal:read"]), via: "oauth", clientId: "claude", personal: true, teams: [] };
  const server = buildMcpServer({ principal, readers, version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "brain-test", version: "0.0.0" });
  await client.connect(b);
  return client;
}

describe("part", () => {
  it("cuts at a line break and says where to go on", () => {
    const p = part(LONG);
    expect(p.text.length).toBeLessThanOrEqual(PART_CHARS);
    expect(p.text.endsWith("\n")).toBe(true);
    expect(p.next).toBe(p.text.length);
    const rest = part(LONG, p.next!);
    expect(p.text + rest.text + part(LONG, rest.next ?? LONG.length).text).toBe(LONG);
    expect(part("short").next).toBeNull();
    expect(part("short", 99).text).toBe("");
  });
});

describe("fetch on a long page", () => {
  it("gives the first part, then the rest on request, so the end of the page can be read", async () => {
    const client = await connect();
    const first = text(await client.callTool({ name: "fetch", arguments: { id: `personal:${page.ref}` } }));
    expect(first).toContain("Line 00000");
    expect(first).not.toContain("STAGILE Agent talk");
    const offset = Number(/offset: (\d+)/.exec(first)?.[1]);
    expect(offset).toBeGreaterThan(0);
    let at: number | null = offset;
    let all = first;
    while (at !== null) {
      const next = text(await client.callTool({ name: "fetch", arguments: { id: `personal:${page.ref}`, offset: at } }));
      all += next;
      const m = /offset: (\d+)/.exec(next);
      at = m ? Number(m[1]) : null;
    }
    expect(all).toContain("Slide 13: data protection in Azure.");
    expect(all).not.toContain("[truncated]");
  });
});
