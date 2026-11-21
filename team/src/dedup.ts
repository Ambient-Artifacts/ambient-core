// The nightly dedup pass, before consolidation: one page per person and org. Pages that are
// one entity twice are merged into one (the other spellings become aliases), and every link to
// a merged page, or to a page named after a description, is pointed at the page that stays.
// Plain code, no LLM: consolidation then rewrites the merged page's head from its latest notes.
import { posix } from "node:path";
import { appendTimeline, parsePage, renderPage, splitCompiled } from "@brain/spec";
import { EntityIndex, nameKey, type Page } from "@brain/wiki";
import { headParts, renderHead, type Head } from "./head.ts";
import type { TeamWiki } from "./wiki.ts";

const LIST_FIELDS = ["people", "orgs", "projects", "topics", "deciders", "affects"];
const ONE_FIELDS = ["recorded_by", "supersedes", "source"];
const ENTITY_FOLDERS = new Set(["people", "orgs", "projects", "topics"]);

export interface DedupOutcome {
  merged: { into: string; from: string[] }[];
  /** Links pointed elsewhere: to the page that stays, or dropped when nothing matches. */
  relinked: Map<string, string | null>;
  /** Pages rewritten because they linked to a merged or dropped page. */
  touched: number;
  commit: string | null;
}

const uniq = <T>(xs: T[], key: (x: T) => string = String): T[] => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Which links to repoint: merged pages to the page that stays, dangling refs to the page they mean. */
export function dedupPlan(store: TeamWiki["store"]): { groups: string[][]; map: Map<string, string | null>; titles: Map<string, string> } {
  const index = new EntityIndex(store);
  const recorders = new Set(store.ofType("note").map((n) => n.frontmatter.recorded_by).filter((r): r is string => typeof r === "string"));
  const groups = index.duplicates({ recorders, backlinks: (ref) => store.backlinks(ref).length });
  const map = new Map<string, string | null>();
  const titles = new Map<string, string>();
  for (const [keep, ...rest] of groups) {
    for (const r of rest) map.set(r, keep!);
    titles.set(keep!, index.bestTitle([keep!, ...rest]));
  }
  // Links to pages that don't exist: a spelling of a page that does, or a description.
  for (const l of store.allLinks()) {
    if (l.rel === "mentions" || map.has(l.dst) || !ENTITY_FOLDERS.has(l.dst.split("/")[0]!) || store.getByRef(l.dst)) continue;
    let to = index.canonical(l.dst);
    if (to && map.has(to)) to = map.get(to)!;
    if (to !== l.dst) map.set(l.dst, to);
  }
  return { groups, map, titles };
}

/** The page that stays, with the others folded in: their current truth, open questions, timeline and names. */
export function mergedPage(keep: Page, others: Page[], title: string, today: string): string {
  const all = [keep, ...others];
  const heads = all.map((p) => headParts(p.body));
  const fold = (s: string) => nameKey(s);
  const sections: Head["sections"] = [];
  for (const h of heads) {
    for (const s of h.sections) {
      const have = sections.find((x) => x.heading.toLowerCase() === s.heading.toLowerCase());
      if (have) have.bullets = uniq([...have.bullets, ...s.bullets], fold).slice(0, 5);
      else sections.push({ heading: s.heading, bullets: uniq(s.bullets, fold).slice(0, 5) });
    }
  }
  const head: Head = {
    currentTruth: uniq(heads.flatMap((h) => h.currentTruth), fold).slice(0, 10),
    sections,
    openQuestions: uniq(heads.flatMap((h) => h.openQuestions), fold).slice(0, 10),
  };
  const aliases = uniq(
    [...all.map((p) => p.title), ...all.flatMap((p) => (Array.isArray(p.frontmatter.aliases) ? p.frontmatter.aliases.map(String) : []))],
    fold,
  )
    .filter((a) => fold(a) !== fold(title))
    .slice(0, 10);
  const links = Object.assign({}, ...all.map((p) => (p.frontmatter.links && typeof p.frontmatter.links === "object" ? p.frontmatter.links : {})));
  const frontmatter: Record<string, unknown> = {
    ...keep.frontmatter,
    title,
    summary: keep.summary || others.find((o) => o.summary)?.summary || title,
    aliases,
    ...(Object.keys(links).length ? { links } : {}),
    updated: today,
  };
  const timeline = all.flatMap((p) => splitCompiled(p.body).timeline);
  const body = appendTimeline(`${renderHead(title, head)}\n\n## Timeline\n`, timeline);
  return renderPage({ frontmatter, body: `\n${body}` });
}

/**
 * Point a page's links at the pages that stay: front-matter refs, and markdown links in the
 * body (a list line that only linked a dropped page goes; an inline one keeps its text).
 * Returns null when nothing changed.
 */
