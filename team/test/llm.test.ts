// The brain's model calls (llm.ts): every writer takes an API key or an Llm, and every answer is
// checked against its shape, whoever wrote it. claudeCodeLlm runs Claude Code on this machine
// (here a stand-in) with no tools, MCP or settings, and the user message on stdin.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicOverviewWriter, claudeCodeArgs, claudeCodeLlm, toWire, type Llm } from "../src/index.ts";

const answer = { headline: "Pricing.", now: [], activeProjects: [], keyPeople: [], openLoops: [], recentDecisions: [] };
const input = { kind: "personal", title: "Your brain", today: "2026-11-19" } as never;

describe("Llm", () => {
  it("lets a writer use any Llm and checks what comes back", async () => {
    const calls: unknown[] = [];
    const good: Llm = { parse: async (req) => (calls.push(req), { output: answer, usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0 } }) };
    expect((await new AnthropicOverviewWriter(good).write(input)).overview).toEqual(answer);
    expect(calls).toHaveLength(1);
    const bad: Llm = { parse: async () => ({ output: { headline: 3 }, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } }) };
    await expect(new AnthropicOverviewWriter(bad).write(input)).rejects.toThrow("model returned no parseable overview");
  });

  it("sends the shape as JSON Schema", () => {
    const wire = toWire({ model: "haiku", maxTokens: 100, system: "s", user: "u", schema: z.object({ a: z.array(z.string()) }), what: "x" });
    expect(wire.schema).toMatchObject({ type: "object", properties: { a: { type: "array" } }, required: ["a"] });
    // Claude Code refuses a schema that names its draft (tried for real: draft 2020-12 isn't known to it).
    expect(wire.schema).not.toHaveProperty("$schema");
    const args = claudeCodeArgs(wire);
    for (const [flag, value] of [["--tools", ""], ["--setting-sources", ""], ["--model", "haiku"], ["--system-prompt", "s"]] as const) expect(args[args.indexOf(flag) + 1]).toBe(value);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
  });

  it("runs Claude Code on this machine, the message on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-"));
    const claude = join(dir, "claude");
    writeFileSync(
      claude,
      `#!/bin/sh
cat > "${dir}/stdin.txt"
echo "\${CLAUDE_CONFIG_DIR:-none}" > "${dir}/config.txt"
echo '{"type":"result","subtype":"success","is_error":false,"structured_output":${JSON.stringify(answer)},"usage":{"input_tokens":3,"cache_creation_input_tokens":10,"output_tokens":4}}'
`,
    );
    chmodSync(claude, 0o755);
    const w = new AnthropicOverviewWriter(claudeCodeLlm({ claude, configDir: join(dir, "cfg") }));
    const out = await w.write(input);
    expect(out).toEqual({ overview: answer, usage: { input_tokens: 13, output_tokens: 4, cache_read_tokens: 0 } });
    expect(readFileSync(join(dir, "stdin.txt"), "utf8")).toContain("<wiki_state>");
    expect(readFileSync(join(dir, "config.txt"), "utf8").trim()).toBe(join(dir, "cfg"));

    writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\necho '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Not logged in"}'\n`);
    await expect(w.write(input)).rejects.toThrow("Claude Code couldn't write the overview: Not logged in");
  });
});
