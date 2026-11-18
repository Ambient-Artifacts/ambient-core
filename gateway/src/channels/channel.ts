// Where Ambient and the bots talk to people. A channel takes what a bot or Ambient says (with who
// says it: the speaker's name and face) and delivers it in its own form; what people write comes
// back as an Inbound for a bot or for Ambient. The app is the first channel: its threads live in
// Convex, so delivering there is a push. Teams, Slack, Telegram or WhatsApp are further channels
// with the same two shapes; nothing that decides what to say knows which one it's talking to.
import type { Notifier, PushMessage } from "../push.ts";

export type Speaker = { kind: "ambient" } | { kind: "bot"; botId: string; name: string; face: string; color?: string; wear?: string[]; team: string | null };

export interface Outgoing {
  speaker: Speaker;
  /** The account it's for. */
  to: string;
  /** text: said in a thread; question: waits for an answer (with `choices` to pick from); status: a short state change. */
  kind: "text" | "question" | "status";
  text: string;
  choices?: string[];
}

export type Target = { kind: "ambient" } | { kind: "bot"; botId: string };

export interface Inbound {
  channel: string;
  /** The Ambient account of whoever wrote it (each channel links its own ids to one). */
  uid: string;
  target: Target;
  text: string;
}

export interface Channel {
  readonly kind: string;
  deliver(message: Outgoing): Promise<void>;
}

/** The Ambient app: the thread is already stored, so a question gets a push that opens it. */
export class AppChannel implements Channel {
  readonly kind = "app";
  constructor(private notifier?: Notifier) {}

  async deliver(m: Outgoing): Promise<void> {
    if (!this.notifier || m.kind !== "question") return;
    if (m.speaker.kind === "bot") await this.notifier.notify(m.to, botQuestionPush({ botId: m.speaker.botId, name: m.speaker.name, team: m.speaker.team, question: m.text }));
    // Ambient's own question (a change it proposes): opens its chat, where the card is.
    else await this.notifier.notify(m.to, ambientQuestionPush(m.text));
  }
}

/** The push when Ambient asks something itself (a proposed change): tapping it opens the chat. */
export function ambientQuestionPush(question: string): PushMessage {
  const body = question.replace(/\s+/g, " ").trim();
  return { title: "Ambient needs you", body: body.length > 180 ? `${body.slice(0, 179)}…` : body, url: "ambient://ambient", thread: "ambient", collapseId: "ambient-question" };
}

/** The push when a bot asks: tapping it opens the bot's thread. */
export function botQuestionPush(n: { botId: string; name: string; team: string | null; question: string }): PushMessage {
  const body = n.question.replace(/\s+/g, " ").trim();
  return {
    title: `${n.name} needs you`,
    body: `${n.team ? `${n.team}: ` : ""}${body.length > 180 ? `${body.slice(0, 179)}…` : body}`,
    url: `ambient://routine/${n.botId}?thread=1`,
    thread: "routines",
    collapseId: `bot-question-${n.botId}`,
  };
}
