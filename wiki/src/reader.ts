// The read interface MCP tools use. A personal wiki is read in-process
// (LocalReader over a WikiStore); a team wiki lives on the team server and is
// read over HTTP with the same operations (dispatchQuery on the server side,
// a remote reader in the gateway).
import { z } from "zod";
import type { ListedPage, Listing } from "./indexes.ts";
import type { ActionItemHit, Brief, DecisionHit, EntityNames, Page, SearchHit, WikiStore } from "./wiki-store.ts";

export interface WikiReader {
  search(query: string, opts?: { limit?: number; types?: string[]; since?: string }): Promise<SearchHit[]>;
  getByRef(ref: string): Promise<Page | undefined>;
  recent(opts?: { since?: string; kind?: string; limit?: number }): Promise<Page[]>;
  resolveEntity(name: string, kind?: string): Promise<Page | undefined>;
  brief(ref: string): Promise<Brief | undefined>;
  actionItems(opts?: { owner?: string; status?: "open" | "done" | "all"; since?: string; about?: string }): Promise<ActionItemHit[]>;
  decisions(opts?: { since?: string; about?: string }): Promise<DecisionHit[]>;
  listing(folder?: string): Promise<Listing>;
  /** Every page's ref, title, summary and dates: enough to draw the whole folder tree. */
  entries(): Promise<ListedPage[]>;
  /** Pages that link to `ref` (front-matter links). */
  backlinks(ref: string): Promise<{ ref: string; title: string; type: string; summary: string }[]>;
  /** A note's full transcript as text, where the wiki keeps transcripts (team servers). */
  transcript?(ref: string): Promise<string | null>;
  /** Every front-matter link between two pages that exist (the app's graph view). */
  links?(): Promise<{ src: string; dst: string }[]>;
  /** People, orgs, projects and topics with their names (title and aliases). */
  entityNames?(): Promise<EntityNames[]>;
  /** The team's page for one recording (WikiStore.findByRecording). */
  byRecording?(id: string): Promise<Page | undefined>;
}

export class LocalReader implements WikiReader {
  constructor(protected store: WikiStore) {}
  async search(query: string, opts?: Parameters<WikiStore["search"]>[1]) {
    return this.store.search(query, opts);
  }
  async getByRef(ref: string) {
    return this.store.getByRef(ref);
  }
  async recent(opts?: Parameters<WikiStore["recent"]>[0]) {
    return this.store.recent(opts);
  }
  async resolveEntity(name: string, kind?: string) {
    return this.store.resolveEntity(name, kind);
  }
  async brief(ref: string) {
    return this.store.brief(ref);
  }
  async actionItems(opts?: Parameters<WikiStore["actionItems"]>[0]) {
    return this.store.actionItems(opts);
  }
  async decisions(opts?: Parameters<WikiStore["decisions"]>[0]) {
    return this.store.decisions(opts);
  }
  async listing(folder?: string) {
    return this.store.listing(folder);
  }
  async entries() {
    return this.store.entries();
  }
  async backlinks(ref: string) {
    return this.store.backlinks(ref).map((p) => ({ ref: p.ref, title: p.title, type: p.type, summary: p.summary }));
  }
  async entityNames() {
    return this.store.entityNames();
  }
  async byRecording(id: string) {
    return this.store.findByRecording(id);
  }
  async links() {
    const seen = new Set<string>();
    const out: { src: string; dst: string }[] = [];
    for (const l of this.store.allLinks()) {
      const key = `${l.src}\n${l.dst}`;
      if (seen.has(key) || l.src === l.dst || !this.store.getByRef(l.dst)) continue;
      seen.add(key);
      out.push({ src: l.src, dst: l.dst });
    }
    return out;
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional();
// A page's ref is its path without ".md", as the repo names it: connected repos have README.md, CLAUDE.md,
// "Meeting Notes.md" or "Über uns.md". Refs are only looked up in the index, never opened as files;
// they still can't be absolute, climb out with "..", or carry control characters.
const pathPart = (s: string) => !/[\u0000-\u001f\u007f\\]/.test(s) && !s.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
const ref = z.string().min(1).max(300).refine(pathPart, "not a page ref");

/** Wire contract for team-server queries: one op name, validated args. */
export const QueryRequest = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("search"),
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).optional(),
    types: z.array(z.string().max(20)).max(10).optional(),
    since: date,
  }),
  z.object({ op: z.literal("getByRef"), ref }),
  z.object({
    op: z.literal("recent"),
    since: date,
    kind: z.string().max(20).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ op: z.literal("resolveEntity"), name: z.string().min(1).max(120), kind: z.string().max(20).optional() }),
  z.object({ op: z.literal("brief"), ref }),
  z.object({
    op: z.literal("actionItems"),
    owner: z.string().max(120).optional(),
    status: z.enum(["open", "done", "all"]).optional(),
    since: date,
    about: ref.optional(),
  }),
  z.object({ op: z.literal("decisions"), since: date, about: ref.optional() }),
  z.object({ op: z.literal("listing"), folder: z.string().max(300).refine((f) => f === "" || pathPart(f.replace(/\/$/, "")), "not a folder").optional() }),
  z.object({ op: z.literal("entries") }),
  z.object({ op: z.literal("backlinks"), ref }),
  z.object({ op: z.literal("transcript"), ref }),
  z.object({ op: z.literal("links") }),
  z.object({ op: z.literal("entityNames") }),
  z.object({ op: z.literal("recording"), id: z.string().regex(/^[0-9A-Za-z_-]{10,64}$/) }),
]);
export type QueryRequest = z.infer<typeof QueryRequest>;

