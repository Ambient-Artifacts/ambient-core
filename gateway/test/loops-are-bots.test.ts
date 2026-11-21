// Loops are bots (docs/bots.md, "Loops are bots"): every routine is a bot, for everyone; there's
// no switch. The features flag says so, a new loop is a bot (over MCP too), none goes back to a
// loop, and a loop from before (a server that had bots off) becomes, once and safely, a bot that
// runs exactly as before: on the computer itself, with all of its owner's keys, reporting news.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAdmin } from "../src/admin.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.9.3", claude: "2.1.300 (Claude Code)" };

type R = { id: string; name: string; enabled: boolean; prompt: string; schedule: { every: string; time: string }; computer: { id: string } | null; bot: { isolation: string; secrets: string[] | null; report: string; face: string; color?: string } | null };

let s: Stack;
let kim: AppSession;
let computer: string;
let host = "";

const call = (who: AppSession, method: string, path: string, body?: unknown) => appCall(s, who.access_token, method, path, body);
const mine = async (who: AppSession) => (await call(who, "GET", "/v1/app/routines")).json.routines as R[];

beforeAll(async () => {
  s = await startStack({});
  kim = await signIn(s, "apple-kim-loops", "Kim Berg");
  const code = String((await call(kim, "POST", "/v1/app/computers", { name: "Kim's server" })).json.code);
  const setup = await fetch(`${s.origin}/v1/host/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, info }) });
  const out = (await setup.json()) as { token: string; computer: { id: string } };
  host = out.token;
  computer = out.computer.id;
  await call(kim, "PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "ghp_kim" });
});
afterAll(() => s.close());

describe("every routine is a bot", () => {
  it("for everyone, and the flag says so", async () => {
    expect((await call(kim, "GET", "/v1/app/features")).json).toEqual({ bots: true, loopsAreBots: true });
  });

  it("a new one is a bot, over MCP too; none goes back to a loop; one of your own needs a computer", async () => {
    const made = await call(kim, "POST", "/v1/app/routines", { name: "Fresh", prompt: "Do it.", schedule: daily, computer });
    const r = made.json.routine as R;
    expect(r.bot).toMatchObject({ isolation: "container", secrets: [], report: "news" });
    expect((await call(kim, "PATCH", `/v1/app/routines/${r.id}`, { bot: null })).json.error).toBe("bots_only");
    const pat = String((await call(kim, "POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const viaMcp = await client.callTool({ name: "create_routine", arguments: { name: "From Claude", prompt: "Do that.", schedule: daily, computer } });
    expect(viaMcp.isError, text(viaMcp)).toBeFalsy();
    expect((await mine(kim)).find((x) => x.name === "From Claude")!.bot).toMatchObject({ isolation: "container" });
    expect((await call(kim, "POST", "/v1/app/routines", { name: "No computer", prompt: "x", schedule: daily, computer: null })).json.error).toBe("bot_needs_computer");
  });
});

describe("a loop from before", () => {
  it("becomes a bot that runs as before, keeping schedule, computer, folder and prompt; once", async () => {
    // A loop from a server that had bots off: a routine without bot settings.
    const made = (await call(kim, "POST", "/v1/app/routines", { name: "Digest", prompt: "Write the digest.", schedule: daily, computer, folder: "~/digest" })).json.routine as R;
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("routines").collect()).find((x) => String(x._id) === made.id)!;
      await ctx.db.patch(row._id, { bot: undefined });
    });
    const before = (await mine(kim)).find((r) => r.id === made.id)!;
    expect(before.bot).toBeNull();
    // What the gateway does at start.
    expect(await s.control.m(s.api.bots.adoptPlainLoops, { now: Date.now() })).toEqual({ adopted: 1 });
    expect(await s.control.m(s.api.bots.adoptPlainLoops, { now: Date.now() })).toEqual({ adopted: 0 });
    const after = (await mine(kim)).find((r) => r.id === made.id)!;
    expect(after.bot).toMatchObject({ isolation: "host", secrets: null, report: "news" });
    expect(after).toMatchObject({ schedule: before.schedule, computer: before.computer, prompt: before.prompt, enabled: before.enabled });
    // It runs as before: on the computer itself, with all of Kim's keys.
    const start = await fetch(`${s.origin}/v1/host/routines/${after.id}/runs`, { method: "POST", headers: { authorization: `Bearer ${host}` } });
    const run = (await start.json()) as { bot: { isolation: string }; env: Record<string, string>; run: { id: string } };
    expect(run.bot.isolation).toBe("host");
    expect(run.env).toEqual({ GH_TOKEN: "ghp_kim" });
    await fetch(`${s.origin}/v1/host/runs/${run.run.id}`, { method: "POST", headers: { authorization: `Bearer ${host}`, "content-type": "application/json" }, body: JSON.stringify({ status: "succeeded", summary: "ok" }) });
  });

  it("puts everyone with bots in Ambient's background work (the heartbeat, Amb's memory, automations)", async () => {
    // With BRAIN_BOTS=all this was nobody: the "*" was dropped before Convex was asked (2026-11-20).
    const people = (await s.control.q(s.api.bots.people, {})) as { users: string[] };
    expect(people.users.map(String)).toContain(kim.user.uid);
  });

  it("leaves nothing for `admin bots adopt-loops`", async () => {
    expect(await runAdmin(["bots", "adopt-loops", kim.user.uid], { config: s.config, control: s.control })).toMatch(/has no plain loops left/);
  });
});
