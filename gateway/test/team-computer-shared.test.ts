// One computer for a person and their team (docs/bots.md, "Personal bots on the team's computer"):
// the owner's computer serves the team they create, a teammate's own bots land on it with the
// teammate's own secrets, a computer connected for the team takes the team's bots, and bots whose
// computer goes away move on instead of falling asleep (Nikolai's Linki, 2026-11-26).
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, signIn, startStack, type Stack } from "./helpers.ts";

const needed = { every: "needed", time: "09:00", timezone: "Europe/Vienna" };
const weekly = { every: "week", days: ["mon"], time: "08:31", timezone: "Europe/Vienna" };
/** On the computer itself with all of the owner's secrets (no Podman here). */
const HOST = { isolation: "host", secrets: null };
const info = { hostname: "srv-shared", os: "Linux 6.8", runner: "0.18.1", claude: "2.1.300 (Claude Code)" };

type Computer = { id: string; name: string; team: { slug: string } | null; yours: boolean; ready: boolean };
type Routine = { id: string; computer: { id: string; name: string } | null };

let s: Stack;
let lena: string;
let ben: string;
let carl: string;
let lenaHost: string;
let lenaComputer: string;
let slug: string;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const synced = async (token: string) => ((await hostCall(token, "POST", "/v1/host/sync", {})).json.routines as { id: string }[]).map((r) => r.id);
const computers = async (who: string) => (await appCall(s, who, "GET", "/v1/app/routines")).json.computers as Computer[];

async function connect(who: string, name: string, team?: string): Promise<{ token: string; id: string }> {
  const added = await appCall(s, who, "POST", "/v1/app/computers", { name, ...(team ? { team } : {}) });
  expect(added.status, JSON.stringify(added.json)).toBe(200);
  const setup = await hostCall("", "POST", "/v1/host/setup", { code: String(added.json.code), info: { ...info, hostname: name.toLowerCase().replace(/\W+/g, "-") } });
  expect(setup.status, JSON.stringify(setup.json)).toBe(200);
  return { token: String(setup.json.token), id: String((setup.json.computer as { id: string }).id) };
}

beforeAll(async () => {
  s = await startStack({});
  lena = (await signIn(s, "apple-lena-shared", "Lena Vogel")).access_token;
  ben = (await signIn(s, "apple-ben-shared", "Ben Weiss")).access_token;
  carl = (await signIn(s, "apple-carl-shared", "Carl Brandt")).access_token;
  ({ token: lenaHost, id: lenaComputer } = await connect(lena, "Lena VPS"));
});
afterAll(() => s.close());

describe("the owner's computer", () => {
  it("becomes the team's too when they create one, and stays theirs", async () => {
    const made = await appCall(s, lena, "POST", "/v1/app/teams", { name: "Studio" });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const team = made.json.team as { slug: string; computer?: { id: string; name: string } };
    slug = team.slug;
    expect(team.computer).toEqual({ id: lenaComputer, name: "Lena VPS" });
    expect((await computers(lena)).find((c) => c.id === lenaComputer)).toMatchObject({ yours: true, team: { slug } });
    // Its stored sign-in, set before and after, is still hers: sealed with her key.
    const token = `sk-ant-oat01-${"s".repeat(40)}`;
    expect((await hostCall(lenaHost, "POST", "/v1/host/claude", { kind: "plan", token })).status).toBe(204);
    expect((await hostCall(lenaHost, "GET", "/v1/host/claude")).json.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: token });
  });

  it("runs the team's bots and her own", async () => {
    const own = await appCall(s, lena, "POST", "/v1/app/routines", { name: "Inbox", prompt: "Sort my inbox.", schedule: weekly, bot: HOST });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    expect((own.json.routine as Routine).computer).toMatchObject({ id: lenaComputer });
    const teamBot = await appCall(s, lena, "POST", "/v1/app/routines", { name: "Digest", prompt: "Write the digest.", schedule: weekly, team: slug, bot: HOST });
    expect(teamBot.status, JSON.stringify(teamBot.json)).toBe(200);
    expect(await synced(lenaHost)).toEqual(expect.arrayContaining([(own.json.routine as Routine).id, (teamBot.json.routine as Routine).id]));
  });
});

