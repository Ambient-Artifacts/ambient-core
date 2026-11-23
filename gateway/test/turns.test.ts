// Amb's turns in flight (bots/turn-queue.ts): written down before a turn starts, removed when its
// answer is out; turns a previous start left behind are picked up again, at most 3 times.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

let s: Stack;
let lena: AppSession;

beforeAll(async () => {
  s = await startStack({ ambient: {} });
  lena = await signIn(s, "apple-lena-turns", "Lena Vogel");
});
afterAll(() => s.close());

const rows = () => s.t.run(async (ctx) => ctx.db.query("turns").collect());

describe("turns in flight", () => {
  it("a chat message's turn is listed while it's answered, and gone after", async () => {
    await s.ambient.send(lena.user.uid, "Lena", "hello").then((o) => o.done);
    expect(await rows()).toEqual([]);
  });

  it("a turn left by an earlier start is picked up again: the message gets its answer", async () => {
    const uid = lena.user.uid;
    // The gateway took the message, wrote the turn down, and stopped before answering.
    await (s.ambient as unknown as { add: (...a: unknown[]) => Promise<unknown> }).add(uid, "user", "still there?", undefined, [], "app");
    await s.turns.enqueue({ kind: "user", uid }, "amb-chat", { name: "Lena", text: "still there?", via: "app", files: [] });
    // Nothing is picked up while the turn is young (this start may still be answering it).
    expect(await s.turns.recover()).toBe(0);
    await s.t.run(async (ctx) => {
      for (const r of await ctx.db.query("turns").collect()) await ctx.db.patch(r._id, { createdAt: r.createdAt - 60_000 });
    });
    expect(await s.turns.recover()).toBe(1);
    const chat = await s.ambient.list(uid);
    expect(chat.messages.at(-1)!.role).toBe("ambient");
    expect(await rows()).toEqual([]);
  });

  it("gives up on a turn after 3 tries", async () => {
    s.turns.on("broken", async () => {
      throw new Error("still broken");
    });
    await s.turns.enqueue({ kind: "user", uid: lena.user.uid }, "broken", {});
    for (let i = 0; i < 4; i++) {
      await s.t.run(async (ctx) => {
        for (const r of await ctx.db.query("turns").collect()) await ctx.db.patch(r._id, { createdAt: r.createdAt - 60_000 });
      });
      await s.turns.recover();
    }
    expect(await rows()).toEqual([]);
  });
});
