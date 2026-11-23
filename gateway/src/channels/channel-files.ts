// Files that come with a message on Slack or Teams, for a bot (docs/bots.md, "Files in Slack and
// Teams"): downloaded, checked against the same limits as the app's (4 files, 10 MB together),
// and kept in the bot's thread like a file sent from the app, so its run gets them on disk. What
// can't be passed on is named in the message, so the bot knows something was left out.
import type { IncomingFile } from "../bots/attachments.ts";
import { heicToJpeg } from "./heic.ts";

export const FILES_MAX = 4;
export const FILES_BYTES_MAX = 10 * 1024 * 1024;

/** A file a channel offers: its name and type as the channel says, and how to get its bytes. */
export interface OfferedFile {
  name: string;
  type?: string;
  size?: number;
  /** Null: the channel doesn't let Ambient read it (the reason is `why`). */
  fetch: (() => Promise<Buffer>) | null;
  why?: string;
}

const BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

/** What a bot can work with: images, PDFs, text, and Office files (its run opens them with its tools). */
function allowed(type: string): boolean {
  return type.startsWith("image/") || type.startsWith("text/") || type === "application/pdf" || type === "application/json" || type === "application/xml" || type === "application/zip" || type.startsWith("application/vnd.openxmlformats-officedocument.");
}

/** The type from the channel, or from the name when the channel says only "binary". */
export function typeOf(name: string, given?: string): string {
  const t = (given ?? "").toLowerCase().split(";")[0]!.trim();
  if (t && t !== "application/octet-stream" && t !== "binary") return t;
  return BY_EXT[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";
}

function cleanName(name: string): string {
  return name.replace(/[\/\\\0\r\n]/g, "_").trim().slice(-200) || "file";
}

/**
 * Downloads what can be passed on (HEIC photos become JPEG), within the limits. `left` names each
 * file that wasn't, with the reason, for the bot's message.
 */
export async function takeFiles(offered: OfferedFile[]): Promise<{ files: IncomingFile[]; left: string[] }> {
  const files: IncomingFile[] = [];
  const left: string[] = [];
  let bytes = 0;
  for (const f of offered) {
    const name = cleanName(f.name);
    let type = typeOf(name, f.type);
    if (!f.fetch) {
      left.push(`${name} (${f.why ?? "couldn't be opened"})`);
      continue;
    }
    if (files.length >= FILES_MAX) {
      left.push(`${name} (only ${FILES_MAX} files at a time)`);
      continue;
    }
    if (!allowed(type)) {
      left.push(`${name} (a ${type} file: only images, PDFs, text and Office files are passed on)`);
      continue;
    }
    if (f.size && bytes + f.size > FILES_BYTES_MAX) {
      left.push(`${name} (too big: 10 MB at most, together)`);
      continue;
    }
    let data: Buffer;
    try {
      data = await f.fetch();
    } catch (err) {
      left.push(`${name} (couldn't be downloaded: ${(err as Error).message})`);
      continue;
    }
    let shownName = name;
    if (type === "image/heic" || type === "image/heif") {
      const jpeg = await heicToJpeg(data).catch(() => null);
      if (jpeg) {
        data = jpeg;
        type = "image/jpeg";
        shownName = name.replace(/\.(heic|heif)$/i, "") + ".jpg";
      }
    }
    if (bytes + data.length > FILES_BYTES_MAX) {
      left.push(`${name} (too big: 10 MB at most, together)`);
      continue;
    }
    bytes += data.length;
    files.push({ name: shownName, type, data: data.toString("base64") });
  }
  return { files, left };
}

/** The line a bot's message gets about files that weren't passed on. */
export function leftLine(left: string[]): string {
  return left.length ? `\n\n(Also sent, but not passed on to you: ${left.join("; ")}. Say so if you need them.)` : "";
}

/** A download with a size cap (a channel's file URL, with its auth header). */
export async function download(fetchImpl: typeof fetch, url: string, headers: Record<string, string> = {}, max = FILES_BYTES_MAX): Promise<Buffer> {
  const res = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) throw new Error("too big");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error("too big");
  // Slack answers a sign-in page (HTML, 200) when the app may not read files.
  if ((res.headers.get("content-type") ?? "").startsWith("text/html") && buf.subarray(0, 200).toString("utf8").toLowerCase().includes("<!doctype html")) throw new Error("the channel sent a web page instead of the file");
  return buf;
}

/** At most this many earlier messages of a thread go with a message, each cut to this length. */
export const THREAD_MAX = 30;
const THREAD_LINE_MAX = 600;

/**
 * A thread's earlier messages (oldest first), as the bot or Amb reads them with the new one: who
 * said what, also what people said to each other before tagging it. Empty: nothing before.
 */
export function threadSoFar(lines: { who: string; text: string }[], heading = "The thread so far (oldest first):"): string {
  const kept = lines.filter((l) => l.text.trim()).slice(-THREAD_MAX);
  if (!kept.length) return "";
  return `\n\n${heading}\n${kept.map((l) => `- ${l.who}: ${l.text.replace(/\s+/g, " ").trim().slice(0, THREAD_LINE_MAX)}`).join("\n")}`;
}

/** A thread's message as the channels read it: who, what, and when (ms), so a lane takes only what's new. */
export interface ThreadMessage {
  who: string;
  text: string;
  at: number;
}
