// Where the brain's model calls go (docs/architecture.md, "Upkeep on your computer"). Every page
// update, overview, decision and session note is one structured answer: a system prompt, a user
// message and the shape the answer must have. Who answers is the Llm:
//   - anthropicLlm: Anthropic's API with a key (self-hosting, tests against the API).
//   - claudeCodeLlm: Claude Code on this machine, signed in with someone's Claude plan (a team's
//     brain on the team's own computer).
//   - the gateway's computer Llm: Claude Code on the person's own computer, through its runner.
// The answer is checked against the shape here, whoever wrote it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Usage } from "./consolidate.ts";

export interface LlmRequest {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  schema: z.ZodType;
  /** What is being written, for errors ("page update", "overview"). */
  what: string;
}

export interface LlmAnswer {
  output: unknown;
  usage: Usage;
}

export interface Llm {
  parse(req: LlmRequest): Promise<LlmAnswer>;
}

/** A request as JSON (the shape as JSON Schema), for a model on another machine. */
export interface WireRequest {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  what: string;
}

export function toWire(req: LlmRequest): WireRequest {
  // Without "$schema": zod names draft 2020-12, which Claude Code's --json-schema refuses ("no schema
  // with key or ref"); the shape itself is plain JSON Schema either way.
  const { $schema: _draft, ...schema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
  return { model: req.model, maxTokens: req.maxTokens, system: req.system, user: req.user, schema, what: req.what };
}

/** An answer checked against the shape; a wrong one is an error saying what it was for. */
export function checked(req: LlmRequest, answer: LlmAnswer): LlmAnswer {
  const parsed = req.schema.safeParse(answer.output);
  if (!parsed.success) throw new Error(`model returned no parseable ${req.what}`);
  return { output: parsed.data, usage: answer.usage };
}

/** Checks every answer, whichever Llm wrote it. */
export function checking(llm: Llm): Llm {
  return { parse: async (req) => checked(req, await llm.parse(req)) };
}

export function anthropicLlm(apiKey: string): Llm {
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 });
  return {
    async parse(req) {
      const res = await client.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { format: zodOutputFormat(req.schema as z.ZodObject) },
      });
      if (res.stop_reason === "refusal") throw new Error(`model declined to write the ${req.what}`);
      if (res.stop_reason === "max_tokens") throw new Error(`${req.what} was cut off (max_tokens)`);
      if (!res.parsed_output) throw new Error(`model returned no parseable ${req.what}`);
      return {
        output: res.parsed_output,
        usage: {
          input_tokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0),
          output_tokens: res.usage.output_tokens,
          cache_read_tokens: res.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}

/**
 * Claude Code's flags for one structured answer: no tools, no MCP servers, no settings (so no
 * hooks or plugins of whoever's machine it is) and no saved session. Shared with the runner.
 */
export function claudeCodeArgs(req: WireRequest): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--model", req.model,
    "--system-prompt", req.system,
    "--json-schema", JSON.stringify(req.schema),
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
  ];
}

/** Claude Code's JSON result as an answer, or why there is none. */
export function claudeCodeAnswer(stdout: string, what: string): LlmAnswer {
  let r: { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; usage?: Record<string, number> };
  try {
    r = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    throw new Error(`Claude Code didn't answer the ${what}`);
  }
  if (r.is_error || r.structured_output === undefined) throw new Error(`Claude Code couldn't write the ${what}: ${String(r.result ?? r.subtype ?? "no answer").slice(0, 300)}`);
  const u = r.usage ?? {};
  return {
    output: r.structured_output,
    usage: { input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output_tokens: u.output_tokens ?? 0, cache_read_tokens: u.cache_read_input_tokens ?? 0 },
  };
}

/** Claude Code on this machine (`claude` on PATH, or `opts.claude`), signed in through `opts.env`. */
export function claudeCodeLlm(opts: { claude?: string; env?: NodeJS.ProcessEnv; configDir?: string; timeoutMs?: number } = {}): Llm {
  return {
    async parse(req) {
      const wire = toWire(req);
      const cwd = mkdtempSync(join(tmpdir(), "ambient-llm-"));
      try {
        const env = { ...process.env, ...opts.env, ...(opts.configDir ? { CLAUDE_CONFIG_DIR: opts.configDir } : {}) };
        const stdout = await new Promise<string>((resolve, reject) => {
          const p = spawn(opts.claude ?? "claude", claudeCodeArgs(wire), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
          let out = "";
          let err = "";
          p.stdout.on("data", (d) => (out += d));
          p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
          const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 240_000);
          p.on("error", (e) => {
            clearTimeout(timer);
            reject(new Error(`Claude Code didn't start: ${e.message}`));
          });
          p.on("close", (code) => {
            clearTimeout(timer);
            if (out.trim()) resolve(out);
            else reject(new Error(`Claude Code stopped (exit ${code}) on the ${req.what}. ${err.trim().split("\n").slice(-2).join(" ")}`.trim()));
          });
          p.stdin.on("error", () => {});
          p.stdin.end(wire.user);
        });
        return claudeCodeAnswer(stdout, req.what);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

/** An API key, or an Llm: what the writers below take. */
export type LlmOrKey = string | Llm;

export function asLlm(k: LlmOrKey): Llm {
  return checking(typeof k === "string" ? anthropicLlm(k) : k);
}
