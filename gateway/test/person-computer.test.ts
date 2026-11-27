// Every computer has a person (docs/bots.md): the team's computer is also the personal computer of
// whoever runs it, a teammate's personal space goes there only once they say yes, their own
// computer always comes first, and creating a team asks before sharing the owner's computer.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, signIn, startStack, type Stack } from "./helpers.ts";

const info = { hostname: "srv-person", os: "Linux 6.8", runner: "0.18.1", claude: "2.1.300 (Claude Code)" };

type Computer = { id: string; name: string; team: { slug: string } | null; yours: boolean };

let s: Stack;
let mia: string;
let tom: string;
let slug: string;
let teamComputer: string;

const hostCall = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const computers = async (who: string) => (await appCall(s, who, "GET", "/v1/app/routines")).json.computers as Computer[];
/** The computer their upkeep runs on, by name (null: none). */
const upkeepComputer = async (who: string) => (await appCall(s, who, "GET", "/v1/app/me/upkeep")).json.computer ?? null;

async function connect(who: string, name: string, team?: string): Promise<string> {
  const added = await appCall(s, who, "POST", "/v1/app/computers", { name, ...(team ? { team } : {}) });
  expect(added.status, JSON.stringify(added.json)).toBe(200);
  const setup = await hostCall("POST", "/v1/host/setup", { code: String(added.json.code), info: { ...info, hostname: name.toLowerCase().replace(/\W+/g, "-") } });
  expect(setup.status, JSON.stringify(setup.json)).toBe(200);
  return String((setup.json.computer as { id: string }).id);
}

beforeAll(async () => {
  s = await startStack({});
  mia = (await signIn(s, "apple-mia-person", "Mia Roth")).access_token;
  tom = (await signIn(s, "apple-tom-person", "Tom Kern")).access_token;
});
afterAll(() => s.close());

describe("creating a team", () => {
  it("leaves the owner's computer hers alone when she says no", async () => {
    const ida = (await signIn(s, "apple-ida-person", "Ida Moser")).access_token;
    const own = await connect(ida, "Ida box");
    const made = await appCall(s, ida, "POST", "/v1/app/teams", { name: "Kiosk", shareComputer: false });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect((made.json.team as { computer?: unknown }).computer).toBeUndefined();
    expect((await computers(ida)).find((c) => c.id === own)).toMatchObject({ yours: true, team: null });
  });
});

describe("the team's own computer", () => {
  beforeAll(async () => {
    const made = await appCall(s, mia, "POST", "/v1/app/teams", { name: "Foundry" });
    slug = (made.json.team as { slug: string }).slug;
    teamComputer = await connect(mia, "Foundry VPS", slug);
    const invite = String((await appCall(s, mia, "POST", `/v1/app/teams/${slug}/invites`, { role: "member" })).json.code);
    expect((await appCall(s, tom, "POST", "/v1/app/teams/join", { code: invite })).status).toBe(200);
  });

  it("is the personal computer of whoever connected it", async () => {
    expect((await computers(mia)).find((c) => c.id === teamComputer)).toMatchObject({ yours: true, team: { slug } });
    expect(await upkeepComputer(mia)).toBe("Foundry VPS");
  });

  it("is a teammate's only once they say yes", async () => {
    expect((await computers(tom)).find((c) => c.id === teamComputer)).toMatchObject({ yours: false });
    expect(await upkeepComputer(tom)).toBeNull();
    expect((await appCall(s, tom, "PUT", `/v1/app/teams/${slug}/personal-on-computer`, { on: true })).status).toBe(204);
    expect(await upkeepComputer(tom)).toBe("Foundry VPS");
    // Still not theirs to change.
    expect((await computers(tom)).find((c) => c.id === teamComputer)).toMatchObject({ yours: false });
  });

  it("comes after a computer of their own", async () => {
    await connect(tom, "Tom server");
    expect(await upkeepComputer(tom)).toBe("Tom server");
    expect((await appCall(s, tom, "PUT", `/v1/app/teams/${slug}/personal-on-computer`, { on: false })).status).toBe(204);
    expect(await upkeepComputer(tom)).toBe("Tom server");
  });

  it("is only for members to say", async () => {
    const out = await appCall(s, (await signIn(s, "apple-eve-person", "Eve Stein")).access_token, "PUT", `/v1/app/teams/${slug}/personal-on-computer`, { on: true });
    expect(out.status).toBe(403);
  });
});

describe("a team computer from before it had a person", () => {
  it("is its owner's", async () => {
    const lea = (await signIn(s, "apple-lea-person", "Lea Brunner")).access_token;
    const team = ((await appCall(s, lea, "POST", "/v1/app/teams", { name: "Loft" })).json.team as { slug: string }).slug;
    const codeHash = createHash("sha256").update("host-setup:LOFT-SRV1").digest("hex");
    const { id } = await s.t.mutation(s.internal.routines.staffAddHost, { team, name: "Loft server", codeHash, expiresAt: Date.now() + 60_000 });
    expect((await computers(lea)).find((c) => c.id === id)).toMatchObject({ yours: true, team: { slug: team } });
  });
});
