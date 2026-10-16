// Routines: a prompt that Claude Code runs on a schedule, on one of the user's computers.
// The schedule is a small structured value (what the app's picker and the MCP tools both
// write); the gateway turns it into a systemd OnCalendar expression for the computer and
// works out the next run for display.
import { z } from "zod";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz) || tz === "UTC";
  } catch {
    return false;
  }
}

export const RoutineSchedule = z
  .object({
    /** hour: every hour at the minute of `time`; weekday: Monday to Friday; week: on `days`. */
    every: z.enum(["hour", "day", "weekday", "week"]),
    days: z.array(z.enum(WEEKDAYS)).max(7).optional(),
    /** "HH:MM", 24-hour, in `timezone`. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** IANA time zone, e.g. Europe/Vienna. */
    timezone: z.string().min(1).max(64).refine(isTimeZone, "unknown time zone"),
  })
  .refine((s) => s.every !== "week" || (s.days?.length ?? 0) > 0, { message: "a weekly routine needs at least one day", path: ["days"] });
export type RoutineSchedule = z.infer<typeof RoutineSchedule>;

const DAY_NAMES: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_PLURAL: Record<Weekday, string> = {
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
  sat: "Saturdays",
  sun: "Sundays",
};

function sortedDays(days: readonly Weekday[] | undefined): Weekday[] {
  return WEEKDAYS.filter((d) => days?.includes(d));
}

/** The systemd calendar expression, e.g. `Wed *-*-* 08:52:00 Europe/Vienna`. */
export function onCalendar(s: RoutineSchedule): string {
  const [hh, mm] = s.time.split(":");
  switch (s.every) {
    case "hour":
      return `*-*-* *:${mm}:00 ${s.timezone}`;
    case "day":
      return `*-*-* ${hh}:${mm}:00 ${s.timezone}`;
    case "weekday":
      return `Mon..Fri *-*-* ${hh}:${mm}:00 ${s.timezone}`;
    case "week":
      return `${sortedDays(s.days).map((d) => DAY_NAMES[d]).join(",")} *-*-* ${hh}:${mm}:00 ${s.timezone}`;
  }
}

/** "Wednesdays at 08:52", "Every hour at :15", "Mondays and Thursdays at 10:00". */
export function describeSchedule(s: RoutineSchedule, opts: { withZone?: boolean } = {}): string {
  const zone = opts.withZone ? ` (${s.timezone})` : "";
  switch (s.every) {
    case "hour":
      return `Every hour at :${s.time.slice(3)}${zone}`;
    case "day":
      return `Every day at ${s.time}${zone}`;
    case "weekday":
      return `Weekdays at ${s.time}${zone}`;
    case "week": {
      const days = sortedDays(s.days);
      if (days.length === 7) return `Every day at ${s.time}${zone}`;
      const names = days.map((d) => DAY_PLURAL[d]);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
      return `${list} at ${s.time}${zone}`;
    }
  }
}

// ---- next run ----

/** The wall-clock parts of `ts` in `tz`. */
function parts(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
  };
}

/** Offset of `tz` from UTC at `ts`, in milliseconds. */
function offset(ts: number, tz: string): number {
  const p = parts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` happens (the later reading across a DST change). */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - offset(guess, tz);
  ts = guess - offset(ts, tz);
  return ts;
}

/** When the routine runs next after `now` (ms since 1970). */
export function nextRun(s: RoutineSchedule, now: number): number {
  const [hh, mm] = s.time.split(":").map(Number) as [number, number];
  const today = parts(now, s.timezone);
  if (s.every === "hour") {
    for (let i = 0; i <= 25; i++) {
      const base = Date.UTC(today.y, today.mo - 1, today.d, today.h + i, mm);
      const p = new Date(base);
      const ts = zoned(p.getUTCFullYear(), p.getUTCMonth() + 1, p.getUTCDate(), p.getUTCHours(), mm, s.timezone);
      if (ts > now) return ts;
    }
  }
  const allowed: readonly Weekday[] = s.every === "weekday" ? ["mon", "tue", "wed", "thu", "fri"] : s.every === "week" ? (s.days ?? []) : WEEKDAYS;
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + i));
    const wd = WEEKDAYS[(day.getUTCDay() + 6) % 7]!;
    if (!allowed.includes(wd)) continue;
    const ts = zoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, s.timezone);
    if (ts > now) return ts;
  }
  throw new Error("no next run");
}
