// Corrections that wait for a page's owner, read from the pages themselves.
//
// When someone who doesn't decide for a page corrects a fact that a source document backs, the
// team's sync keeps the documented fact and adds an open question in a fixed form
// (conventions §14 of a team wiki that takes corrections):
//
//   - <Name> says <what is true> (correction of <YYYY-MM-DD>); <file> says <claim>. <Owner> to decide.
//
// That line is what people see on the page, so it is also what the bot reads: no second record
// that could disagree with the page. The question disappears from the page once it is decided.
import { createHash } from "node:crypto";

export interface Waiting {
  /** Stable for one question on one page: the page, the date and who corrected. */
  key: string;
  ref: string;
  pageTitle: string;
  corrector: string;
  date: string;
  /** What the corrector says is true. */
  says: string;
  /** The rest of the question: what the documents say. */
  documents: string;
  owner: string;
  /** The question as written on the page, without list marker or bold label. */
  line: string;
}

const NAME = String.raw`[A-ZÄÖÜ][\p{L}'’-]+(?: (?:von |van |de |zu )?[A-ZÄÖÜ][\p{L}'’-]+)+`;
const SAYS = new RegExp(String.raw`(${NAME}) says (.+?) \(correction of (\d{4}-\d{2}-\d{2})\)`, "u");
const OWNER = new RegExp(String.raw`(${NAME}) to decide\.?\s*$`, "u");

/** The list items of the page's "Open questions" section (none when it has no such section). */
function questionLines(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s+(open questions|offene fragen)\b/i.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l)) break;
    if (/^\s*[-*]\s+/.test(l)) out.push(l.replace(/^\s*[-*]\s+/, ""));
    else if (out.length && /^\s{2,}\S/.test(l)) out[out.length - 1] += ` ${l.trim()}`;
  }
  return out;
}

export function waitingOnPage(page: { ref: string; title: string; body: string }): Waiting[] {
  const out: Waiting[] = [];
  for (const raw of questionLines(page.body)) {
    const line = raw.replace(/^\*\*[^*]+:\*\*\s*/, "").trim();
    const says = SAYS.exec(line);
    const owner = OWNER.exec(line);
    if (!says || !owner) continue;
    const corrector = says[1]!;
    const date = says[3]!;
    const after = line.slice(says.index + says[0].length).replace(/^[;,.]\s*/, "");
    const documents = after.slice(0, after.length - owner[0].length).trim().replace(/[.;]\s*$/, "");
    out.push({
      key: createHash("sha256").update(`${page.ref}\n${date}\n${corrector}`).digest("hex").slice(0, 16),
      ref: page.ref,
      pageTitle: page.title,
      corrector,
      date,
      says: says[2]!.trim(),
      documents,
      owner: owner[1]!,
      line,
    });
  }
  return out;
}

/** Names compare without case, accents or extra spaces ("Daniel  Kalb" = "daniel kalb"). */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}
