// The morning push of what's waiting on you: on workdays, the first hourly run from 8 o'clock in
// the user's time zone (the one their app last reported; Vienna until it has), at most once a
// day, only when something is open, and counts only (briefs.ts digestMessage). Tapping it opens
// the app's list (ambient://actions). Turned off with the `digest` switch.
import { api, type Control } from "./control.ts";
import type { Directory } from "./directory.ts";
import { appStores, digestMessage, waitingOn } from "./briefs.ts";
import type { PersonalStore } from "./personal.ts";
import type { Notifier } from "./push.ts";
import type { TeamLink } from "./teams.ts";

export const DEFAULT_ZONE = "Europe/Vienna";
const FROM_HOUR = 8;
const UNTIL_HOUR = 11;

/** The zone if this runtime knows it. */
export function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** Date, hour and weekday (1 = Monday … 7 = Sunday) at `now` in `zone`. */
export function localTime(now: Date, zone = DEFAULT_ZONE): { day: string; hour: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "") + 1;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}

export function localDay(now: Date, zone?: string): string {
  return localTime(now, zone ?? DEFAULT_ZONE).day;
}

export interface DigestRun {
  uid: string;
  status: "sent" | "nothing" | "not_now" | "off" | "failed";
  error?: string;
}

export async function runDigest(d: {
  control: Control;
  personal: PersonalStore;
  teams: TeamLink;
  directory: Directory;
  notifier: Notifier;
  now?: Date;
}): Promise<DigestRun[]> {
  const now = d.now ?? new Date();
  const runs: DigestRun[] = [];
  for (const c of await d.control.q(api.push.digestCandidates, {})) {
    if (c.off) {
      runs.push({ uid: c.uid, status: "off" });
      continue;
    }
    const t = localTime(now, validZone(c.timeZone ?? undefined) ?? DEFAULT_ZONE);
    if (t.weekday > 5 || t.hour < FROM_HOUR || t.hour >= UNTIL_HOUR || c.sentOn === t.day) {
      runs.push({ uid: c.uid, status: "not_now" });
      continue;
    }
    try {
      const [stores, user] = await Promise.all([appStores(c.uid, d), d.directory.user(c.uid)]);
      const message = digestMessage(await waitingOn(stores, user?.name, t.day));
      if (message) await d.notifier.notify(c.uid, { ...message, url: "ambient://actions", thread: "actions", collapseId: `actions-${t.day}` });
      await d.control.m(api.push.markDigest, { uid: c.uid as never, day: t.day });
      runs.push({ uid: c.uid, status: message ? "sent" : "nothing" });
    } catch (err) {
      runs.push({ uid: c.uid, status: "failed", error: (err as Error).message.slice(0, 200) });
    }
  }
  return runs;
}
