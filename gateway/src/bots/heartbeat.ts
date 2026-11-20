// Ambient's heartbeat (docs/bots.md, "The heartbeat"): every half hour in the day, code gathers
// what happened for each person with bots (runs that failed, decisions waiting long, approvals
// waiting). Only when there's something new does Ambient get a turn, in its session; it writes a
// short message (into the chat, with a push) or stays silent. Code decides when there's news, the
// model only how to say it: nothing is missed because a model misjudged it, and nothing is sent
// because one felt like it. Nothing twice, at most 6 a day, none at night.
import { api, type Control } from "../control.ts";
import type { Notifier } from "../push.ts";
import type { AmbientChat } from "./ambient.ts";

const EVERY_MS = 30 * 60_000;
const MAX_A_DAY = 6;
const DAY_START = 8;
const DAY_END = 21;
const ZONE = "Europe/Vienna";
/** When Amb goes through the day for its memory. */
const MEMORY_HOUR = 3;
/** What Ambient replies when nothing needs saying. */
export const NOTHING = "NOTHING";

interface Event {
  key: string;
  kind: "failed" | "waiting" | "approval";
  routineId?: string;
  name?: string;
  at: number;
}

export function localParts(ts: number, zone = ZONE): { hour: number; day: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}` };
}

export function heartbeatPrompt(name: string, events: Event[], now: number): string {
  const lines = events.map((e) => {
    const ago = Math.max(1, Math.round((now - e.at) / 60_000));
    if (e.kind === "failed") return `- The bot "${e.name}" failed its last run (${ago} min ago).`;
    if (e.kind === "waiting") return `- A decision${e.name ? ` from "${e.name}"` : ""} has waited for ${name} for ${Math.round(ago / 60)} h.`;
    return `- A root command is waiting for ${name}'s approval.`;
  });
  return [
    `[Heartbeat, not a message from ${name}. What's new since you last looked:]`,
    ...lines,
    `If something here needs ${name}, write them one short message (two to four sentences: what, why it matters, what you suggest; look things up with your tools first, e.g. the bot's thread). If it can wait or they already know, reply exactly ${NOTHING}.`,
  ].join("\n");
}

export class Heartbeat {
  /** Whether Amb tells the person about their bots ("notify" in Amb's settings; docs/bots.md). */
  watching?: (uid: string) => Promise<boolean>;

  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private d: {
      control: Control;
      ambient: AmbientChat;
      /** Everyone with bots or a chat with Ambient (Convex `bots.people`). */
      people?: () => Promise<string[]>;
      notifier?: Notifier;

      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Looks every 5 minutes who's due (a person's beat is every 30 minutes). */
  start(): void {
    if (this.timer || !this.d.people) return;
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.busy || !this.d.people) return;
    this.busy = true;
    try {
      const people = await this.d.people();
      for (const uid of people) {
        await this.beat(uid).catch((err: Error) => console.warn(`[heartbeat] ${err.message}`));
        await this.nightly(uid).catch((err: Error) => console.warn(`[heartbeat] nightly: ${err.message}`));
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Once a night (03:00 Vienna), Amb looks back at the day and keeps what matters in its memory
   * (docs/bots.md, "Amb's memory"). Convex records the day first, so a restart doesn't run it twice.
   */
  async nightly(uid: string, opts: { force?: boolean } = {}): Promise<"kept" | "skipped"> {
    const { hour, day } = localParts(this.now());
    if (!opts.force && hour !== MEMORY_HOUR) return "skipped";
    const out = (await this.d.control.m(api.bots.memoryDay, { uid: uid as never, day })) as { first: boolean };
    if (!out.first) return "skipped";
    await this.d.ambient.keepMemory(uid, await this.d.ambient.nameOf(uid), "nightly");
    return "kept";
  }

  /** One person's beat; `force` (tests) skips the half-hour wait and the daytime window. */
  async beat(uid: string, opts: { force?: boolean } = {}): Promise<"quiet" | "sent" | "skipped"> {
    if (this.watching && !(await this.watching(uid).catch(() => true))) return "skipped";
    const now = this.now();
    const { hour, day } = localParts(now);
    const out = (await this.d.control.q(api.bots.heartbeatEvents, { uid: uid as never, since: 0, now })) as { events: Event[]; state: { lastBeatAt: number; day: string; sentToday: number; seen: string[] } | null };
    const state = out.state;
    if (!opts.force) {
      if (hour < DAY_START || hour >= DAY_END) return "skipped";
      if (state && now - state.lastBeatAt < EVERY_MS) return "skipped";
    }
    const sentToday = state && state.day === day ? state.sentToday : 0;
    const fresh = out.events.filter((e) => !state?.seen.includes(e.key));
    if (!fresh.length || sentToday >= MAX_A_DAY) {
      await this.d.control.m(api.bots.recordBeat, { uid: uid as never, at: now, day, sent: false, seen: [] });
      return "quiet";
    }
    const name = await this.d.ambient.nameOf(uid);
    const reply = (await this.d.ambient.internalTurn(uid, name, heartbeatPrompt(name, fresh, now)).catch(() => "")).trim();
    const speak = reply && reply.replace(/[.\s]/g, "").toUpperCase() !== NOTHING;
    if (speak) {
      await this.d.ambient.say(uid, reply);
      void this.d.notifier?.notify(uid, { title: "Ambient", body: reply.length > 180 ? `${reply.slice(0, 179)}…` : reply, url: "ambient://ambient", thread: "ambient", collapseId: "ambient-heartbeat" }).catch(() => undefined);
    }
    // Seen either way: what Ambient chose not to bring up isn't brought up again.
    await this.d.control.m(api.bots.recordBeat, { uid: uid as never, at: now, day, sent: Boolean(speak), seen: fresh.map((e) => e.key) });
    return speak ? "sent" : "quiet";
  }
}
