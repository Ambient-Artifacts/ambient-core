// An Ambient team's bot in Microsoft Teams. It tells a page's owner when a correction waits for
// them, lets them decide with one click, and posts a short morning report of what changed in the
// team's wiki to one channel.
//
//   Teams ──activity──▶ handle(): remember the team and the report channel, answer "open"/"help",
//                                 take a click on a card ──▶ a correction note from the owner
//   gateway, every 10 minutes ──▶ tick(): look for waiting corrections ──▶ direct message to the owner
//                                         (workdays, outside quiet hours, once per question)
//                                 ──▶ the morning report, once per workday from reportHour
//
// A click doesn't edit the wiki: it files the owner's own correction, the same note
// suggest_correction makes, and the team's sync applies it like any correction by the owner.
import type { WikiReader } from "@brain/wiki";
import type { TeamNoteV1 } from "@brain/spec";
import { localTime } from "../digest.ts";
import type { Activity, BotClient, Member } from "./botframework.ts";
import type { MsTeamsBotConfig } from "./config.ts";
import type { BotState, BotStore } from "./store.ts";
import { sameName, waitingOnPage, type Waiting } from "./waiting.ts";

export interface TeamMemberAccount {
  uid: string;
  name: string;
  email: string | null;
}

export interface CorrectionInput {
  uid: string;
  name: string;
  wrong: string;
  right: string;
  howKnown: string;
  refs: string[];
  subject: string;
}

export interface BotDeps {
  config: MsTeamsBotConfig;
  client: BotClient;
  store: BotStore;
  /** The team's wiki, read as config.readAs; undefined while the team has no server. */
  reader: () => Promise<WikiReader | undefined>;
  /** The Ambient team's members with their sign-in email. */
  accounts: () => Promise<TeamMemberAccount[]>;
  /** File a correction note in the team's wiki as `uid` (no hold). */
  correct: (c: CorrectionInput) => Promise<TeamNoteV1 | { path: string }>;
  now?: () => Date;
  log?: (msg: string) => void;
}

const ROSTER_MAX_AGE_MS = 6 * 3600_000;

