// Amb on iMessage (docs/bots.md, "iMessage"), through a hosted line from Linq (linqapp.com): the
// person texts the line, Amb answers there, and what Amb says first can go there instead of a push.
// It's the same conversation as in the app (AmbientChat): a text is one more message in it.
//
//   the app or an AI app ──▶ start(uid) ──▶ a code ("AMB-7K2Q9F") and the line's number
//   the person texts the code to the line ──▶ Linq ──▶ POST /v1/hooks/linq (signed)
//        ──▶ the number is theirs now (they hold the phone), linked to their account
//   a text from a linked number ──▶ Amb's chat (via "imessage") ──▶ the answer goes back as a text
//   Amb writes first (channels/reach.ts) ──▶ send(uid) ──▶ a text
//
// The person always writes first: a shared line may only text numbers that texted it, and holding
// the phone is what proves the number is theirs. A number nobody linked gets no answer and no turn.
//
// Kept in the sealed records (no table of its own): each person's link (their number, the chat),
// sealed with their key. Finding the account for a number, or for a code, needs a lookup that
// isn't under one owner: those rows hold only ids, keyed by an HMAC of the number, never the
// number itself.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { api, type Control } from "../control.ts";
import type { MasterKey } from "../crypto.ts";
import type { RoutineKeys } from "../routines/keys.ts";
import { numbered, type AmbChannel, type OutFile, type Question } from "./reach.ts";
import { heicToJpeg, isHeic } from "./heic.ts";
import { AUDIO_BYTES_MAX, isAudio } from "./transcribe.ts";

const LINK = "imessage:link";
const HANDLE = "imessage:handle";
const CODE = "imessage:code";
const POLL = "imessage:poll";
/** A poll's pick settles its decision for this long; an older poll is answered in words. */
const POLL_TTL_MS = 14 * 24 * 60 * 60_000;
const INDEX_OWNER = { ownerKind: "team" as const, ownerId: "_imessage" };
const CODE_TTL_MS = 60 * 60_000;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** A text is cut here; the whole answer is in the app. */
const TEXT_MAX = 3_000;
/** Linq shows "typing" for about 85 s per call; renewed while Amb works, at most this long. */
const TYPING_EVERY_MS = 60_000;
const TYPING_MAX_MS = 10 * 60_000;
/** Wrong codes from one number, per hour, before it's ignored. */
const TRIES_MAX = 5;
const API = "https://api.linqapp.com/api/partner";
/** Linq's answer to a send to someone who asked it to stop (403). */
const OPTED_OUT_CODE = 2024;
/** A line's state and a chat's health are asked from Linq at most this often. */
const HEALTH_TTL_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** What a text may bring Amb, as its chat takes it: up to 4 files, 10 MB together. */
const FILES_MAX = 4;
const FILES_BYTES_MAX = 10 * 1024 * 1024;
/** The kinds Amb can read as they are: pictures Claude takes, PDFs and text. An iPhone's HEIC photo is turned into a JPEG first, a voice memo into text. */
const READABLE = /^(image\/(jpeg|png|gif|webp)|application\/pdf|application\/json|text\/.+)$/;
/**
 * How long Amb waits before it writes first again to someone who hasn't answered what it sent
 * (Linq's back-off: one follow-up after a day, one more after a few days, then nothing until
 * they write). Indexed by how many went unanswered; past the end, it stays quiet.
 */
const WAIT_AFTER_UNANSWERED_MS = [0, 0, DAY_MS, 3 * DAY_MS];

export interface LinqConfig {
  apiKey: string;
  /** The webhook subscription's signing secret (whsec_…). */
  webhookSecret: string;
  /** The line's number (E.164), shown to people so they can text it. Asked from Linq when unset. */
  number?: string;
}

export function loadLinq(env: Record<string, string | undefined>): LinqConfig | undefined {
  const apiKey = env.BRAIN_LINQ_API_KEY?.trim();
  const webhookSecret = env.BRAIN_LINQ_WEBHOOK_SECRET?.trim();
  if (!apiKey && !webhookSecret) return undefined;
  if (!apiKey || !webhookSecret) throw new Error("BRAIN_LINQ_API_KEY and BRAIN_LINQ_WEBHOOK_SECRET go together: set both or neither.");
  const number = env.BRAIN_LINQ_NUMBER?.trim();
  if (number && !/^\+[1-9][0-9]{6,14}$/.test(number)) throw new Error("BRAIN_LINQ_NUMBER must be a phone number like +14155550123.");
  return { apiKey, webhookSecret, ...(number ? { number } : {}) };
}

interface Link {
  /** Their number (E.164) or Apple ID email, as Linq gives it. */
  handle: string;
  /** The Linq chat between them and the line. */
  chatId: string;
  linkedAt: number;
  /** The line the chat is on (E.164), as Linq's webhooks name it. */
  line?: string;
  /** They asked Amb to stop texting (when): nothing goes out until they write again. */
  optedOut?: number;
  /** The chat's health as Linq last reported it (HEALTHY, AT_RISK, CRITICAL, OPTED_OUT). */
  health?: string;
  /** When they last wrote (a text, or a tap on a poll). */
  heardAt?: number;
  /** What Amb wrote first since then, and when it last did: its back-off. */
  unanswered?: number;
  lastFirstAt?: number;
  /** When Amb's contact card was last shared in the chat. */
  cardAt?: number;
}

