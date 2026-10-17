// One page per person, org, project and topic. Summarizers name the same entity in different
// ways ("Nikolai", "Nikolai Madlener", "Nikolai (testing on the Mac)"), and every spelling used
// to become its own page. This maps a ref a note brings to the page the wiki already has for
// that entity, and finds pages that are one entity twice. Plain code, no LLM.
import { ENTITY_FOLDERS, descriptiveRef, foldText, refWords, slugify, type EntityFolder } from "@brain/spec";
import type { Page } from "./wiki-store.ts";

const TYPE_OF: Record<EntityFolder, string> = { people: "person", orgs: "org", projects: "project", topics: "topic" };

/** Folded words, single-spaced: "Nikolai's Team" → "nikolai s team". */
export function nameKey(s: string): string {
  return foldText(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

interface Entry {
  page: Page;
  ref: string;
  /** The title's name key and words. */
  title: string;
  words: string[];
  /** Every name the page goes by: title, aliases, its file name read as words. */
  names: Set<string>;
  emails: Set<string>;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

function entryOf(page: Page): Entry {
  const aliases = Array.isArray(page.frontmatter.aliases) ? page.frontmatter.aliases.map(String) : [];
  const title = nameKey(page.title);
  const names = new Set([title, refWords(page.ref).join(" "), ...aliases.map(nameKey)].filter(Boolean));
  // The first 20,000 characters: the regex rescans from every position where no "@" follows, so a
  // huge page (one synced from a repo has no size cap) would slow every ingest.
  const emails = new Set((page.body.slice(0, 20_000).match(EMAIL) ?? []).map((e) => e.toLowerCase()));
  return { page, ref: page.ref, title, words: title ? title.split(" ") : [], names, emails };
}

/** Does `run` appear as consecutive words in `words`? */
function containsRun(words: string[], run: string[]): boolean {
  if (run.length === 0 || run.length > words.length) return false;
  for (let i = 0; i + run.length <= words.length; i++) if (run.every((w, j) => words[i + j] === w)) return true;
  return false;
}

export interface EntitySource {
  ofType(type: string): Page[];
  getByRef(ref: string): Page | undefined;
}

export class EntityIndex {
  private byFolder = new Map<EntityFolder, Entry[]>();

  constructor(private store: EntitySource) {
    for (const f of ENTITY_FOLDERS) {
      this.byFolder.set(f, store.ofType(TYPE_OF[f]).filter((p) => p.ref.startsWith(`${f}/`)).map(entryOf));
    }
  }

  /**
   * The ref to use for an entity a note names: the page the wiki already has for it, the ref
   * itself when the entity is new, or null when the ref was made from a description and no
   * page matches it (better no page than one named after a sentence).
   * `recorder` is who recorded the note: a summarizer that names them in full means them.
   */
  canonical(ref: string, opts: { recorder?: { ref: string; name?: string | null } } = {}): string | null {
    const folder = ref.split("/")[0] as EntityFolder;
    const entries = this.byFolder.get(folder);
    if (!entries) return ref;
    if (this.store.getByRef(ref)) return ref;
    const slug = ref.slice(folder.length + 1);
    const words = refWords(ref);
    const name = words.join(" ");

    const r = opts.recorder;
    if (folder === "people" && r?.name && r.ref !== ref && slugify(r.name) === slug) return r.ref;

    const named = entries.filter((e) => e.names.has(name));
    if (named.length > 0) return named.map((e) => e.ref).sort()[0]!;

    if (folder === "people" && !descriptiveRef(ref)) {
      const sameFirst = entries.filter((e) => e.words[0] === words[0]);
      // "Nikolai" when one person here is called Nikolai.
      if (words.length === 1 && sameFirst.length === 1) return sameFirst[0]!.ref;
      // "Nikolai Madlener" when the only Nikolai here has no last name yet.
      if (words.length > 1 && sameFirst.length === 1 && sameFirst[0]!.words.length === 1) return sameFirst[0]!.ref;
    }

    if (descriptiveRef(ref)) {
      // The longest name of a page inside the description, when one page has it.
      let best: Entry[] = [];
      let len = 0;
      for (const e of entries) {
        for (const n of e.names) {
          const run = n.split(" ");
          if (!containsRun(words, run) || run.length < len) continue;
          if (run.length > len) {
            best = [];
            len = run.length;
          }
          if (!best.includes(e)) best.push(e);
        }
      }
      return best.length === 1 ? best[0]!.ref : null;
    }
    return ref;
  }

  /**
   * Pages that are one person or org twice, as groups with the page to keep first. The keeper
   * is a page notes are recorded by (`recorders`: a member's own page, which the gateway keeps
   * sending), else the one more pages link to, else the one with the fuller name.
   */
  duplicates(opts: { recorders?: Set<string>; backlinks?: (ref: string) => number } = {}): string[][] {
    const groups: string[][] = [];
    for (const folder of ["people", "orgs"] as const) {
      const entries = this.byFolder.get(folder) ?? [];
      const parent = entries.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
      const join = (a: number, b: number) => {
        parent[find(a)] = find(b);
      };
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          if (this.same(folder, entries, i, j)) join(i, j);
        }
      }
      const byRoot = new Map<number, Entry[]>();
      entries.forEach((e, i) => byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), e]));
      for (const members of byRoot.values()) {
        if (members.length < 2) continue;
        const score = (e: Entry) => [opts.recorders?.has(e.ref) ? 1 : 0, opts.backlinks?.(e.ref) ?? 0, e.words.length, e.title.length, -e.ref.length];
        const sorted = [...members].sort((a, b) => {
          const [x, y] = [score(a), score(b)];
          for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return y[k]! - x[k]!;
          return a.ref.localeCompare(b.ref);
        });
        groups.push(sorted.map((e) => e.ref));
      }
    }
    return groups;
  }

  /** The fullest proper name among pages (for the merged page's title). */
  bestTitle(refs: string[]): string {
    const pages = refs.map((r) => this.store.getByRef(r)).filter((p): p is Page => !!p);
    const ok = pages.filter((p) => !descriptiveRef(p.ref) || nameKey(p.title).split(" ").length <= 4);
    const pick = (ok.length ? ok : pages).sort((a, b) => nameKey(b.title).split(" ").length - nameKey(a.title).split(" ").length)[0];
    return pick?.title ?? "";
  }

  private same(folder: "people" | "orgs", entries: Entry[], i: number, j: number): boolean {
    const a = entries[i]!;
    const b = entries[j]!;
    // The same full name, or one page goes by the other's full name.
    if (a.words.length >= 2 && (b.names.has(a.title) || a.title === b.title)) return true;
    if (b.words.length >= 2 && a.names.has(b.title)) return true;
    for (const e of a.emails) if (b.emails.has(e)) return true;
    if (folder !== "people") return false;
    // A first name alone, when one person here has that first name with a last name.
    const [short, full] = a.words.length === 1 ? [a, b] : b.words.length === 1 ? [b, a] : [null, null];
    if (!short || !full || full.words.length < 2 || full.words[0] !== short.words[0]) return false;
    const fullOnes = new Set(entries.filter((e) => e.words.length >= 2 && e.words[0] === short.words[0]).map((e) => e.title));
    return fullOnes.size === 1;
  }
}
