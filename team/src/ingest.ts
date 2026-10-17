// Ingest: a Team note from a phone becomes one entry page in the team wiki.
// Deterministic, no AI. The note's own front matter is treated as untrusted
// input: only known fields survive, links are sanitized, size is capped.
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { NoteFrontmatter, NoteId, renderPage, slugify, type TeamNoteV1 } from "@brain/spec";
import { EntityIndex } from "@brain/wiki";
import type { TeamWiki } from "./wiki.ts";

const REF = /^(people|orgs|projects|topics)\/[a-z0-9][a-z0-9-]{0,79}$/;

function refs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && REF.test(x)))].slice(0, 30);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A work session's tool and place, from untrusted front matter. */
function work(v: unknown): { tool: string; repo?: string; branch?: string; ended_at?: string } | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const tool = str(w.tool, 40);
  if (!tool) return null;
  const repo = str(w.repo, 200);
  const branch = str(w.branch, 120);
  const ended = typeof w.ended_at === "string" && !Number.isNaN(Date.parse(w.ended_at)) ? new Date(w.ended_at).toISOString() : "";
  return { tool, ...(repo ? { repo } : {}), ...(branch ? { branch } : {}), ...(ended ? { ended_at: ended } : {}) };
}

/** Strip raw HTML so a note can't smuggle markup into renderers. */
function cleanBody(md: string): string {
  return md.replace(/<\/?[a-zA-Z][^>]*>/g, "").slice(0, 20_000).trim();
}

export function notePath(note: TeamNoteV1, title: string): string {
  const date = note.recorded_at.slice(0, 10);
  const id6 = note.note_id.slice(-6).toLowerCase();
  // Work sessions with AI agents have their own folder; notes/ is recorded conversations.
  return `${note.kind === "session" ? "sessions" : "notes"}/${date.slice(0, 7)}/${date}-${slugify(title) || "note"}-${id6}.md`;
}

export interface IngestResult {
  /** `replaced`: the recorder's device summarized a note again that the team had only as quotes. */
  status: "stored" | "duplicate" | "replaced";
  path: string;
}

export async function ingestNote(
  wiki: TeamWiki,
  note: TeamNoteV1,
  opts: { rawDir: string; recordedBySlug: string | null },
): Promise<IngestResult & { commit?: string | null }> {
  const recordedBy = opts.recordedBySlug && REF.test(opts.recordedBySlug) ? opts.recordedBySlug : undefined;
  // The id names the raw transcript's file: never a path (the schema says so too).
  if (!NoteId.safeParse(note.note_id).success) throw new IngestError(422, "invalid note: note_id");
  const existing = wiki.store.findById(note.note_id);
  // A note the team already has stays as it is, except one Apple's model didn't write (quotes
  // or a list of its parts) that the same person's device has now summarized again (the app's
  // Summarize again). Nobody else can replace it: who sent it comes from the gateway.
  const compile = existing?.frontmatter.compile as { fallback?: unknown } | undefined;
  const replacing = !!existing && compile?.fallback !== undefined && compile.fallback !== "none"
    && !!recordedBy && existing.frontmatter.recorded_by === recordedBy;
  if (existing && !replacing) return { status: "duplicate", path: existing.path };

  const fm = note.entry_page.frontmatter;
  const title = str(fm.title, 60) || "Untitled note";
  const today = new Date().toISOString().slice(0, 10);
  // Each entity to the page the wiki already has for it ("Nikolai Madlener" when the team has
  // Nikolai's page); a name made from a description and matching nothing gets no page.
  const index = new EntityIndex(wiki.store);
  const recorder = recordedBy ? { ref: recordedBy, name: note.recorded_by_name ?? null } : undefined;
  const canon = (v: unknown) => [...new Set(refs(v).map((r) => index.canonical(r, { recorder })).filter((r): r is string => r !== null))];
  const people = canon(fm.people);
  if (recordedBy && !people.includes(recordedBy)) people.unshift(recordedBy);

  const frontmatter: Record<string, unknown> = {
    id: note.note_id,
    type: "note",
    title,
    summary: str(fm.summary, 200) || title,
    kind: note.kind,
    recorded_at: note.recorded_at,
    duration_s: note.duration_s,
    language: note.language,
    scope: "team",
    team_id: wiki.teamId,
    ...(recordedBy ? { recorded_by: recordedBy } : {}),
    consent: note.consent,
    people,
    orgs: canon(fm.orgs),
    projects: canon(fm.projects),
    topics: canon(fm.topics),
    ...(work(fm.work) ? { work: work(fm.work) } : {}),
    compile: note.client.compiler === "extractive"
      ? { engine: "fm-ondevice", status: "partial", fallback: "extractive" }
      : note.client.compiler === "session-summary"
        ? { engine: "server", status: "compiled", fallback: "none" }
        : { engine: "fm-ondevice", status: "compiled", fallback: "none" },
    updated: today,
  };
  const parsed = NoteFrontmatter.safeParse(frontmatter);
  if (!parsed.success) throw new IngestError(422, `invalid note: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);

  // Replaced at its old address, so links to it stay. A new note whose address is already
  // another note's (same day, title and last six characters of the id, by chance or made so by a
  // member) gets its whole id in the name instead: it must never overwrite someone else's note.
  let path = existing?.path ?? notePath(note, title);
  const taken = wiki.store.getByRef(path.replace(/\.md$/, ""));
  if (!existing && taken && taken.frontmatter.id !== note.note_id) {
    path = path.replace(/-[0-9a-z_-]{6}\.md$/, `-${note.note_id.toLowerCase()}.md`);
    if (wiki.store.getByRef(path.replace(/\.md$/, ""))) throw new IngestError(409, "a different note already has this address");
  }
  // Links to the note's pages in this wiki's layout (the phone's own links point elsewhere).
  const related = (["people", "orgs", "projects", "topics"] as const).flatMap((k) =>
    (frontmatter[k] as string[]).map((ref) => {
      const name = wiki.store.getByRef(ref)?.title ?? ref.split("/").pop()!.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      return `- [${name.replace(/[[\]]/g, "")}](${posix.relative(posix.dirname(path), `${ref}.md`)})`;
    }),
  );
  const own = cleanBody(note.entry_page.body_md).replace(/\n## Related\n[\s\S]*?(?=\n## |$)/, "").trimEnd();
  const body = related.length ? `${own}\n\n## Related\n${related.join("\n")}` : own;
  const text = renderPage({ frontmatter, body: `\n${body.startsWith("# ") ? body : `# ${title}\n\n${body}`}\n` });

  if (note.transcript) {
    // Raw transcripts stay outside git (retention-limited, never exported by default).
    await mkdir(opts.rawDir, { recursive: true });
    await writeFile(join(opts.rawDir, `${note.note_id}.json`), JSON.stringify(note.transcript));
  }

  const out = await wiki.write(async (put) => {
    await put(path, text);
    const id6 = note.note_id.slice(-6).toLowerCase();
    const result: IngestResult = { status: replacing ? "replaced" : "stored", path };
    return { message: `${replacing ? "summarized again" : "ingest"}: ${title} (${id6})`, result };
  });
  return out;
}

export class IngestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
