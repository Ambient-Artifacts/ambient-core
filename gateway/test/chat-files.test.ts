// Files in the chat (docs/bots.md, "Files in the chat"): what someone sends with a message in
// Ambient's chat or a bot's thread is kept, sealed with its owner's key in Convex file storage, and
// shown again: the message lists it, the app fetches it. Nobody else's id works; the bot's run gets
// its files with its run token; Forget chat and deleting the bot take them along.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, appRaw, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-files", os: "Linux 6.8", runner: "0.12.1", claude: "2.1.326 (Claude Code)" };
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("a picture of a whiteboard")]);
type File = { id: string; name: string; type: string; size: number };

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let host: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] }, ambient: { apiKey: undefined } });
  lena = await signIn(s, "apple-lena-files", "Lena Vogel");
  ben = await signIn(s, "apple-ben-files", "Ben Weiss");
  s.config.bots!.users.push(lena.user.uid, ben.user.uid);
  const code = String((await appCall(s, lena.access_token, "POST", "/v1/app/computers", { name: "VPS" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
});
afterAll(() => s.close());

describe("Ambient's chat", () => {
  it("keeps a file sent with a message, sealed, and shows it to its sender only", async () => {
    const sent = await appCall(s, lena.access_token, "POST", "/v1/app/ambient/chat", { text: "Look at this", attachments: [{ name: "board.png", type: "image/png", data: PNG.toString("base64") }] });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const message = sent.json.message as { text: string; files: File[] };
    expect(message.text).toBe("Look at this");
    expect(message.files).toEqual([{ id: expect.any(String), name: "board.png", type: "image/png", size: PNG.length }]);
    const id = message.files[0]!.id;

    // The history shows it again.
    const chat = (await appCall(s, lena.access_token, "GET", "/v1/app/ambient/chat")).json as { messages: { text: string; files: File[] }[] };
    expect(chat.messages.find((m) => m.text === "Look at this")?.files.map((f) => f.id)).toEqual([id]);

    const file = await appRaw(s, lena.access_token, "GET", `/v1/app/ambient/chat/files/${id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);

    // Convex holds ciphertext only, the name sealed too.
    const stored = await s.t.run(async (ctx) => {
      const row = await ctx.db.get(id as never);
      const blob = await ctx.storage.get((row as unknown as { storageId: string }).storageId as never);
      return { row: JSON.stringify(row), hex: Buffer.from(await blob!.arrayBuffer()).toString("hex") };
    });
    expect(stored.hex.includes(Buffer.from("whiteboard").toString("hex"))).toBe(false);
    expect(stored.row).not.toContain("board.png");

    // Someone else's id: not found, never the file.
    expect((await appRaw(s, ben.access_token, "GET", `/v1/app/ambient/chat/files/${id}`)).status).toBe(404);
    expect((await appRaw(s, lena.access_token, "GET", "/v1/app/ambient/chat/files/nonsense")).status).toBe(404);

    // New chat keeps it with the history; Forget chat takes it along.
    await appCall(s, lena.access_token, "DELETE", "/v1/app/ambient/chat");
    expect((await appRaw(s, lena.access_token, "GET", `/v1/app/ambient/chat/files/${id}`)).status).toBe(200);
    await appCall(s, lena.access_token, "DELETE", "/v1/app/ambient/chat?forget=1");
    expect((await appRaw(s, lena.access_token, "GET", `/v1/app/ambient/chat/files/${id}`)).status).toBe(404);
  });
});

describe("a bot's thread", () => {
  it("keeps the file, shows it to who may read the thread, and gives it to the bot's run", async () => {
    const made = await appCall(s, lena.access_token, "POST", "/v1/app/routines", { name: "Reviewer", prompt: "Review what I send.", schedule: daily, bot: {} });
    const botId = (made.json.routine as { id: string }).id;
    const posted = await appCall(s, lena.access_token, "POST", `/v1/app/routines/${botId}/thread`, { text: "", attachments: [{ name: "notes.md", type: "text/markdown", data: Buffer.from("# Notes").toString("base64") }] });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    const message = posted.json.message as { text: string; files: File[] };
    expect(message.files).toEqual([{ id: expect.any(String), name: "notes.md", type: "text/markdown", size: 7 }]);
    const id = message.files[0]!.id;
    const thread = (await appCall(s, lena.access_token, "GET", `/v1/app/routines/${botId}/thread`)).json as { messages: { files: File[] }[] };
    expect(thread.messages.at(-1)?.files.map((f) => f.id)).toEqual([id]);
    const file = await appRaw(s, lena.access_token, "GET", `/v1/app/routines/${botId}/thread/files/${id}`);
    expect(file.headers.get("content-type")).toContain("text/markdown");
    expect(await file.text()).toBe("# Notes");
    // Not from the chat's route, not for someone else.
    expect((await appRaw(s, lena.access_token, "GET", `/v1/app/ambient/chat/files/${id}`)).status).toBe(404);
    expect((await appRaw(s, ben.access_token, "GET", `/v1/app/routines/${botId}/thread/files/${id}`)).status).toBe(404);

    // The run the message starts gets it: listed with its message, fetched with the run's token.
    const start = await hostCall(host, "POST", `/v1/host/routines/${botId}/runs`);
    const resume = start.json.resume as { message: string; files: File[] };
    expect(resume.files.map((f) => f.id)).toEqual([id]);
    const runToken = String(start.json.runToken);
    const forRun = await fetch(`${s.origin}/v1/bot/files/${id}`, { headers: { authorization: `Bearer ${runToken}` } });
    expect(await forRun.text()).toBe("# Notes");
    expect((await fetch(`${s.origin}/v1/bot/files/${id}`, { headers: { authorization: "Bearer ambient_run_nope" } })).status).toBe(409);
    await hostCall(host, "POST", `/v1/host/runs/${(start.json.run as { id: string }).id}`, { status: "succeeded", summary: "Read it." });

    // The bot goes, and its files with it.
    await appCall(s, lena.access_token, "DELETE", `/v1/app/routines/${botId}`);
    expect(await s.t.run(async (ctx) => ctx.db.get(id as never))).toBeNull();
  });
});
