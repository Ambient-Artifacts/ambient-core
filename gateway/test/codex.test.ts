// Codex next to Claude Code (docs/bots.md): a bot's runtime and its model, how a computer's Codex
// bots sign in (its own ChatGPT sign-in, done there with a device code through the long poll, or a
// stored OpenAI key), what the computer gets, the MCP tools, and the fix card for a Codex failure.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BotInput, botSettings, modelRuntime } from "@brain/spec";
import { claudeFix, openaiProblem } from "../src/bots/messages.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "vps", os: "Linux 6.8", runner: "0.9.0", claude: "2.1.326 (Claude Code)", codex: "codex-cli 0.169.0", codexLogin: "none" };

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let host: string;
let computerId: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const call = (method: string, path: string, body?: unknown, who = lena) => appCall(s, who.access_token, method, path, body);
type Computer = { id: string; codex: string | null; openaiAccount: { use: string; key: { by: string | null } | null; signedIn: string | null } };
const computer = async () => ((await call("GET", "/v1/app/routines")).json.computers as Computer[]).find((c) => c.id === computerId)!;

beforeAll(async () => {
  s = await startStack({ ambient: {} });
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  ben = await signIn(s, "apple-ben", "Ben Weiss");
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  const setup = await hostCall("", "POST", "/v1/host/setup", { code, info });
  host = String(setup.json.token);
  computerId = (setup.json.computer as { id: string }).id;
});
afterAll(() => s.close());

