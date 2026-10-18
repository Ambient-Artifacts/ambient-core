// Ingest: a Team note from a phone becomes one entry page in the team wiki.
// Deterministic, no AI. The note's own front matter is treated as untrusted
// input: only known fields survive, links are sanitized, size is capped.
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  destinationFileName,
  NoteFrontmatter,
  NoteId,
  renderPage,
  renderTranscript,
  renderWorkLog,
  slugify,
  type TeamNoteV1,
  type TeamSettings,
} from "@brain/spec";
import { EntityIndex } from "@brain/wiki";
import type { OutboxKind, TranscriptOutbox } from "./destination.ts";
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

export interface IngestOptions {
  rawDir: string;
  recordedBySlug: string | null;
  /** The team's settings as they apply now (TeamSettingsStore.effective). Defaults when absent. */
  settings?: TeamSettings;
  /** Where files wait for delivery to their destination. Without it, nothing is delivered. */
  outbox?: TranscriptOutbox;
  /** The team's repo is kept by another tool: only files for the destinations, no pages. */
  readOnly?: boolean;
}

interface DestinationFile {
  kind: OutboxKind;
  title: string;
  file: string;
  text: string;
}

/**
 * The files this note sends to the team's destinations: its transcript (a recording, unless
 * transcripts go nowhere) or a copy of the work log (a work session, when the team set a folder).
 */
export function destinationFiles(wiki: TeamWiki, note: TeamNoteV1, settings: TeamSettings): DestinationFile[] {
  const fm = note.entry_page.frontmatter;
  const title = str(fm.title, 60) || "Untitled note";
  const recordedBy = note.recorded_by_name ? str(note.recorded_by_name, 80) : undefined;
  const segments = note.transcript?.segments ?? [];
  const out: DestinationFile[] = [];
  if (settings.transcripts.kind !== "none" && segments.some((s) => s.text.trim())) {
    const m = note.meeting;
    const meetingTitle = str(m?.title, 200);
    const meta = {
      id: note.note_id,
      title: meetingTitle || title,
      recorded_at: note.recorded_at,
      ...(note.ended_at ? { ended_at: note.ended_at } : {}),
      duration_s: note.duration_s,
      locale: note.language,
      team: wiki.teamName,
      ...(recordedBy ? { recorded_by: recordedBy } : {}),
      ...(m
        ? {
          meeting: {
            title: meetingTitle || title,
            ...(m.start ? { start: m.start } : {}),
            ...(m.end ? { end: m.end } : {}),
            attendees: m.attendees.map((a) => str(a, 120)).filter(Boolean),
          },
        }
        : {}),
      speakers: (note.speakers ?? [...new Set(segments.map((s) => s.speaker).filter((x): x is string => !!x))]).map((a) => str(a, 80)).filter(Boolean),
    };
    out.push({ kind: "transcript", title: meta.title, file: destinationFileName(meta), text: renderTranscript(meta, segments) });
  }
  if (settings.work.kind !== "none" && note.kind === "session") {
    const w = work(fm.work);
    const meta = {
      id: note.note_id,
      title,
      summary: str(fm.summary, 200) || title,
      recorded_at: note.recorded_at,
      ...(w?.ended_at ? { ended_at: w.ended_at } : {}),
      team: wiki.teamName,
      ...(recordedBy ? { recorded_by: recordedBy } : {}),
      ...(w ? { tool: w.tool, ...(w.repo ? { repo: w.repo } : {}), ...(w.branch ? { branch: w.branch } : {}) } : {}),
    };
    // The phone's and the gateway's links point into their own wikis: not into the team's folder.
    const body = cleanBody(note.entry_page.body_md).replace(/\n## Related\n[\s\S]*?(?=\n## |$)/, "").trimEnd();
    out.push({ kind: "work", title, file: destinationFileName(meta), text: renderWorkLog(meta, body.startsWith("# ") ? body : `# ${title}\n\n${body}`) });
  }
  return out;
}

export async function ingestNote(
  wiki: TeamWiki,
  note: TeamNoteV1,
  opts: IngestOptions,
): Promise<IngestResult & { commit?: string | null }> {
  const recordedBy = opts.recordedBySlug && REF.test(opts.recordedBySlug) ? opts.recordedBySlug : undefined;
  // The id names the raw transcript's file: never a path (the schema says so too).
  if (!NoteId.safeParse(note.note_id).success) throw new IngestError(422, "invalid note: note_id");
  const settings = opts.settings ?? { transcripts: { kind: "repo", folder: "raw" }, work: { kind: "none" }, microsoft: null };
  const files = opts.outbox ? destinationFiles(wiki, note, settings) : [];

  if (opts.readOnly) {
    // Another tool keeps the wiki: Ambient adds no page, and its copy of the transcript would be
    // out of reach (the MCP finds transcripts through their note), so only the files go out.
    if (!files.length) throw new IngestError(409, "read_only");
    const where = (f: DestinationFile) => `drive:${f.file}`;
    if ((await Promise.all(files.map((f) => opts.outbox!.seen(note.note_id, f.kind)))).every(Boolean)) {
      return { status: "duplicate", path: where(files[0]!) };
    }
    for (const f of files) await opts.outbox!.add({ note_id: note.note_id, ...f });
    return { status: "stored", path: where(files[0]!) };
  }

  const existing = wiki.store.findById(note.note_id);
  // A note the team already has stays as it is, except one Apple's model didn't write (quotes
  // or a list of its parts) that the same person's device has now summarized again (the app's
  // Summarize again). Nobody else can replace it: who sent it comes from the gateway.
  const compile = existing?.frontmatter.compile as { fallback?: unknown } | undefined;
  const replacing = !!existing && compile?.fallback !== undefined && compile.fallback !== "none"
    && !!recordedBy && existing.frontmatter.recorded_by === recordedBy;
  if (existing && !replacing) return { status: "duplicate", path: existing.path };

  // Queued before the page is written: if a later step fails, the phone retries, and the same
  // note is queued again into the same file.
  for (const f of files) await opts.outbox!.add({ note_id: note.note_id, ...f });
  const transcript = files.find((f) => f.kind === "transcript");
  const rawPath = transcript && settings.transcripts.kind === "repo" ? `${settings.transcripts.folder}/${transcript.file}` : undefined;

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
    ...(rawPath ? { raw: rawPath } : {}),
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
