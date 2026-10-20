// The team server's HTTP API. Only the gateway may call it: every request
// carries a 60-second ES256 JWT (typ brain-team+jwt, aud team:<id>) that we
// verify against the gateway's public keys.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWK, type JWTPayload } from "jose";
import { clock, IgnorePaths, MicrosoftConnection, TeamNoteV1, TeamSettings, withKind, WorkDestination } from "@brain/spec";
import { dispatchQuery, GitError, HasContent, LocalReader, normalizeIgnore, QueryRequest, type WikiStore } from "@brain/wiki";
import type { Deliverer } from "./destination.ts";
import { GraphError, graphFor as defaultGraphFor, GraphTokens, type DriveFolder, type MicrosoftGraph } from "./graph.ts";
import { destinationFiles, IngestError, ingestNote } from "./ingest.ts";
import type { TeamSettingsStore } from "./settings.ts";
import { ReadOnlyWiki, type TeamWiki } from "./wiki.ts";

export interface TeamAppConfig {
  teamId: string;
  gatewayIssuer: string;
  /** JWKS URL of the gateway (production) or an inline key set (tests). */
  gatewayJwks: string | { keys: JWK[] };
  rawDir: string;
  version: string;
  /** Where the nightly job writes state.json and result JSON; /health reports from it. */
  outDir?: string;
  /** Team settings and delivery to the team's destinations (product/sources.md). */
  settings?: TeamSettingsStore;
  deliverer?: Deliverer;
  /** Tokens the gateway pushes for Ambient's own Microsoft app ("Connect Microsoft 365"). */
  graphTokens?: GraphTokens;
  /** Builds the Graph client for a Microsoft 365 connection (tests inject a fake fetch). */
  graphFor?: (conn: MicrosoftConnection) => MicrosoftGraph;
}

