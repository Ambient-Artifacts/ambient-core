// An Ambient team's bot in Microsoft Teams: the part that has to answer right away.
//
//   Teams ──activity──▶ handle()
//     a click on a card        ──▶ is the question still open, and is this its owner? (fixed code)
//                                  ──▶ the owner's own correction note, the same as suggest_correction
//     a message in a chat, or  ──▶ Claude, with the team's Ambient tools as the person who asked
//     an @mention in a channel     (ask.ts), answers in the thread
//
// What happens on a schedule (the morning report, telling owners that a correction waits for
// them) is the team's own loops: they send the cards this bot then takes the clicks for.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WikiReader } from "@brain/wiki";
import type { TeamNoteV1 } from "@brain/spec";
import { answer, type Turn } from "./ask.ts";
import type { Activity, BotClient, Member } from "./botframework.ts";
import type { MsTeamsBotConfig } from "./config.ts";
import { sameName, waitingOnPage } from "./waiting.ts";

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
  /** The Ambient team's members with their sign-in email. */
  accounts: () => Promise<TeamMemberAccount[]>;
  /** The team's wiki, read as `uid`; undefined while the team has no server. */
  reader: (uid: string) => Promise<WikiReader | undefined>;
  /** The team's MCP server for `uid` (team scope, as /t/<team>/mcp gives it). */
  mcp: (uid: string) => Promise<McpServer | undefined>;
  /** File a correction note in the team's wiki as `uid` (no hold). */
  correct: (c: CorrectionInput) => Promise<TeamNoteV1 | { path: string }>;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/** What a card's buttons carry (the team's loop writes them; scripts/teams_bot.py in its repo). */
export interface CardChoice {
  ambient: "accept" | "keep";
  ref: string;
  corrector: string;
  date: string;
  owner: string;
}

const T = {
  en: {
    hello: "Hi! I'm the team's brain. Ask me anything about what's in the wiki, here with @mention or in a direct chat. I also post a short report each workday morning and message a page's owner when a correction waits for them.",
    noAccount: "I couldn't find your Ambient account (by your email). Ask your team's admin to invite you to Ambient.",
    noKey: "I can't answer questions yet: no AI key is set up for this team.",
    failed: "That didn't work just now. Please try again in a few minutes.",
    empty: "I couldn't find an answer to that in the wiki.",
    gone: "This question is already answered.",
    notOwner: (owner: string) => `Only ${owner} decides for this page.`,
    accepted: (c: CardChoice) => `Done: you confirmed ${c.corrector}'s correction. The page changes with the next sync (within the hour).`,
    kept: (c: CardChoice) => `Done: the page keeps what the documents say, and the open question goes away with the next sync (within the hour). Tell ${c.corrector.split(" ")[0]} why, if it helps.`,
  },
  de: {
    hello: "Hallo! Ich bin das Brain des Teams. Frag mich alles, was im Wiki steht, hier mit @Erwähnung oder im Chat mit mir. Jeden Werktag am Morgen schreibe ich hier einen kurzen Bericht, und wartet eine Korrektur auf den Owner einer Seite, schreibe ich ihm direkt.",
    noAccount: "Ich habe dein Ambient-Konto (über deine E-Mail) nicht gefunden. Bitte den Admin deines Teams, dich zu Ambient einzuladen.",
    noKey: "Fragen kann ich noch nicht beantworten: Für dieses Team ist noch kein KI-Schlüssel eingerichtet.",
    failed: "Das hat gerade nicht geklappt. Bitte versuch es in ein paar Minuten noch einmal.",
    empty: "Dazu habe ich im Wiki nichts gefunden.",
    gone: "Diese Frage ist schon beantwortet.",
    notOwner: (owner: string) => `Für diese Seite entscheidet ${owner}.`,
    accepted: (c: CardChoice) => `Erledigt: Du hast die Korrektur von ${c.corrector} bestätigt. Die Seite ändert sich mit dem nächsten Sync (innerhalb einer Stunde).`,
    kept: (c: CardChoice) => `Erledigt: Die Seite behält, was in den Dokumenten steht, und die offene Frage verschwindet mit dem nächsten Sync (innerhalb einer Stunde). Sag ${c.corrector.split(" ")[0]} am besten kurz, warum.`,
  },
};

