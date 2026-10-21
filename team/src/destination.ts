// Destinations (product/sources.md): each shared recording's transcript goes to storage the
// team controls, `raw/` in its repository by default or a OneDrive/SharePoint folder; copies of
// shared work logs go to a folder too when the team wants them. Delivery runs outside the inbox
// request through a small outbox on disk: a slow drive or git push must not make the phone
// retry, because a retry only hits "duplicate" and would lose the file.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MicrosoftConnection, TeamSettings } from "@brain/spec";
import { GraphError, graphFor, GraphTokens, MicrosoftGraph, WAITING_FOR_TOKEN } from "./graph.ts";
import type { Author } from "./repo.ts";
import type { TeamSettingsStore } from "./settings.ts";
import type { TeamWiki } from "./wiki.ts";

export type OutboxKind = "transcript" | "work";

export interface OutboxItem {
  note_id: string;
  kind: OutboxKind;
  title: string;
  /** Relative to the destination folder: YYYY-MM/YYYY-MM-DD-<title>-<id6>.md */
  file: string;
  text: string;
  queued_at: string;
  attempts: number;
  next_at: number;
  last_error?: string;
  /** Whose recording or work log it is: the commit's author when it goes into the repo. */
  by?: Author;
}

/** Waits between attempts: 1 min, 5 min, 30 min, then every 2 hours. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
const ID = /^[0-9A-Za-z_-]{8,64}$/;

export class TranscriptOutbox {
  constructor(readonly dir: string) {}

  private name(noteId: string, kind: OutboxKind): string {
    if (!ID.test(noteId)) throw new Error(`bad note id ${noteId}`);
    return `${noteId}.${kind}`;
  }

  /** Queue (or queue again) a file. The same note always lands in the same file. */
  async add(item: Pick<OutboxItem, "note_id" | "kind" | "title" | "file" | "text" | "by">, now = Date.now()): Promise<void> {
    await this.put({ ...item, queued_at: new Date(now).toISOString(), attempts: 0, next_at: now });
  }

  private async put(item: OutboxItem): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${this.name(item.note_id, item.kind)}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(item), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  async all(): Promise<OutboxItem[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const items: OutboxItem[] = [];
    for (const n of names.sort()) {
      try {
        items.push(JSON.parse(await readFile(join(this.dir, n), "utf8")) as OutboxItem);
      } catch {
        // half-written by a crash: the next add() rewrites it
      }
    }
    return items;
  }

  /** Queued or already delivered: a note sent again (the phone retrying) isn't written twice. */
  async seen(noteId: string, kind: OutboxKind): Promise<boolean> {
    const name = this.name(noteId, kind);
    for (const p of [join(this.dir, `${name}.json`), join(this.dir, "done", name)]) {
      if (await stat(p).then(() => true, () => false)) return true;
    }
    return false;
  }

  async done(item: Pick<OutboxItem, "note_id" | "kind">): Promise<void> {
    const name = this.name(item.note_id, item.kind);
    await mkdir(join(this.dir, "done"), { recursive: true });
    await writeFile(join(this.dir, "done", name), "");
    await rm(join(this.dir, `${name}.json`), { force: true });
  }

  /** Dropped without delivery (the team switched the destination off): may be queued again later. */
  async drop(item: Pick<OutboxItem, "note_id" | "kind">): Promise<void> {
    await rm(join(this.dir, `${this.name(item.note_id, item.kind)}.json`), { force: true });
  }

  async failed(item: OutboxItem, error: string, now = Date.now()): Promise<void> {
    const attempts = item.attempts + 1;
    await this.put({ ...item, attempts, last_error: error, next_at: now + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]! });
  }
}

export interface Destination {
  write(item: OutboxItem): Promise<void>;
}

/** `raw/` in the team's repository: committed, and pushed when a repo is connected. */
export class RepoDestination implements Destination {
  constructor(
    private wiki: TeamWiki,
    private folder: string,
  ) {}

  async write(item: OutboxItem): Promise<void> {
    await this.wiki.write(async (put) => {
      await put(`${this.folder}/${item.file}`, item.text, { index: false });
      const by = item.by ? ` by ${item.by.name}` : "";
      return { message: `transcript: ${item.title} (${item.note_id.slice(-6).toLowerCase()})${by}`, result: {}, author: item.by };
    });
  }
}

/** A OneDrive or SharePoint folder, through the team's Microsoft 365 connection. */
export class DriveDestination implements Destination {
  constructor(
    private graph: MicrosoftGraph,
    private folder: { drive_id: string; folder_id: string },
  ) {}

