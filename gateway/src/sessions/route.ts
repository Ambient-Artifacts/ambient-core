// POST /v1/sessions: the Claude Code plugin's hook sends a finished session here. The body is
// gzip'd text: the hook's JSON input on the first line, then the transcript (JSONL). Auth is a
// personal token with `sessions:write`, which the Ambient app creates for the plugin.
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { createGunzip, createInflate } from "node:zlib";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { LEGACY_PAT_PREFIX, PAT_PREFIX, type PatService } from "../auth/pats.ts";
import type { Directory } from "../directory.ts";
import { inFlight, limiter } from "../limiter.ts";
import { claudeCodeReader } from "./condense.ts";
import { BadUpload, type SessionService } from "./service.ts";

export function sessionUploadRouter(d: { pats: PatService; directory: Directory; sessions: SessionService }): Router {
  const r = express.Router();
  const allow = limiter(30);
  const perUser = inFlight(2);
  const everyone = inFlight(UPLOADS_AT_ONCE);

  // The token first, from the headers alone: only then is the body read, so nobody can make the
  // gateway inflate and buffer an upload (or a gzip bomb) without a valid token.
  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const pat = token.startsWith(PAT_PREFIX) || token.startsWith(LEGACY_PAT_PREFIX) ? await d.pats.find(token) : undefined;
    if (!pat || pat.resource.kind !== "personal" || !(await d.directory.user(pat.uid))) {
      res.status(401).json({ error: "invalid_token", message: "Create a new token in the Ambient app (Settings → Work sessions)." });
      return;
    }
    if (!pat.scopes.includes("sessions:write")) {
      res.status(403).json({ error: "insufficient_scope", message: "This token can't send sessions. Create one in Settings → Work sessions." });
      return;
    }
    if (!allow(pat.uid)) {
      res.status(429).json({ error: "slow_down" });
      return;
    }
    // Two at a time per account (the plugin sends one when a session ends, and retries), and
    // UPLOADS_AT_ONCE for everyone: each keeps up to about 40 MB (claudeCodeReader's KEEP_CHARS
    // plus its lines), and sign-ups are open. A slot is held UPLOAD_DEADLINE_MS at most, so a few
    // accounts trickling bodies can't keep them all for long.
    const mine = perUser(pat.uid);
    const ours = mine && everyone("all");
    if (!mine || !ours) {
      mine?.();
      res.status(429).json({ error: "slow_down" });
      return;
    }
    const deadline = setTimeout(() => req.destroy(), UPLOAD_DEADLINE_MS);
    res.on("close", () => {
      clearTimeout(deadline);
      mine();
      ours();
    });
    res.locals.uid = pat.uid;
    next();
  };

  // Streamed, a line at a time: a transcript can be well over 100 MB (tool output, images) and only
  // its prompts, answers and actions are kept. MAX_UPLOAD_BYTES applies to the inflated size.
  r.post("/v1/sessions", authenticate, async (req, res) => {
    const encoding = String(req.headers["content-encoding"] ?? "identity").toLowerCase();
    const inflate = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "identity" ? null : undefined;
    if (inflate === undefined) {
      res.status(415).json({ error: "unsupported_encoding", message: "Send the session as gzip or as plain text." });
      return;
    }
    const source: Readable = inflate ? req.pipe(inflate) : req;
    let meta: string | null = null;
    const reader = claudeCodeReader();
    try {
      for await (const line of lines(source, MAX_UPLOAD_BYTES, MAX_LINE_CHARS)) {
        if (meta === null) meta = line;
        else reader.line(line);
      }
      const out = await d.sessions.receiveParsed(res.locals.uid as string, meta ?? "", reader.done());
      res.status(out.status === "queued" ? 202 : 200).json(out);
    } catch (err) {
      inflate?.destroy();
      if (err instanceof TooLarge) {
        res.status(413).set("Connection", "close").json({ error: "too_large", message: `Sessions over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB aren't taken.` });
        // The rest is read and dropped (not inflated), so the client gets the answer rather than a
        // reset; the server's request timeout ends one that never stops.
        req.unpipe();
        req.resume();
        return;
      }
      if (err instanceof BadUpload || (err as { code?: string }).code?.startsWith("Z_")) {
        res.status(400).json({ error: "bad_upload", message: err instanceof BadUpload ? err.message : "The upload isn't valid gzip." });
        return;
      }
      if (req.destroyed || res.writableEnded) return; // the client went away
      throw err;
    }
  });

  return r;
}

/** An upload's inflated size limit. */
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;
/** Uploads being read at once, across all accounts, and how long one may take. */
export const UPLOADS_AT_ONCE = 24;
export const UPLOAD_DEADLINE_MS = 180_000;
/** Longer lines are skipped unread: a screenshot or a file's contents, never something a note uses. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

class TooLarge extends Error {}

/** The stream's lines (UTF-8), without holding more than one line at a time. */
async function* lines(stream: AsyncIterable<Buffer>, maxBytes: number, maxLine: number): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let total = 0;
  let carry = "";
  let skipping = false;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new TooLarge();
    const text = decoder.write(chunk);
    let start = 0;
    for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
      if (!skipping) yield carry + text.slice(start, nl);
      carry = "";
      skipping = false;
      start = nl + 1;
    }
    if (skipping) continue;
    carry += text.slice(start);
    if (carry.length > maxLine) {
      carry = "";
      skipping = true;
    }
  }
  const last = carry + decoder.end();
  if (!skipping && last) yield last;
}
