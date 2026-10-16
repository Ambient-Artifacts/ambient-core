// The team server's HTTP API. Only the gateway may call it: every request
// carries a 60-second ES256 JWT (typ brain-team+jwt, aud team:<id>) that we
// verify against the gateway's public keys.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWK, type JWTPayload } from "jose";
import { TeamNoteV1 } from "@brain/spec";
import { dispatchQuery, GitError, LocalReader, QueryRequest, type WikiStore } from "@brain/wiki";
import { IngestError, ingestNote } from "./ingest.ts";
import type { TeamWiki } from "./wiki.ts";

export interface TeamAppConfig {
  teamId: string;
  gatewayIssuer: string;
  /** JWKS URL of the gateway (production) or an inline key set (tests). */
  gatewayJwks: string | { keys: JWK[] };
  rawDir: string;
  version: string;
  /** Where the nightly job writes state.json and result JSON; /health reports from it. */
  outDir?: string;
}

export function createTeamApp(wiki: TeamWiki, cfg: TeamAppConfig): Express {
  const keys = typeof cfg.gatewayJwks === "string" ? createRemoteJWKSet(new URL(cfg.gatewayJwks)) : createLocalJWKSet(cfg.gatewayJwks);
  const app = express();
  app.disable("x-powered-by");

  // Open to the core VM only (Caddy). The health check reads the nightly job's state from here.
  app.get("/health", async (_req, res) => {
    // Catch up with commits from other processes first, so `head` is the wiki as it is.
    await wiki.refresh().catch(() => undefined);
    res.json({
      status: "ok",
      service: "brain-team",
      version: cfg.version,
      pages: wiki.store.size,
      consolidate: await jobState(wiki, cfg.outDir),
      repo: wiki.remote?.status() ?? null,
      // The wiki's git head: the gateway's health check tells the apps when it moves.
      head: wiki.head,
    });
  });

  const auth = (purpose: "query" | "inbox" | "repo") => async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing token" });
      return;
    }
    try {
      const { payload } = await jwtVerify(header.slice(7), keys, {
        issuer: cfg.gatewayIssuer,
        audience: `team:${cfg.teamId}`,
        typ: "brain-team+jwt",
        algorithms: ["ES256"],
        maxTokenAge: "120s",
      });
      if (payload.purpose !== purpose) throw new Error("wrong purpose");
      res.locals.token = payload;
      next();
    } catch {
      res.status(401).json({ error: "invalid token" });
    }
  };

  app.post("/v1/query", express.json({ limit: "64kb" }), auth("query"), async (req, res) => {
    const parsed = QueryRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad query" });
      return;
    }
    await wiki.refresh();
    res.json({ result: await dispatchQuery(new TeamReader(wiki.store, cfg.rawDir), parsed.data) });
  });

  // The team's own git repo (set by an admin through the gateway).
  app.get("/v1/repo", auth("repo"), (_req, res) => {
    res.json({ repo: wiki.remote?.status() ?? null });
  });

  app.post("/v1/repo", express.json({ limit: "16kb" }), auth("repo"), async (req, res) => {
    const remote = wiki.remote;
    if (!remote) {
      res.status(501).json({ error: "unsupported", message: "This team server can't connect a repo." });
      return;
    }
    const url = typeof req.body?.url === "string" ? req.body.url : "";
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    try {
      const repo = await wiki.exclusive(async () => {
        const status = await remote.connect(url, token);
        wiki.reload();
        return status;
      });
      res.json({ repo });
    } catch (err) {
      if (err instanceof GitError) {
        res.status(400).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete("/v1/repo", auth("repo"), async (_req, res) => {
    await wiki.exclusive(async () => wiki.remote?.disconnect());
    res.status(204).end();
  });

  app.post("/v1/inbox", express.json({ limit: "2mb" }), auth("inbox"), async (req, res) => {
    const parsed = TeamNoteV1.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad note", issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
      return;
    }
    if (parsed.data.team_id !== cfg.teamId) {
      res.status(400).json({ error: "wrong team" });
      return;
    }
    const token = res.locals.token as JWTPayload & { recorded_by_slug?: string };
    try {
      const out = await ingestNote(wiki, parsed.data, {
        rawDir: cfg.rawDir,
        recordedBySlug: typeof token.recorded_by_slug === "string" ? token.recorded_by_slug : null,
      });
      res.status(out.status === "stored" ? 201 : 200).json({ status: out.status, path: out.path });
    } catch (err) {
      if (err instanceof IngestError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[team] unhandled", err);
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  });
  return app;
}

/** Team reads plus transcripts: the raw copy of each shared note, kept outside git. */
class TeamReader extends LocalReader {
  constructor(
    store: WikiStore,
    private rawDir: string,
  ) {
    super(store);
  }

  async transcript(ref: string): Promise<string | null> {
    const page = this.store.getByRef(ref);
    const id = page?.frontmatter.id;
    if (!page || typeof id !== "string" || !/^[0-9A-Za-z_-]{8,64}$/.test(id)) return null;
    try {
      const raw = JSON.parse(await readFile(join(this.rawDir, `${id}.json`), "utf8")) as { segments?: { t0: number; text: string; speaker?: string }[] };
      const lines = (raw.segments ?? []).map((s) => `[${clock(s.t0)}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`);
      return lines.length ? `Transcript of "${page.title}" (${page.sortDate.slice(0, 10)})\n\n${lines.join("\n")}` : null;
    } catch {
      return null;
    }
  }
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The nightly job's last result and how many notes still wait to be folded in. */
async function jobState(wiki: TeamWiki, outDir?: string) {
  if (!outDir) return null;
  let last: { status: string; finished_at: string } | null = null;
  try {
    const files = (await readdir(join(outDir, "consolidate"))).filter((f) => f.endsWith(".json")).sort();
    if (files.length) last = JSON.parse(await readFile(join(outDir, "consolidate", files[files.length - 1]!), "utf8"));
  } catch {
    // no runs yet
  }
  let done = new Set<string>();
  try {
    done = new Set((JSON.parse(await readFile(join(outDir, "state.json"), "utf8")) as { consolidated: string[] }).consolidated);
  } catch {
    // no state yet
  }
  const pending = wiki.store.ofType("note").filter((n) => typeof n.frontmatter.id === "string" && !done.has(n.frontmatter.id));
  const oldestPending = pending.map((n) => n.sortDate).sort()[0] ?? null;
  return { lastStatus: last?.status ?? null, lastRunAt: last?.finished_at ?? null, pendingNotes: pending.length, oldestPending };
}
