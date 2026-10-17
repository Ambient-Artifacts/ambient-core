// Personal wikis: encrypted at rest in Convex, decrypted only here, in memory,
// to answer a search or restore a phone. One in-memory index per user, rebuilt
// when the user's sequence number moves.
import { forgetNotes, mergeLiving, parsePage } from "@brain/spec";
import { LocalReader, WikiStore, type WikiReader } from "@brain/wiki";
import { api, type Control } from "./control.ts";
import {
  decryptPage,
  encryptPage,
  newDataKey,
  sha256Hex,
  unwrapDataKey,
  wrapDataKey,
  type MasterKey,
} from "./crypto.ts";

export interface SyncUpsert {
  op: "upsert";
  path: string;
  hash: string;
  content: string;
  updated: string;
}
export interface SyncDelete {
  op: "delete";
  path: string;
}
export type SyncOp = SyncUpsert | SyncDelete;

/** Wiki pages, plus raw transcripts (`raw/YYYY/MM/<id>.md`) so they are backed up too. */
export const PERSONAL_PATH = /^(wiki\/[a-z0-9][a-z0-9/_.-]*|raw\/\d{4}\/\d{2}\/[0-9A-Za-z_-]+)\.md$/;
const MAX_PAGE_BYTES = 200_000;
const MAX_RAW_BYTES = 600_000;
const LIVING = /^wiki\/(people|orgs|projects|topics)\//;

export interface PageChange {
  path: string;
  hash: string;
  content: string;
  /** Deleted on another device (or by the server): delete it here too. */
  deleted?: boolean;
}

/**
 * Who a sync comes from, as stored on the pages it writes: "device:<id>" for app builds that
 * send their own id, "phone" for older ones (which all said "iphone" and only pulled the
 * server's writes).
 */
export function deviceOrigin(deviceId: string | undefined): string {
  return deviceId && deviceId !== "iphone" ? `device:${deviceId}` : "phone";
}

export class PersonalStore {
  private indexes = new Map<string, { seq: number; reader: WikiReader; at: number }>();
  private keys = new Map<string, Buffer>();

  constructor(
    private control: Control,
    private master: MasterKey,
    private opts: { maxCachedUsers?: number } = {},
  ) {}

  private async dataKey(uid: string): Promise<Buffer> {
    const cached = this.keys.get(uid);
    if (cached) return cached;
    let rec = await this.control.q(api.personal.getKey, { uid: uid as never });
    if (!rec) {
      const dek = newDataKey();
      rec = await this.control.m(api.personal.putKeyIfAbsent, {
        uid: uid as never,
        masterKeyId: this.master.id,
        wrapped: wrapDataKey(this.master, uid, dek),
        now: Date.now(),
      });
    }
    if (rec.masterKeyId !== this.master.id) throw new Error(`user key wrapped by unknown master key ${rec.masterKeyId}`);
    const dek = unwrapDataKey(this.master, uid, rec.wrapped);
    this.keys.set(uid, dek);
    return dek;
  }

