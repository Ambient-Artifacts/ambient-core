// Health check: invariants on a real stack, and when alerts are sent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alerts, checkHealth } from "../src/worker/health.ts";
import { startStack, type Stack } from "./helpers.ts";
import { TeamLink } from "../src/teams.ts";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

const H = 3_600_000;

describe("health check", () => {
  it("is green when the gateway and team servers answer and nothing waits", async () => {
    const link = new TeamLink(s.origin, s.config.signingKeys[0]!);
    const { problems, summary } = await checkHealth({
      control: s.control,
      gatewayUrl: s.origin,
      unit: async () => ({ result: "success", lastRunAt: Date.now() - 5 * 60_000 }),
      teamToken: (team) => link.token(team, "health"),
    });
    expect(problems).toEqual([]);
    expect(summary[0]).toBe("gateway ok");
    expect(summary.some((l) => l.startsWith("acme:"))).toBe(true);
  });

  it("flags a dead gateway, a stalled worker and a failed unit", async () => {
    const { problems } = await checkHealth({
      control: s.control,
      gatewayUrl: "http://127.0.0.1:9",
      unit: async () => ({ result: "exit-code", lastRunAt: Date.now() - 2 * H }),
    });
    expect(problems.map((p) => p.key).sort()).toEqual(["gateway", "personal:stalled", "personal:unit"]);
  });
});

describe("alerts", () => {
  const p = { key: "team:acme:down", text: "Team Acme server unreachable" };

  it("alerts once for a new problem, repeats daily, and says when it recovered", () => {
    const first = alerts({ open: {} }, [p], 0, false, []);
    expect(first.messages).toEqual(["🔴 Team Acme server unreachable"]);
    expect(alerts(first.state, [p], 1 * H, false, []).messages).toEqual([]);
    expect(alerts(first.state, [p], 25 * H, false, []).messages).toEqual(["🔴 Still: Team Acme server unreachable"]);
    expect(alerts(first.state, [], 2 * H, false, []).messages).toEqual(["🟢 Recovered: Team Acme server unreachable"]);
  });

  it("posts the daily heartbeat even when all is green", () => {
    expect(alerts({ open: {} }, [], 0, true, ["gateway ok"]).messages).toEqual(["Ambient daily: all green.\ngateway ok"]);
  });
});
