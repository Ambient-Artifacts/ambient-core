import { describe, expect, it } from "vitest";
import { RoutineSchedule, describeSchedule, nextRun, onCalendar } from "../src/index.ts";

const vienna = (s: Omit<RoutineSchedule, "timezone">) => RoutineSchedule.parse({ ...s, timezone: "Europe/Vienna" });
const at = (iso: string) => Date.parse(iso);
const iso = (ts: number) => new Date(ts).toISOString();

describe("routine schedules", () => {
  it("validates", () => {
    expect(RoutineSchedule.safeParse({ every: "day", time: "07:00", timezone: "Europe/Vienna" }).success).toBe(true);
    expect(RoutineSchedule.safeParse({ every: "day", time: "7:00", timezone: "Europe/Vienna" }).success).toBe(false);
    expect(RoutineSchedule.safeParse({ every: "day", time: "24:00", timezone: "Europe/Vienna" }).success).toBe(false);
    expect(RoutineSchedule.safeParse({ every: "day", time: "07:00", timezone: "Mars/Olympus" }).success).toBe(false);
    expect(RoutineSchedule.safeParse({ every: "week", time: "07:00", timezone: "UTC" }).success).toBe(false);
    expect(RoutineSchedule.safeParse({ every: "week", days: [], time: "07:00", timezone: "UTC" }).success).toBe(false);
  });

  it("turns into systemd calendar expressions", () => {
    expect(onCalendar(vienna({ every: "week", days: ["wed"], time: "08:52" }))).toBe("Wed *-*-* 08:52:00 Europe/Vienna");
    expect(onCalendar(vienna({ every: "week", days: ["fri", "mon"], time: "10:00" }))).toBe("Mon,Fri *-*-* 10:00:00 Europe/Vienna");
    expect(onCalendar(vienna({ every: "weekday", time: "09:30" }))).toBe("Mon..Fri *-*-* 09:30:00 Europe/Vienna");
    expect(onCalendar(vienna({ every: "day", time: "06:00" }))).toBe("*-*-* 06:00:00 Europe/Vienna");
    expect(onCalendar(vienna({ every: "hour", time: "00:15" }))).toBe("*-*-* *:15:00 Europe/Vienna");
  });

  it("reads as a sentence", () => {
    expect(describeSchedule(vienna({ every: "week", days: ["wed"], time: "08:52" }))).toBe("Wednesdays at 08:52");
    expect(describeSchedule(vienna({ every: "week", days: ["thu", "mon", "fri"], time: "10:00" }))).toBe("Mondays, Thursdays and Fridays at 10:00");
    expect(describeSchedule(vienna({ every: "hour", time: "00:15" }), { withZone: true })).toBe("Every hour at :15 (Europe/Vienna)");
    expect(describeSchedule(vienna({ every: "weekday", time: "09:00" }))).toBe("Weekdays at 09:00");
  });

  it("finds the next run in the schedule's time zone", () => {
    // Sunday 2026-10-11 15:00 in Vienna (CEST, UTC+2).
    const now = at("2026-10-11T13:00:00Z");
    expect(iso(nextRun(vienna({ every: "week", days: ["wed"], time: "08:52" }), now))).toBe("2026-10-14T06:52:00.000Z");
    expect(iso(nextRun(vienna({ every: "day", time: "16:00" }), now))).toBe("2026-10-11T14:00:00.000Z");
    expect(iso(nextRun(vienna({ every: "day", time: "14:00" }), now))).toBe("2026-10-12T12:00:00.000Z");
    expect(iso(nextRun(vienna({ every: "weekday", time: "07:00" }), now))).toBe("2026-10-12T05:00:00.000Z");
    expect(iso(nextRun(vienna({ every: "hour", time: "00:15" }), now))).toBe("2026-10-11T13:15:00.000Z");
    expect(iso(nextRun(vienna({ every: "week", days: ["sun"], time: "15:00" }), now))).toBe("2026-10-18T13:00:00.000Z");
  });

  it("follows daylight saving time", () => {
    // Vienna leaves summer time on 2026-10-25: 07:00 is 05:00Z before and 06:00Z after.
    const s = vienna({ every: "day", time: "07:00" });
    expect(iso(nextRun(s, at("2026-10-24T12:00:00Z")))).toBe("2026-10-25T06:00:00.000Z");
    expect(iso(nextRun(s, at("2026-10-23T12:00:00Z")))).toBe("2026-10-24T05:00:00.000Z");
    expect(iso(nextRun(RoutineSchedule.parse({ every: "day", time: "07:00", timezone: "America/Los_Angeles" }), at("2026-10-11T13:00:00Z")))).toBe(
      "2026-10-11T14:00:00.000Z",
    );
  });
});
