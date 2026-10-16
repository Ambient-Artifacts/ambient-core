// Teams managed from the app: create one (it claims a free pool server), invite people,
// change roles, remove someone, leave.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkHealth } from "../src/worker/health.ts";
import { appCall, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
let owner: string;
let ownerUid: string;

beforeAll(async () => {
  s = await startStack();
  const signedIn = await signIn(s, "apple-owner", "Lena Vogel");
  owner = signedIn.access_token;
  ownerUid = signedIn.user.uid;
});
afterAll(() => s.close());

describe("teams from the app", () => {
  let code: string;
  let mayaUid: string;
  let maya: string;

  it("creates a team on the free pool server, which then serves it", async () => {
    const health = await checkHealth({ control: s.control, gatewayUrl: s.origin, unit: async () => ({ result: "success", lastRunAt: Date.now() }) });
    expect(health.problems).toEqual([]);

    const made = await appCall(s, owner, "POST", "/v1/app/teams", { name: "Ambient Artifacts" });
    expect(made.status).toBe(200);
    expect(made.json.team).toMatchObject({ slug: "ambient-artifacts", name: "Ambient Artifacts", role: "owner", peopleSlug: "people/lena-vogel" });
    expect(JSON.parse(readFileSync(join(s.poolDir, "team.json"), "utf8"))).toMatchObject({ teamName: "Ambient Artifacts" });

    const me = await appCall(s, owner, "GET", "/v1/app/me");
    expect((me.json.teams as { slug: string }[]).map((t) => t.slug)).toContain("ambient-artifacts");
    // The claimed server answers team queries now.
    const q = await appCall(s, owner, "POST", "/v1/app/teams/ambient-artifacts/query", { op: "recent", limit: 5 });
    expect(q.status).toBe(200);
  });

  it("says so when the pool is empty, and the health check flags it", async () => {
    const again = await appCall(s, owner, "POST", "/v1/app/teams", { name: "Second Team" });
    expect(again.status).toBe(503);
    expect(again.json.error).toBe("no_server");
    const health = await checkHealth({ control: s.control, gatewayUrl: s.origin, unit: async () => ({ result: "success", lastRunAt: Date.now() }) });
    expect(health.problems.map((p) => p.key)).toContain("pool:empty");
  });

  it("invites someone, who joins as a member", async () => {
    const invite = await appCall(s, owner, "POST", "/v1/app/teams/ambient-artifacts/invites", { uses: 3 });
    expect(invite.status).toBe(200);
    code = invite.json.code as string;
    expect(code).toMatch(/^AMBI-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const joined = await signIn(s, "apple-maya", "Maya Stein");
    maya = joined.access_token;
    mayaUid = joined.user.uid;
    const join = await appCall(s, maya, "POST", "/v1/app/teams/join", { code: code.toLowerCase() });
    expect(join.json.team).toMatchObject({ slug: "ambient-artifacts", role: "member" });

    const list = await appCall(s, maya, "GET", "/v1/app/teams/ambient-artifacts/members");
    expect((list.json.members as { name: string; role: string }[]).map((m) => [m.name, m.role])).toEqual([
      ["Lena Vogel", "owner"],
      ["Maya Stein", "member"],
    ]);
  });

  it("only owners and admins invite; only the owner changes roles", async () => {
    expect((await appCall(s, maya, "POST", "/v1/app/teams/ambient-artifacts/invites", {})).status).toBe(403);
    expect((await appCall(s, maya, "POST", `/v1/app/teams/ambient-artifacts/members/${ownerUid}/role`, { role: "member" })).status).toBe(403);
    expect((await appCall(s, owner, "POST", `/v1/app/teams/ambient-artifacts/members/${mayaUid}/role`, { role: "admin" })).status).toBe(204);
    expect((await appCall(s, maya, "POST", "/v1/app/teams/ambient-artifacts/invites", {})).status).toBe(200);
    // An admin can't remove the owner; nobody can be removed with a made-up id.
    expect((await appCall(s, maya, "DELETE", `/v1/app/teams/ambient-artifacts/members/${ownerUid}`)).status).toBe(403);
    expect((await appCall(s, owner, "DELETE", "/v1/app/teams/ambient-artifacts/members/not-an-id")).status).toBe(403);
  });

  it("the owner can't leave; a member can, and loses access", async () => {
    const stay = await appCall(s, owner, "POST", "/v1/app/teams/ambient-artifacts/leave");
    expect(stay.status).toBe(400);
    expect(stay.json.error).toBe("owner_cannot_leave");
    expect((await appCall(s, maya, "POST", "/v1/app/teams/ambient-artifacts/leave")).status).toBe(204);
    expect((await appCall(s, maya, "GET", "/v1/app/teams/ambient-artifacts/members")).status).toBe(403);
  });

  it("the owner removes someone", async () => {
    const again = await appCall(s, maya, "POST", "/v1/app/teams/join", { code });
    expect(again.status).toBe(200);
    expect((await appCall(s, owner, "DELETE", `/v1/app/teams/ambient-artifacts/members/${mayaUid}`)).status).toBe(204);
    const list = await appCall(s, owner, "GET", "/v1/app/teams/ambient-artifacts/members");
    expect((list.json.members as unknown[]).length).toBe(1);
  });
});
