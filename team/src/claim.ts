// A pool server before it has a team: it answers /health and one request, the gateway's claim
// ("you now serve team X"), signed like every other gateway call and addressed to this server's
// id. The claim is saved to team.json and the process restarts (systemd) as that team's server.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import express, { type Express } from "express";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWK } from "jose";

export interface UnclaimedConfig {
  serverId: string;
  dataDir: string;
  gatewayIssuer: string;
  gatewayJwks: string | { keys: JWK[] };
  version: string;
  /** After the claim is saved (production: exit, so systemd starts the team server). */
  onClaimed: (team: { teamId: string; teamName: string }) => void;
}

export function createUnclaimedApp(cfg: UnclaimedConfig): Express {
  const keys = typeof cfg.gatewayJwks === "string" ? createRemoteJWKSet(new URL(cfg.gatewayJwks)) : createLocalJWKSet(cfg.gatewayJwks);
  const app = express();
  app.disable("x-powered-by");
  let claimed = false;

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "brain-team", version: cfg.version, claimed, serverId: cfg.serverId });
  });

  app.post("/v1/claim", express.json({ limit: "4kb" }), async (req, res) => {
    const header = req.headers.authorization;
    try {
      if (!header?.startsWith("Bearer ")) throw new Error("missing token");
      const { payload } = await jwtVerify(header.slice(7), keys, {
        issuer: cfg.gatewayIssuer,
        audience: `pool:${cfg.serverId}`,
        typ: "brain-team+jwt",
        algorithms: ["ES256"],
        maxTokenAge: "120s",
      });
      if (payload.purpose !== "claim") throw new Error("wrong purpose");
    } catch {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
    const teamName = typeof req.body?.teamName === "string" ? req.body.teamName.trim().slice(0, 80) : "";
    if (!/^[a-z0-9]{10,64}$/.test(teamId) || !teamName) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (claimed) {
      res.status(409).json({ error: "already_claimed" });
      return;
    }
    // Taken before the first await, so two claims at once can't both get through.
    claimed = true;
    // A server that still holds a wiki (an earlier team's) must never hand it to a new team.
    if ((await readdir(join(cfg.dataDir, "wiki")).catch(() => [])).length) {
      console.error(`[team] refusing a claim: ${join(cfg.dataDir, "wiki")} is not empty`);
      claimed = false;
      res.status(409).json({ error: "wiki_not_empty" });
      return;
    }
    await mkdir(cfg.dataDir, { recursive: true });
    await writeFile(join(cfg.dataDir, "team.json"), JSON.stringify({ teamId, teamName, claimedAt: new Date().toISOString() }, null, 2));
    res.status(202).json({ ok: true });
    cfg.onClaimed({ teamId, teamName });
  });

  return app;
}
