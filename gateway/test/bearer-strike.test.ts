// Which failed tokens count against an address (AuthError.strike): made-up ones, not expired ones.
import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { AuthError, createBearerVerifier } from "../src/auth/bearer.ts";

describe("failed-token strikes", () => {
  it("don't count an expired token, Bearer or DPoP; do count a bad signature", async () => {
    const issuer = "https://gw.example";
    const target = { url: `${issuer}/mcp`, teamSlug: null };
    const signing = await generateKeyPair("ES256", { extractable: true });
    const jwk = { ...(await exportJWK(signing.privateKey)), kid: "k1", alg: "ES256", use: "sig" };
    const verify = createBearerVerifier({ issuer, signingKeys: [jwk as never], directory: {} as never, pats: {} as never });
    const device = await generateKeyPair("ES256", { extractable: true });
    const pub = await exportJWK(device.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const token = (claims: Record<string, unknown>, key = signing.privateKey) =>
      new SignJWT({ scope: "personal:read", client_id: "c", ...claims })
        .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "at+jwt" })
        .setIssuer(issuer)
        .setAudience(target.url)
        .setSubject("u1")
        .setIssuedAt(now - 7200)
        .setExpirationTime(now - 3600)
        .setJti(randomUUID())
        .sign(key);
    const dpopToken = await token({ cnf: { jkt: await calculateJwkThumbprint(pub) } });
    const proof = await new SignJWT({ htm: "POST", htu: target.url, ath: createHash("sha256").update(dpopToken).digest("base64url") })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: { kty: pub.kty!, crv: pub.crv!, x: pub.x!, y: pub.y! } })
      .setIssuedAt()
      .setJti(randomUUID())
      .sign(device.privateKey);
    const strike = async (header: string, p?: string) => {
      const err = await verify(header, target, { method: "POST", proof: p }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      return (err as AuthError).strike;
    };
    expect(await strike(`Bearer ${await token({})}`)).toBe(false);
    expect(await strike(`DPoP ${dpopToken}`, proof)).toBe(false);
    expect(await strike(`Bearer ${await token({}, device.privateKey)}`)).toBe(true);
  });
});
