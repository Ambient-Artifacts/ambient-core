// A bot's answer as it's written (docs/bots.md, "Live text"): the real runner, with a stand-in
// Claude Code that writes its answer in pieces, sends the text as it grows; whoever may read the
// bot's thread sees it on their event stream and in the thread while it's written, then `done`
// once the message is in the thread. Nothing of it is stored, and another computer can't send it.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, appHeaders, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const RUNNER = join(import.meta.dirname, "..", "..", "runner", "ambient-runner.mjs");
const info = { hostname: "srv-live", os: "Linux 6.8", runner: "0.15.0", claude: "2.1.330 (Claude Code)" };
const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };

type Live = { routineId: string; runId: string; text: string; tool: string | null; seq: number; done?: boolean };

let s: Stack;
let lena: AppSession;
let host = "";

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};

/** The `bot_live` events on a user's stream, as they come. */
async function liveEvents(who: AppSession) {
  const url = `${s.origin}/v1/app/events`;
  const res = await fetch(url, { headers: await appHeaders(who.access_token, "GET", url), signal: AbortSignal.timeout(30_000) });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const seen: Live[] = [];
  let buffer = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const lines = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);
        if (lines.includes("event: bot_live")) seen.push(JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) as Live);
      }
    }
  })();
  return { seen, close: () => reader.cancel() };
}

const until = async (ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("not in time");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  s = await startStack({ streamMaxMs: 60_000 });
  lena = await signIn(s, "apple-lena-live", "Lena Vogel");
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "Lena's server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
});
afterAll(() => s.close());

describe("a bot's answer as it's written", () => {
  it("reaches its reader while it's written, and goes once the message is in the thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "work"));
    const line = (o: unknown) => `echo '${JSON.stringify(o)}'`;
    const delta = (text: string) => line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi',
        'echo "$@" > args.txt',
        'if echo "$@" | grep -q -- "--input-format"; then head -n 1 > /dev/null; else cat > /dev/null; fi',
        line({ type: "system", subtype: "init" }),
        line({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }),
        delta("Found "),
        "sleep 0.6",
        delta("the bug: "),
        "sleep 0.6",
        delta("the retry never resets."),
        "sleep 0.6",
        // A subagent's words aren't the bot's answer.
        line({ type: "stream_event", parent_tool_use_id: "toolu_1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SUBAGENT" } } }),
        line({ type: "assistant", message: { content: [{ type: "text", text: "Found the bug: the retry never resets." }] } }),
        line({ type: "result", subtype: "success", is_error: false, result: "Found the bug: the retry never resets.", num_turns: 1 }),
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "claude"), 0o755);
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Fixer", prompt: "Fix the login bug.", schedule: daily, folder: join(dir, "work"), bot: { isolation: "host" } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = (made.json.routine as { id: string }).id;

    const stream = await liveEvents(lena);
    const run = new Promise<number | null>((resolve) => {
      const p = spawn(process.execPath, [RUNNER, "run", id], {
        env: {
          AMBIENT_CLAUDE_ENV: "/nonexistent/ambient-claude.env",
          AMBIENT_CONFIG_DIR: "/nonexistent/ambient-runner",
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          AMBIENT_SYSTEM_PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          AMBIENT_SERVER: s.origin,
          AMBIENT_HOST_TOKEN: host,
          AMBIENT_CLAUDE: join(bin, "claude"),
          AMBIENT_STATE_DIR: join(dir, "state"),
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
        },
      });
      p.on("close", resolve);
    });

    // While it's written: the text grows, and the thread shows it too.
    await until(() => stream.seen.some((e) => e.text === "Found the bug: "));
    const mid = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/thread`)).json as { live: Live | null };
    expect(mid.live).toMatchObject({ routineId: id, text: expect.stringMatching(/^Found the bug: /) });
    await until(() => stream.seen.some((e) => e.text === "Found the bug: the retry never resets."));
    // Then the message is in the thread, and the live text goes.
    expect(await run).toBe(0);
    await until(() => stream.seen.some((e) => e.done));
    stream.close();
    expect(stream.seen.every((e) => e.routineId === id && !e.text.includes("SUBAGENT"))).toBe(true);
    const seqs = stream.seen.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const after = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${id}/thread`)).json as { live: Live | null; messages: { author: string; text: string }[] };
    expect(after.live).toBeNull();
    expect(after.messages.at(-1)!.text).toBe("Found the bug: the retry never resets.");
  }, 30_000);

  it("isn't taken from another computer, nor for a run that's over", async () => {
    const other = await signIn(s, "apple-ben-live", "Ben Weiss");
    const code = String((await appCall(s, other.access_token, "POST", "/v1/app/computers", { name: "Ben's server" })).json.code);
    const benHost = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
    const id = ((await appCall(s, lena.access_token, "GET", "/v1/app/routines")).json.routines as { id: string; name: string }[]).find((r) => r.name === "Fixer")!.id;
    const start = await hostCall(host, "POST", `/v1/host/routines/${id}/runs`);
    const runId = (start.json.run as { id: string }).id;
    expect((await hostCall(benHost, "POST", `/v1/host/runs/${runId}/live`, { seq: 1, text: "Not mine" })).status).toBe(404);
    expect((await hostCall(host, "POST", `/v1/host/runs/${runId}/live`, { seq: 1, text: "Mine" })).status).toBe(204);
    await hostCall(host, "POST", `/v1/host/runs/${runId}`, { status: "succeeded", summary: "Done." });
    expect((await hostCall(host, "POST", `/v1/host/runs/${runId}/live`, { seq: 2, text: "Late" })).status).toBe(404);
  });
});
