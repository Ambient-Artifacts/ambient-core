// POST /v1/sessions: the Claude Code plugin's hook sends a finished session here. The body is
// gzip'd text: the hook's JSON input on the first line, then the transcript (JSONL). Auth is a
// personal token with `sessions:write`, which the Ambient app creates for the plugin.
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { LEGACY_PAT_PREFIX, PAT_PREFIX, type PatService } from "../auth/pats.ts";
import type { Directory } from "../directory.ts";
import { inFlight, limiter } from "../limiter.ts";
import { BadUpload, type SessionService } from "./service.ts";

export function sessionUploadRouter(d: { pats: PatService; directory: Directory; sessions: SessionService }): Router {
  const r = express.Router();
  const allow = limiter(30);
  const perUser = inFlight(2);
  const everyone = inFlight(6);

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
    // Up to 150 MB each, held in memory while they're read and condensed: two at a time per
    // account, a few for everyone (the plugin sends one when a session ends, and retries).
    const mine = perUser(pat.uid);
    const ours = mine && everyone("all");
    if (!mine || !ours) {
      mine?.();
      res.status(429).json({ error: "slow_down" });
      return;
    }
    res.on("close", () => {
      mine();
      ours();
    });
    res.locals.uid = pat.uid;
    next();
  };

  // body-parser inflates `Content-Encoding: gzip`; the limit applies to the inflated size.
  r.post("/v1/sessions", authenticate, express.raw({ type: () => true, limit: "150mb" }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    try {
      const out = await d.sessions.receive(res.locals.uid as string, body);
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
