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
import { numbered, type AmbChannel, type Question } from "./reach.ts";

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
}

export class IMessageError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** What the channel needs of Amb's chat. */
export interface AmbInbox {
  /** Takes the message into Amb's chat; resolves once the answer is stored and sent back. */
  sendQueued(uid: string, name: string, text: string, via: string): Promise<unknown>;
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
    chat?: { id?: string; is_group?: boolean; owner_handle?: { handle?: string } };
    sender_handle?: { handle?: string; is_me?: boolean };
    parts?: { type?: string; value?: string }[];
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
    if (!res.ok) throw new IMessageError("linq_refused", `Linq answered ${res.status}${json.error?.code ? ` (${json.error.code})` : ""}${json.error?.message ? `: ${json.error.message}` : ""}`, 502);
    return { status: res.status, json };
  }

  private async text(chatId: string, text: string): Promise<void> {
    const plain = toPlainText(text);
    const value = plain.length > TEXT_MAX ? `${plain.slice(0, TEXT_MAX).trimEnd()}…\n\n(The rest is in the Ambient app.)` : plain;
    if (!value) return;
    await this.call("POST", `/v3/chats/${encodeURIComponent(chatId)}/messages`, { message: { parts: [{ type: "text", value }] } });
  }

  /** Amb's text to a person who connected iMessage. */
  async send(uid: string, text: string): Promise<void> {
    const link = await this.get<Link>(uid, LINK);
    if (!link) throw new IMessageError("not_connected", "iMessage isn't connected.", 400);
    await this.text(link.chatId, text);
  }

  /**
   * A decision as iMessage asks it: the question as a text, then a poll with its answers; a tap on
   * one settles the decision (onVote). When the poll can't be sent (the chat fell back to SMS, the
   * line doesn't do polls), the answers go as numbered text instead, so the question is never lost.
   */
  async ask(uid: string, text: string, question: Question): Promise<void> {
    const link = await this.get<Link>(uid, LINK);
    if (!link) throw new IMessageError("not_connected", "iMessage isn't connected.", 400);
    if (!this.d.answer) return this.text(link.chatId, `${text}${numbered(question.choices)}`);
    await this.text(link.chatId, text);
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

  /** A tap on a poll's option: the decision's answer, when it's the person's own poll and still open. */
  private async onVote(handle: string, chatId: string, messageId: string, optionId: string): Promise<void> {
    const known = await this.index(HANDLE, this.indexKey("handle", handle));
    if (!known || !this.d.answer) return;
    const uid = known.u;
    const link = await this.get<Link>(uid, LINK);
    if (!link || link.handle !== handle) return;
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
    const handle = m?.sender_handle?.handle;
    const chatId = m?.chat?.id;
    // A tap on a poll Amb sent: the decision's answer.
    if (event.event_type === "poll.vote.added") {
      if (!m || !handle || !chatId || !m.message_id || !m.option_id || m.sender_handle?.is_me || m.chat?.is_group) return { status: 200, body: { ok: true } };
      const voteId = event.event_id ?? headers.id!;
      if (this.seen.has(voteId)) return { status: 200, body: { ok: true } };
      this.seen.set(voteId, this.now());
      this.track(this.onVote(normalizeHandle(handle), chatId, m.message_id, m.option_id));
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
    this.track(this.onText(from, chatId, text, parts.some((p) => p.type !== "text")));
    return { status: 200, body: { ok: true } };
  }

  private async onText(handle: string, chatId: string, text: string, files: boolean): Promise<void> {
    const known = await this.index(HANDLE, this.indexKey("handle", handle));
    // A code someone is waiting with: the number becomes theirs (and stops being anyone else's).
    const claim = await this.claim(text);
    if (claim && claim.uid !== known?.u) {
      if (known) await this.disconnect(known.u);
      return this.link(claim.uid, claim.code, handle, chatId);
    }
    if (!known) return this.strike(handle);
    const uid = known.u;
    const link = await this.get<Link>(uid, LINK);
    // The lookup outlived the link (disconnected in between): not theirs anymore.
    if (!link || link.handle !== handle) return;
    if (link.chatId !== chatId) await this.put(uid, LINK, { ...link, chatId } satisfies Link);
    if (!text) {
      if (files) await this.text(chatId, "I can only read text here so far. Send it to me in the Ambient app and I'll look at it.");
      return;
    }
    void this.call("POST", `/v3/chats/${encodeURIComponent(chatId)}/read`).catch(() => undefined);
    const stopTyping = this.typing(chatId);
    try {
      await this.d.inbox.sendQueued(uid, await this.d.inbox.nameOf(uid), text, this.kind);
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

  private async link(uid: string, code: string, handle: string, chatId: string): Promise<void> {
    await this.put(uid, LINK, { handle, chatId, linkedAt: this.now() } satisfies Link);
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