const T = {
  en: {
    hello: () =>
      'Hi! I\'m the team\'s brain. Each workday morning I post here what changed in the wiki, and I message a page\'s owner directly when a correction waits for them. In a direct chat with me, write "open" to see what waits for you.',
    help: 'Write "open" to see the corrections that wait for your decision. I also message you when a new one comes in, and post a short report of what changed each workday morning.',
    none: "Nothing waits for you right now.",
    yours: (n: number) => `${n === 1 ? "One correction waits" : `${n} corrections wait`} for your decision:`,
    cardTitle: (w: Waiting) => `${w.corrector} corrected "${w.pageTitle}"`,
    cardBody: (w: Waiting) => `**${w.corrector} says:** ${w.says} (${w.date})\n\n**The documents say:** ${w.documents || "–"}\n\nYou decide for this page.`,
    accept: (w: Waiting) => `${firstName(w.corrector)} is right`,
    keep: "The document is right",
    open: "Open the page",
    accepted: (w: Waiting) => `Done: you confirmed ${w.corrector}'s correction. The page changes with the next sync (within the hour).`,
    kept: (w: Waiting) => `Done: the page keeps what the documents say, and the open question goes away with the next sync (within the hour). Tell ${firstName(w.corrector)} why, if it helps.`,
    gone: "This question is already answered.",
    notOwner: (w: Waiting) => `Only ${w.owner} decides for this page.`,
    noAccount: "I couldn't find your Ambient account (by your email). Ask your team's admin to invite you to Ambient.",
    failed: "That didn't work, the wiki didn't take it. Please try again in a few minutes.",
    report: "Yesterday in the brain",
    reportSince: (day: string) => `Since ${day} in the brain`,
    notes: (n: number) => `${n} new note${n === 1 ? "" : "s"}`,
    pages: (n: number) => `${n} page${n === 1 ? "" : "s"} updated`,
    waitingHead: "Waiting for a decision",
    waitingLine: (w: Waiting) => `${w.owner}: ${w.corrector}'s correction on "${w.pageTitle}" (since ${w.date})`,
    more: (n: number) => `and ${n} more`,
  },
  de: {
    hello: () =>
      'Hallo! Ich bin das Brain des Teams. Jeden Werktag am Morgen schreibe ich hier, was sich im Wiki geändert hat, und ich schreibe dem Owner einer Seite direkt, wenn eine Korrektur auf ihn wartet. Im Chat mit mir zeigt "offen", was auf dich wartet.',
    help: 'Schreib "offen", dann zeige ich dir die Korrekturen, die auf deine Entscheidung warten. Kommt eine neue dazu, melde ich mich, und jeden Werktag am Morgen gibt es einen kurzen Bericht, was sich geändert hat.',
    none: "Gerade wartet nichts auf dich.",
    yours: (n: number) => `${n === 1 ? "Eine Korrektur wartet" : `${n} Korrekturen warten`} auf deine Entscheidung:`,
    cardTitle: (w: Waiting) => `${w.corrector} hat „${w.pageTitle}“ korrigiert`,
    cardBody: (w: Waiting) => `**${w.corrector} sagt:** ${w.says} (${w.date})\n\n**Die Dokumente sagen:** ${w.documents || "–"}\n\nDu entscheidest für diese Seite.`,
    accept: (w: Waiting) => `${firstName(w.corrector)} hat recht`,
    keep: "Das Dokument stimmt",
    open: "Seite öffnen",
    accepted: (w: Waiting) => `Erledigt: Du hast die Korrektur von ${w.corrector} bestätigt. Die Seite ändert sich mit dem nächsten Sync (innerhalb einer Stunde).`,
    kept: (w: Waiting) => `Erledigt: Die Seite behält, was in den Dokumenten steht, und die offene Frage verschwindet mit dem nächsten Sync (innerhalb einer Stunde). Sag ${firstName(w.corrector)} am besten kurz, warum.`,
    gone: "Diese Frage ist schon beantwortet.",
    notOwner: (w: Waiting) => `Für diese Seite entscheidet ${w.owner}.`,
    noAccount: "Ich habe dein Ambient-Konto (über deine E-Mail) nicht gefunden. Bitte den Admin deines Teams, dich zu Ambient einzuladen.",
    failed: "Das hat nicht geklappt, das Wiki hat es nicht angenommen. Bitte versuch es in ein paar Minuten noch einmal.",
    report: "Gestern im Brain",
    reportSince: (day: string) => `Seit ${day} im Brain`,
    notes: (n: number) => `${n} neue ${n === 1 ? "Notiz" : "Notizen"}`,
    pages: (n: number) => `${n} ${n === 1 ? "Seite" : "Seiten"} aktualisiert`,
    waitingHead: "Wartet auf eine Entscheidung",
    waitingLine: (w: Waiting) => `${w.owner}: Korrektur von ${w.corrector} auf „${w.pageTitle}“ (seit ${w.date})`,
    more: (n: number) => `und ${n} weitere`,
  },
};

const firstName = (name: string) => name.split(" ")[0] ?? name;

