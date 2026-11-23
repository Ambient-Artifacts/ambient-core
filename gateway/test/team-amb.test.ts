// A team's Amb in a channel (bots/team-amb.ts): each thread is a lane, one session on the team's
// computer with a token for that team alone, resumed every turn, and given only what's new in the
// thread; a new thread starts cold from the whole thread.
import { describe, expect, it } from "vitest";
import { laneOf, TeamAmb, type LaneRecord } from "../src/bots/team-amb.ts";
import type { Team } from "../src/directory.ts";

const team: Team = { id: "t1", slug: "acme", name: "Acme", status: "active", serverUrl: null };
const S1 = "11111111-1111-1111-1111-111111111111";

type Job = { mode?: string; instructions: string; text: string; history: { role: string; text: string }[]; lane?: string; session?: string; fresh: boolean };

function setup(o: { connected: boolean; store?: Map<string, LaneRecord>; now?: () => number }) {
  const asked: { job: Job; opts: { teamId?: string } }[] = [];
  const computers = {
    connected: () => o.connected,
    askWithFiles: async (_host: unknown, job: Job, opts: { teamId?: string }) => {
      asked.push({ job, opts });
      return { text: `answer ${asked.length}`, files: [], session: S1 };
    },
  };
  const amb = new TeamAmb({
    computers: computers as never,
    computersOf: async () => [
      { id: "own", uid: "u1", name: "Lena's Mac", team: null, teamId: null },
      { id: "srv", uid: "u1", name: "Acme server", team: "Acme", teamId: "t1" },
    ],
    teamsOf: async (uid) => (uid === "u1" || uid === "u3" ? [team] : []),
    teamMcp: async () => {
      throw new Error("not in this test");
    },
    model: "m",
    ...(o.store ? { store: { get: async (t: string, c: string) => o.store!.get(`${t}|${c}`) ?? null, put: async (t: string, c: string, v: LaneRecord) => void o.store!.set(`${t}|${c}`, v) } } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  return { amb, asked };
}

describe("a team's Amb in a channel", () => {
  it("starts a thread's lane cold with the whole thread, then resumes it with only what's new", async () => {
    let now = 1_000_000;
    const store = new Map<string, LaneRecord>();
    const { amb, asked } = setup({ connected: true, store, now: () => now });
    const before = [
      { who: "Max", text: "the export is broken", at: 900_000 },
      { who: "Sonja", text: "since Monday", at: 950_000 },
    ];
    expect((await amb.turn("t1", { uid: "u1", name: "Lena" }, "slack:C1:1", "what happened?", [], before)).text).toBe("answer 1");
    const first = asked[0]!;
    expect(first.opts).toEqual({ teamId: "t1" });
    expect(first.job).toMatchObject({ mode: "chat", fresh: false, lane: laneOf("t1", "slack:C1:1") });
    expect(first.job.session).toBeUndefined();
    expect(first.job.instructions).toContain("Acme's brain only");
    expect(first.job.text).toContain("Lena: what happened?\n\nThe thread so far (oldest first):\n- Max: the export is broken\n- Sonja: since Monday");
    expect(store.get("t1|slack:C1:1")).toMatchObject({ session: S1 });

    // Later in the same thread: the session resumes, and only what people said since comes along.
    now += 60_000;
    const later = [...before, { who: "you", text: "answer 1", at: 1_000_000 }, { who: "Max", text: "it's back now", at: 1_030_000 }];
    await amb.turn("t1", { uid: "u3", name: "Klaus" }, "slack:C1:1", "so is it fixed?", [], later);
    const second = asked[1]!.job;
    expect(second.session).toBe(S1);
    expect(second.lane).toBe(first.job.lane);
    expect(second.text).toBe("Klaus: so is it fixed?\n\nSaid in the thread since you last answered:\n- Max: it's back now");
    // The turns so far come along, for a computer that has to start the lane cold.
    expect(second.history.map((t) => t.text)).toEqual(["Lena: what happened?", "answer 1"]);

    // Another thread is another lane.
    await amb.turn("t1", { uid: "u1", name: "Lena" }, "slack:C1:2", "hi");
    expect(asked[2]!.job.lane).not.toBe(first.job.lane);
    expect(asked[2]!.job.session).toBeUndefined();
  });

  it("keeps a thread like any chat: weeks later it resumes the same session", async () => {
    let now = 1_000_000;
    const store = new Map<string, LaneRecord>();
    const { amb, asked } = setup({ connected: true, store, now: () => now });
    await amb.turn("t1", { uid: "u1", name: "Lena" }, "teams:x", "who decides on pricing?");
    now += 90 * 24 * 3600_000;
    await amb.turn("t1", { uid: "u1", name: "Lena" }, "teams:x", "and discounts?");
    expect(asked[1]!.job.session).toBe(S1);
    expect(store.get("t1|teams:x")!.turns).toHaveLength(4);
  });

  it("answers no one outside the team, and says how to connect a computer when there's none", async () => {
    const { amb, asked } = setup({ connected: false });
    expect((await amb.turn("t1", { uid: "u2", name: "Max" }, "teams:x", "hi")).text).toContain("not in this team");
    expect((await amb.turn("t1", { uid: "u1", name: "Lena" }, "teams:x", "hi")).text).toContain("No computer runs Acme's Ambient yet");
    expect(asked).toHaveLength(0);
  });
});
