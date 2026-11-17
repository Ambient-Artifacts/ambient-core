// Claude with an Ambient MCP server built in this process (as /mcp or /t/<team>/mcp would be for
// the person), connected over an in-memory transport: the same tools, instructions and permissions
// as in Claude with the Ambient connector, limited to an allowlist. The Teams bot and Ambient's
// chat both answer this way; neither has a second implementation of the brain's reads.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

type ContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export async function toolLoop(o: {
  server: McpServer;
  apiKey: string;
  model: string;
  /** Added after the server's own instructions. */
  instructions: string;
  /** Tool names the model may call; the rest stay hidden. */
  allowed: Set<string>;
  history: Turn[];
  /** The new message: text, or content blocks (text, images, documents). */
  question: string | unknown[];
  maxSteps?: number;
  maxTokens?: number;
  clientName?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: o.clientName ?? "ambient", version: "1" });
  await o.server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const tools = (await client.listTools()).tools
      .filter((t) => o.allowed.has(t.name))
      .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema }));
    const system = `${client.getInstructions() ?? ""}\n\n${o.instructions}`.trim();
    const messages: { role: "user" | "assistant"; content: unknown }[] = [...o.history.map((t) => ({ role: t.role, content: t.text })), { role: "user", content: o.question }];
    for (let step = 0; step < (o.maxSteps ?? 8); step++) {
      const res = await f("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": o.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: o.model, max_tokens: o.maxTokens ?? 1500, system, tools, messages }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await res.json().catch(() => ({}))) as { content?: ContentBlock[]; stop_reason?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? ""}`.trim());
      const content = body.content ?? [];
      messages.push({ role: "assistant", content });
      const calls = content.filter((c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use");
      if (body.stop_reason !== "tool_use" || !calls.length) {
        return content
          .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();
      }
      const results = [];
      for (const call of calls) {
        if (!o.allowed.has(call.name)) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: "This tool isn't available here.", is_error: true });
          continue;
        }
        const out = await client.callTool({ name: call.name, arguments: (call.input ?? {}) as Record<string, unknown> }).catch((err: Error) => ({
          content: [{ type: "text", text: err.message }],
          isError: true,
        }));
        // The structured result when the tool gives one: it carries what the text leaves out (a page's
        // front matter: owner, sources, status), as Claude Code and other MCP clients see it.
        const structured = (out as { structuredContent?: unknown }).structuredContent;
        const text = (
          structured
            ? JSON.stringify(structured)
            : ((out.content ?? []) as { type: string; text?: string }[])
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n")
        ).slice(0, 40_000);
        results.push({ type: "tool_result", tool_use_id: call.id, content: text || "(empty)", ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    return "";
  } finally {
    await client.close().catch(() => undefined);
    await o.server.close().catch(() => undefined);
  }
}