  async write(item: OutboxItem): Promise<void> {
    await this.graph.upload(this.folder, item.file, item.text);
  }
}

export interface DeliveryStatus {
  /** Where transcripts go: `repo:raw`, `drive:<folder>` or `none`. */
  destination: string;
  /** Where copies of work logs go: `drive:<folder>` or `none`. */
  work_destination: string;
  waiting: number;
  oldest_queued_at: string | null;
  last_error: string | null;
  last_delivered_at: string | null;
  /** True when a file has failed three times or more: the health check reports it. */
  failing: boolean;
}

export function describeDestination(d: TeamSettings["transcripts"] | TeamSettings["work"]): string {
  return d.kind === "repo" ? `repo:${d.folder}` : d.kind === "drive" ? `drive:${d.label || d.folder_id}` : "none";
}

export class Deliverer {
  private running: Promise<{ delivered: number; failed: number }> | null = null;
  private lastDeliveredAt: string | null = null;
  private graphs = new Map<string, MicrosoftGraph>();

  constructor(
    readonly outbox: TranscriptOutbox,
    private settings: TeamSettingsStore,
    private wiki: TeamWiki,
    /** The Graph client for a connection (server.ts shares one GraphTokens with the app; tests inject a fake). */
    private makeGraph: (conn: MicrosoftConnection) => MicrosoftGraph = (conn) => graphFor(conn, new GraphTokens()),
  ) {}

  private current(): TeamSettings {
    return this.settings.effective(!!this.wiki.remote?.readOnly);
  }

  /** The destination the settings name for `kind`, a reason it can't be used, or null (off). */
  destination(kind: OutboxKind): Destination | string | null {
    const s = this.current();
    const d = kind === "transcript" ? s.transcripts : s.work;
    if (d.kind === "none") return null;
    if (d.kind === "repo") return new RepoDestination(this.wiki, d.folder);
    if (!s.microsoft) return "Microsoft 365 isn't connected; connect it again in the team settings.";
    const m = s.microsoft;
    const key = m.kind === "own" ? `own/${m.tenant_id}/${m.client_id}/${m.client_secret}` : `ambient/${m.tenant_id}`;
    if (!this.graphs.has(key)) this.graphs.set(key, this.makeGraph(m));
    return new DriveDestination(this.graphs.get(key)!, d);
  }

  /** Deliver everything that's due. Concurrent calls share one run. */
  run(now = Date.now()): Promise<{ delivered: number; failed: number }> {
    if (!this.running) this.running = this.deliver(now, false).finally(() => (this.running = null));
    return this.running;
  }

  /** A Microsoft token arrived: what waited only for it goes out now, whatever its backoff says. */
  async tokenArrived(now = Date.now()): Promise<{ delivered: number; failed: number }> {
    await this.run(now).catch(() => undefined); // what's due anyway, first
    while (this.running) await this.running.catch(() => undefined);
    this.running = this.deliver(now, true).finally(() => (this.running = null));
    return this.running;
  }

  private async deliver(now: number, waitingForToken: boolean): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const item of await this.outbox.all()) {
      if (waitingForToken ? item.last_error !== WAITING_FOR_TOKEN : item.next_at > now) continue;
      const kind = item.kind ?? "transcript";
      const dest = this.destination(kind);
      if (dest === null) {
        await this.outbox.drop({ ...item, kind }); // the team switched this destination off
        continue;
      }
      try {
        if (typeof dest === "string") throw new GraphError(400, dest);
        await dest.write(item);
        await this.outbox.done({ ...item, kind });
        this.lastDeliveredAt = new Date().toISOString();
        delivered++;
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        await this.outbox.failed({ ...item, kind }, message, now);
        console.error(`[team] ${kind} ${item.note_id} not delivered to ${describeDestination(kind === "transcript" ? this.current().transcripts : this.current().work)}: ${message}`);
        failed++;
      }
    }
    return { delivered, failed };
  }

  async status(): Promise<DeliveryStatus> {
    const items = await this.outbox.all();
    const withError = items.filter((i) => i.last_error).sort((a, b) => b.next_at - a.next_at);
    const s = this.current();
    return {
      destination: describeDestination(s.transcripts),
      work_destination: describeDestination(s.work),
      waiting: items.length,
      oldest_queued_at: items.map((i) => i.queued_at).sort()[0] ?? null,
      last_error: withError[0]?.last_error ?? null,
      last_delivered_at: this.lastDeliveredAt,
      failing: items.some((i) => i.attempts >= 3),
    };
  }
}
