// Talking to team servers. Every request carries a short-lived ES256 JWT
// signed by the gateway (aud = team:<id>); team servers verify it against the
// gateway's public JWKS and accept nothing else.
import { importJWK, SignJWT, type JWK } from "jose";
import { RemoteReader, type QueryRequest, type WikiReader } from "@brain/wiki";
import type { TeamNoteV1 } from "@brain/spec";
import type { Team } from "./directory.ts";

export const TEAM_TOKEN_TYP = "brain-team+jwt";

export class TeamServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * For a claim: whether it surely didn't happen ("refused", "unreachable"), happened for
     * someone else ("taken": the server is in use, keep it out of the pool), or may have
     * ("uncertain": a timeout or a server error after it may have saved the team).
     */
    readonly claim?: "refused" | "unreachable" | "taken" | "uncertain",
  ) {
    super(message);
  }
}

export class TeamLink {
  private keyPromise: Promise<CryptoKey | Uint8Array>;
  private kid: string;

  constructor(
    private issuer: string,
    signingKey: JWK,
    private fetchImpl: typeof fetch = fetch,
    /** Called after a note or work session is stored in a team's wiki (its revision moves). */
    private onStored?: (team: Team) => Promise<void>,
  ) {
    this.kid = signingKey.kid ?? "default";
    this.keyPromise = importJWK(signingKey, "ES256");
  }

  async token(team: Pick<Team, "id" | "slug">, purpose: "query" | "inbox" | "repo" | "settings" | "health", subject?: string, extra: Record<string, string> = {}): Promise<string> {
    return new SignJWT({ ...extra, purpose, team_slug: team.slug })
      .setProtectedHeader({ alg: "ES256", kid: this.kid, typ: TEAM_TOKEN_TYP })
      .setIssuer(this.issuer)
      .setAudience(`team:${team.id}`)
      .setSubject(subject ?? "gateway")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(await this.keyPromise);
  }

  /**
   * Tell a free pool server which team it now serves. It saves that and restarts as the team's
   * server; `ready` waits (briefly) until it answers as one.
   */
  async claim(server: { serverId: string; url: string }, team: { id: string; name: string }): Promise<void> {
    const token = await new SignJWT({ purpose: "claim" })
      .setProtectedHeader({ alg: "ES256", kid: this.kid, typ: TEAM_TOKEN_TYP })
      .setIssuer(this.issuer)
      .setAudience(`pool:${server.serverId}`)
      .setSubject("gateway")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(await this.keyPromise);
    let res: Response;
    try {
      res = await this.fetchImpl(`${server.url}/v1/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ teamId: team.id, teamName: team.name }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      const never = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
      throw new TeamServerError(503, `pool server unreachable: ${(err as Error).message}`, never ? "unreachable" : "uncertain");
    }
    if (res.status === 202) return;
    const claim = res.status === 409 ? "taken" : res.status >= 400 && res.status < 500 ? "refused" : "uncertain";
    throw new TeamServerError(503, `pool server answered ${res.status}`, claim);
  }

  /** True once the server answers as a team's server (not as an unclaimed pool server). */
  async ready(url: string, timeoutMs = 15_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        const res = await this.fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok && (await res.json()).claimed === undefined) return true;
      } catch {
        // Restarting.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async post(team: Team, path: string, purpose: "query" | "inbox", body: unknown, subject?: string, extra?: Record<string, string>): Promise<unknown> {
    if (!team.serverUrl) throw new TeamServerError(503, `team ${team.slug} has no server yet`);
    let res: Response;
    try {
      res = await this.fetchImpl(`${team.serverUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await this.token(team, purpose, subject, extra)}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(purpose === "inbox" ? 20_000 : 8_000),
      });
    } catch (err) {
      throw new TeamServerError(503, `team server unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new TeamServerError(res.status >= 500 ? 503 : res.status, `team server answered ${res.status}`);
    return res.json();
  }

  /** The team repo endpoints, passed through with their status (400s carry a message for the user). */
  repo(team: Team, uid: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<{ status: number; json: unknown }> {
    return this.passThrough(team, uid, "repo", "/v1/repo", method, body, 120_000);
  }

  /** Team settings: destinations and the Microsoft 365 connection (the secret never comes back). */
  settings(team: Team, uid: string, method: "GET" | "PUT", body?: unknown): Promise<{ status: number; json: unknown }> {
    // Choosing a folder asks Microsoft up to three times, each with retries on throttling.
    return this.passThrough(team, uid, "settings", "/v1/settings", method, body, 90_000);
  }

  private async passThrough(
    team: Team,
    uid: string,
    purpose: "repo" | "settings",
    path: string,
    method: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; json: unknown }> {
    if (!team.serverUrl) throw new TeamServerError(503, `team ${team.slug} has no server yet`);
    let res: Response;
    try {
      res = await this.fetchImpl(`${team.serverUrl}${path}`, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${await this.token(team, purpose, uid)}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TeamServerError(503, `team server unreachable: ${(err as Error).message}`);
    }
    if (res.status >= 500) throw new TeamServerError(503, `team server answered ${res.status}`);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }

  reader(team: Team, uid: string): WikiReader {
    return new RemoteReader(async (req: QueryRequest) => {
      const out = (await this.post(team, "/v1/query", "query", req, uid)) as { result: unknown };
      return out.result;
    });
  }

  async deliver(team: Team, note: TeamNoteV1, uid: string, recordedBySlug: string | null): Promise<{ status: "stored" | "duplicate"; path: string }> {
    const extra: Record<string, string> = recordedBySlug ? { recorded_by_slug: recordedBySlug } : {};
    const out = (await this.post(team, "/v1/inbox", "inbox", note, uid, extra)) as { status: "stored" | "duplicate"; path: string };
    if (out.status === "stored") await this.onStored?.(team);
    return out;
  }
}
