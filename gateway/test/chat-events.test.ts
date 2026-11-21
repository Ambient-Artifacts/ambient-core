// Chats are live (docs/bots.md, "Channels"): a message that lands in Amb's chat, whichever door it
// came by, is announced on the person's event stream, so an open app fetches it at once instead of
// asking every few seconds. Only that it changed: no text on the stream, and nobody else's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, appHeaders, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const fakeAnthropic: typeof fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.anthropic.com/")) return fetch(input, init);
  return new Response(JSON.stringify({ content: [{ type: "text", text: "Here is your answer." }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
};

let s: Stack;
let lena: AppSession;
let mia: AppSession;

type Chat = { chat: string; at: number };

/** The `chat` events on a user's stream, as they come, with the raw text to look through. */
async function chatEvents(who: AppSession) {
  const url = `${s.origin}/v1/app/events`;
  const res = await fetch(url, { headers: await appHeaders(who.access_token, "GET", url), signal: AbortSignal.timeout(30_000) });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const seen: Chat[] = [];
  const raw: string[] = [];
  let buffer = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        raw.push(block);
        const lines = block.split("\n");
        if (lines.includes("event: chat")) seen.push(JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) as Chat);
      }
    }
  })();
  return { seen, raw, close: () => reader.cancel() };
}

const until = async (ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("not in time");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  s = await startStack({ streamMaxMs: 60_000, ambient: { apiKey: "sk-test", fetchImpl: fakeAnthropic } });
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  mia = await signIn(s, "apple-mia", "Mia Berg");
});
afterAll(() => s.close());

describe("a chat's changes on the event stream", () => {
  it("announces the person's message and Amb's answer to them, and to nobody else", async () => {
    const hers = await chatEvents(lena);
    const others = await chatEvents(mia);
    await new Promise((r) => setTimeout(r, 200));
    const sent = await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "What's the secret plan for Monday?" });
    expect(sent.status).toBe(200);
    // Her own message, then Amb's answer: one event each.
    await until(() => hers.seen.length >= 2);
    expect(hers.seen.every((e) => e.chat === "ambient" && e.at > 0)).toBe(true);
    // Only that it changed: neither the question nor the answer is on the stream.
    const all = hers.raw.join("\n");
    expect(all).not.toContain("secret plan");
    expect(all).not.toContain("Here is your answer");
    // The chat's own route has both.
    const chat = (await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json.messages as { role: string; text: string }[];
    expect(chat.map((m) => m.role)).toEqual(["user", "ambient"]);
    expect(others.seen).toHaveLength(0);
    await hers.close();
    await others.close();
  });

  it("announces a chat that was cleared", async () => {
    const hers = await chatEvents(lena);
    await new Promise((r) => setTimeout(r, 200));
    expect((await appCall(s, lena.access_token, "DELETE", "/v1/app/ambient/chat")).status).toBeLessThan(300);
    await until(() => hers.seen.length >= 1);
    expect(hers.seen[0]!.chat).toBe("ambient");
    await hers.close();
  });
});
