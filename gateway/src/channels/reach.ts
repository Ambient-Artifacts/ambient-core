// Where Amb's own words go besides the app's chat (docs/bots.md, "Channels"). Amb has one
// conversation with a person, kept in the app; a channel (iMessage first) is another door to it.
// Two rules, both decided here in code, never by the model:
//
//   an answer goes back through the door the message came in by, and nowhere else;
//   what Amb says first (the heartbeat, a decision, an automation) goes to the one place the
//   person chose ("reach" in Amb's settings): that channel, or the app's push. Never both.
//
// When the chosen channel can't take it (not connected anymore, the provider refuses), the push
// goes out instead, so nothing is lost. While the person has Amb's chat open in the app, they see
// it there and the channel stays quiet.
import type { Notifier, PushMessage } from "../push.ts";

/** A way to reach a person outside the app, as Amb. */
export interface AmbChannel {
  readonly kind: string;
  /** Whether this person connected it. */
  linked(uid: string): Promise<boolean>;
  /** Sends Amb's text there (in the channel's own form). Throws when it can't. */
  send(uid: string, text: string): Promise<void>;
}

/** The app was used this recently: Amb's chat is likely on screen. */
const APP_ACTIVE_MS = 90_000;

export class AmbReach {
  private channels = new Map<string, AmbChannel>();
  private appSeen = new Map<string, number>();

  constructor(
    private d: {
      notifier?: Notifier;
      /** The person's choice ("app", or a channel's kind). */
      reachOf: (uid: string) => Promise<string>;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  add(channel: AmbChannel): void {
    this.channels.set(channel.kind, channel);
  }

  /** The channels a person can pick (connected ones), for the settings. */
  kinds(): string[] {
    return [...this.channels.keys()];
  }

  async linked(uid: string, kind: string): Promise<boolean> {
    return (await this.channels.get(kind)?.linked(uid).catch(() => false)) ?? false;
  }

  /** The person has Amb's chat open in the app right now (the app asked for it). */
  appActive(uid: string): void {
    this.appSeen.set(uid, this.now());
  }

  private inApp(uid: string): boolean {
    const at = this.appSeen.get(uid);
    return at !== undefined && this.now() - at < APP_ACTIVE_MS;
  }

  /** Amb's answer to a message written in a channel: back there. Never throws. */
  async reply(uid: string, via: string, text: string): Promise<void> {
    const channel = this.channels.get(via);
    if (!channel || !text.trim()) return;
    await channel.send(uid, text).catch((err: Error) => console.warn(`[reach] an answer didn't go out on ${via}: ${err.message}`));
  }

  /**
   * Amb writes first (it's already in the chat): one place hears of it. Returns where it went:
   * the channel's kind, "app" (a push), or "none" (no push service and no channel).
   */
  async tell(uid: string, text: string, push: PushMessage): Promise<string> {
    const want = await this.d.reachOf(uid).catch(() => "app");
    const channel = want !== "app" && !this.inApp(uid) ? this.channels.get(want) : undefined;
    if (channel && (await channel.linked(uid).catch(() => false))) {
      try {
        await channel.send(uid, text);
        return channel.kind;
      } catch (err) {
        console.warn(`[reach] ${want} didn't take it, sent as a push: ${(err as Error).message}`);
      }
    }
    if (!this.d.notifier) return "none";
    await this.d.notifier.notify(uid, push).catch(() => undefined);
    return "app";
  }
}
