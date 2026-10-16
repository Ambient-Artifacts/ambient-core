// oidc-provider storage on Convex. Sessions, interactions, grants, codes,
// refresh tokens and dynamically registered clients all live in the `oauth`
// table; JWT access tokens are self-contained and never stored.
import type { Adapter, AdapterPayload } from "oidc-provider";
import { api, type Control } from "../control.ts";

const NEVER = 8_640_000_000_000_000; // max Date in ms

export function convexAdapterFactory(control: Control) {
  return (model: string): Adapter => ({
    async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
      await control.m(api.oauth.upsert, {
        model,
        key: id,
        payload: JSON.stringify(payload),
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : NEVER,
        grantId: payload.grantId,
        uid: payload.uid,
        userCode: payload.userCode,
      });
    },
    async find(id: string) {
      const p = await control.q(api.oauth.find, { model, key: id, now: Date.now() });
      return p ? (JSON.parse(p) as AdapterPayload) : undefined;
    },
    async findByUid(uid: string) {
      const p = await control.q(api.oauth.findByUid, { model, uid, now: Date.now() });
      return p ? (JSON.parse(p) as AdapterPayload) : undefined;
    },
    async findByUserCode(userCode: string) {
      const p = await control.q(api.oauth.findByUserCode, { model, userCode, now: Date.now() });
      return p ? (JSON.parse(p) as AdapterPayload) : undefined;
    },
    async consume(id: string) {
      await control.m(api.oauth.consume, { model, key: id, now: Date.now() });
    },
    async destroy(id: string) {
      await control.m(api.oauth.destroy, { model, key: id });
    },
    async revokeByGrantId(grantId: string) {
      await control.m(api.oauth.revokeByGrantId, { grantId });
    },
  });
}