/** "<at>Bot</at> hallo" → "hallo"; Teams sends channel messages as HTML. */
export function plainText(text: string | undefined): string {
  return (text ?? "")
    .replace(/<at>[^<]*<\/at>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

const HISTORY_TURNS = 8;
const HISTORY_MS = 2 * 3600_000;

export class MsTeamsBot {
  private readonly t: (typeof T)["en"];
  /** The last turns per conversation, so a follow-up question has its context (kept in memory only). */
  private history = new Map<string, { at: number; turns: Turn[] }>();
  /** Questions answered by a click here; the page only loses the question with the next sync. */
  private answered = new Map<string, number>();

  constructor(private d: BotDeps) {
    this.t = T[d.config.language];
  }

  get appId(): string {
    return this.d.config.appId;
  }

  private log(msg: string): void {
    (this.d.log ?? ((m) => console.log(`[msteams ${this.d.config.team}] ${m}`)))(msg);
  }

  /** Whether an activity is for this bot and from its tenant. */
  accepts(a: Activity): boolean {
    const tenant = a.channelData?.tenant?.id ?? a.conversation.tenantId;
    return a.recipient.id === `28:${this.appId}` && tenant === this.d.config.tenantId;
  }

  async handle(a: Activity): Promise<void> {
    if (a.type === "conversationUpdate") {
      if (a.membersAdded?.some((m) => m.id === a.recipient.id)) this.log(`installed: ${this.where(a)}`);
      return;
    }
    if (a.type !== "message") return;
    if (a.value && typeof a.value === "object") return this.choice(a, a.value as Partial<CardChoice>);
    const text = plainText(a.text);
    const inChannel = a.conversation.conversationType === "channel";
    if (inChannel && (!text || /^(hallo|hello|hi|hey)[!. ]*$/i.test(text))) {
      // The loops need these ids to post the morning report here (the team's pipeline variables).
      this.log(`greeted in a channel: ${this.where(a)}`);
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.hello });
      return;
    }
    if (!text) return;
    await this.ask(a, text);
  }

  private where(a: Activity): string {
    const channel = a.conversation.id.split(";")[0];
    return `serviceUrl=${a.serviceUrl} team=${a.channelData?.team?.id ?? "-"} channel=${a.conversation.conversationType === "channel" ? channel : "-"}`;
  }

  /** The person behind an activity: their Teams profile (with email) and their Ambient account. */
  private async who(a: Activity): Promise<{ member?: Member; account?: TeamMemberAccount }> {
    const member = await this.d.client.member(a.serviceUrl, a.conversation.id, a.from.id).catch((err) => {
      this.log(`member lookup: ${(err as Error).message}`);
      return undefined;
    });
    const emails = [member?.email, member?.userPrincipalName].filter((e): e is string => !!e).map((e) => e.toLowerCase());
    const accounts = await this.d.accounts();
    const account = accounts.find((x) => x.email && emails.includes(x.email.toLowerCase()));
    return { member, account };
  }

  private async ask(a: Activity, question: string): Promise<void> {
    const apiKey = this.d.config.anthropicApiKey ?? this.d.apiKey;
    if (!apiKey) {
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.noKey });
      return;
    }
    const { member, account } = await this.who(a);
    if (!account) {
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.noAccount });
      return;
    }
    const server = await this.d.mcp(account.uid);
    if (!server) {
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.failed });
      return;
    }
    await this.d.client.typing(a.serviceUrl, a.conversation.id).catch(() => undefined);
    const key = a.conversation.id;
    const past = this.history.get(key);
    const history = past && Date.now() - past.at < HISTORY_MS ? past.turns : [];
    let reply: string;
    try {
      reply = await answer({
        server,
        apiKey,
        model: this.d.config.model,
        language: this.d.config.language,
        name: member?.name ?? account.name,
        history,
        question,
        fetchImpl: this.d.fetchImpl,
      });
    } catch (err) {
      this.log(`answer failed: ${(err as Error).message}`);
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.failed });
      return;
    }
    const text = reply || this.t.empty;
    this.history.set(key, { at: Date.now(), turns: [...history, { role: "user" as const, text: question }, { role: "assistant" as const, text }].slice(-HISTORY_TURNS) });
    if (this.history.size > 500) this.history.delete(this.history.keys().next().value!);
    await this.d.client.send(a.serviceUrl, a.conversation.id, { text, textFormat: "markdown" });
  }

  private async choice(a: Activity, v: Partial<CardChoice>): Promise<void> {
    if ((v.ambient !== "accept" && v.ambient !== "keep") || !v.ref || !v.corrector || !v.date) return;
    const c = v as CardChoice;
    const reply = async (text: string) => {
      // Replace the card the click came from, so it can't be clicked twice.
      if (a.replyToId) await this.d.client.update(a.serviceUrl, a.conversation.id, a.replyToId, { text }).catch(() => this.d.client.send(a.serviceUrl, a.conversation.id, { text }));
      else await this.d.client.send(a.serviceUrl, a.conversation.id, { text });
    };
    const { member, account } = await this.who(a);
    if (!account) {
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.noAccount });
      return;
    }
    // The card says what it's about; the page says whether it's still open and who decides.
    const reader = await this.d.reader(account.uid);
    const page = await reader?.getByRef(c.ref).catch(() => undefined);
    const w = page && waitingOnPage({ ref: page.ref, title: page.title, body: page.body }).find((x) => sameName(x.corrector, c.corrector) && x.date === c.date);
    if (!w) return reply(this.t.gone);
    const done = `${w.ref}\n${w.corrector}\n${w.date}`;
    if ((this.answered.get(done) ?? 0) > Date.now() - HISTORY_MS) return reply(this.t.gone);
    if (![account.name, member?.name, a.from.name].some((n) => !!n && sameName(n, w.owner))) {
      await this.d.client.send(a.serviceUrl, a.conversation.id, { text: this.t.notOwner(w.owner) });
      return;
    }
    const decided = `${w.owner} decides for this page and answered the open question from ${w.corrector}'s correction of ${w.date} in Microsoft Teams`;
    const correction: CorrectionInput =
      c.ambient === "accept"
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
    this.answered.set(done, Date.now());
    this.log(`${account.name} answered ${w.corrector}'s correction of ${w.date} on ${w.ref}: ${c.ambient}`);
    await reply(c.ambient === "accept" ? this.t.accepted(c) : this.t.kept(c));
  }
}