/** Server side: run one validated query against a reader. */
export async function dispatchQuery(reader: WikiReader, req: QueryRequest): Promise<unknown> {
  switch (req.op) {
    case "search":
      return reader.search(req.query, { limit: req.limit, types: req.types, since: req.since });
    case "getByRef":
      return (await reader.getByRef(req.ref)) ?? null;
    case "recent":
      return reader.recent({ since: req.since, kind: req.kind, limit: req.limit });
    case "resolveEntity":
      return (await reader.resolveEntity(req.name, req.kind)) ?? null;
    case "brief":
      return (await reader.brief(req.ref)) ?? null;
    case "actionItems":
      return reader.actionItems({ owner: req.owner, status: req.status, since: req.since, about: req.about });
    case "decisions":
      return reader.decisions({ since: req.since, about: req.about });
    case "listing":
      return reader.listing(req.folder);
    case "entries":
      return reader.entries();
    case "backlinks":
      return reader.backlinks(req.ref);
    case "transcript":
      return reader.transcript ? ((await reader.transcript(req.ref)) ?? null) : null;
    case "links":
      return reader.links ? reader.links() : [];
    case "entityNames":
      return reader.entityNames ? reader.entityNames() : [];
    case "recording":
      return reader.byRecording ? ((await reader.byRecording(req.id)) ?? null) : null;
  }
}

/** Client side: a WikiReader that sends each call to `send` (e.g. an HTTP POST). */
export class RemoteReader implements WikiReader {
  constructor(private send: (req: QueryRequest) => Promise<unknown>) {}
  async search(query: string, opts: { limit?: number; types?: string[]; since?: string } = {}) {
    return (await this.send({ op: "search", query, ...opts })) as SearchHit[];
  }
  async getByRef(ref: string) {
    return ((await this.send({ op: "getByRef", ref })) ?? undefined) as Page | undefined;
  }
  async recent(opts: { since?: string; kind?: string; limit?: number } = {}) {
    return (await this.send({ op: "recent", ...opts })) as Page[];
  }
  async resolveEntity(name: string, kind?: string) {
    return ((await this.send({ op: "resolveEntity", name, kind })) ?? undefined) as Page | undefined;
  }
  async brief(ref: string) {
    return ((await this.send({ op: "brief", ref })) ?? undefined) as Brief | undefined;
  }
  async actionItems(opts: { owner?: string; status?: "open" | "done" | "all"; since?: string; about?: string } = {}) {
    return (await this.send({ op: "actionItems", ...opts })) as ActionItemHit[];
  }
  async decisions(opts: { since?: string; about?: string } = {}) {
    return (await this.send({ op: "decisions", ...opts })) as DecisionHit[];
  }
  async listing(folder?: string) {
    return (await this.send({ op: "listing", folder })) as Listing;
  }
  async entries() {
    return (await this.send({ op: "entries" })) as ListedPage[];
  }
  async backlinks(ref: string) {
    return (await this.send({ op: "backlinks", ref })) as { ref: string; title: string; type: string; summary: string }[];
  }
  async transcript(ref: string) {
    return ((await this.send({ op: "transcript", ref })) ?? null) as string | null;
  }
  async links() {
    return (await this.send({ op: "links" })) as { src: string; dst: string }[];
  }
  async entityNames() {
    return (await this.send({ op: "entityNames" })) as EntityNames[];
  }
  async byRecording(id: string) {
    return ((await this.send({ op: "recording", id })) ?? undefined) as Page | undefined;
  }
}
