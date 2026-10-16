// The parts of the placement eval (run.ts) that don't need a model to be tested: the fixture
// wikis, the MCP connection an app would make, and the scoring.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LocalReader, WikiStore } from "@brain/wiki";
import type { Principal } from "../gateway/src/auth/bearer.ts";
import { personalInstructions } from "../gateway/src/mcp/context.ts";
import { buildMcpServer, type ReaderSource } from "../gateway/src/mcp/tools.ts";
import { grade, type Question } from "./questions.ts";

const HERE = import.meta.dirname;
export const TODAY = "2026-10-15";
const MAX_ROUNDS = 8;

export type Condition = "general" | "personal";

export interface Result {
  id: string;
  kind: Question["kind"];
  condition: Condition;
  correct: boolean;
  abstained: boolean;
  /** Tools called before the answer, in order (Ambient's and the other apps'). */
  tools: string[];
  answer: string;
  inputTokens: number;
  outputTokens: number;
}

export function wikis() {
  const team = WikiStore.fromDirectory(join(HERE, "fixture"), "team", "t_kessler");
  const personal = new WikiStore("personal");
  personal.upsert("wiki/me.md", readFileSync(join(HERE, "personal", "me.md"), "utf8"));
  const readers: ReaderSource = { personal: async () => new LocalReader(personal), team: () => new LocalReader(team) };
  const principal: Principal = {
    uid: "u_mara",
    scopes: new Set(["personal:read", "team:read"]),
    via: "pat",
    personal: true,
    teams: [{ id: "t_kessler", slug: "kessler", name: "Kessler Werkzeuge", status: "active", serverUrl: null, role: "member", peopleSlug: "people/mara-huber" }],
  };
  return { readers, principal };
}

export async function connect(condition: Condition) {
  const { readers, principal } = wikis();
  const personal = condition === "personal" ? await personalInstructions(principal, readers, { name: "Mara Huber" }) : null;
  const server = buildMcpServer({ principal, readers, version: "eval", personal });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "ambient-eval", version: "1" });
  await client.connect(clientSide);
  const listed = (await client.listTools()).tools.filter((t) => t.annotations?.readOnlyHint === true);
  const tools: Anthropic.Tool[] = listed.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
  return { client, tools, instructions: client.getInstructions() ?? "" };
}

/**
 * The other apps a member has connected next to Ambient (as in claude.ai on 2026-10-15, when
 * the model didn't look in Ambient): they find nothing here, so looking in Ambient is a choice
 * the model has to make, not the only thing it can do.
 */
export const OTHER_TOOLS: Anthropic.Tool[] = [
  { name: "web_search", description: "Search the web.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "gmail_search", description: "Search the user's Gmail messages.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "drive_search", description: "Search files in the user's Google Drive.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const OTHER = new Set(OTHER_TOOLS.map((t) => t.name));

/** Did the model use Ambient (rather than only the other apps)? */
export const lookedInAmbient = (tools: string[]) => tools.some((t) => !OTHER.has(t));

const resultText = (r: unknown) =>
  ((r as { content?: { type: string; text?: string }[] }).content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .slice(0, 20_000);

export async function ask(anthropic: Anthropic, model: string, condition: Condition, q: Question): Promise<Result> {
  const { client, tools, instructions } = await connect(condition);
  const system = `You are Claude, a helpful assistant. Today is ${TODAY}. The user has connected Gmail, Google Drive and Ambient, and you can search the web. Ambient's instructions follow.\n\n<app name="ambient">\n${instructions}\n</app>`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: q.ask }];
  const used: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await anthropic.messages.create({ model, max_tokens: 1500, system, tools: [...OTHER_TOOLS, ...tools], messages });
    inputTokens += res.usage.input_tokens;
    outputTokens += res.usage.output_tokens;
    answer = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || calls.length === 0) break;
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      used.push(call.name);
      const out = OTHER.has(call.name)
        ? { content: [{ type: "text", text: "No results." }] }
        : await client.callTool({ name: call.name, arguments: call.input as Record<string, unknown> }).catch((err: Error) => ({ content: [{ type: "text", text: `error: ${err.message}` }], isError: true }));
      results.push({ type: "tool_result", tool_use_id: call.id, content: resultText(out) || "(empty)", ...((out as { isError?: boolean }).isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  await client.close();
  const g = grade(q, answer);
  return { id: q.id, kind: q.kind, condition, correct: g.correct, abstained: g.abstained, tools: used, answer, inputTokens, outputTokens };
}

export interface Summary {
  score: number;
  of: number;
  recall: number;
  precision: number;
  looked: number;
  abstainedRight: number;
}

export function summarize(results: Result[]): Summary {
  const answerable = results.filter((r) => r.kind !== "negative");
  const negatives = results.filter((r) => r.kind === "negative");
  const right = answerable.filter((r) => r.correct).length;
  const wrong = answerable.filter((r) => !r.correct && !r.abstained).length;
  return {
    score: results.filter((r) => r.correct).length,
    of: results.length,
    recall: answerable.length ? right / answerable.length : 0,
    precision: right + wrong ? right / (right + wrong) : 0,
    looked: results.filter((r) => lookedInAmbient(r.tools)).length,
    abstainedRight: negatives.filter((r) => r.correct).length,
  };
}