/** "<at>Bot</at> hallo" → "hallo"; Teams sends channel messages as HTML. */
export function plainText(text: string | undefined): string {
  return (text ?? "")
    .replace(/<at>[^<]*<\/at>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export class MsTeamsBot {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly t: (typeof T)["en"];

  constructor(private d: BotDeps) {
    this.t = T[d.config.language];
  }

  get appId(): string {
    return this.d.config.appId;
  }

  get tenantId(): string {
    return this.d.config.tenantId;
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private log(msg: string): void {
    (this.d.log ?? ((m) => console.log(`[msteams ${this.d.config.team}] ${m}`)))(msg);
  }

  /** One thing at a time per bot: activities and ticks both read and write its state. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async withState<T>(fn: (s: BotState) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const s = await this.d.store.load();
      try {
        return await fn(s);
      } finally {
        await this.d.store.save(s);
      }
    });
  }

  /** Whether an activity is for this bot and from its tenant. */
  accepts(a: Activity): boolean {
    const tenant = a.channelData?.tenant?.id ?? a.conversation.tenantId;
    return a.recipient.id === `28:${this.appId}` && tenant === this.tenantId;
  }

  async handle(a: Activity): Promise<void> {
    await this.withState(async (s) => {
      s.serviceUrl = a.serviceUrl;
      const team = a.channelData?.team;
      if (team?.id) {
        if (s.teamId !== team.id) s.members = undefined;
        s.teamId = team.id;
        if (team.name) s.teamName = team.name;
      }
      if (a.type === "conversationUpdate") {
        if (a.membersRemoved?.some((m) => m.id === a.recipient.id) && team?.id) {
          this.log("removed from the team");
          s.teamId = undefined;
          s.channel = undefined;
          s.members = undefined;
        }
        if (a.membersAdded?.some((m) => m.id === a.recipient.id)) this.log(`installed in ${team?.name ?? "a chat"}`);
        return;
      }
      if (a.type !== "message") return;
      if (a.value && typeof a.value === "object") return this.choice(s, a);
      const text = plainText(a.text).toLowerCase();
      if (a.conversation.conversationType === "channel") {
        const id = a.conversation.id.split(";")[0]!;
        if (!s.channel || /\b(hier|here)\b/.test(text) || s.channel.id === id) s.channel = { id, name: a.channelData?.channel?.name ?? s.channel?.name };
        await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.hello() });
        await this.roster(s, true).catch((err) => this.log(`roster: ${(err as Error).message}`));
        return;
      }
      if (a.conversation.conversationType === "personal" || !a.conversation.isGroup) {
        if (/^(offen|open|offene?)\b/.test(text)) return this.openFor(s, a);
        await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.help });
      }
    });
  }

  private async roster(s: BotState, force = false): Promise<Member[]> {
    if (!s.serviceUrl || !s.teamId) return s.members?.list ?? [];
    if (!force && s.members && Date.now() - Date.parse(s.members.at) < ROSTER_MAX_AGE_MS) return s.members.list;
    const list = await this.d.client.members(s.serviceUrl, s.teamId);
    s.members = { at: this.now().toISOString(), list: list.map((m) => ({ id: m.id, name: m.name, aadObjectId: m.aadObjectId, email: m.email, userPrincipalName: m.userPrincipalName })) };
    return s.members.list;
  }

  private memberOf(s: BotState, a: Activity): Member | undefined {
    const list = s.members?.list ?? [];
    return list.find((m) => m.id === a.from.id || (a.from.aadObjectId && m.aadObjectId === a.from.aadObjectId));
  }

  private isOwner(w: Waiting, who: { name?: string } | undefined, fromName: string | undefined): boolean {
    return [who?.name, fromName].some((n) => !!n && sameName(n, w.owner));
  }

  private async openFor(s: BotState, a: Activity): Promise<void> {
    if (!s.members) await this.roster(s).catch(() => undefined);
    const who = this.memberOf(s, a);
    const mine = (s.waiting ?? []).filter((w) => this.isOwner(w, who, a.from.name) && !s.told?.[w.key]?.done);
    if (!mine.length) {
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.none });
      return;
    }
    await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.yours(mine.length) });
    for (const w of mine) {
      const id = await this.d.client.send(a.serviceUrl, a.conversation.id, this.card(w));
      s.told = { ...s.told, [w.key]: { ...s.told?.[w.key], at: s.told?.[w.key]?.at ?? this.now().toISOString(), conversation: a.conversation.id, activity: id } };
    }
  }

  card(w: Waiting): Record<string, unknown> {
    const url = this.d.config.pageUrl?.replace("{path}", encodeURIComponent(`${w.ref}.md`).replace(/%2F/g, "/"));
    return {
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            version: "1.4",
            body: [
              { type: "TextBlock", text: this.t.cardTitle(w), weight: "Bolder", wrap: true },
              { type: "TextBlock", text: this.t.cardBody(w), wrap: true },
            ],
            actions: [
              { type: "Action.Submit", title: this.t.accept(w), data: { ambient: "accept", key: w.key } },
              { type: "Action.Submit", title: this.t.keep, data: { ambient: "keep", key: w.key } },
              ...(url ? [{ type: "Action.OpenUrl", title: this.t.open, url }] : []),
            ],
          },
        },
      ],
    };
  }

  private async choice(s: BotState, a: Activity): Promise<void> {
    const v = a.value as { ambient?: string; key?: string };
    if ((v.ambient !== "accept" && v.ambient !== "keep") || !v.key) return;
    const reply = async (text: string) => {
      // Replace the card the click came from, so it can't be clicked twice.
      if (a.replyToId) await this.d.client.update(a.serviceUrl, a.conversation.id, a.replyToId, { text }).catch(() => this.d.client.send(a.serviceUrl, a.conversation.id, { text }));
      else await this.d.client.send(a.serviceUrl, a.conversation.id, { text });
    };
    const w = (s.waiting ?? []).find((x) => x.key === v.key);
    if (!w || s.told?.[w.key]?.done) return reply(this.t.gone);
    if (!s.members) await this.roster(s).catch(() => undefined);
    const who = this.memberOf(s, a);
    if (!this.isOwner(w, who, a.from.name)) {
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.notOwner(w) });
      return;
    }
    const accounts = await this.d.accounts();
    const emails = [who?.email, who?.userPrincipalName].filter((e): e is string => !!e).map((e) => e.toLowerCase());
    const account = accounts.find((x) => x.email && emails.includes(x.email.toLowerCase())) ?? accounts.find((x) => sameName(x.name, w.owner));
    if (!account) {
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.noAccount });
      return;
    }
    const decided = `${w.owner} decides for this page and answered the open question from ${w.corrector}'s correction of ${w.date} in Microsoft Teams`;
    const correction: CorrectionInput =
      v.ambient === "accept"
        ? {
            uid: account.uid,
            name: account.name,
            wrong: w.documents || `The page's open question: ${w.line}`,
            right: w.says,
            howKnown: `${decided}: ${w.corrector} is right. This answers the open question on the page; remove it.`,
            refs: [w.ref],
            subject: w.pageTitle,
          }
        : {
            uid: account.uid,
            name: account.name,
            wrong: `${w.corrector} says ${w.says}`,
            right: `What the documents say stays${w.documents ? `: ${w.documents}` : ""}.`,
            howKnown: `${decided}: the documents are right. Keep the page as it is and remove the open question.`,
            refs: [w.ref],
            subject: w.pageTitle,
          };
    try {
      await this.d.correct(correction);
    } catch (err) {
      this.log(`correction failed: ${(err as Error).message}`);
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.failed });
      return;
    }
    s.told = { ...s.told, [w.key]: { ...s.told?.[w.key], at: s.told?.[w.key]?.at ?? this.now().toISOString(), done: v.ambient } };
    this.log(`${account.name} answered ${w.key} on ${w.ref}: ${v.ambient}`);
    await reply(v.ambient === "accept" ? this.t.accepted(w) : this.t.kept(w));
  }

  /** The waiting corrections in the wiki now (pages whose open questions name a correction and an owner). */
  async scan(reader: WikiReader): Promise<Waiting[]> {
    const hits = await reader.search("correction decide", { limit: 50 });
    const seen = new Set<string>();
    const out: Waiting[] = [];
    for (const h of hits) {
      if (seen.has(h.page.ref)) continue;
      seen.add(h.page.ref);
      out.push(...waitingOnPage({ ref: h.page.ref, title: h.page.title, body: h.page.body }));
    }
    return out.sort((x, y) => x.date.localeCompare(y.date) || x.ref.localeCompare(y.ref));
  }

  /** Every ten minutes: tell owners about new waiting corrections; the morning report. */
  async tick(): Promise<{ told: number; reported: boolean }> {
    return this.withState(async (s) => {
      if (!s.serviceUrl || !s.teamId) return { told: 0, reported: false };
      const reader = await this.d.reader();
      if (!reader) return { told: 0, reported: false };
      const now = this.now();
      s.waiting = await this.scan(reader);
      const open = new Set(s.waiting.map((w) => w.key));
      // Forget answered questions once they're off the page, so the file doesn't grow.
      for (const k of Object.keys(s.told ?? {})) if (!open.has(k)) delete s.told![k];

      const zone = this.d.config.timeZone;
      const t = localTime(now, zone);
      const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, minute: "2-digit" }).format(now));
      const workday = t.weekday <= 5;
      const awake = workday && t.hour * 60 + minute >= minutes(this.d.config.quietUntil) && t.hour * 60 + minute < minutes(this.d.config.quietFrom);

      let told = 0;
      if (awake) {
        const members = await this.roster(s).catch((err) => {
          this.log(`roster: ${(err as Error).message}`);
          return s.members?.list ?? [];
        });
        for (const w of s.waiting) {
          if (s.told?.[w.key]) continue;
          const owner = members.find((m) => sameName(m.name, w.owner));
          if (!owner) continue;
          try {
            const conversation = await this.d.client.directChat(s.serviceUrl, owner.id);
            const activity = await this.d.client.send(s.serviceUrl, conversation, this.card(w));
            s.told = { ...s.told, [w.key]: { at: now.toISOString(), conversation, activity } };
            told++;
          } catch (err) {
            this.log(`telling ${w.owner}: ${(err as Error).message}`);
          }
        }
      }

      let reported = false;
      if (workday && s.channel && s.reportedOn !== t.day && t.hour >= this.d.config.reportHour && t.hour < this.d.config.reportHour + 3) {
        const text = await this.report(reader, s, now);
        if (text) await this.d.client.send(s.serviceUrl, s.channel.id, { text, textFormat: "markdown" });
        s.reportedOn = t.day;
        s.reportedAt = now.toISOString();
        reported = !!text;
      }
      return { told, reported };
    });
  }

  /** The morning report, or nothing when nothing changed and nothing waits. */
  async report(reader: WikiReader, s: BotState, now: Date): Promise<string | undefined> {
    const since = s.reportedAt ?? new Date(now.getTime() - 24 * 3600_000).toISOString();
    const notes = (await reader.recent({ since, limit: 50 })).filter((p) => p.sortDate >= since);
    const sinceDay = since.slice(0, 10);
    const noteRefs = new Set(notes.map((n) => n.ref));
    const pages = (await reader.entries()).filter((p) => p.type !== "note" && !noteRefs.has(p.ref) && p.updated >= sinceDay && !p.ref.startsWith("ambient/"));
    const waiting = (s.waiting ?? []).filter((w) => !s.told?.[w.key]?.done);
    const visible = notes.filter((n) => !n.ref.startsWith("ambient/corrections/"));
    if (!visible.length && !pages.length && !waiting.length) return undefined;

    const yesterday = localTime(new Date(now.getTime() - 24 * 3600_000), this.d.config.timeZone).day;
    const head = !s.reportedAt || localTime(new Date(since), this.d.config.timeZone).day === yesterday ? this.t.report : this.t.reportSince(localTime(new Date(since), this.d.config.timeZone).day);
    const section = <X>(title: string, xs: X[], line: (x: X) => string, max = 6) =>
      [`**${title}**`, ...xs.slice(0, max).map((x) => `- ${line(x)}`), ...(xs.length > max ? [`- ${this.t.more(xs.length - max)}`] : [])].join("\n");
    const parts = [`**${head}**`];
    if (visible.length) parts.push(section(this.t.notes(visible.length), visible, (n) => n.title));
    if (pages.length) parts.push(section(this.t.pages(pages.length), pages, (p) => p.title));
    if (waiting.length) parts.push(section(this.t.waitingHead, waiting, (w) => this.t.waitingLine(w)));
    return parts.join("\n\n");
  }
}
