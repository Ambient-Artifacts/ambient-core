// oidc-provider storage on Convex. Sessions, interactions, grants, codes,
// refresh tokens and dynamically registered clients all live in the `oauth`
// table; JWT access tokens are self-contained and never stored.
//
// Nothing stored there is usable on its own. A code, a refresh token or a session id is a bearer
// secret, and oidc-provider uses it as the row's id (and in the payload as `jti`). So the id, the
// session `uid` and `userCode` are stored as HMACs, and the payload is sealed (AES-256-GCM, bound to
// its model and key) with keys derived from the master key, which Convex never sees. Someone with
// the database, an export or a backup can't redeem a token or a code from it.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { errors, type Adapter, type AdapterPayload } from "oidc-provider";
import { api, type Control } from "../control.ts";
import type { MasterKey } from "../crypto.ts";

const NEVER = 8_640_000_000_000_000; // max Date in ms

type Stored = { key: string; payload: string; consumedAt: number | null } | null;

export function convexAdapterFactory(control: Control, master: MasterKey) {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master.key, Buffer.alloc(0), info, 32));
  const sealKey = derive("ambient oauth rows: seal");
  const lookupKey = derive("ambient oauth rows: lookup");
  const hash = (field: string, model: string, value: string) =>
    `h1:${createHmac("sha256", lookupKey).update(`${field}:${model}:${value}`).digest("base64url")}`;

  const seal = (model: string, key: string, json: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", sealKey, iv);
    cipher.setAAD(Buffer.from(`oauth:${model}:${key}`));
    const body = Buffer.concat([cipher.update(json, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
  };

  const open = (model: string, row: Stored): AdapterPayload | undefined => {
    if (!row) return undefined;
    let payload: AdapterPayload;
    if (row.payload.startsWith("{")) {
      // Written before rows were sealed (they expire within 180 days of 2026-10-16).
      payload = JSON.parse(row.payload) as AdapterPayload;
    } else {
      const [, iv, body] = row.payload.split(".");
      const raw = Buffer.from(body ?? "", "base64url");
      const decipher = createDecipheriv("aes-256-gcm", sealKey, Buffer.from(iv ?? "", "base64url"));
      decipher.setAAD(Buffer.from(`oauth:${model}:${row.key}`));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8")) as AdapterPayload;
    }
    // Convex marks a used code or token in a column of its own (it can't read the payload).
    if (row.consumedAt !== null && payload.consumed === undefined) payload.consumed = Math.floor(row.consumedAt / 1000);
    return payload;
  };

  return (model: string): Adapter => ({
    async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
      const key = hash("id", model, id);
      await control.m(api.oauth.upsert, {
        model,
        key,
        legacyKey: id,
        payload: seal(model, key, JSON.stringify(payload)),
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : NEVER,
        grantId: payload.grantId,
        uid: payload.uid ? hash("uid", model, payload.uid) : undefined,
        userCode: payload.userCode ? hash("userCode", model, payload.userCode) : undefined,
        accountId: payload.accountId,
        clientId: payload.clientId,
      });
    },
    async find(id: string) {
      return open(model, await control.q(api.oauth.find, { model, key: hash("id", model, id), legacyKey: id, now: Date.now() }));
    },
    async findByUid(uid: string) {
      return open(model, await control.q(api.oauth.findByUid, { model, uid: hash("uid", model, uid), legacyUid: uid, now: Date.now() }));
    },
    async findByUserCode(userCode: string) {
      return open(model, await control.q(api.oauth.findByUserCode, { model, userCode: hash("userCode", model, userCode), legacyUserCode: userCode, now: Date.now() }));
    },
    async consume(id: string) {
      const out = await control.m(api.oauth.consume, { model, key: hash("id", model, id), legacyKey: id, now: Date.now() });
      // Used twice (two requests raced past oidc-provider's own check): Convex has ended the grant.
      if (out.reused) throw new errors.InvalidGrant("grant request is invalid");
    },
    async destroy(id: string) {
      await control.m(api.oauth.destroy, { model, key: hash("id", model, id), legacyKey: id });
    },
    async revokeByGrantId(grantId: string) {
      await control.m(api.oauth.revokeByGrantId, { grantId });
    },
  });
}
