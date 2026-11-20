// Directory readiness (docs/connect-agents.md): Anthropic's connector directory requires every
// tool to have a title and say whether it only reads (readOnlyHint) or what it may destroy
// (destructiveHint). Checked for every kind of connection: personal with bots, personal without,
// and a team-only one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, INVITE, mcpClient, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;

beforeAll(async () => {
  s = await startStack({});
});
afterAll(() => s.close());

type Tool = { name: string; title?: string; annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean } };

async function tools(url: string, token: string): Promise<Tool[]> {
  const client = await mcpClient(url, token);
  const list = (await client.listTools()).tools as Tool[];
  await client.close();
  return list;
}

function problems(list: Tool[]): string[] {
  const out: string[] = [];
  for (const t of list) {
    if (!(t.title ?? t.annotations?.title)?.trim()) out.push(`${t.name}: no title`);
    const a = t.annotations ?? {};
    if (a.readOnlyHint !== true && typeof a.destructiveHint !== "boolean") out.push(`${t.name}: neither readOnlyHint: true nor destructiveHint`);
  }
  return out;
}

describe("every tool has a title and says whether it reads or what it may destroy", () => {
  it("for a person with bots, a person without, and a team-only connection", async () => {
    const lena = await signIn(s, "apple-lena-tools", "Lena Vogel");
    const ben = await signIn(s, "apple-ben-tools", "Ben Weiss");
    const joined = await appCall(s, lena.access_token, "POST", "/v1/app/teams/join", { code: INVITE });
    const slug = (joined.json.team as { slug: string }).slug;

    const personal = String((await appCall(s, lena.access_token, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const withBots = await tools(`${s.origin}/mcp`, personal);
    expect(withBots.map((t) => t.name)).toEqual(expect.arrayContaining(["search", "list_routines", "bot_files", "search_history"]));

    const benToken = String((await appCall(s, ben.access_token, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const withoutBots = await tools(`${s.origin}/mcp`, benToken);

    const teamToken = String((await appCall(s, lena.access_token, "POST", "/v1/app/pats", { label: "Copilot", team: slug })).json.token);
    const teamOnly = await tools(`${s.origin}/t/${slug}/mcp`, teamToken);

    expect(problems([...withBots, ...withoutBots, ...teamOnly])).toEqual([]);
  });
});