describe("a bot's runtime and model", () => {
  it("knows which runtime a model is for, and drops the other one's when the runtime changes", () => {
    expect(modelRuntime("claude-opus-5-5")).toBe("claude-code");
    expect(modelRuntime("gpt-5.5")).toBe("codex");
    expect(modelRuntime("o3")).toBe("codex");
    expect(modelRuntime("llama-3")).toBeNull();
    expect(BotInput.safeParse({ model: { model: "llama-3" } }).success).toBe(false);
    const claude = botSettings({ model: { model: "claude-opus-5-5" } });
    expect(botSettings({ runtime: "codex" }, claude).model).toBeUndefined();
    expect(botSettings({ runtime: "codex", model: { model: "gpt-5.5", effort: "high" } }, claude).model).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  it("runs a bot on Codex with an OpenAI model, and refuses the other runtime's model", async () => {
    const made = await call("POST", "/v1/app/routines", { name: "Codex dev", prompt: "Fix the test.", schedule: daily, computer: computerId, bot: { runtime: "codex", model: { model: "gpt-5.5", effort: "max" } } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = (made.json.routine as { id: string }).id;
    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    expect(start.json.bot).toMatchObject({ runtime: "codex", model: { model: "gpt-5.5", effort: "max" } });
    const wrong = await call("POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: daily, computer: computerId, bot: { runtime: "codex", model: { model: "claude-opus-5-5" } } });
    expect(wrong.json.error).toBe("model_runtime");
    // A computer's default model is Claude Code's.
    expect((await call("PUT", `/v1/app/computers/${computerId}/model`, { model: "gpt-5.5" })).json.error).toBe("claude_model_only");
  });
});

describe("how a computer's Codex bots sign in", () => {
  it("shows Codex and its sign-in from the computer's sync", async () => {
    await hostCall(host, "POST", "/v1/host/sync", { info: { ...info, codexLogin: "chatgpt" } });
    expect(await computer()).toMatchObject({ codex: "codex-cli 0.169.0", openaiAccount: { use: "plan", key: null, signedIn: "chatgpt" } });
  });

  it("stores an OpenAI key (from the app only), hands it to the computer, and switches back", async () => {
    expect((await call("PUT", `/v1/app/computers/${computerId}/openai`, { key: "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx" })).json.error).toBe("bad_openai_key");
    expect((await call("POST", `/v1/app/computers/${computerId}/openai/use`, { use: "key" })).json.error).toBe("no_openai_key");
    const set = await call("PUT", `/v1/app/computers/${computerId}/openai`, { key: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345" });
    expect((set.json.computer as Computer).openaiAccount).toMatchObject({ use: "key", key: { by: "Lena Vogel" } });
    const synced = await hostCall(host, "POST", "/v1/host/sync", { info });
    expect(synced.json.openai).toMatch(/^key:\d+$/);
    const got = await hostCall(host, "GET", "/v1/host/openai");
    expect(got.json).toMatchObject({ env: { CODEX_API_KEY: "sk-proj-abcdefghijklmnopqrstuvwxyz012345" } });
    expect(((await call("POST", `/v1/app/computers/${computerId}/openai/use`, { use: "plan" })).json.computer as Computer).openaiAccount.use).toBe("plan");
    expect((await hostCall(host, "POST", "/v1/host/sync", { info })).json.openai).toBeNull();
    expect((await hostCall(host, "GET", "/v1/host/openai")).json).toEqual({ version: null, env: {} });
    expect(((await call("DELETE", `/v1/app/computers/${computerId}/openai/key`)).json.computer as Computer).openaiAccount).toMatchObject({ use: "plan", key: null });
    // Not someone else's computer.
    expect((await call("PUT", `/v1/app/computers/${computerId}/openai`, { key: "sk-proj-abcdefghijklmnopqrstuvwxyz012345" }, ben)).status).toBe(400);
  });

  it("signs in with a ChatGPT plan on the computer: the link and code come back through its long poll", async () => {
    // Not connected yet: the message says how to do it there.
    const offline = await call("POST", `/v1/app/computers/${computerId}/openai/login`);
    expect(offline.status).toBe(409);
    expect(String(offline.json.message)).toContain("codex login --device-auth");
    // The computer waits for work (Ambient runs there), the person asks, the runner answers.
    const waiting = hostCall(host, "GET", "/v1/host/ambient/next");
    await new Promise((r) => setTimeout(r, 100));
    const asked = call("POST", `/v1/app/computers/${computerId}/openai/login`);
    const job = (await waiting).json as { id: string; kind: string };
    expect(job.kind).toBe("codex-login");
    await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: JSON.stringify({ url: "https://auth.openai.com/codex/device", code: "ABCD-12345", expiresAt: 1 }) });
    expect((await asked).json).toEqual({ computer: "Build server", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", expiresAt: 1 });
  });

  it("is in Amb's tools: switch the sign-in, start the ChatGPT one, see it in list_routines", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await client.callTool({ name: "list_routines", arguments: {} }))).toContain("Codex codex-cli 0.169.0, Codex bots use the computer's own Codex sign-in");
    const noKey = await client.callTool({ name: "use_openai_account", arguments: { computer: "Build server", use: "key" } });
    expect(noKey.isError).toBe(true);
    expect(text(noKey)).toContain(`ambient://computer/${computerId}/openai`);
    const waiting = hostCall(host, "GET", "/v1/host/ambient/next");
    await new Promise((r) => setTimeout(r, 100));
    const asked = client.callTool({ name: "sign_in_chatgpt", arguments: { computer: "Build server" } });
    const job = (await waiting).json as { id: string };
    await hostCall(host, "POST", `/v1/host/ambient/${job.id}`, { text: JSON.stringify({ url: "https://auth.openai.com/codex/device", code: "WXYZ-98765" }) });
    expect(text(await asked)).toContain("enter the code WXYZ-98765");
    await client.close();
  });
});

describe("a Codex failure that's the sign-in", () => {
  it("is offered as an OpenAI fix, not a Claude one", () => {
    const failed = "Codex ended with exit code 1.\n\nunexpected status 401 Unauthorized: Incorrect API key provided, auth error code: invalid_api_key";
    expect(openaiProblem(failed)).toBe("signin");
    expect(claudeFix("failure", failed, "c1")).toEqual({ kind: "openai", computer: "c1", reason: "signin" });
    expect(claudeFix("failure", "Codex ended with exit code 1.\n\nYou've hit your usage limit.", "c1")).toEqual({ kind: "openai", computer: "c1", reason: "credit" });
    expect(claudeFix("failure", "Claude Code ended with exit code 1.\n\nCredit balance is too low", "c1")).toEqual({ kind: "claude", computer: "c1", reason: "credit" });
    // A revoked token (a change of plan) and a session that ran out: both are Claude's sign-in.
    expect(claudeFix("failure", "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.", "c1")).toEqual({ kind: "claude", computer: "c1", reason: "signin" });
    expect(claudeFix("failure", "Failed to authenticate: OAuth session expired and could not be refreshed", "c1")).toEqual({ kind: "claude", computer: "c1", reason: "signin" });
  });
});