export function createTeamApp(wiki: TeamWiki, cfg: TeamAppConfig): Express {
  const keys = typeof cfg.gatewayJwks === "string" ? createRemoteJWKSet(new URL(cfg.gatewayJwks)) : createLocalJWKSet(cfg.gatewayJwks);
  const app = express();
  app.disable("x-powered-by");

  /** The gateway's token for this team and `purpose`, or null. */
  const verified = async (req: Request, purpose: "query" | "inbox" | "repo" | "settings" | "graph" | "health") => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    try {
      const { payload } = await jwtVerify(header.slice(7), keys, {
        issuer: cfg.gatewayIssuer,
        audience: `team:${cfg.teamId}`,
        typ: "brain-team+jwt",
        algorithms: ["ES256"],
        maxTokenAge: "120s",
      });
      return payload.purpose === purpose ? payload : null;
    } catch {
      return null;
    }
  };

  // Up or not, for anyone. The details (the repo and its errors, the nightly job, the git head)
  // only with the gateway's health token: Caddy keeps others out on Ambient Cloud, but a
  // self-hosted server may not, and the details include the repo's address and git's errors.
  app.get("/health", async (req, res) => {
    const base = { status: "ok", service: "brain-team", version: cfg.version };
    if (!(await verified(req, "health"))) {
      res.json(base);
      return;
    }
    // Catch up with commits from other processes first, so `head` is the wiki as it is.
    await wiki.refresh().catch(() => undefined);
    res.json({
      ...base,
      pages: wiki.store.size,
      consolidate: await jobState(wiki, cfg.outDir, !!wiki.remote?.readOnly),
      repo: wiki.remote?.status() ?? null,
      delivery: (await cfg.deliverer?.status()) ?? null,
      // The wiki's git head: the gateway's health check tells the apps when it moves.
      head: wiki.head,
    });
  });

  const auth = (purpose: "query" | "inbox" | "repo" | "settings" | "graph") => async (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing token" });
      return;
    }
    const payload = await verified(req, purpose);
    if (!payload) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    res.locals.token = payload;
    next();
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
    const mode = req.body?.mode === "read-only" ? "read-only" : "two-way";
    const existing = req.body?.existing === true;
    try {
      const repo = await wiki.exclusive(async () => {
        const status = await remote.connect(url, token, { mode, existing });
        wiki.reload();
        return status;
      });
      res.json({ repo });
    } catch (err) {
      // Files of its own: the app shows what's there and asks before connecting it.
      if (err instanceof HasContent) {
        res.status(409).json({ error: err.code, message: err.message, files: err.files, sample: err.sample });
        return;
      }
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
    // Another tool keeps this wiki: a note is taken only when it has somewhere to go (a recording
    // with a transcript folder, a work session with a work log folder), and checked before
    // anything is stored.
    const readOnly = !!wiki.remote?.readOnly;
    const settings = cfg.settings?.effective(readOnly);
    if (readOnly && !(settings && cfg.deliverer && destinationFiles(wiki, parsed.data, settings).length)) {
      res.status(409).json({ error: "read_only", message: new ReadOnlyWiki().message });
      return;
    }
    const token = res.locals.token as JWTPayload & { recorded_by_slug?: string };
    try {
      const out = await ingestNote(wiki, parsed.data, {
        rawDir: cfg.rawDir,
        recordedBySlug: typeof token.recorded_by_slug === "string" ? token.recorded_by_slug : null,
        settings,
        outbox: cfg.deliverer?.outbox,
        readOnly,
      });
      res.status(out.status === "stored" ? 201 : 200).json({ status: out.status, path: out.path });
      // Delivered after answering, so a slow drive never makes the phone retry.
      void cfg.deliverer?.run().catch((err) => console.error("[team] delivery", err));
    } catch (err) {
      if (err instanceof IngestError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // A token for Ambient's own Microsoft app, for one company: the gateway holds the app's
  // credential and sends a fresh token every 20 minutes (and right after "Connect Microsoft 365").
  app.put("/v1/graph-token", express.json({ limit: "16kb" }), auth("graph"), (req, res) => {
    if (!cfg.graphTokens) {
      res.status(501).json({ error: "unsupported" });
      return;
    }
    const b = (req.body ?? {}) as { tenant_id?: unknown; access_token?: unknown; expires_at?: unknown };
    const now = Date.now();
    if (
      typeof b.tenant_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.tenant_id) ||
      typeof b.access_token !== "string" || b.access_token.length < 20 || b.access_token.length > 12_000 ||
      typeof b.expires_at !== "number" || b.expires_at <= now || b.expires_at > now + 24 * 3600_000
    ) {
      res.status(400).json({ error: "bad token" });
      return;
    }
    cfg.graphTokens.set(b.tenant_id, b.access_token, b.expires_at);
    res.status(204).end();
    // Files that waited for the token go out now.
    void cfg.deliverer?.tokenArrived().catch((err) => console.error("[team] delivery", err));
  });

  // Team settings (product/sources.md): where transcripts and copies of work logs go, and the
  // Microsoft 365 connection. Members read them through the gateway, owners and admins change
  // them (the gateway checks the role). Secrets go in, never out.
  const settingsReply = async (store: TeamSettingsStore) => {
    const readOnly = !!wiki.remote?.readOnly;
    return {
      settings: store.public(readOnly),
      delivery: (await cfg.deliverer?.status()) ?? null,
      repo_mode: wiki.remote?.connected ? (readOnly ? "read-only" : "two-way") : null,
    };
  };

  app.get("/v1/settings", auth("settings"), async (_req, res) => {
    if (!cfg.settings) {
      res.status(501).json({ error: "unsupported", message: "This team server has no settings yet." });
      return;
    }
    res.json(await settingsReply(cfg.settings));
  });

  app.put("/v1/settings", express.json({ limit: "16kb" }), auth("settings"), async (req, res) => {
    const store = cfg.settings;
    if (!store) {
      res.status(501).json({ error: "unsupported", message: "This team server has no settings yet." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next: TeamSettings = structuredClone(store.get());
    const tokens = cfg.graphTokens ?? new GraphTokens();
    const graphFor = cfg.graphFor ?? ((conn: MicrosoftConnection) => defaultGraphFor(conn, tokens));
    /** A folder from a pasted link, or from its drive and item IDs (all a single-folder grant allows). */
    const pick = async (t: Record<string, unknown>): Promise<DriveFolder> => {
      if (!next.microsoft) throw new SettingsError("Connect Microsoft 365 first, then choose a folder.");
      const graph = graphFor(next.microsoft);
      if (typeof t.url === "string" && t.url.trim()) return graph.resolveFolder(t.url);
      if (typeof t.drive_id === "string" && typeof t.folder_id === "string" && t.drive_id.trim() && t.folder_id.trim()) {
        return graph.folder(t.drive_id.trim(), t.folder_id.trim());
      }
      throw new SettingsError("Paste the folder's link, or give its drive ID and folder ID.");
    };
    try {
      if (body.microsoft === null) next.microsoft = null;
      else if (body.microsoft !== undefined) {
        // Apps from before Ambient's own Microsoft app send the company's app without `kind`.
        const conn = MicrosoftConnection.safeParse(withKind(body.microsoft));
        if (!conn.success) throw new SettingsError("Microsoft 365 needs the tenant ID, the app (client) ID and a client secret.");
        // Proves the credentials before they're stored; for Ambient's app, that the gateway has
        // sent a token for this company (only its "Connect Microsoft 365" flow sets this kind).
        await graphFor(conn.data).accessToken();
        next.microsoft = conn.data;
      }
      const t = body.transcripts as Record<string, unknown> | undefined;
      if (t?.kind === "drive") next.transcripts = { kind: "drive", ...(await pick(t)) };
      else if (t?.kind === "repo") {
        if (wiki.remote?.readOnly) throw new SettingsError("This team's repo is kept by another tool, so transcripts can't go there. Choose a OneDrive or SharePoint folder.");
        next.transcripts = { kind: "repo", folder: "raw" };
      } else if (t?.kind === "none") next.transcripts = { kind: "none" };
      else if (t !== undefined) throw new SettingsError("Transcripts go to the team repo, a OneDrive or SharePoint folder, or nowhere.");
      const w = body.work as Record<string, unknown> | undefined;
      if (w?.kind === "drive") next.work = { kind: "drive", ...(await pick(w)) };
      else if (w !== undefined) {
        const parsed = WorkDestination.safeParse(w);
        if (!parsed.success) throw new SettingsError("Work logs go to a OneDrive or SharePoint folder, or nowhere.");
        next.work = parsed.data;
      }
      if (body.ignore !== undefined) {
        const paths = IgnorePaths.safeParse(body.ignore);
        if (!paths.success) throw new SettingsError("Left-out paths are folders or files in the repo, like templates or README.md.");
        next.ignore = normalizeIgnore(paths.data);
      }
      if (!next.microsoft && (next.transcripts.kind === "drive" || next.work.kind === "drive")) {
        throw new SettingsError("A OneDrive or SharePoint folder needs the Microsoft 365 connection. Choose another place first.");
      }
      const valid = TeamSettings.safeParse(next);
      if (!valid.success) throw new SettingsError(`Those settings aren't valid (${valid.error.issues[0]?.path.join(".")}).`);
      await store.save(valid.data);
      wiki.setIgnore(valid.data.ignore);
      res.json(await settingsReply(store));
      void cfg.deliverer?.run().catch((err) => console.error("[team] delivery", err));
    } catch (err) {
      if (err instanceof SettingsError || err instanceof GraphError) {
        res.status(400).json({ error: "settings", message: err.message });
        return;
      }
      throw err;
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ReadOnlyWiki) {
      if (!res.headersSent) res.status(409).json({ error: "read_only", message: err.message });
      return;
    }
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

class SettingsError extends Error {}

/** The nightly job's last result and how many notes still wait to be folded in. */
async function jobState(wiki: TeamWiki, outDir?: string, readOnly = false) {
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
  // A read-only wiki is another tool's: Ambient's nightly upkeep never runs there.
  const pending = readOnly ? [] : wiki.store.ofType("note").filter((n) => typeof n.frontmatter.id === "string" && !done.has(n.frontmatter.id));
  const oldestPending = pending.map((n) => n.sortDate).sort()[0] ?? null;
  return { lastStatus: last?.status ?? null, lastRunAt: last?.finished_at ?? null, pendingNotes: pending.length, oldestPending };
}
