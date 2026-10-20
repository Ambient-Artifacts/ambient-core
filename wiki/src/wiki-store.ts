// Read model over one wiki (a user's personal wiki or a team wiki), backed by
// the shared "brain-index v1" SQLite schema. Production builds it in memory
// from the user's decrypted Convex rows; the spike builds it from markdown files.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import {
  INDEX_SCHEMA_SQL,
  type ActionItem,
  firstHeading,
  foldText,
  parseActionItems,
  parsePageLenient,
  section,
  splitCompiled,
} from "@brain/spec";
import { bodyLinks } from "./body-links.ts";
import { buildListing, type Listing, type ListedPage } from "./indexes.ts";
import { ignoring, purposeOf } from "./repo-files.ts";
import { attention, lintWiki, type LintReport } from "./lint.ts";

export type StoreScope = "personal" | "team";

export interface Page {
  path: string;
  ref: string;
  type: string;
  title: string;
  summary: string;
  updated: string;
  sortDate: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface SearchHit {
  page: Page;
  snippet: string;
}

export interface ActionItemHit extends ActionItem {
  note: Pick<Page, "ref" | "title" | "sortDate">;
}

export interface DecisionHit {
  text: string;
  date: string;
  source: Pick<Page, "ref" | "title" | "type">;
  status?: string;
}

export interface EntityNames {
  ref: string;
  type: string;
  title: string;
  aliases: string[];
}

export interface Brief {
  page: Pick<Page, "ref" | "title" | "type" | "summary" | "updated">;
  currentTruth: string;
  timeline: string[];
  openActions: ActionItemHit[];
  decisions: DecisionHit[];
  recentNotes: Pick<Page, "ref" | "title" | "sortDate">[];
}

const ENTITY_TYPES = ["person", "org", "project", "topic"];
const LINK_FIELDS = ["people", "orgs", "projects", "topics", "deciders", "affects", "recorded_by", "supersedes", "source"];
const SKIP_TEAM_ROOT = new Set(["AGENTS.md", "conventions.md", "index.md", "log.md", "_meta", "raw", "inbox", "review", "out", ".git"]);
/** Generated or agent-facing files at the top of a personal wiki folder; not pages. */
const SKIP_PERSONAL_ROOT = new Set(["index.md", "log.md", "AGENTS.md"]);

interface PageRow {
  rowid: number;
  path: string;
  type: string;
  title: string;
  summary: string;
  sort_date: string;
  updated: string;
  frontmatter_json: string;
  body: string;
}

function tokens(query: string): string[] {
  return (foldText(query).match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return v === undefined || v === null ? "" : String(v);
}

export class WikiStore {
  private db: Database.Database;
  /** "wiki/" for personal stores, "" for team stores. */
  private prefix: string;

  constructor(
    readonly scope: StoreScope,
    readonly teamId: string | null = null,
  ) {
    this.prefix = scope === "personal" ? "wiki/" : "";
    this.db = new Database(":memory:");
    this.db.exec(INDEX_SCHEMA_SQL);
  }

  /**
   * What folders say about themselves in their own `_index.md` (a repo Ambient didn't write has them),
   * by folder ref. Ambient's generated index files say nothing here.
   */
  readonly folderNotes = new Map<string, string>();

  /** `ignore`: paths below the repo root (folders or files) that aren't knowledge and stay out. */
  static fromDirectory(root: string, scope: StoreScope, teamId: string | null = null, opts: { ignore?: readonly string[] } = {}): WikiStore {
    const store = new WikiStore(scope, teamId);
    const base = scope === "personal" ? join(root, "wiki") : root;
    const skip = ignoring(opts.ignore ?? []);
    const walk = (dir: string, top: boolean): void => {
      for (const name of readdirSync(dir)) {
        if (top && scope === "team" && SKIP_TEAM_ROOT.has(name)) continue;
        if (top && scope === "personal" && SKIP_PERSONAL_ROOT.has(name)) continue;
        if (name.startsWith(".")) continue;
        const p = join(dir, name);
        if (skip(relative(root, p).split(sep).join("/"))) continue;
        // lstat: a symlink (from a connected repo) is skipped, never followed out of the wiki.
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p, false);
        else if (st.isFile() && name.endsWith(".md") && !name.startsWith("_")) {
          store.upsert(relative(root, p).split(sep).join("/"), readFileSync(p, "utf8"));
        } else if (st.isFile() && name === "_index.md" && dir !== base && st.size < 200_000) {
          const about = purposeOf(readFileSync(p, "utf8"));
          if (about) store.folderNotes.set(relative(base, dir).split(sep).join("/"), about);
        }
      }
    };
    walk(base, true);
    return store;
  }

  refOf(path: string): string {
    return path.slice(this.prefix.length).replace(/\.md$/, "");
  }

  pathOf(ref: string): string {
    return `${this.prefix}${ref}.md`;
  }

  /** Pages whose front matter couldn't be read, by path. They're indexed without front matter. */
  readonly invalid = new Map<string, string>();

  upsert(path: string, text: string): void {
    const { frontmatter: fm, body, error } = parsePageLenient(text);
    if (error) {
      this.invalid.set(path, error);
      console.warn(`wiki: front matter of ${path} isn't valid YAML (${error}); indexed without it`);
    } else this.invalid.delete(path);
    const fileTitle = path.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " ");
    const title = asString(fm.title) || firstHeading(body) || fileTitle;
    const summary = asString(fm.summary);
    const type = asString(fm.type) || "other";
    const updated = asString(fm.updated);
    const sortDate = asString(fm.recorded_at) || asString(fm.date) || updated;
    const ref = this.refOf(path);

    const tx = this.db.transaction(() => {
      this.removeRows(path);
      this.db
        .prepare(
          `INSERT INTO pages (path, type, title, summary, scope, team_id, sort_date, updated, frontmatter_json, body, title_f, summary_f, body_f)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(path, type, title, summary, this.scope, this.teamId, sortDate, updated, JSON.stringify(fm), body,
          foldText(title), foldText(summary), foldText(body));

      const aliases = new Set([title, fileTitle, ...(Array.isArray(fm.aliases) ? fm.aliases.map(asString) : [])]);
      const insAlias = this.db.prepare("INSERT OR IGNORE INTO aliases (alias_f, path) VALUES (?, ?)");
      for (const a of aliases) if (a.trim()) insAlias.run(foldText(a.trim()), path);

      const insLink = this.db.prepare("INSERT OR IGNORE INTO links (src, dst, rel) VALUES (?, ?, ?)");
      const addLinks = (rel: string, v: unknown) => {
        for (const dst of Array.isArray(v) ? v : [v]) if (typeof dst === "string" && dst) insLink.run(ref, dst, rel);
      };
      for (const f of LINK_FIELDS) addLinks(f, fm[f]);
      if (fm.links && typeof fm.links === "object") {
        for (const [rel, v] of Object.entries(fm.links as Record<string, unknown>)) addLinks(rel, v);
      }
      // Links in the text, for wikis that link there (a team's own repo): the graph and backlinks.
      addLinks("mentions", bodyLinks(path, body, this.prefix));
    });
    tx();
  }

  remove(path: string): void {
    this.invalid.delete(path);
    this.db.transaction(() => this.removeRows(path))();
  }

  private removeRows(path: string): void {
    this.db.prepare("DELETE FROM pages WHERE path = ?").run(path);
    this.db.prepare("DELETE FROM aliases WHERE path = ?").run(path);
    this.db.prepare("DELETE FROM links WHERE src = ?").run(this.refOf(path));
  }

  get size(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n;
  }

  private toPage(r: PageRow): Page {
    return {
      path: r.path,
      ref: this.refOf(r.path),
      type: r.type,
      title: r.title,
      summary: r.summary,
      updated: r.updated,
      sortDate: r.sort_date,
      frontmatter: JSON.parse(r.frontmatter_json) as Record<string, unknown>,
      body: r.body,
    };
  }

  /** Look up a page by its front-matter `id` (notes carry the recording's id). */
  findById(id: string): Page | undefined {
    const r = this.db
      .prepare("SELECT * FROM pages WHERE json_extract(frontmatter_json, '$.id') = ? LIMIT 1")
      .get(id) as PageRow | undefined;
    return r ? this.toPage(r) : undefined;
  }

  /** Every page of one type, oldest first by sort date. */
  ofType(type: string): Page[] {
    return (this.db.prepare("SELECT * FROM pages WHERE type = ? ORDER BY sort_date ASC").all(type) as PageRow[]).map((r) =>
      this.toPage(r),
    );
  }

  /** Title, summary and dates of every page: what the index pages are built from. */
  entries(): ListedPage[] {
    const rows = this.db.prepare("SELECT path, type, title, summary, updated, sort_date FROM pages").all() as Pick<
      PageRow,
      "path" | "type" | "title" | "summary" | "updated" | "sort_date"
    >[];
    const recorders = new Map(
      (this.db.prepare("SELECT src, dst FROM links WHERE rel = 'recorded_by'").all() as { src: string; dst: string }[]).map((l) => [l.src, l.dst]),
    );
    return rows.map((r) => {
      const ref = this.refOf(r.path);
      const recordedBy = recorders.get(ref);
      return { ref, type: r.type, title: r.title, summary: r.summary, updated: r.updated, sortDate: r.sort_date, ...(recordedBy ? { recordedBy } : {}) };
    });
  }

  /** The folders and pages at one level ("" = top), as on the index pages. */
  listing(folder = ""): Listing {
    return buildListing(this.entries(), folder, folder ? undefined : attention(this.lint()), this.folderNotes);
  }

  /** Every link (src and dst are refs): front matter by its field, links in the text as "mentions". */
  allLinks(): { src: string; dst: string; rel: string }[] {
    return this.db.prepare("SELECT src, dst, rel FROM links").all() as { src: string; dst: string; rel: string }[];
  }

  lint(opts: { today?: string } = {}): LintReport {
    return lintWiki(this, opts);
  }

  getByRef(ref: string): Page | undefined {
    const r = this.db.prepare("SELECT * FROM pages WHERE path = ?").get(this.pathOf(ref)) as PageRow | undefined;
    return r ? this.toPage(r) : undefined;
  }

  search(query: string, opts: { limit?: number; types?: string[]; since?: string } = {}): SearchHit[] {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const toks = tokens(query);
    if (toks.length === 0) return [];

    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.types?.length) {
      filters.push(`p.type IN (${opts.types.map(() => "?").join(",")})`);
      params.push(...opts.types);
    }
    if (opts.since) {
      filters.push("p.sort_date >= ?");
      params.push(opts.since);
    }
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";

    const seen = new Set<number>();
    const rows: PageRow[] = [];
    const run = (sql: string, match: string) => {
      if (rows.length >= limit) return;
      for (const r of this.db.prepare(sql).all(match, ...params, limit * 2) as PageRow[]) {
        if (seen.has(r.rowid) || rows.length >= limit) continue;
        seen.add(r.rowid);
        rows.push(r);
      }
    };
    const ftsSql = `SELECT p.* FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
      WHERE pages_fts MATCH ? ${where} ORDER BY bm25(pages_fts, 5.0, 3.0, 1.0), p.sort_date DESC LIMIT ?`;
    const quoted = toks.map((t) => `"${t}"*`);
    run(ftsSql, quoted.join(" AND "));
    if (toks.length > 1) run(ftsSql, quoted.join(" OR "));
    // Trigram pass catches compound-word fragments ("strategie" in "preisstrategie").
    const tri = toks.filter((t) => t.length >= 3).map((t) => `"${t}"`);
    if (tri.length) {
      run(
        `SELECT p.* FROM pages_tri t JOIN pages p ON p.rowid = t.rowid
         WHERE pages_tri MATCH ? ${where} ORDER BY p.sort_date DESC LIMIT ?`,
        tri.join(" AND "),
      );
    }
    return rows.map((r) => {
      const page = this.toPage(r);
      return { page, snippet: snippet(page, toks) };
    });
  }

  recent(opts: { since?: string; kind?: string; limit?: number } = {}): Page[] {
    const params: unknown[] = [];
    let sql = "SELECT * FROM pages WHERE type = 'note'";
    if (opts.since) {
      sql += " AND sort_date >= ?";
      params.push(opts.since);
    }
    if (opts.kind) {
      sql += " AND json_extract(frontmatter_json, '$.kind') = ?";
      params.push(opts.kind);
    }
    sql += " ORDER BY sort_date DESC LIMIT ?";
    params.push(Math.min(opts.limit ?? 10, 50));
    return (this.db.prepare(sql).all(...params) as PageRow[]).map((r) => this.toPage(r));
  }

  /** Resolve a name or alias to an entity page (exact alias first, then prefix). */
  resolveEntity(name: string, kind?: string): Page | undefined {
    const f = foldText(name.trim());
    if (!f) return undefined;
    const types = kind ? [kind] : ENTITY_TYPES;
    const inTypes = types.map(() => "?").join(",");
    const q = (cond: string, arg: string) =>
      this.db
        .prepare(
          `SELECT p.* FROM aliases a JOIN pages p ON p.path = a.path
           WHERE ${cond} AND p.type IN (${inTypes}) ORDER BY length(a.alias_f) LIMIT 1`,
        )
        .get(arg, ...types) as PageRow | undefined;
    const like = f.replace(/[\\%_]/g, (c) => `\\${c}`);
    const r =
      q("a.alias_f = ?", f) ??
      q("a.alias_f LIKE ? ESCAPE '\\'", `${like}%`) ??
      q("a.alias_f LIKE ? ESCAPE '\\'", `%${like}%`);
    return r ? this.toPage(r) : undefined;
  }

  /** Every person, org, project and topic with the names it goes by: what a client matches mentions against. */
  entityNames(): EntityNames[] {
    return ENTITY_TYPES.flatMap((type) =>
      this.ofType(type).map((p) => ({
        ref: p.ref,
        type,
        title: p.title,
        aliases: Array.isArray(p.frontmatter.aliases) ? p.frontmatter.aliases.map(asString).filter(Boolean) : [],
      })),
    );
  }

  backlinks(ref: string): Page[] {
    const srcs = this.db.prepare("SELECT DISTINCT src FROM links WHERE dst = ?").all(ref) as { src: string }[];
    return srcs.map((s) => this.getByRef(s.src)).filter((p): p is Page => p !== undefined);
  }

  actionItems(opts: { owner?: string; status?: "open" | "done" | "all"; since?: string; about?: string } = {}): ActionItemHit[] {
    const status = opts.status ?? "open";
    const notes = opts.about ? this.backlinks(opts.about).filter((p) => p.type === "note") : this.recent({ since: opts.since, limit: 50 });
    const owner = opts.owner ? foldText(opts.owner) : null;
    const out: ActionItemHit[] = [];
    for (const n of notes) {
      if (opts.since && n.sortDate < opts.since) continue;
      for (const a of parseActionItems(n.body)) {
        if (status === "open" && a.done) continue;
        if (status === "done" && !a.done) continue;
        if (owner && !(a.owner && foldText(a.owner).includes(owner))) continue;
        out.push({ ...a, note: { ref: n.ref, title: n.title, sortDate: n.sortDate } });
      }
    }
    return out.sort((x, y) => (x.due ?? "9999").localeCompare(y.due ?? "9999"));
  }

  decisions(opts: { since?: string; about?: string } = {}): DecisionHit[] {
    const out: DecisionHit[] = [];
    const decisionPages = (this.db.prepare("SELECT * FROM pages WHERE type = 'decision' ORDER BY sort_date DESC").all() as PageRow[])
      .map((r) => this.toPage(r))
      .filter((p) => !opts.about || this.linksTo(p.ref, opts.about));
    for (const d of decisionPages) {
      out.push({
        text: d.summary || d.title,
        date: d.sortDate,
        status: asString(d.frontmatter.status),
        source: { ref: d.ref, title: d.title, type: d.type },
      });
    }
    const notes = opts.about ? this.backlinks(opts.about).filter((p) => p.type === "note") : this.recent({ since: opts.since, limit: 50 });
    for (const n of notes) {
      for (const line of section(n.body, "Decisions")) {
        const m = /^\s*-\s+(.+)$/.exec(line);
        if (m?.[1]) out.push({ text: m[1].trim(), date: n.sortDate, source: { ref: n.ref, title: n.title, type: n.type } });
      }
    }
    return out
      .filter((d) => !opts.since || d.date >= opts.since)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  private linksTo(src: string, dst: string): boolean {
    return this.db.prepare("SELECT 1 FROM links WHERE src = ? AND dst = ?").get(src, dst) !== undefined;
  }

  /** Deterministic context pack about an entity. No LLM involved. */
  brief(ref: string): Brief | undefined {
    const page = this.getByRef(ref);
    if (!page) return undefined;
    const { currentTruth, timeline } = splitCompiled(page.body);
    const names = new Set(
      [page.title, ...(Array.isArray(page.frontmatter.aliases) ? page.frontmatter.aliases.map(asString) : [])].map(foldText),
    );
    const linked = this.actionItems({ about: ref, status: "open" });
    const owned = this.actionItems({ status: "open" }).filter((a) => a.owner && names.has(foldText(a.owner)));
    const openActions = [...linked, ...owned].filter(
      (a, i, all) => all.findIndex((b) => b.note.ref === a.note.ref && b.task === a.task) === i,
    );
    const recentNotes = this.backlinks(ref)
      .filter((p) => p.type === "note")
      .sort((a, b) => b.sortDate.localeCompare(a.sortDate))
      .slice(0, 5)
      .map((p) => ({ ref: p.ref, title: p.title, sortDate: p.sortDate }));
    return {
      page: { ref: page.ref, title: page.title, type: page.type, summary: page.summary, updated: page.updated },
      currentTruth: currentTruth.replace(/^# .+\n+/, "").trim(),
      timeline: timeline.slice(-10),
      openActions,
      decisions: this.decisions({ about: ref }).slice(0, 10),
      recentNotes,
    };
  }
}

function snippet(page: Page, toks: string[]): string {
  for (const raw of page.body.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(#+|-|\*|\d+\.)\s*/, "").trim();
    if (!line) continue;
    const f = foldText(line);
    if (toks.some((t) => f.includes(t))) return line.length > 240 ? `${line.slice(0, 237)}...` : line;
  }
  return page.summary || page.title;
}
