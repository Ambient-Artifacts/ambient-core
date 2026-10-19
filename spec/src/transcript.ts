// The files a team's destination receives (product/sources.md): a transcript for each shared
// recording and, when the team wants them, a copy of each shared work log. Front matter in the
// app's own style (BrainCore WikiWriter.transcriptPage: one key per line, flow values, strings
// double-quoted), so pipelines that read the app's transcripts read these too; then one line
// per segment, `[HH:MM:SS] Speaker: text`, as in the MCP `transcript` tool.
import { slugify } from "./page.ts";

export interface TranscriptMeta {
  id: string;
  title: string;
  recorded_at: string;
  ended_at?: string;
  duration_s: number;
  locale: string;
  /** The team's name. */
  team: string;
  recorded_by?: string;
  meeting?: { title: string; start?: string; end?: string; attendees: string[] };
  speakers: string[];
}

export interface TranscriptSegment {
  t0: number;
  text: string;
  speaker?: string;
}

export interface WorkLogMeta {
  id: string;
  title: string;
  summary: string;
  recorded_at: string;
  ended_at?: string;
  team: string;
  recorded_by?: string;
  /** Where the work happened: the AI app or agent, and the repository and branch when known. */
  tool?: string;
  repo?: string;
  branch?: string;
}

type Flow = string | number | boolean | Flow[] | { [key: string]: Flow | undefined };

/** A value the way the app writes it: JSON strings (valid YAML), `[a, b]` lists, `{k: v}` maps. */
function flow(v: Flow): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(flow).join(", ")}]`;
  return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${k}: ${flow(x!)}`).join(", ")}}`;
}

function page(fields: [string, Flow | undefined][], body: string): string {
  const lines = fields.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${flow(v!)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** 0 → "00:00:00". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** `YYYY-MM/YYYY-MM-DD-<title>-<id6>.md`, relative to the destination folder. Stable for a note. */
export function destinationFileName(meta: { id: string; title: string; recorded_at: string }): string {
  const date = meta.recorded_at.slice(0, 10);
  const slug = slugify(meta.title).slice(0, 60).replace(/-+$/, "") || "note";
  return `${date.slice(0, 7)}/${date}-${slug}-${meta.id.slice(-6).toLowerCase()}.md`;
}

export function transcriptLines(segments: TranscriptSegment[]): string[] {
  return segments
    .filter((s) => s.text.trim())
    .map((s) => {
      const speaker = s.speaker?.replace(/[\r\n:]+/g, " ").replace(/\s+/g, " ").trim();
      return `[${clock(s.t0)}] ${speaker ? `${speaker}: ` : ""}${s.text.replace(/\s+/g, " ").trim()}`;
    });
}

export function renderTranscript(meta: TranscriptMeta, segments: TranscriptSegment[]): string {
  const m = meta.meeting;
  return page(
    [
      ["id", meta.id],
      ["type", "transcript"],
      ["title", meta.title],
      ["recorded_at", meta.recorded_at],
      ["ended_at", meta.ended_at],
      ["duration_s", meta.duration_s],
      ["locale", meta.locale],
      ["scope", "team"],
      ["team", meta.team],
      ["recorded_by", meta.recorded_by],
      ["meeting", m ? { title: m.title, start: m.start, end: m.end, attendees: m.attendees } : undefined],
      ["speakers", meta.speakers],
    ],
    `${transcriptLines(segments).join("\n")}\n`,
  );
}

export function renderWorkLog(meta: WorkLogMeta, bodyMd: string): string {
  return page(
    [
      ["id", meta.id],
      ["type", "work"],
      ["title", meta.title],
      ["summary", meta.summary],
      ["recorded_at", meta.recorded_at],
      ["ended_at", meta.ended_at],
      ["scope", "team"],
      ["team", meta.team],
      ["recorded_by", meta.recorded_by],
      ["tool", meta.tool],
      ["repo", meta.repo],
      ["branch", meta.branch],
    ],
    `${bodyMd.trim()}\n`,
  );
}