describe("a teammate without a computer", () => {
  let benBot: string;

  beforeAll(async () => {
    const invite = String((await appCall(s, lena, "POST", `/v1/app/teams/${slug}/invites`, { role: "member" })).json.code);
    expect((await appCall(s, ben, "POST", "/v1/app/teams/join", { code: invite })).status).toBe(200);
  });

  it("sees the team's computer, not as theirs", async () => {
    expect((await computers(ben)).find((c) => c.id === lenaComputer)).toMatchObject({ yours: false, team: { slug } });
  });

  it("gets their own bots on the team's computer, with their own secrets", async () => {
    expect((await appCall(s, ben, "PUT", "/v1/app/routines/secrets/BEN_TOKEN", { value: "ben-secret-1" })).status).toBe(204);
    expect((await appCall(s, lena, "PUT", "/v1/app/routines/secrets/LENA_TOKEN", { value: "lena-secret-1" })).status).toBe(204);
    const made = await appCall(s, ben, "POST", "/v1/app/routines", { name: "Reading list", prompt: "Collect links.", schedule: weekly, bot: HOST });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    benBot = (made.json.routine as Routine).id;
    expect((made.json.routine as Routine).computer).toMatchObject({ id: lenaComputer, name: "Lena VPS" });
    expect(await synced(lenaHost)).toContain(benBot);
    const run = await hostCall(lenaHost, "POST", `/v1/host/routines/${benBot}/runs`);
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json.env).toMatchObject({ BEN_TOKEN: "ben-secret-1" });
    expect(run.json.env).not.toHaveProperty("LENA_TOKEN");
    await hostCall(lenaHost, "POST", `/v1/host/runs/${(run.json.run as { id: string }).id}`, { status: "succeeded", summary: "Collected 3 links." });
  });

  it("may pick it by name; someone outside the team may not", async () => {
    const picked = await appCall(s, ben, "POST", "/v1/app/routines", { name: "Picked", prompt: "x", schedule: needed, computer: "Lena VPS", bot: HOST });
    expect(picked.status, JSON.stringify(picked.json)).toBe(200);
    expect((await appCall(s, carl, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: weekly, computer: lenaComputer, bot: HOST })).json.error).toBe("no_such_computer");
    // Carl has no computer and no team: nothing to put a bot on.
    expect((await appCall(s, carl, "POST", "/v1/app/routines", { name: "x", prompt: "y", schedule: weekly, bot: HOST })).json.error).toBe("bot_needs_computer");
  });

  it("can't change the computer's sign-in", async () => {
    expect((await appCall(s, ben, "POST", `/v1/app/computers/${lenaComputer}/claude/use`, { use: "computer" })).status).toBe(403);
  });
});

describe("a computer connected for the team", () => {
  let teamHost: string;
  let teamComputer: string;

  it("takes the team's bots; her own and her teammate's stay on hers", async () => {
    ({ token: teamHost, id: teamComputer } = await connect(lena, "Studio server", slug));
    const team = await synced(teamHost);
    const mine = await synced(lenaHost);
    const all = (await appCall(s, lena, "GET", "/v1/app/routines")).json.routines as (Routine & { name: string })[];
    const id = (name: string) => all.find((r) => r.name === name)!.id;
    expect(team).toContain(id("Digest"));
    expect(mine).not.toContain(id("Digest"));
    expect(mine).toContain(id("Inbox"));
    // A teammate's own bot made now goes on the team's computer.
    const made = await appCall(s, ben, "POST", "/v1/app/routines", { name: "Later", prompt: "x", schedule: weekly, bot: HOST });
    expect((made.json.routine as Routine).computer).toMatchObject({ id: teamComputer });
  });

  it("is where a teammate's bots go when the owner removes her computer", async () => {
    expect((await appCall(s, lena, "DELETE", `/v1/app/computers/${lenaComputer}`)).status).toBeLessThan(300);
    const benRoutines = (await appCall(s, ben, "GET", "/v1/app/routines")).json.routines as (Routine & { name: string })[];
    expect(benRoutines.find((r) => r.name === "Reading list")?.computer).toMatchObject({ id: teamComputer });
    expect(await synced(teamHost)).toContain(benRoutines.find((r) => r.name === "Reading list")!.id);
    // Hers too: she has no computer of her own left, so her team's.
    const lenaRoutines = (await appCall(s, lena, "GET", "/v1/app/routines")).json.routines as (Routine & { name: string })[];
    expect(lenaRoutines.find((r) => r.name === "Inbox")?.computer).toMatchObject({ id: teamComputer });
  });

  it("stops running a teammate's bots once they leave the team", async () => {
    const benRoutines = (await appCall(s, ben, "GET", "/v1/app/routines")).json.routines as (Routine & { name: string })[];
    const id = benRoutines.find((r) => r.name === "Reading list")!.id;
    expect((await appCall(s, ben, "POST", `/v1/app/teams/${slug}/leave`)).status).toBe(204);
    expect(await synced(teamHost)).not.toContain(id);
    expect((await hostCall(teamHost, "POST", `/v1/host/routines/${id}/runs`)).status).toBe(404);
  });
});

describe("connecting a computer after creating the team", () => {
  it("makes it the team's while the team has none", async () => {
    const nora = (await signIn(s, "apple-nora-shared", "Nora Lind")).access_token;
    const made = await appCall(s, nora, "POST", "/v1/app/teams", { name: "Workshop" });
    const team = made.json.team as { slug: string; computer?: unknown };
    expect(team.computer).toBeUndefined();
    const { id } = await connect(nora, "Nora box");
    expect((await computers(nora)).find((c) => c.id === id)).toMatchObject({ yours: true, team: { slug: team.slug } });
  });

  it("but not a staff-connected team server's place: staff replacing the team's computer leaves the owner's hers", async () => {
    const olga = (await signIn(s, "apple-olga-shared", "Olga Berg")).access_token;
    const { id } = await connect(olga, "Olga box");
    const team = ((await appCall(s, olga, "POST", "/v1/app/teams", { name: "Atelier" })).json.team as { slug: string }).slug;
    const codeHash = createHash("sha256").update("host-setup:ATEL-SRV1").digest("hex");
    await s.t.mutation(s.internal.routines.staffAddHost, { team, name: "Atelier server", codeHash, expiresAt: Date.now() + 60_000 });
    const c = (await computers(olga)).find((x) => x.id === id);
    expect(c).toMatchObject({ yours: true, team: null });
  });
});
