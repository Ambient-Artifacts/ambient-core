// The Wiki tab shows index.md and each folder's _index.md: the gateway renders them from the
// pages with the same code that writes them into the git repos.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderIndexFiles, WikiStore } from "@brain/wiki";
import { appCall, fixturePersonalOps, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
let token: string;

beforeAll(async () => {
  s = await startStack();
  token = (await signIn(s, "apple-index", "Ida Index")).access_token;
  await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: "mac-index", ops: fixturePersonalOps(), since_seq: 0 });
  await appCall(s, token, "POST", "/v1/app/teams/join", { code: INVITE });
});
afterAll(() => s.close());

describe("index files in the app", () => {
  it("renders the personal index.md and a folder's _index.md exactly like the repo files", async () => {
    const pages = (await appCall(s, token, "GET", "/v1/app/personal/pages")).json.pages as { path: string; content: string }[];
    const store = new WikiStore("personal");
    for (const p of pages) if (p.path.startsWith("wiki/")) store.upsert(p.path, p.content);
    const files = renderIndexFiles(store.entries(), "Ambient wiki");

    const top = await appCall(s, token, "GET", "/v1/app/wiki/index");
    expect(top.json.path).toBe("index.md");
    expect(String(top.json.markdown)).toContain("# Ambient wiki");
    const people = await appCall(s, token, "GET", "/v1/app/wiki/index?folder=people");
    expect(people.json).toEqual({ path: "people/_index.md", markdown: files.get("people/_index.md") });
  });

  it("renders a team wiki's index, only for members, and says when a folder doesn't exist", async () => {
    const team = await appCall(s, token, "GET", "/v1/app/wiki/index?team=acme");
    expect(String(team.json.markdown)).toContain("# Acme wiki");
    expect((await appCall(s, token, "GET", "/v1/app/wiki/index?team=other")).status).toBe(403);
    expect((await appCall(s, token, "GET", "/v1/app/wiki/index?folder=nothing-here")).status).toBe(404);
    expect((await appCall(s, token, "GET", "/v1/app/wiki/index?folder=../x")).status).toBe(400);
  });
});