interface Pending {
  code: string;
  exp: number;
}

/** A decision sent as a poll: which decision, and what each option says. */
interface PollRecord {
  decisionId: string;
  options: { id: string; text: string }[];
  at: number;
}

export interface IMessageStatus {
  connected: boolean;
  /** Their number, mostly hidden ("+43 ••• 4567"). */
  handle: string | null;
  /** The line to text. */
  number: string | null;
  /** A code waiting to be texted. */
  code: string | null;
  expiresAt: number | null;
  /** Opens Messages with the code filled in. */
  link: string | null;
  /** They asked Amb to stop texting them: it writes in the app until they text it again. */
  optedOut: boolean;
}

export class IMessageError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    /** Linq's own error code, when it refused. */
    public linqCode?: number,
  ) {
    super(message);
  }
}

/**
 * Whether a text asks Amb to stop texting. Linq's own keywords as the whole message (it then
 * refuses every send itself, 403 code 2024), and the same wish said in words, which Linq leaves
 * to us. STOP, UNSUBSCRIBE and OPT OUT count in any casing; CANCEL, END and QUIT only in
 * capitals, as Linq matches them: in small letters they're more often an answer to Amb.
 */
export function isOptOut(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (/^(stop|stopp|unsubscribe|opt[\s-]?out)[.!]*$/i.test(t)) return true;
  if (/^(CANCEL|END|QUIT)$/.test(t)) return true;
  return (
    /^(please\s+)?(stop|quit)\s+(texting|messaging|writing(\s+to)?|sending)(\s+me)?(\s+(here|messages?|texts?))*(\s+please)?[.!]*$/i.test(t) ||
    /^(please\s+)?(don'?t|don’t|do not|never)\s+(text|message|write(\s+to)?|contact)\s+me(\s+(again|anymore|any more|here))*(\s+please)?[.!]*$/i.test(t) ||
    /^(please\s+)?(leave me alone|unsubscribe me|no more (texts?|messages?))(\s+please)?[.!]*$/i.test(t) ||
    /^(bitte\s+)?(hör|hoer)\s+auf,?(\s+mir)?\s+zu\s+schreiben[.!]*$/i.test(t) ||
    /^(bitte\s+)?(schreib|schreibe|schreibt)\s+mir\s+(nicht\s+mehr|nie\s+wieder)(\s+bitte)?[.!]*$/i.test(t) ||
    /^(bitte\s+)?keine\s+(nachrichten|sms|texte)\s+mehr(\s+bitte)?[.!]*$/i.test(t)
  );
}

/** What the channel needs of Amb's chat. */
export interface AmbInbox {
  /** Takes the message (and the files sent with it) into Amb's chat; resolves once the answer is stored and sent back. */
  sendQueued(uid: string, name: string, text: string, via: string, attachments?: { name: string; type: string; data: string }[]): Promise<unknown>;
  nameOf(uid: string): Promise<string>;
}

/** Files a decision's answer for the person (DecisionService.answer); throws the server's sentence when it can't. */
export type AnswerDecision = (uid: string, decisionId: string, answer: string) => Promise<void>;

interface LinqEvent {
  event_type?: string;
  event_id?: string;
  data?: {
    id?: string;
    direction?: string;
    chat?: { id?: string; is_group?: boolean; owner_handle?: { handle?: string } | null; health_status?: { status?: string } };
    /** phone_number.status_updated: the line and what it changed to. */
    phone_number?: string;
    new_status?: string;
    new_state?: string;
    new_reputation?: string;
    sender_handle?: { handle?: string; is_me?: boolean };
    parts?: { type?: string; value?: string; url?: string; filename?: string; mime_type?: string; size_bytes?: number }[];
    /** A poll vote: the poll's message and the option picked. */
    message_id?: string;
    option_id?: string;
  };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A number or Apple ID as one spelling: "+43 660 123-4567" and "+436601234567" are the same person. */
export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  return h.includes("@") ? h : h.replace(/[^\d+]/g, "");
}

function mask(handle: string): string {
  if (handle.includes("@")) return handle.replace(/^(.).*(@.*)$/, "$1•••$2");
  return handle.length > 6 ? `${handle.slice(0, 3)} ••• ${handle.slice(-4)}` : "•••";
}

/** Amb's Markdown as a text message: iMessage shows it as written, so the marks come off. */
export function toPlainText(md: string): string {
  return md
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\((ambient:[^)\s]+)\)/g, "$1 (in the Ambient app)")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label}: ${url}`))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^(\s*)[*-]\s+/gm, "$1• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class IMessageChannel implements AmbChannel {
  readonly kind = "imessage";
  /** Event ids seen lately: Linq delivers at least once. */
  private seen = new Map<string, number>();
  private tries = new Map<string, { n: number; at: number }>();
  private line: { number: string; at: number } | undefined;
  /** The lines' states and the chats' health, as Linq last said (asked again after 15 minutes). */
  private lines: { at: number; list: { number: string; paused: boolean; slow: boolean }[] } | undefined;
  private healths = new Map<string, { status: string; at: number }>();
  private pending = new Set<Promise<unknown>>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      master: MasterKey;
      config: LinqConfig;
      inbox: AmbInbox;
      /** Files a pick in a poll as the decision's answer. Without it, polls aren't sent. */
      answer?: AnswerDecision;
      /** Turns a voice memo into what was said (channels/transcribe.ts). Without it, voice memos aren't taken. */
      transcribe?: (bytes: Buffer, type: string) => Promise<string>;
      /** They asked Amb to stop texting: where it writes first goes back to the app. */
      onOptOut?: (uid: string) => Promise<void> | void;
      fetchImpl?: typeof fetch;
      /** Linq's API (tests: a stand-in). */
      apiBase?: string;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Tests: everything a webhook started has finished. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((err: Error) => console.warn(`[imessage] ${err.message}`)).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  // ---- records ----

  private async get<T>(uid: string, kind: string, key = "it"): Promise<T | null> {
    const r = (await this.d.control.q(api.records.get, { ownerKind: "user", ownerId: uid, kind, key })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    const raw = await this.d.keys.open({ kind: "user", uid }, `record:${kind}`, r.iv, r.ct).catch(() => null);
    try {
      return raw ? (JSON.parse((JSON.parse(raw) as { c: string }).c) as T) : null;
    } catch {
      return null;
    }
  }

  private async put(uid: string, kind: string, value: unknown, deleted = false, key = "it"): Promise<void> {
    const content = JSON.stringify(value);
    const sealed = await this.d.keys.seal({ kind: "user", uid }, `record:${kind}`, JSON.stringify({ c: content }));
    await this.d.control.m(api.records.put, { ownerKind: "user", ownerId: uid, kind, key, iv: sealed.iv, ct: sealed.ciphertext, size: content.length, byKind: "user", ...(deleted ? { deleted: true } : {}), keep: 1, now: this.now() });
  }

  /** The key a number or a code is looked up by: an HMAC, so the rows hold no numbers. */
  private indexKey(what: string, value: string): string {
    return createHmac("sha256", this.d.master.key).update(`ambient:imessage:${what}:${value}`).digest("hex").slice(0, 40);
  }

  private async index(kind: string, key: string): Promise<{ u: string; exp?: number } | null> {
    const r = (await this.d.control.q(api.records.get, { ...INDEX_OWNER, kind, key })) as { ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    try {
      const o = JSON.parse(Buffer.from(r.ct, "base64url").toString("utf8")) as { u?: string; exp?: number };
      return o.u ? { u: o.u, ...(o.exp ? { exp: o.exp } : {}) } : null;
    } catch {
      return null;
    }
  }

  private async setIndex(kind: string, key: string, value: { u: string; exp?: number } | null): Promise<void> {
    const ct = value ? b64url(JSON.stringify(value)) : "-";
    await this.d.control.m(api.records.put, { ...INDEX_OWNER, kind, key, iv: "-", ct, size: ct.length, byKind: "user", ...(value ? {} : { deleted: true }), keep: 1, now: this.now() });
  }

  // ---- connecting ----

  async linked(uid: string): Promise<boolean> {
    return (await this.get<Link>(uid, LINK)) !== null;
  }

  /** The line people text: the configured one, or the one Linq gives this account. */
  async number(): Promise<string | null> {
    if (this.d.config.number) return this.d.config.number;
    if (this.line && this.now() - this.line.at < 10 * 60_000) return this.line.number;
    const out = await this.call<{ phone_number?: string }>("GET", "/v3/available_number").catch(() => null);
    if (!out?.json.phone_number) return this.line?.number ?? null;
    this.line = { number: out.json.phone_number, at: this.now() };
    return this.line.number;
  }

  async status(uid: string): Promise<IMessageStatus> {
    const [link, pending, number] = await Promise.all([this.get<Link>(uid, LINK), this.get<Pending>(uid, CODE), this.number()]);
    const code = !link && pending && pending.exp > this.now() ? pending : null;
    return {
      connected: !!link,
      handle: link ? mask(link.handle) : null,
      number,
      code: code?.code ?? null,
      expiresAt: code?.exp ?? null,
      link: code && number ? `sms:${number}&body=${encodeURIComponent(code.code)}` : null,
      optedOut: !!link?.optedOut,
    };
  }

  /** A code to text to the line (good for an hour); the one still waiting, when there is one. */
  async start(uid: string): Promise<IMessageStatus> {
    if (await this.linked(uid)) return this.status(uid);
    const before = await this.get<Pending>(uid, CODE);
    if (!before || before.exp - this.now() < 10 * 60_000) {
      if (before) await this.setIndex(CODE, this.indexKey("code", before.code), null);
      const code = `AMB-${Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("")}`;
      const exp = this.now() + CODE_TTL_MS;
      await this.put(uid, CODE, { code, exp } satisfies Pending);
      await this.setIndex(CODE, this.indexKey("code", code), { u: uid, exp });
    }
    return this.status(uid);
  }

  async disconnect(uid: string): Promise<void> {
    const link = await this.get<Link>(uid, LINK);
    if (link) {
      await this.setIndex(HANDLE, this.indexKey("handle", link.handle), null);
      await this.put(uid, LINK, {}, true);
    }
    const pending = await this.get<Pending>(uid, CODE);
    if (pending) {
      await this.setIndex(CODE, this.indexKey("code", pending.code), null);
      await this.put(uid, CODE, {}, true);
    }
  }

  // ---- Linq ----

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await (this.d.fetchImpl ?? fetch)(`${this.d.apiBase ?? API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.d.config.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json = {} as T & { error?: { code?: number; message?: string } };
    try {
      if (text) json = JSON.parse(text) as typeof json;
    } catch {
      // Not JSON: the status says enough.
    }
    if (!res.ok) throw new IMessageError("linq_refused", `Linq answered ${res.status}${json.error?.code ? ` (${json.error.code})` : ""}${json.error?.message ? `: ${json.error.message}` : ""}`, 502, json.error?.code);
    return { status: res.status, json };
  }

  private static parts(text: string): { type: "text"; value: string }[] {
    const plain = toPlainText(text);
    const value = plain.length > TEXT_MAX ? `${plain.slice(0, TEXT_MAX).trimEnd()}…\n\n(The rest is in the Ambient app.)` : plain;
    return value ? [{ type: "text", value }] : [];
  }

  /** A text into a chat. `overrideOptout`: the one confirmation after someone asked Amb to stop. */
  private async text(chatId: string, text: string, opts: { overrideOptout?: boolean } = {}): Promise<void> {
    const parts = IMessageChannel.parts(text);
    if (!parts.length) return;
    await this.call("POST", `/v3/chats/${encodeURIComponent(chatId)}/messages`, { message: { parts }, ...(opts.overrideOptout ? { override_optout: true } : {}) });
  }

  // ---- when Amb may text (Linq's best practices: opt-out, chat health, line reputation, back-off) ----

  /** The lines as Linq sees them now: one that's flagged or not delivering is paused, one with warning signs slow. */
  private async lineStates(): Promise<{ number: string; paused: boolean; slow: boolean }[]> {
    if (this.lines && this.now() - this.lines.at < HEALTH_TTL_MS) return this.lines.list;
    const out = await this.call<{ phone_numbers?: { phone_number?: string; line_status?: string; status?: string; reputation?: { state?: string; status?: string } }[] }>("GET", "/v3/phone_numbers").catch(() => null);
    // Not known right now: what was known stays, and nothing is held back for it.
    if (!out) return this.lines?.list ?? [];
    const list = (out.json.phone_numbers ?? []).flatMap((n) => {
      if (!n.phone_number) return [];
      const flagged = (n.line_status ?? n.status) === "FLAGGED";
      const paused = flagged || n.reputation?.state === "DELIVERY_LIMITED" || n.reputation?.status === "CRITICAL";
      const slow = n.reputation?.state === "NEEDS_ATTENTION" || n.reputation?.status === "AT_RISK";
      return [{ number: n.phone_number, paused, slow }];
    });
    this.lines = { at: this.now(), list };
    return list;
  }

  /** The state of the line a chat is on (the only line's, when the chat's isn't known). */
  private async lineOf(link: Link): Promise<{ paused: boolean; slow: boolean }> {
    const list = await this.lineStates();
    const own = list.find((l) => l.number === link.line) ?? (list.length === 1 ? list[0] : undefined);
    return own ?? { paused: false, slow: false };
  }

  /** The chat's health as Linq has it now (every chat read carries it), else as last heard. */
  private async healthOf(link: Link): Promise<string | undefined> {
    const known = this.healths.get(link.chatId);
    if (known && this.now() - known.at < HEALTH_TTL_MS) return known.status;
    const out = await this.call<{ health_status?: { status?: string }; chat?: { health_status?: { status?: string } } }>("GET", `/v3/chats/${encodeURIComponent(link.chatId)}`).catch(() => null);
    const status = out?.json.health_status?.status ?? out?.json.chat?.health_status?.status;
    if (!status) return link.health;
    this.healths.set(link.chatId, { status, at: this.now() });
    return status;
  }

  /**
   * Whether Amb may write first to this person now; throws with the reason when it may not (the
   * push goes instead: channels/reach.ts). An answer to what they just wrote isn't held back by
   * any of this, only by an opt-out.
   */
  private async mayWriteFirst(uid: string, link: Link): Promise<void> {
    const held = (why: string) => new IMessageError("held_back", why, 409);
    const line = await this.lineOf(link);
    if (line.paused) throw held("the line is flagged or not delivering");
    const health = await this.healthOf(link);
    if (health === "OPTED_OUT") {
      await this.optOut(uid, link);
      throw new IMessageError("opted_out", "they asked not to be texted", 403);
    }
    if (health === "CRITICAL") throw held("the chat's health is critical");
    const unanswered = link.unanswered ?? 0;
    const since = this.now() - (link.lastFirstAt ?? 0);
    const wait = WAIT_AFTER_UNANSWERED_MS[unanswered];
    if (wait === undefined) throw held(`${unanswered} messages went unanswered`);
    if (since < wait) throw held(`${unanswered} messages went unanswered; waiting before the next`);
    // Warning signs on the chat or its line: one message a day at most until they write.
    if ((health === "AT_RISK" || line.slow) && unanswered >= 1 && since < DAY_MS) throw held("the chat or its line is at risk; one a day");
  }

  /** They asked Amb to stop: remembered, and where it writes first goes back to the app. */
  private async optOut(uid: string, link: Link): Promise<void> {
    if (!link.optedOut) await this.put(uid, LINK, { ...link, optedOut: this.now(), health: "OPTED_OUT" } satisfies Link);
    this.healths.delete(link.chatId);
    await Promise.resolve(this.d.onOptOut?.(uid)).catch(() => undefined);
  }

  /** The link, when Amb may text there: connected, and not asked to stop. */
  private async sendable(uid: string, first: boolean): Promise<Link> {
    const link = await this.get<Link>(uid, LINK);
    if (!link) throw new IMessageError("not_connected", "iMessage isn't connected.", 400);
    if (link.optedOut) throw new IMessageError("opted_out", "they asked not to be texted", 403);
    if (first) await this.mayWriteFirst(uid, link);
    return link;
  }

  /**
   * Sends Amb's text. What it writes first goes to the person, not to a chat (POST /v3/messages
   * with `to` and no `from`): Linq picks the line, reuses their chat while its line is healthy and
   * moves off a flagged one by itself. An answer goes into the chat they wrote in. A send Linq
   * refuses because they opted out (2024) is remembered and never tried again.
   */
  private async out(uid: string, link: Link, text: string, first: boolean, files: OutFile[] = []): Promise<Link> {
    let next = link;
    try {
      const parts: Record<string, unknown>[] = IMessageChannel.parts(text);
      // What Amb made goes with its words, as iMessage shows files; one that can't be sent is named instead.
      const missed: string[] = [];
      for (const file of files.slice(0, FILES_MAX)) {
        const id = await this.upload(file).catch((err: Error) => (console.warn(`[imessage] ${file.name} wasn't sent: ${err.message}`), null));
        if (id) parts.push({ type: "media", attachment_id: id });
        else missed.push(file.name);
      }
      if (missed.length) {
        const note = `(${missed.join(", ")}: in the Ambient app.)`;
        const first = parts[0];
        if (first && first.type === "text") first.value = `${String(first.value)}\n\n${note}`;
        else parts.unshift({ type: "text", value: note });
      }
      if (parts.length && first) {
        const out = await this.call<{ chat_id?: string }>("POST", "/v3/messages", { to: [link.handle], message: { parts } });
        if (out.json.chat_id && out.json.chat_id !== link.chatId) next = { ...next, chatId: out.json.chat_id };
      } else if (parts.length) {
        await this.call("POST", `/v3/chats/${encodeURIComponent(link.chatId)}/messages`, { message: { parts } });
      }
    } catch (err) {
      if (err instanceof IMessageError && err.linqCode === OPTED_OUT_CODE) await this.optOut(uid, link);
      throw err;
    }
    const now = this.now();
    if (first) next = { ...next, unanswered: (link.unanswered ?? 0) + 1, lastFirstAt: now };
    // Its contact card again, about once a day: there's no telling whether they saved it.
    if (now - (link.cardAt ?? 0) > DAY_MS) {
      await this.call("POST", `/v3/chats/${encodeURIComponent(next.chatId)}/share_contact_card`).catch(() => undefined);
      next = { ...next, cardAt: now };
    }
    if (next !== link) await this.put(uid, LINK, next satisfies Link);
    return next;
  }

  /** Amb's text to a person who connected iMessage. `first`: Amb writes first (not an answer). */
  async send(uid: string, text: string, opts: { first?: boolean; files?: OutFile[] } = {}): Promise<void> {
    const first = opts.first === true;
    await this.out(uid, await this.sendable(uid, first), text, first, opts.files ?? []);
  }

  /** A file to Linq (its upload URL, then the bytes), for a media part: the id to send it by. */
  private async upload(file: OutFile): Promise<string> {
    const out = await this.call<{ attachment_id?: string; upload_url?: string; http_method?: string; required_headers?: Record<string, string> }>("POST", "/v3/attachments", {
      filename: file.name.slice(0, 255),
      content_type: file.type,
      size_bytes: file.bytes.length,
    });
    if (!out.json.attachment_id || !out.json.upload_url) throw new Error("Linq gave no upload URL");
    const res = await (this.d.fetchImpl ?? fetch)(out.json.upload_url, {
      method: out.json.http_method ?? "PUT",
      headers: out.json.required_headers ?? { "content-type": file.type },
      body: new Uint8Array(file.bytes),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`the upload answered ${res.status}`);
    return out.json.attachment_id;
  }

  private async download(url: string, max: number): Promise<Buffer> {
    const res = await (this.d.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > max) throw new Error("too large");
    return body;
  }

  /**
   * What a text brought, as Amb's chat takes it. Files are fetched from Linq's links (good for an
   * hour): the kinds Amb reads as they are, an iPhone's HEIC photo as a JPEG, up to 4 and 10 MB
   * together. A voice memo becomes what was said (`said`), when a transcriber is set up.
   * `skipped` names what couldn't be taken.
   */
  private async fetchFiles(media: { url?: string; filename?: string; mime_type?: string; size_bytes?: number }[]): Promise<{ files: { name: string; type: string; data: string }[]; said: string[]; skipped: string[] }> {
    const files: { name: string; type: string; data: string }[] = [];
    const said: string[] = [];
    const skipped: string[] = [];
    let bytes = 0;
    for (const m of media) {
      const name = (m.filename ?? "file").replace(/[\/\\\0\r\n]/g, "_").slice(0, 200);
      const type = (m.mime_type ?? "").toLowerCase().split(";")[0]!.trim();
      // Linq's links are https (tests: the stand-in's own address).
      const url = m.url && (m.url.startsWith("https://") || (!!this.d.apiBase && m.url.startsWith(this.d.apiBase))) ? m.url : null;
      const audio = isAudio(type, name);
      const heic = isHeic(type, name);
      try {
        if (!url) throw new Error("no link");
        if (audio) {
          if (!this.d.transcribe) throw new Error("no transcriber");
          const text = await this.d.transcribe(await this.download(url, AUDIO_BYTES_MAX), type);
          if (!text) throw new Error("nothing made out");
          said.push(text);
          continue;
        }
        if ((!heic && !READABLE.test(type)) || files.length >= FILES_MAX) throw new Error("not a kind Amb reads");
        let body = await this.download(url, 2 * FILES_BYTES_MAX);
        if (heic) body = await heicToJpeg(body);
        if (bytes + body.length > FILES_BYTES_MAX) throw new Error("too large");
        bytes += body.length;
        files.push(heic ? { name: name.replace(/\.hei[cf]$/i, "") + ".jpg", type: "image/jpeg", data: body.toString("base64") } : { name, type, data: body.toString("base64") });
      } catch (err) {
        console.warn(`[imessage] a file wasn't taken: ${(err as Error).message}`);
        skipped.push(audio ? "the voice memo" : name);
      }
    }
    return { files, said, skipped };
  }

  /**
   * A decision as iMessage asks it: the question as a text, then a poll with its answers; a tap on
   * one settles the decision (onVote). When the poll can't be sent (the chat fell back to SMS, the
   * line doesn't do polls), the answers go as numbered text instead, so the question is never lost.
   */
  async ask(uid: string, text: string, question: Question, opts: { first?: boolean } = {}): Promise<void> {
    const first = opts.first === true;
    const before = await this.sendable(uid, first);
    if (!this.d.answer) {
      await this.out(uid, before, `${text}${numbered(question.choices)}`, first);
      return;
    }
    const link = await this.out(uid, before, text, first);
    try {
      const out = await this.call<{ message_id?: string; poll?: { options?: { option_id?: string; text?: string }[] } }>("POST", `/v3/chats/${encodeURIComponent(link.chatId)}/polls`, {
        poll: { options: question.choices.map((c) => ({ text: c.slice(0, 200) })), idempotency_key: `decision-${question.decisionId}` },
      });
      const options = (out.json.poll?.options ?? []).flatMap((o) => (o.option_id && o.text ? [{ id: o.option_id, text: o.text }] : []));
      if (!out.json.message_id || options.length < 2) throw new Error("Linq sent no poll back");
      await this.put(uid, POLL, { decisionId: question.decisionId, options, at: this.now() } satisfies PollRecord, false, out.json.message_id);
    } catch (err) {
      console.warn(`[imessage] a poll didn't go out, sent as text: ${(err as Error).message}`);
      await this.text(link.chatId, numbered(question.choices).trim());
    }
  }

  /** They wrote (a text, or a tap): what Amb sent is answered, an opt-out is over, the chat's health is as Linq says. */
  private async heard(uid: string, link: Link, seen: { chatId: string; health?: string; line?: string }): Promise<Link> {
    const { optedOut: _over, ...rest } = link;
    const next: Link = { ...rest, chatId: seen.chatId, heardAt: this.now(), unanswered: 0, ...(seen.health ? { health: seen.health } : {}), ...(seen.line ? { line: seen.line } : {}) };
    if (seen.health) this.healths.set(seen.chatId, { status: seen.health, at: this.now() });
    await this.put(uid, LINK, next satisfies Link);
    return next;
  }

  /** A tap on a poll's option: the decision's answer, when it's the person's own poll and still open. */
  private async onVote(handle: string, chatId: string, messageId: string, optionId: string, seen: { health?: string; line?: string } = {}): Promise<void> {
    const known = await this.index(HANDLE, this.indexKey("handle", handle));
    if (!known || !this.d.answer) return;
    const uid = known.u;
    const link = await this.get<Link>(uid, LINK);
    if (!link || link.handle !== handle) return;
    await this.heard(uid, link, { chatId, ...seen });
    const poll = await this.get<PollRecord>(uid, POLL, messageId);
    const option = poll?.options.find((o) => o.id === optionId);
    if (!poll || !option || this.now() - poll.at > POLL_TTL_MS) return;
    try {
      await this.d.answer(uid, poll.decisionId, option.text);
      await this.text(chatId, `Got it: ${option.text}.`);
    } catch (err) {
      // Already answered elsewhere (the app, the bot's thread), or gone: said once, in the server's words.
      await this.text(chatId, (err as Error).message || "That one's already answered.");
    }
  }

  // ---- what Linq sends ----

  /** Standard Webhooks: HMAC-SHA256 over "<id>.<timestamp>.<body>" with the secret's bytes, base64. */
  private signed(h: { id?: string; timestamp?: string; signature?: string }, raw: Buffer): boolean {
    const ts = Number(h.timestamp);
    if (!h.id || !h.signature || !Number.isFinite(ts) || Math.abs(this.now() / 1000 - ts) > 5 * 60) return false;
    const secret = this.d.config.webhookSecret;
    const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
    const want = createHmac("sha256", key).update(`${h.id}.${h.timestamp}.`).update(raw).digest();
    return h.signature.split(" ").some((part) => {
      const [version, value] = part.split(",");
      if (version !== "v1" || !value) return false;
      const got = Buffer.from(value, "base64");
      return got.length === want.length && timingSafeEqual(got, want);
    });
  }

  async receive(headers: { id?: string; timestamp?: string; signature?: string }, raw: Buffer): Promise<{ status: number; body: unknown }> {
    if (!this.signed(headers, raw)) return { status: 401, body: { error: "bad_signature" } };
    let event: LinqEvent;
    try {
      event = JSON.parse(raw.toString("utf8")) as LinqEvent;
    } catch {
      return { status: 400, body: { error: "bad_request" } };
    }
    const m = event.data;
    // A line's state changed (flagged, at risk, recovered): asked afresh before Amb next writes first.
    if (event.event_type === "phone_number.status_updated") {
      this.lines = undefined;
      console.warn(`[imessage] line ${m?.phone_number ?? "?"} is now ${m?.new_status ?? "?"}, ${m?.new_state ?? m?.new_reputation ?? "?"}`);
      return { status: 200, body: { ok: true } };
    }
    const handle = m?.sender_handle?.handle;
    const chatId = m?.chat?.id;
    const seen = { ...(m?.chat?.health_status?.status ? { health: m.chat.health_status.status } : {}), ...(m?.chat?.owner_handle?.handle ? { line: m.chat.owner_handle.handle } : {}) };
    // A tap on a poll Amb sent: the decision's answer.
    if (event.event_type === "poll.vote.added") {
      if (!m || !handle || !chatId || !m.message_id || !m.option_id || m.sender_handle?.is_me || m.chat?.is_group) return { status: 200, body: { ok: true } };
      const voteId = event.event_id ?? headers.id!;
      if (this.seen.has(voteId)) return { status: 200, body: { ok: true } };
      this.seen.set(voteId, this.now());
      this.track(this.onVote(normalizeHandle(handle), chatId, m.message_id, m.option_id, seen));
      return { status: 200, body: { ok: true } };
    }
    // Only a person's own text in a chat with the line: no groups, nothing the line sent itself.
    if (event.event_type !== "message.received" || !m || !handle || !chatId || m.sender_handle?.is_me || m.direction === "outbound" || m.chat?.is_group) return { status: 200, body: { ok: true } };
    const id = m.id ?? event.event_id ?? headers.id!;
    const now = this.now();
    for (const [k, at] of this.seen) if (now - at > 60 * 60_000) this.seen.delete(k);
    if (this.seen.has(id)) return { status: 200, body: { ok: true } };
    this.seen.set(id, now);
    const parts = m.parts ?? [];
    const text = parts
      .filter((p) => p.type === "text" && typeof p.value === "string")
      .map((p) => p.value!.trim())
      .filter(Boolean)
      .join("\n");
    const from = normalizeHandle(handle);
    if (this.struckOut(from)) return { status: 200, body: { ok: true } };
    this.track(this.onText(from, chatId, text, parts.filter((p) => p.type === "media"), seen));
    return { status: 200, body: { ok: true } };
  }

  private async onText(handle: string, chatId: string, text: string, media: { url?: string; filename?: string; mime_type?: string; size_bytes?: number }[], seen: { health?: string; line?: string } = {}): Promise<void> {
    const known = await this.index(HANDLE, this.indexKey("handle", handle));
    // A code someone is waiting with: the number becomes theirs (and stops being anyone else's).
    const claim = await this.claim(text);
    if (claim && claim.uid !== known?.u) {
      if (known) await this.disconnect(known.u);
      return this.link(claim.uid, claim.code, handle, chatId, seen.line);
    }
    if (!known) return this.strike(handle);
    const uid = known.u;
    const link = await this.get<Link>(uid, LINK);
    // The lookup outlived the link (disconnected in between): not theirs anymore.
    if (!link || link.handle !== handle) return;
    // "Stop": no turn for Amb and nothing more by text. One line says so and how to come back
    // (Linq refuses everything else to them from here; this one send carries the override).
    if (isOptOut(text)) {
      const already = !!link.optedOut;
      await this.optOut(uid, { ...link, chatId });
      if (!already) await this.text(chatId, "Okay, I won't text you here anymore. Write to me here any time and I'll answer again.", { overrideOptout: true }).catch(() => undefined);
      return;
    }
    await this.heard(uid, link, { chatId, ...seen });
    // Photos, PDFs and text files come along; what Amb can't read here is said, not dropped silently.
    // A voice memo is what was said: it joins what was typed, as their message.
    const { files, said, skipped } = media.length ? await this.fetchFiles(media) : { files: [], said: [], skipped: [] };
    const message = [text, ...said].filter(Boolean).join("\n\n");
    if (!message && !files.length) {
      if (skipped.length) await this.text(chatId, skipped.every((n) => n === "the voice memo") ? (this.d.transcribe ? "I couldn't take that voice memo here. Type it, or send it again in a minute." : "I can't listen to voice memos yet. Type it and I'll answer.") : "I can't open that here. I read photos, PDFs, text files and voice memos; for anything else, send it to me in the Ambient app.");
      return;
    }
    void this.call("POST", `/v3/chats/${encodeURIComponent(chatId)}/read`).catch(() => undefined);
    const stopTyping = this.typing(chatId);
    // Some came through and some didn't: said at once, so they know what Amb is answering about.
    if (skipped.length) await this.text(chatId, `I can't open ${skipped.join(", ")} here (I read photos, PDFs, text files and voice memos). The Ambient app takes it.`).catch(() => undefined);
    try {
      await this.d.inbox.sendQueued(uid, await this.d.inbox.nameOf(uid), message, this.kind, files);
    } finally {
      stopTyping();
    }
  }

  /** "Typing…" while Amb works on it. Best effort: Linq shows it only in a chat that's been active. */
  private typing(chatId: string): () => void {
    const start = this.now();
    const path = `/v3/chats/${encodeURIComponent(chatId)}/typing`;
    const show = () => void this.call("POST", path).catch(() => undefined);
    show();
    const timer = setInterval(() => (this.now() - start > TYPING_MAX_MS ? clearInterval(timer) : show()), TYPING_EVERY_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** The account whose waiting code this text carries, if it does. */
  private async claim(text: string): Promise<{ uid: string; code: string } | null> {
    const m = /\bAMB[-\s]?([A-Z0-9]{6})\b/i.exec(text)?.[1]?.toUpperCase();
    if (!m) return null;
    const code = `AMB-${m}`;
    const found = await this.index(CODE, this.indexKey("code", code));
    const pending = found ? await this.get<Pending>(found.u, CODE) : null;
    return found && pending && pending.code === code && pending.exp >= this.now() ? { uid: found.u, code } : null;
  }

  /**
   * A number nobody linked, without a code someone waits with: counted, never answered (a wrong
   * number gets no reply from a line it doesn't know), and ignored after a few.
   */
  private strike(handle: string): void {
    const now = this.now();
    const t = this.tries.get(handle);
    this.tries.set(handle, t && now - t.at < 60 * 60_000 ? { n: t.n + 1, at: t.at } : { n: 1, at: now });
  }

  private struckOut(handle: string): boolean {
    const t = this.tries.get(handle);
    return !!t && this.now() - t.at < 60 * 60_000 && t.n >= TRIES_MAX;
  }

  private async link(uid: string, code: string, handle: string, chatId: string, line?: string): Promise<void> {
    const now = this.now();
    // They wrote first, and the card is shared right below (after Amb's first text, as Linq asks).
    await this.put(uid, LINK, { handle, chatId, linkedAt: now, heardAt: now, unanswered: 0, cardAt: now, ...(line ? { line } : {}) } satisfies Link);
    await this.setIndex(HANDLE, this.indexKey("handle", handle), { u: uid });
    await this.setIndex(CODE, this.indexKey("code", code), null);
    await this.put(uid, CODE, {}, true);
    this.tries.delete(handle);
    const name = await this.d.inbox.nameOf(uid).catch(() => "");
    await this.text(chatId, `You're connected${name && name !== "them" ? `, ${name.split(" ")[0]}` : ""}. Write to me here like in the app: it's one conversation.`);    // Its contact card, so the thread shows Ambient's name and picture instead of a number. Only
    // when the line has one set up at Linq (404 otherwise): nothing depends on it.
    await this.call("POST", `/v3/chats/${encodeURIComponent(chatId)}/share_contact_card`).catch(() => undefined);
  }
}
