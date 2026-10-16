// POST /v1/sessions: the Claude Code plugin's hook sends a finished session here. The body is
// gzip'd text: the hook's JSON input on the first line, then the transcript (JSONL). Auth is a
// personal token with `sessions:write`, which the Ambient app creates for the plugin.
import express, { type Router } from "express";
import { LEGACY_PAT_PREFIX, PAT_PREFIX, type PatService } from "../auth/pats.ts";
import type { Directory } from "../directory.ts";
import { BadUpload, type SessionService } from "./service.ts";

export function sessionUploadRouter(d: { pats: PatService; directory: Directory; sessions: SessionService }): Router {
  const r = express.Router();
  const hits = new Map<string, { at: number; n: number }>();
  const allow = (uid: string) => {
    const now = Date.now();
    const h = hits.get(uid);
    if (!h || now - h.at > 60_000) {
      hits.set(uid, { at: now, n: 1 });
      if (hits.size > 50_000) hits.clear();
      return true;
    }
    return ++h.n <= 30;
  };

  // body-parser inflates `Content-Encoding: gzip`; the limit applies to the inflated size.
  r.post("/v1/sessions", express.raw({ type: () => true, limit: "150mb" }), async (req, res) => {
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
    const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    try {
      const out = await d.sessions.receive(pat.uid, body);
      res.status(out.status === "queued" ? 202 : 200).json(out);
    } catch (err) {
      if (err instanceof BadUpload) {
        res.status(400).json({ error: "bad_upload", message: err.message });
        return;
      }
      throw err;
    }
  });

  return r;
}
