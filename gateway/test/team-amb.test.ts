// A team's Amb in a channel (bots/team-amb.ts): on the team's computer with a token for that team
// alone, a short session apart from anyone's own chat, the thread's last turns kept for a follow-up.
import { describe, expect, it } from "vitest";
import { TeamAmb } from "../src/bots/team-amb.ts";
import type { Team } from "../src/directory.ts";

const team: Team = { id: "t1", slug: "acme", name: "Acme", status: "active", serverUrl: null };

function setup(o: { connected: boolean; apiKey?: string }) {
  const asked: { job: { mode?: string; instructions: string; text: string; history: { role: string; text: string }[] }; opts: { teamId?: string } }[] = [];
  const computers = {
    connected: () => o.connected,
    askWithFiles: async (_host: unknown, job: (typeof asked)[number]["job"], opts: { teamId?: string }) => {
      asked.push({ job, opts });
      return { text: `answer ${asked.length}`, files: [] };
    },
  };
  const amb = new TeamAmb({
    computers: computers as never,
    computersOf: async () => [
      { id: "own", uid: "u1", name: "Lena's Mac", team: null, teamId: null },
      { id: "srv", uid: "u1", name: "Acme server", team: "Acme", teamId: "t1" },
    ],
    teamsOf: async (uid) => (uid === "u1" ? [team] : []),
    teamMcp: async () => {
      throw new Error("not in this test");
    },
    apiKey: o.apiKey,
    model: "m",
  });
  return { amb, asked };
}

describe("a team's Amb in a channel", () => {
  it("runs on the team's computer with the team's token, in a session of its own, and keeps the thread", async () => {
    const { amb, asked } = setup({ connected: true });
    expect((await amb.turn("t1", { uid: "u1", name: "Lena" }, "slack:C1:1", "what's our pricing?")).text).toBe("answer 1");
    expect(asked[0]!.opts).toEqual({ teamId: "t1" });
    expect(asked[0]!.job.mode).toBe("internal");
    expect(asked[0]!.job.instructions).toContain("Acme's brain only");
    expect(asked[0]!.job.instructions).toContain("nothing personal");
    await amb.turn("t1", { uid: "u1", name: "Lena" }, "slack:C1:1", "and for teams?");
    expect(asked[1]!.job.history.map((t) => t.text)).toEqual(["Lena: what's our pricing?", "answer 1"]);
    // Another thread starts fresh.
    await amb.turn("t1", { uid: "u1", name: "Lena" }, "slack:C1:2", "hi");
    expect(asked[2]!.job.history).toEqual([]);
  });

  it("answers no one outside the team, and says how to connect a computer when there's none", async () => {
    const { amb, asked } = setup({ connected: false });
    expect((await amb.turn("t1", { uid: "u2", name: "Max" }, "teams:x", "hi")).text).toContain("not in this team");
    expect((await amb.turn("t1", { uid: "u1", name: "Lena" }, "teams:x", "hi")).text).toContain("No computer runs Acme's Ambient yet");
    expect(asked).toHaveLength(0);
  });
});
