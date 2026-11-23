// Links written in a page's text ("[Anna](../people/anna.md)"), as refs. Wikis Ambient writes
// keep their links in front matter (people, projects, …); wikis written by people or other tools
// (a team's own repo, connected two-way or read-only) link in the text, and their graph and
// backlinks would be empty without these. Stored with rel "mentions".
import { posix } from "node:path";

/** Markdown links and images' siblings: `[text](target)`, `[text](<target>)`, with an optional title. */
const LINK = /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** Fenced code blocks: links in them are examples, not links. */
const FENCE = /^(```|~~~)[\s\S]*?^\1/gm;
const MAX_LINKS = 500;

/**
 * The refs a page's text links to. `path` is the page's path in the store ("people/anna.md", or
 * "wiki/people/anna.md" in a personal store); `prefix` is the store's ("" or "wiki/"). Links that
 * leave the wiki, point at something other than a Markdown file or go to another site are skipped.
 */
export function bodyLinks(path: string, body: string, prefix = ""): string[] {
  const out = new Set<string>();
  const text = body.replace(FENCE, "");
  for (const m of text.matchAll(LINK)) {
    if (out.size >= MAX_LINKS) break;
    let target = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("#")) continue;
    target = target.split("#")[0]!.split("?")[0]!;
    try {
      target = decodeURIComponent(target);
    } catch {
      // a literal "%": keep it as written
    }
    if (!target.toLowerCase().endsWith(".md")) continue;
    // "/people/anna.md" is from the repo's root; anything else is relative to the page.
    const resolved = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(path), target));
    if (resolved.startsWith("../") || resolved === ".." || !resolved.startsWith(prefix)) continue;
    const ref = resolved.slice(prefix.length, -3);
    if (!ref || ref.split("/").some((part) => part.startsWith("."))) continue;
    out.add(ref);
  }
  return [...out];
}
