// Loops are bots (docs/bots.md, "Loops are bots"): with bots there are no plain loops. The
// features flag says so, a new loop is a bot, none goes back to a loop, and `admin bots
// adopt-loops` turns existing loops into bots that run exactly as before (on the computer itself,
// all of the owner's keys, news only), once and safely. Accounts without bots keep loops.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adoptedLook, runAdmin } from "../src/admin.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.9.3", claude: "2.1.300 (Claude Code)" };

type R = { id: string; name: string; enabled: boolean; prompt: string; schedule: { every: string; time: string }; computer: { id: string } | null; team: { slug: string } | null; bot: { isolation: string; secrets: string[] | null; report: string; face: string; color?: string } | null };

let s: Stack;
let kim: AppSession;
let ola: AppSession;
let computer: string;
let slug: string;
let host = "";

const call = (who: AppSession, method: string, path: string, body?: unknown) => appCall(s, who.access_token, method, path, body);
const admin = (...args: string[]) => runAdmin(args, { config: s.config, control: s.control });
const mine = async (who: AppSession) => (await call(who, "GET", "/v1/app/routines")).json.routines as R[];

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] } });
  kim = await signIn(s, "apple-kim-loops", "Kim Berg");
  ola = await signIn(s, "apple-ola-loops", "Ola Nord");
  const code = String((await call(kim, "POST", "/v1/app/computers", { name: "Kim's server" })).json.code);
  const setup = await fetch(`${s.origin}/v1/host/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, info }) });
  const out = (await setup.json()) as { token: string; computer: { id: string } };
  host = out.token;
  computer = out.computer.id;
  await call(kim, "PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "ghp_kim" });
  // Kim's loops from before bots: one on her server, one paused, one with no computer, one of her team's.
  await call(kim, "POST", "/v1/app/routines", { name: "Digest", prompt: "Write the digest.", schedule: daily, computer, folder: "~/digest" });
  await call(kim, "POST", "/v1/app/routines", { name: "Paused one", prompt: "x", schedule: daily, computer, enabled: false });
  const nowhere = await call(kim, "POST", "/v1/app/routines", { name: "Nowhere", prompt: "x", schedule: daily, computer: null });
  expect(nowhere.status, JSON.stringify(nowhere.json)).toBe(200);
  slug = ((await call(kim, "POST", "/v1/app/teams", { name: "Loop Lab" })).json.team as { slug: string }).slug;
});
afterAll(() => s.close());

describe("before bots", () => {
  it("keeps loops as loops, and the flag says so", async () => {
    expect((await call(kim, "GET", "/v1/app/features")).json).toEqual({ bots: false, loopsAreBots: false });
    expect((await mine(kim)).every((r) => r.bot === null)).toBe(true);
  });
});

describe("with bots", () => {
  it("says loops are bots, and lists the old loops as loops until they're adopted", async () => {
    s.config.bots!.users.push(kim.user.uid);
    expect((await call(kim, "GET", "/v1/app/features")).json).toEqual({ bots: true, loopsAreBots: true });
    expect((await mine(kim)).filter((r) => r.bot === null).map((r) => r.name).sort()).toEqual(["Digest", "Nowhere", "Paused one"]);
  });

  it("makes a new loop a bot, over MCP too, and none goes back to a loop", async () => {
    const made = await call(kim, "POST", "/v1/app/routines", { name: "Fresh", prompt: "Do it.", schedule: daily, computer });
    const r = made.json.routine as R;
    expect(r.bot).toMatchObject({ isolation: "container", secrets: [], report: "news" });
    const back = await call(kim, "PATCH", `/v1/app/routines/${r.id}`, { bot: null });
    expect(back.json.error).toBe("bots_only");
    const pat = String((await call(kim, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const viaMcp = await client.callTool({ name: "create_routine", arguments: { name: "From Claude", prompt: "Do that.", schedule: daily, computer } });
    expect(viaMcp.isError, text(viaMcp)).toBeFalsy();
    expect((await mine(kim)).find((x) => x.name === "From Claude")!.bot).toMatchObject({ isolation: "container" });
    // A bot of their own still needs a computer.
    expect((await call(kim, "POST", "/v1/app/routines", { name: "No computer", prompt: "x", schedule: daily, computer: null })).json.error).toBe("bot_needs_computer");
  });

  it("previews the adoption without changing anything", async () => {
    const dry = await admin("bots", "adopt-loops", kim.user.uid, "--dry-run");
    expect(dry).toContain("Dry run, nothing changed for Kim Berg:");
    expect(dry).toContain(`would become a bot: "Digest" (Kim Berg), on Kim's server, on the computer itself, all of the owner's keys, news only.`);
    expect(dry).toContain(`would become a bot: "Paused one" (Kim Berg), on Kim's server, on the computer itself, all of the owner's keys, news only, paused.`);
    expect(dry).toContain(`skipped: "Nowhere" (Kim Berg): no computer`);
    expect((await mine(kim)).filter((r) => r.bot === null)).toHaveLength(3);
  });

  it("turns the loops into bots that run as before, keeping schedule, computer, folder and prompt", async () => {
    const before = (await mine(kim)).find((r) => r.name === "Digest")!;
    const out = await admin("bots", "adopt-loops", kim.user.uid);
    expect(out).toContain(`now a bot: "Digest" (Kim Berg), on Kim's server.`);
    expect(out).toContain(`now a bot: "Paused one" (Kim Berg), on Kim's server.`);
    const after = (await mine(kim)).find((r) => r.name === "Digest")!;
    expect(after.bot).toMatchObject({ isolation: "host", secrets: null, report: "news", ...adoptedLook(after.id) });
    expect(after).toMatchObject({ schedule: before.schedule, computer: before.computer, prompt: before.prompt, enabled: before.enabled });
    expect((await mine(kim)).find((r) => r.name === "Paused one")!.enabled).toBe(false);
    // It runs as before: on the computer itself, with all of Kim's keys.
    const start = await fetch(`${s.origin}/v1/host/routines/${after.id}/runs`, { method: "POST", headers: { authorization: `Bearer ${host}` } });
    const run = (await start.json()) as { bot: { isolation: string }; env: Record<string, string>; run: { id: string } };
    expect(run.bot.isolation).toBe("host");
    expect(run.env).toEqual({ GH_TOKEN: "ghp_kim" });
    await fetch(`${s.origin}/v1/host/runs/${run.run.id}`, { method: "POST", headers: { authorization: `Bearer ${host}`, "content-type": "application/json" }, body: JSON.stringify({ status: "succeeded", summary: "ok" }) });
    // Its prompt is AGENTS.md's first version.
    const history = (await call(kim, "GET", `/v1/app/routines/${after.id}/files/history?path=AGENTS.md`)).json.versions as { version: number; why: string | null }[];
    expect(history.map((v) => [v.version, v.why])).toEqual([[1, "was a loop"]]);
  });

  it("does nothing the second time, and keeps the one with no computer a loop", async () => {
    const again = await admin("bots", "adopt-loops", kim.user.uid);
    expect(again).toContain(`skipped: "Nowhere"`);
    expect(again).not.toContain("now a bot");
    expect((await mine(kim)).filter((r) => r.bot === null).map((r) => r.name)).toEqual(["Nowhere"]);
    expect(adoptedLook("abc")).toEqual(adoptedLook("abc"));
  });

  it("does a team's loops only as someone in that team, and leaves people without bots alone", async () => {
    await expect(admin("bots", "adopt-loops", ola.user.uid, "--team", slug)).rejects.toThrow(`isn't in a team "${slug}"`);
    expect(await admin("bots", "adopt-loops", kim.user.uid, "--team", slug)).toBe(`The team "${slug}" has no plain loops left (0 bot(s)).`);
    // Ola has no bots: her loop stays a loop, and adopting is refused by the service's own rule.
    const code = String((await call(ola, "POST", "/v1/app/computers", { name: "Ola's server" })).json.code);
    const olaHost = ((await (await fetch(`${s.origin}/v1/host/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, info }) })).json()) as { computer: { id: string } }).computer.id;
    const loop = (await call(ola, "POST", "/v1/app/routines", { name: "Ola's loop", prompt: "x", schedule: daily, computer: olaHost })).json.routine as R;
    expect(loop.bot).toBeNull();
    const out = await admin("bots", "adopt-loops", ola.user.uid);
    expect(out).toContain(`not changed: "Ola's loop"`);
    expect((await mine(ola)).find((r) => r.id === loop.id)!.bot).toBeNull();
  });
});
