// History (docs/bots.md, "History: nothing is forgotten"): Amb's chat and every bot's thread are
// kept in full, sealed. search_history finds what was said, by words and dates: for a person (Amb,
// an AI app) over their chat, the threads of the bots they see and those bots' handoffs; for a
// bot's run over its own thread and handoffs. The gateway opens the messages to search them, a
// page at a time; nothing is stored unsealed and there's no index to keep in step.
import { api, type Control } from "../control.ts";
import { sha256Hex } from "../crypto.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { RoutineError, RUN_TOKEN_PREFIX, type Actor, type RoutineService } from "../routines/service.ts";
import type { BotFolder } from "./folder.ts";
import { CHAT_PURPOSE, openMessage } from "./messages.ts";

export interface HistoryHit {
  /** Milliseconds since 1970. */
  at: number;
  who: string;
  /** "chat", or which bot's thread or handoffs. */
  where: string;
  text: string;
}

export interface HistoryQuery {
  q?: string;
  from?: string;
  to?: string;
  /** Only this bot's thread and handoffs. */
  bot?: string;
  limit?: number;
}

const PAGE = 500;
/** How far back a search looks at most, in messages: the chat, and each bot's thread. */
const CHAT_PAGES = 20;
const THREAD_PAGES = 6;
const SNIPPET = 240;

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase();

/** A date (whole day) or a moment, as milliseconds; `end`: a bare date means its end. */
export function parseWhen(s: string | undefined, end: boolean): number | undefined {
  if (!s?.trim()) return undefined;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const day = Date.parse(`${t}T00:00:00Z`);
    return Number.isNaN(day) ? undefined : end ? day + 24 * 3600_000 - 1 : day;
  }
  const at = Date.parse(t);
  if (Number.isNaN(at)) throw new RoutineError("bad_request", `“${t}” isn't a date: use YYYY-MM-DD, or a date and time.`, 400);
  return at;
}

/** Whether every word of the query is in the text (accents and case don't matter). */
export function matches(text: string, terms: string[]): boolean {
  if (!terms.length) return true;
  const t = fold(text);
  return terms.every((w) => t.includes(w));
}

function snippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET * 2) return flat;
  const i = terms.length ? fold(flat).indexOf(terms[0]!) : 0;
  const start = Math.max(0, i - SNIPPET);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + SNIPPET * 2)}${start + SNIPPET * 2 < flat.length ? "…" : ""}`;
}

interface Row {
  id: string;
  role: string;
  iv: string;
  ct: string;
  authorName?: string | null;
  createdAt: number;
}

export class HistorySearch {
  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      routines: RoutineService;
      folder: BotFolder;
      nameOf: (uid: string) => Promise<string>;
    },
  ) {}

  private terms(q: string | undefined): string[] {
    return fold(q ?? "")
      .split(/\s+/)
      .map((w) => w.replace(/^["'„“]+|["'“”]+$/g, ""))
      .filter((w) => w.length > 0)
      .slice(0, 8);
  }

  private range(o: HistoryQuery): { after: number; before: number } {
    const from = parseWhen(o.from, false);
    const to = parseWhen(o.to, true);
    return { after: (from ?? 0) - 1, before: (to ?? Number.MAX_SAFE_INTEGER - 1) + 1 };
  }

  private limit(o: HistoryQuery) {
    return Math.min(Math.max(o.limit ?? 20, 1), 50);
  }

  /** Pages back through one stream until `want` hits or `pages` pages; newest first. */
  private async scan(load: (before: number) => Promise<Row[] | null>, open: (r: Row) => Promise<HistoryHit | null>, terms: string[], after: number, before: number, pages: number, want: number): Promise<HistoryHit[]> {
    const out: HistoryHit[] = [];
    let cursor = before;
    for (let i = 0; i < pages && out.length < want; i++) {
      const rows = await load(cursor);
      if (!rows?.length) break;
      for (const r of rows) {
        const hit = await open(r);
        if (hit && matches(hit.text, terms)) out.push({ ...hit, text: snippet(hit.text, terms) });
        if (out.length >= want) break;
      }
      cursor = rows[rows.length - 1]!.createdAt;
      if (rows.length < PAGE || cursor <= after) break;
    }
    return out;
  }

  private async thread(owner: Owner, routineId: string, name: string, terms: string[], after: number, before: number, want: number): Promise<HistoryHit[]> {
    const where = `${name}'s thread`;
    const hits = await this.scan(
      async (b) => ((await this.d.control.q(api.bots.threadHistory, { id: routineId, after, before: b }).catch(() => null)) as { messages: Row[] } | null)?.messages ?? null,
      async (r) => {
        const body = await openMessage(this.d.keys, owner, r.iv, r.ct).catch(() => null);
        if (!body?.text) return null;
        return { at: r.createdAt, who: r.role === "bot" ? name : (r.authorName ?? (r.role === "ambient" ? "Ambient" : "owner")), where, text: body.text };
      },
      terms,
      after,
      before,
      THREAD_PAGES,
      want,
    );
    const handoffs = (await this.d.folder.handoffs(owner, routineId, 30).catch(() => []))
      .filter((h) => h.createdAt > after && h.createdAt < before && matches(h.text, terms))
      .map((h) => ({ at: h.createdAt, who: name, where: `${name}'s handoff (${h.status})`, text: snippet(h.text, terms) }));
    return [...hits, ...handoffs];
  }

  /** For a person: their chat with Amb, and the threads and handoffs of the bots they see (or one). */
  async forPerson(actor: Actor, o: HistoryQuery): Promise<HistoryHit[]> {
    const terms = this.terms(o.q);
    const { after, before } = this.range(o);
    const want = this.limit(o);
    const all: HistoryHit[] = [];
    if (!o.bot) {
      const owner: Owner = { kind: "user", uid: actor.uid };
      const name = await this.d.nameOf(actor.uid);
      all.push(
        ...(await this.scan(
          async (b) => (await this.d.control.q(api.bots.chatHistory, { uid: actor.uid as never, after, before: b })) as unknown as Row[],
          async (r) => {
            const body = await openMessage(this.d.keys, owner, r.iv, r.ct, CHAT_PURPOSE).catch(() => null);
            return body?.text ? { at: r.createdAt, who: r.role === "user" ? name : "Ambient", where: "chat", text: body.text } : null;
          },
          terms,
          after,
          before,
          CHAT_PAGES,
          want,
        )),
      );
    }
    const bots = o.bot ? [o.bot] : (await this.d.routines.list(actor)).routines.filter((r) => r.bot).map((r) => r.id);
    for (const id of bots.slice(0, 50)) {
      const f = await this.d.routines.folderOf(actor, id, false).catch((err) => {
        if (o.bot) throw err;
        return null;
      });
      if (f) all.push(...(await this.thread(f.owner, f.routineId, f.name, terms, after, before, want)));
    }
    return all.sort((a, b) => b.at - a.at).slice(0, want);
  }

  /** For a bot's run (its run token): its own thread and handoffs. */
  async forRun(authorization: string | undefined, o: HistoryQuery): Promise<HistoryHit[]> {
    const t = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!t.startsWith(RUN_TOKEN_PREFIX)) throw new RoutineError("invalid_token", "This isn't a run's token.", 401);
    const who = await this.d.control.q(api.bots.runOwner, { runTokenHash: sha256Hex(t) });
    if (!who) throw new RoutineError("run_over", "This run is over.", 409);
    const owner: Owner = who.teamId ? { kind: "team", teamId: String(who.teamId) } : { kind: "user", uid: String(who.createdBy) };
    const terms = this.terms(o.q);
    const { after, before } = this.range(o);
    const want = this.limit(o);
    return (await this.thread(owner, String(who.routineId), who.name, terms, after, before, want)).sort((a, b) => b.at - a.at).slice(0, want);
  }
}

/** Hits as lines for a tool's text: newest first. */
export function historyLines(hits: HistoryHit[]): string {
  if (!hits.length) return "Nothing found.";
  return hits.map((h) => `- ${new Date(h.at).toISOString().slice(0, 16).replace("T", " ")} UTC · ${h.who} (${h.where}): ${h.text}`).join("\n");
}
