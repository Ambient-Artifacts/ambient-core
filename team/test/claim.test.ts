// A pool server's one job before it has a team: accept the gateway's claim, once, and only
// when it holds no earlier team's wiki.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUnclaimedApp } from "../src/claim.ts";

const ISSUER = "https://mcp.example.test";
const TEAM = "jd7abc123def456ghi789jkl";
let privateKey: CryptoKey;
let jwk: JWK;
const servers: Server[] = [];

beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
});
afterAll(() => servers.forEach((s) => s.close()));

async function pool(dataDir: string, claims: unknown[]) {
  const server = createServer(
    createUnclaimedApp({ serverId: "pool-1", dataDir, gatewayIssuer: ISSUER, gatewayJwks: { keys: [jwk] }, version: "test", onClaimed: (t) => claims.push(t) }),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const token = (aud: string, purpose = "claim") =>
  new SignJWT({ purpose })
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "brain-team+jwt" })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setSubject("gateway")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);

const claim = async (url: string, bearer: string) =>
  fetch(`${url}/v1/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ teamId: TEAM, teamName: "Ambient Artifacts" }),
  });

describe("pool server claim", () => {
  it("says it's unclaimed, takes one claim addressed to it, and saves it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-pool-"));
    const claims: unknown[] = [];
    const url = await pool(dir, claims);
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ claimed: false, serverId: "pool-1" });
    expect((await claim(url, await token("pool:pool-2"))).status).toBe(401);
    expect((await claim(url, await token("team:" + TEAM))).status).toBe(401);
    expect((await claim(url, await token("pool:pool-1", "query"))).status).toBe(401);
    expect((await claim(url, await token("pool:pool-1"))).status).toBe(202);
    expect(JSON.parse(readFileSync(join(dir, "team.json"), "utf8"))).toMatchObject({ teamId: TEAM, teamName: "Ambient Artifacts" });
    expect(claims).toEqual([{ teamId: TEAM, teamName: "Ambient Artifacts" }]);
    expect((await claim(url, await token("pool:pool-1"))).status).toBe(409);
  });

  it("refuses when an earlier team's wiki is still on the server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-pool-"));
    mkdirSync(join(dir, "wiki"));
    writeFileSync(join(dir, "wiki", "index.md"), "# Old team\n");
    const claims: unknown[] = [];
    const url = await pool(dir, claims);
    const res = await claim(url, await token("pool:pool-1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wiki_not_empty" });
    expect(claims).toEqual([]);
  });
});
