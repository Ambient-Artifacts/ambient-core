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
    /**
     * hour: every hour at the minute of `time`; weekday: Monday to Friday; week: on `days`;
     * needed: no schedule at all ("When it needs to"): a bot that runs when it's written to, on
     * events, and at the wake-ups it books itself (docs/bots.md, "Wake-ups"). `time` means nothing
     * then; `timezone` is where its wake-ups' local times are.
     */
    every: z.enum(["hour", "day", "weekday", "week", "needed"]),
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

/** The systemd calendar expression, e.g. `Wed *-*-* 08:52:00 Europe/Vienna`; null: no timer. */
export function onCalendar(s: RoutineSchedule): string | null {
  const [hh, mm] = s.time.split(":");
  switch (s.every) {
    case "needed":
      return null;
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
    case "needed":
      return "When it needs to";
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
export function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - offset(guess, tz);
  ts = guess - offset(ts, tz);
  return ts;
}

/** When the routine runs next after `now` (ms since 1970); null without a schedule. */
export function nextRun(s: RoutineSchedule, now: number): number | null {
  if (s.every === "needed") return null;
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

// ---- wake-ups (docs/bots.md, "Wake-ups") ----

/**
 * The instant of a wake-up's time as a bot writes it: ISO 8601 with a `Z` or an offset
 * (2026-11-24T09:00:00+01:00), or a local "2026-11-24 09:00" / "2026-11-24T09:00", read in
 * `timezone`. Null when it isn't one.
 */
export function wakeTime(at: string, timezone: string): number | null {
  const t = at.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(t);
  if (local) {
    const [y, mo, d, h, mi] = local.slice(1).map(Number) as [number, number, number, number, number];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return zoned(y, mo, d, h, mi, timezone);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** "Tue 24 Nov, 09:00" in `timezone`. */
export function describeWake(at: number, timezone: string): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(at))) p[x.type] = x.value;
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}
