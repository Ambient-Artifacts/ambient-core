// Two devices on one account (an iPhone and a Mac): each pulls what the other recorded, a
// person page both changed keeps both timeline lines, and a deletion on one reaches the other.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePage, splitCompiled } from "@brain/spec";
import { appCall, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
let token: string;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const up = (path: string, content: string) => ({ op: "upsert", path, hash: sha(content), content, updated: "2026-10-08" });

const note = (title: string) => `---\ntype: "note"\ntitle: "${title}"\nscope: "personal"\nupdated: "2026-10-08"\n---\n\n# ${title}\n`;
const anna = (lines: string[]) =>
  `---\ntitle: "Anna Müller"\ntype: "person"\nupdated: "2026-10-08"\n---\n\n# Anna Müller\n\n- Owns pricing.\n\n## Timeline\n${lines.join("\n")}\n`;
const lineA = "- 2026-10-07: Owns pricing ([note](../notes/2026/10/2026-10-07-pricing-aaaaaa.md))";
const lineB = "- 2026-10-08: Sent the deck ([note](../notes/2026/10/2026-10-08-deck-bbbbbb.md))";

type Reply = { seq: number; changes: { path: string; content: string; deleted?: boolean }[]; through?: number | null };
const sync = async (device: string, ops: unknown[], since: number) =>
  (await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: device, ops, since_seq: since })).json as Reply;

beforeAll(async () => {
  s = await startStack();
  token = (await signIn(s, "apple-two-devices", "Nina Two")).access_token;
});
afterAll(() => s.close());

describe("two devices on one account", () => {
  let macSeq = 0;
  let phoneSeq = 0;

  it("the Mac pulls what the iPhone recorded, and not its own pages back", async () => {
    const phone = await sync("iphone-6F2A", [up("wiki/notes/2026/10/2026-10-07-pricing-aaaaaa.md", note("Pricing")), up("wiki/people/anna-mueller.md", anna([lineA]))], 0);
    phoneSeq = phone.seq;
    expect(phone.changes).toEqual([]);
    expect((phone as unknown as { devices: boolean }).devices).toBe(true);
    const mac = await sync("mac-91C3", [up("wiki/notes/2026/10/2026-10-08-deck-bbbbbb.md", note("Deck"))], 0);
    macSeq = mac.seq;
    expect(mac.changes.map((c) => c.path).sort()).toEqual(["wiki/notes/2026/10/2026-10-07-pricing-aaaaaa.md", "wiki/people/anna-mueller.md"]);
  });

  it("a person page changed on both keeps both lines, and both devices get the merge", async () => {
    // The Mac adds its line to its own copy of Anna's page, which lacks the iPhone's line.
    const mac = await sync("mac-91C3", [up("wiki/people/anna-mueller.md", anna([lineB]))], macSeq);
    macSeq = mac.seq;
    const merged = mac.changes.find((c) => c.path === "wiki/people/anna-mueller.md")!;
    expect(splitCompiled(parsePage(merged.content).body).timeline).toEqual([lineA, lineB]);
    const phone = await sync("iphone-6F2A", [], phoneSeq);
    phoneSeq = phone.seq;
    const paths = phone.changes.map((c) => c.path);
    expect(paths).toContain("wiki/notes/2026/10/2026-10-08-deck-bbbbbb.md");
    expect(splitCompiled(parsePage(phone.changes.find((c) => c.path === "wiki/people/anna-mueller.md")!.content).body).timeline).toEqual([lineA, lineB]);
  });

  it("a recording deleted on the Mac is deleted on the iPhone", async () => {
    const mac = await sync("mac-91C3", [{ op: "delete", path: "wiki/notes/2026/10/2026-10-08-deck-bbbbbb.md" }], macSeq);
    macSeq = mac.seq;
    const phone = await sync("iphone-6F2A", [], phoneSeq);
    expect(phone.changes.filter((c) => c.deleted).map((c) => c.path)).toEqual(["wiki/notes/2026/10/2026-10-08-deck-bbbbbb.md"]);
    // The deletion also removed the deck's line from Anna's page (forgetNote), for both.
    const annaNow = phone.changes.filter((c) => c.path === "wiki/people/anna-mueller.md").pop()!;
    expect(splitCompiled(parsePage(annaNow.content).body).timeline).toEqual([lineA]);
  });

  it("an older build (which says 'iphone') still only gets the server's pages", async () => {
    const old = await sync("iphone", [], 0);
    expect(old.changes.every((c) => c.path === "wiki/people/anna-mueller.md")).toBe(true);  // server-written merges only
    expect(old.changes.some((c) => c.deleted)).toBe(false);
  });

  it("lists every page's path and hash (no content), so a device can drop pages deleted elsewhere", async () => {
    const res = await appCall(s, token, "GET", "/v1/app/personal/paths");
    const paths = (res.json.paths as { path: string; hash: string }[]).map((p) => p.path);
    expect(paths).toContain("wiki/notes/2026/10/2026-10-07-pricing-aaaaaa.md");
    expect(paths).not.toContain("wiki/notes/2026/10/2026-10-08-deck-bbbbbb.md");
    expect(JSON.stringify(res.json)).not.toContain("content");
  });
});