  /**
   * Validate, encrypt and store a batch from the phone, and return what the server changed
   * since the phone's `sinceSeq` (Claude upkeep, overview, captures). A living page the server
   * rewrote is merged: the server's head, both timelines (see mergeLiving).
   */
  async sync(
    uid: string,
    ops: SyncOp[],
    sinceSeq?: number,
    deviceId?: string,
  ): Promise<{ seq: number; applied: number; rejected: { path: string; reason: string }[]; changes: PageChange[]; through: number | null; devices: boolean }> {
    const origin = deviceOrigin(deviceId);
    const dek = await this.dataKey(uid);
    const rejected: { path: string; reason: string }[] = [];
    const out = [];
    // A deleted recording: strip it from the server's copies of the living pages first, so the
    // merge below can't bring its timeline lines back from a page the server rewrote.
    const forgotten = ops.filter((o) => o.op === "delete" && /^wiki\/notes\//.test(o.path)).map((o) => o.path);
    if (forgotten.length) await this.forget(uid, forgotten);
    const stored = await this.storedVersions(uid, dek, ops);
    const merged: { path: string; content: string }[] = [];
    for (const o of ops) {
      if (!PERSONAL_PATH.test(o.path) || o.path.includes("..")) {
        rejected.push({ path: o.path, reason: "bad_path" });
        continue;
      }
      if (o.op === "delete") {
        out.push({ op: "delete" as const, path: o.path });
        continue;
      }
      if (Buffer.byteLength(o.content, "utf8") > (o.path.startsWith("raw/") ? MAX_RAW_BYTES : MAX_PAGE_BYTES)) {
        rejected.push({ path: o.path, reason: "too_large" });
        continue;
      }
      if (sha256Hex(o.content) !== o.hash) {
        rejected.push({ path: o.path, reason: "hash_mismatch" });
        continue;
      }
      const fm = parsePage(o.content).frontmatter;
      if (fm.scope === "team") {
        // Team notes travel through the team inbox, never into the personal store.
        rejected.push({ path: o.path, reason: "team_scope" });
        continue;
      }
      const prev = stored.get(o.path);
      if (prev && prev.origin !== origin) {
        // Someone else wrote this page last: the server (Claude upkeep) or another device.
        // Living pages keep that version's head and gain this device's new timeline lines, so
        // neither side's lines are lost; everyone pulls the merge. Other pages: the server's
        // own writes win over an older device copy; between devices the newest upload wins.
        if (LIVING.test(o.path)) {
          const content = mergeLiving(prev.content, o.content);
          if (content !== prev.content) merged.push({ path: o.path, content });
          continue;
        }
        if (prev.origin === "server") continue;
      }
      const { iv, ciphertext } = encryptPage(dek, uid, o.path, o.content);
      out.push({ op: "upsert" as const, path: o.path, hash: o.hash, iv, ciphertext, updated: o.updated });
    }
    let seq = out.length === 0 ? await this.control.q(api.personal.seq, { uid: uid as never }) : 0;
    let applied = 0;
    for (let i = 0; i < out.length; i += 100) {
      const r = await this.control.m(api.personal.apply, { uid: uid as never, ops: out.slice(i, i + 100), origin });
      seq = r.seq;
      applied += r.applied;
    }
    if (merged.length) {
      const r = await this.serverWrite(uid, merged);
      seq = Math.max(seq, r.seq);
      applied += r.applied;
    }
    if (applied > 0) this.indexes.delete(uid);
    const pulled = sinceSeq === undefined ? { changes: [], through: null } : await this.changesSince(uid, sinceSeq, dek, deviceId);
    // `devices`: this reply follows per-device sync (tells new app builds the server has it).
    return { seq, applied, rejected, ...pulled, devices: origin !== "phone" };
  }

  /**
   * Remove deleted recordings from every stored page (see spec forgetNotes): all of them in one
   * pass over the pages. One by one, a sync of 500 deletes (real or made up) re-read every page
   * 500 times, and held up every other request to this gateway while it did.
   */
  private async forget(uid: string, notePaths: string[]): Promise<void> {
    const pages = new Map((await this.pages(uid)).pages.map((p) => [p.path, p.content]));
    const r = forgetNotes(notePaths, pages);
    const deletes = new Set(r.deletes);
    const writes = new Map(r.writes.filter((w) => !deletes.has(w.path)).map((w) => [w.path, w.content]));
    if (writes.size) await this.serverWrite(uid, [...writes].map(([path, content]) => ({ path, content })));
    const ops = [...deletes].filter((p) => PERSONAL_PATH.test(p)).map((path) => ({ op: "delete" as const, path }));
    for (let i = 0; i < ops.length; i += 100) await this.control.m(api.personal.apply, { uid: uid as never, ops: ops.slice(i, i + 100) });
    this.indexes.delete(uid);
  }

  /** The stored version of each wiki page in `ops`, with who wrote it (path → text, origin). */
  private async storedVersions(uid: string, dek: Buffer, ops: SyncOp[]): Promise<Map<string, { content: string; origin: string }>> {
    const paths = ops.filter((o) => o.op === "upsert" && o.path.startsWith("wiki/")).map((o) => o.path);
    const out = new Map<string, { content: string; origin: string }>();
    for (let i = 0; i < paths.length; i += 200) {
      const rows = await this.control.q(api.personal.getMany, { uid: uid as never, paths: paths.slice(i, i + 200) });
      for (const r of rows) out.set(r.path, { content: decryptPage(dek, uid, r.path, r.iv, r.ciphertext), origin: r.origin });
    }
    return out;
  }

  /**
   * What a device should pull after `since`: pages and deletions by the server and the user's
   * other devices (only the server's pages for older builds without a device id). `through`
   * is set when there is more to fetch: the device asks again from that seq.
   */
  async changesSince(uid: string, since: number, dek?: Buffer, deviceId?: string): Promise<{ changes: PageChange[]; through: number | null }> {
    const key = dek ?? (await this.dataKey(uid));
    const origin = deviceOrigin(deviceId);
    const r = await this.control.q(api.personal.changedSince, { uid: uid as never, since, device: origin === "phone" ? undefined : origin });
    const changes: PageChange[] = [
      ...r.pages.map((p) => ({ seq: p.seq, change: { path: p.path, hash: p.hash, content: decryptPage(key, uid, p.path, p.iv, p.ciphertext) } })),
      ...r.deleted.map((d) => ({ seq: d.seq, change: { path: d.path, hash: "", content: "", deleted: true } })),
    ]
      .sort((a, b) => a.seq - b.seq)
      .map((x) => x.change);
    return { changes, through: r.through };
  }

  /** Write pages as the server (Claude upkeep, overview, captures). The phone pulls them on its next sync. */
  async serverWrite(uid: string, pages: { path: string; content: string }[]): Promise<{ seq: number; applied: number }> {
    const dek = await this.dataKey(uid);
    const today = new Date().toISOString().slice(0, 10);
    const ops = pages.map((p) => {
      if (!PERSONAL_PATH.test(p.path) || p.path.includes("..")) throw new Error(`bad path ${p.path}`);
      const { iv, ciphertext } = encryptPage(dek, uid, p.path, p.content);
      const updated = String(parsePage(p.content).frontmatter.updated ?? today).slice(0, 10);
      return { op: "upsert" as const, path: p.path, hash: sha256Hex(p.content), iv, ciphertext, updated };
    });
    let seq = 0;
    let applied = 0;
    for (let i = 0; i < ops.length; i += 100) {
      const r = await this.control.m(api.personal.apply, { uid: uid as never, ops: ops.slice(i, i + 100), origin: "server" });
      seq = r.seq;
      applied += r.applied;
    }
    if (applied > 0) this.indexes.delete(uid);
    return { seq, applied };
  }

  /** Delete pages as the server; devices delete them too (tombstones). */
  async serverDelete(uid: string, paths: string[]): Promise<void> {
    const ops = paths.filter((p) => PERSONAL_PATH.test(p) && !p.includes("..")).map((path) => ({ op: "delete" as const, path }));
    if (!ops.length) return;
    await this.control.m(api.personal.apply, { uid: uid as never, ops, origin: "server" });
    this.indexes.delete(uid);
  }

  /** One page's current text, or undefined. */
  async readPage(uid: string, path: string): Promise<string | undefined> {
    if (!PERSONAL_PATH.test(path) || path.includes("..")) return undefined;
    const dek = await this.dataKey(uid);
    const [row] = await this.control.q(api.personal.getMany, { uid: uid as never, paths: [path] });
    return row ? decryptPage(dek, uid, row.path, row.iv, row.ciphertext) : undefined;
  }

  /** Encrypt a small secret (a repo token, sync state) with the user's own data key. */
  async seal(uid: string, label: string, text: string): Promise<{ iv: string; ciphertext: string }> {
    return encryptPage(await this.dataKey(uid), uid, label, text);
  }

  async open(uid: string, label: string, iv: string, ciphertext: string): Promise<string> {
    return decryptPage(await this.dataKey(uid), uid, label, iv, ciphertext);
  }

  /** A note's transcript, if the phone backed it up (`raw` in the note's front matter). */
  async transcript(uid: string, rawPath: string): Promise<string | undefined> {
    if (!/^raw\/\d{4}\/\d{2}\/[0-9A-Za-z_-]+\.md$/.test(rawPath) || rawPath.includes("..")) return undefined;
    const dek = await this.dataKey(uid);
    const [row] = await this.control.q(api.personal.getMany, { uid: uid as never, paths: [rawPath] });
    return row ? decryptPage(dek, uid, row.path, row.iv, row.ciphertext) : undefined;
  }

  /** All pages decrypted, for "restore from cloud" on a new phone. */
  async pages(uid: string): Promise<{ seq: number; pages: { path: string; hash: string; content: string; updated: string }[] }> {
    const dek = await this.dataKey(uid);
    const { seq, pages } = await this.control.q(api.personal.list, { uid: uid as never });
    return {
      seq,
      pages: pages.map((p) => ({ path: p.path, hash: p.hash, updated: p.updated, content: decryptPage(dek, uid, p.path, p.iv, p.ciphertext) })),
    };
  }

  /** In-memory search index over the user's decrypted pages, reused while unchanged. */
  async reader(uid: string): Promise<WikiReader> {
    const seq = await this.control.q(api.personal.seq, { uid: uid as never });
    const hit = this.indexes.get(uid);
    if (hit && hit.seq === seq) {
      hit.at = Date.now();
      return hit.reader;
    }
    const { pages } = await this.pages(uid);
    const store = new WikiStore("personal");
    for (const p of pages) if (p.path.startsWith("wiki/")) store.upsert(p.path, p.content);
    const reader = new LocalReader(store);
    this.indexes.set(uid, { seq, reader, at: Date.now() });
    this.evict();
    return reader;
  }

  private evict(): void {
    const max = this.opts.maxCachedUsers ?? 500;
    if (this.indexes.size <= max) return;
    const oldest = [...this.indexes.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.indexes.size - max);
    for (const [uid] of oldest) this.indexes.delete(uid);
  }
}
