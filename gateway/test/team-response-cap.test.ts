// A team server's answers are read up to a ceiling: one compromised team server can't fill the
// shared gateway's memory.
import { describe, expect, it } from "vitest";
import { readCapped } from "../src/teams.ts";

const streamOf = (chunks: number, size: number) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(size).fill(120));
        c.close();
      },
    }),
  );

describe("team server answers", () => {
  it("are read up to the ceiling, and refused past it, whatever the length header says", async () => {
    expect((await readCapped(streamOf(4, 256), 1024)).length).toBe(1024);
    await expect(readCapped(streamOf(5, 256), 1024)).rejects.toMatchObject({ status: 502 });
    await expect(readCapped(new Response("x".repeat(10), { headers: { "content-length": "999999" } }), 1024)).rejects.toMatchObject({ status: 502 });
  });
});