export function relinkPage(page: Page, text: string, map: Map<string, string | null>): string | null {
  const parsed = parsePage(text);
  const fm: Record<string, unknown> = { ...parsed.frontmatter };
  let changed = false;
  const to = (v: unknown) => (typeof v === "string" && map.has(v) ? map.get(v) : v);
  for (const f of LIST_FIELDS) {
    if (!Array.isArray(fm[f])) continue;
    const before = fm[f] as unknown[];
    const after = uniq(before.map(to).filter((x) => x !== null && x !== undefined), String);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      fm[f] = after;
      changed = true;
    }
  }
  for (const f of ONE_FIELDS) {
    if (typeof fm[f] !== "string" || !map.has(fm[f] as string)) continue;
    const next = map.get(fm[f] as string);
    if (next) fm[f] = next;
    else delete fm[f];
    changed = true;
  }
  if (fm.links && typeof fm.links === "object") {
    const links: Record<string, unknown> = {};
    for (const [rel, v] of Object.entries(fm.links as Record<string, unknown>)) {
      const next = Array.isArray(v) ? uniq(v.map(to).filter((x) => x !== null && x !== undefined), String) : to(v);
      if (next !== null && next !== undefined && !(Array.isArray(next) && next.length === 0)) links[rel] = next;
      if (JSON.stringify(next) !== JSON.stringify(v)) changed = true;
    }
    fm.links = links;
  }

  const dir = posix.dirname(page.path);
  const target = (href: string): string | undefined => {
    if (/^[a-z]+:/i.test(href) || href.startsWith("/")) return undefined;
    const ref = posix.normalize(posix.join(dir, href)).replace(/\.md$/, "");
    return map.has(ref) ? ref : undefined;
  };
  let lines: string[] = [];
  for (const line of parsed.body.split("\n")) {
    const only = /^\s*[-*]\s+\[[^\]]*\]\(([^)\s]+\.md)\)\s*$/.exec(line);
    if (only && target(only[1]!) && map.get(target(only[1]!)!) === null) {
      changed = true;
      continue;
    }
    lines.push(
      line.replace(/\[([^\]]*)\]\(([^)\s]+\.md)\)/g, (whole, label: string, href: string) => {
        const ref = target(href);
        if (!ref) return whole;
        changed = true;
        const next = map.get(ref);
        return next ? `[${label}](${posix.relative(dir, `${next}.md`)})` : label;
      }),
    );
  }
  if (!changed) return null;
  // Two lines of one list that now open with a link to the same page: keep the first.
  let seen = new Set<string>();
  lines = lines.filter((l) => {
    if (!/^\s*[-*]\s/.test(l)) {
      seen = new Set();
      return true;
    }
    const lead = /^\s*[-*]\s+\[[^\]]*\]\(([^)\s]+)\)/.exec(l)?.[1];
    if (!lead) return true;
    if (seen.has(lead)) return false;
    seen.add(lead);
    return true;
  });
  return renderPage({ frontmatter: fm, body: `\n${lines.join("\n").replace(/^\n+/, "")}` });
}

/** Merge the duplicates and repoint links, in one commit. */
export async function dedupe(wiki: TeamWiki, today = new Date().toISOString().slice(0, 10)): Promise<DedupOutcome> {
  const { groups, map, titles } = dedupPlan(wiki.store);
  const out: DedupOutcome = { merged: [], relinked: map, touched: 0, commit: null };
  if (map.size === 0) return out;
  const store = wiki.store;
  const writes = new Map<string, string>();
  const removes: string[] = [];
  for (const [keep, ...rest] of groups) {
    const page = store.getByRef(keep!)!;
    const others = rest.map((r) => store.getByRef(r)).filter((p): p is Page => !!p);
    writes.set(page.path, mergedPage(page, others, titles.get(keep!) || page.title, today));
    removes.push(...others.map((o) => o.path));
    out.merged.push({ into: keep!, from: rest });
  }
  const gone = new Set(removes);
  for (const p of [...store.ofType("note"), ...store.ofType("decision"), ...store.ofType("overview"), ...["person", "org", "project", "topic"].flatMap((t) => store.ofType(t))]) {
    if (gone.has(p.path)) continue;
    const text = writes.get(p.path) ?? wiki.read(p.path);
    const next = relinkPage(p, text, map);
    if (next !== null) {
      writes.set(p.path, next);
      out.touched++;
    }
  }
  if (writes.size === 0 && removes.length === 0) return out;
  const what = out.merged.map((m) => `${m.from.join(", ")} into ${m.into}`);
  const dropped = [...map.values()].filter((v) => v === null).length;
  const message = `dedup: ${what.length ? `merged ${what.join("; ")}` : "relinked pages"}${dropped ? ` (${dropped} links to descriptions dropped)` : ""}`;
  const res = await wiki.write(async (put, remove) => {
    for (const [path, text] of writes) await put(path, text);
    for (const path of removes) await remove(path);
    return { message, result: {} };
  });
  out.commit = res.commit;
  return out;
}
