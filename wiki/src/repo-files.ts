// What a connected repo brings that Ambient didn't write: files that aren't knowledge (templates,
// scripts, a README) and folders that describe themselves in their own `_index.md`.

/** "./templates/", "/templates" and "templates" all name the folder templates; "..": none of them. */
export function normalizeIgnore(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const p = raw.trim().replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "");
    if (p && !p.split("/").some((s) => s === "." || s === "..")) out.add(p);
  }
  return [...out].sort();
}

/** Whether a path below the repo root is left out: it is, or lies in, one of the ignored folders or files. */
export function ignoring(list: readonly string[]): (path: string) => boolean {
  const entries = normalizeIgnore(list);
  return (path) => entries.some((e) => path === e || path.startsWith(`${e}/`));
}

const MAX_PURPOSE = 1200;

/**
 * What a folder's own `_index.md` says about the folder: the text between its heading and its first
 * section ("## Pages"). The back link and the "N pages" line of an index Ambient generated are not
 * that, so an index Ambient wrote gives nothing, and one a team wrote gives its own words.
 */
export function purposeOf(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    i = end < 0 ? 0 : end + 1;
  }
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (/^# /.test(lines[i] ?? "")) i++;
  const intro: string[] = [];
  for (; i < lines.length && !/^#{1,6}\s/.test(lines[i]!); i++) intro.push(lines[i]!);
  const kept: string[] = [];
  let size = 0;
  for (const para of intro.join("\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (/^\[(back to the index|←)/i.test(para) || /^\d+ pages?\b/i.test(para) || /^_no pages yet_$/i.test(para)) continue;
    if (size + para.length > MAX_PURPOSE && kept.length) break;
    kept.push(para);
    size += para.length;
  }
  return kept.join("\n\n").slice(0, MAX_PURPOSE).trim();
}

/** The first line of a purpose, for a listing of folders: no markdown emphasis, no final period, at most 140 characters. */
export function headline(purpose: string): string {
  const first = (purpose.split("\n").find((l) => l.trim()) ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
  return first.length <= 140 ? first : `${first.slice(0, 139).replace(/\s+\S*$/, "")}…`;
}
