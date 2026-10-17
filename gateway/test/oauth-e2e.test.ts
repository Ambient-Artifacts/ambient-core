// The OAuth flow an MCP client (claude.ai, ChatGPT, Codex) runs against us,
// with the MVP login: a pairing code shown in the Brain app.
// 401 → resource metadata → AS metadata → dynamic registration → authorize
// (PKCE + resource) → pairing code → consent → token → MCP → refresh → revoke.
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, CookieJar, dpopKey, dpopProof, fixturePersonalOps, followUntil, get, INVITE, mcpClient, pkce, postForm, signIn, startStack, text, type Stack } from "./helpers.ts";

const REDIRECT = "http://127.0.0.1:9/callback";
/** A well-formed code nobody was given. */
const WRONG = "AAAA2222";
let s: Stack;
let lena: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  s = await startStack();
  lena = await signIn(s, "apple-lena", "Lena Vogel");
  await appCall(s, lena.access_token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps() });
  await appCall(s, lena.access_token, "POST", "/v1/app/teams/join", { code: INVITE });
});
afterAll(() => s.close());

interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  code_challenge_methods_supported: string[];
}

async function discover(resourcePath: string) {
  const unauth = await fetch(`${s.origin}${resourcePath}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(unauth.status).toBe(401);
  const prmUrl = /resource_metadata="([^"]+)"/.exec(unauth.headers.get("www-authenticate") ?? "")?.[1];
  expect(prmUrl).toBe(`${s.origin}/.well-known/oauth-protected-resource${resourcePath}`);
  const prm = (await (await fetch(prmUrl!)).json()) as { resource: string; authorization_servers: string[] };
  const as = (await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as AsMetadata;
  return { prm, as };
}

async function register(as: AsMetadata) {
  const res = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP Client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function pairingCode(accessToken: string): Promise<string> {
  const res = await appCall(s, accessToken, "POST", "/v1/app/pairing-codes");
  expect(res.status).toBe(200);
  return String(res.json.code);
}

/** Up to the code page: the sign-in's URL and its cookies. */
async function startLogin(as: AsMetadata, clientId: string, resource: string | null, challenge: string) {
  const jar = new CookieJar();
  const url = new URL(as.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: resource?.endsWith("/t/acme/mcp") ? "team:read" : "personal:read team:read",
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  if (resource) params.resource = resource;
  url.search = new URLSearchParams(params).toString();

  const step = await followUntil(await get(url.toString(), jar), s.origin, jar, `${s.origin}/interaction/`);
  expect(await (await get(step.url, jar)).text()).toContain("enter the code it shows");
  return { jar, step };
}

async function authorize(as: AsMetadata, clientId: string, resource: string | null, appToken: string, challenge: string, opts: { wrongCodes?: number } = {}) {
  const started = await startLogin(as, clientId, resource, challenge);
  const jar = started.jar;
  let step = started.step;
  let res: Response;
  for (let i = 0; i < (opts.wrongCodes ?? 0); i++) {
    res = await postForm(`${step.url}/login`, jar, { code: WRONG });
    if (res.status !== 401) break;
  }
  const code = await pairingCode(appToken);
  // Typed the way people do: lower case, with a space.
  res = await postForm(`${step.url}/login`, jar, { code: `${code.slice(0, 4)} ${code.slice(4)}`.toLowerCase() });
  step = await followUntil(res, s.origin, jar, [`${s.origin}/interaction/`, REDIRECT]);
  if (step.url.startsWith(REDIRECT)) {
    // Login was refused outright (too many attempts): the flow ended at the client with an error.
    return { callback: new URL(step.url), consentHtml: "" };
  }
  const consentHtml = await (await get(step.url, jar)).text();
  res = await postForm(`${step.url}/confirm`, jar, {});
  const done = await followUntil(res, s.origin, jar, REDIRECT);
  return { callback: new URL(done.url), consentHtml };
}

async function token(as: AsMetadata, body: Record<string, string>) {
  const res = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, string> };
}

describe("disconnecting an AI app in the app", () => {
  it("lists the connected app by name and ends its tokens at once", async () => {
    const { as } = await discover("/mcp");
    const clientId = await register(as);
    const { verifier, challenge } = pkce();
    const resource = `${s.origin}/mcp`;
    const { callback, consentHtml } = await authorize(as, clientId, resource, lena.access_token, challenge);
    expect(consentHtml).toContain("For <b>Lena Vogel");
    const t = await token(as, { grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource });
    expect(t.status).toBe(200);

    const listed = (await appCall(s, lena.access_token, "GET", "/v1/app/connections")).json.connections as { id: string; clientId: string; name: string }[];
    const mine = listed.find((c) => c.clientId === clientId)!;
    expect(mine.name).toBe("Test MCP Client");
    const other = await signIn(s, "apple-someone-else", "Someone Else");
    expect((await appCall(s, other.access_token, "DELETE", `/v1/app/connections/${encodeURIComponent(mine.id)}`)).status).toBe(404);
    expect((await appCall(s, lena.access_token, "DELETE", `/v1/app/connections/${encodeURIComponent(mine.id)}`)).status).toBe(204);

    expect((await token(as, { grant_type: "refresh_token", refresh_token: t.json.refresh_token!, client_id: clientId, resource })).status).toBe(400);
    const after = (await appCall(s, lena.access_token, "GET", "/v1/app/connections")).json.connections as { clientId: string }[];
    expect(after.map((c) => c.clientId)).not.toContain(clientId);
  });
});

describe("OAuth for the personal /mcp resource", () => {
  it("runs discovery → DCR → pairing code → token → MCP → refresh → revoke", async () => {
    const { as } = await discover("/mcp");
    expect(as.issuer).toBe(s.origin);
    expect(as.code_challenge_methods_supported).toContain("S256");

    const clientId = await register(as);
    const { verifier, challenge } = pkce();
    const resource = `${s.origin}/mcp`;
    const { callback, consentHtml } = await authorize(as, clientId, resource, lena.access_token, challenge);
    expect(consentHtml).toContain("Allow Test MCP Client?");
    expect(callback.searchParams.get("state")).toBe("st4te");

    const t = await token(as, {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    });
    expect(t.status).toBe(200);
    expect(decodeProtectedHeader(t.json.access_token!).typ).toBe("at+jwt");
    const claims = decodeJwt(t.json.access_token!);
    expect(claims).toMatchObject({ aud: resource, sub: lena.user.uid });

    const client = await mcpClient(resource, t.json.access_token!);
    const found = text(await client.callTool({ name: "search", arguments: { query: "Müller" } }));
    expect(found).toContain("Anna Müller");
    const team = text(await client.callTool({ name: "brief", arguments: { about: "Bergmann", scope: "team" } }));
    expect(team).toContain("Bergmann Logistik");
    await client.close();

    // The database holds nothing a token could be redeemed from: no row is keyed by the refresh
    // token or carries it, and every payload is sealed.
    const rows = await s.t.run(async (ctx) => ctx.db.query("oauth").collect());
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).not.toBe(t.json.refresh_token);
      expect(row.payload).not.toContain(t.json.refresh_token!);
      expect(row.payload.startsWith("v1.")).toBe(true);
    }

    // Nor is a row's stored key a token: handed in as one, it's refused.
    for (const row of rows.filter((r) => r.model === "RefreshToken")) {
      expect((await token(as, { grant_type: "refresh_token", refresh_token: row.key, client_id: clientId, resource })).status).toBe(400);
    }

    const r1 = await token(as, { grant_type: "refresh_token", refresh_token: t.json.refresh_token!, client_id: clientId, resource });
    expect(r1.status).toBe(200);
    expect((await token(as, { grant_type: "refresh_token", refresh_token: t.json.refresh_token!, client_id: clientId, resource })).status).toBe(400);

    const rev = await fetch(as.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: r1.json.refresh_token!, client_id: clientId }),
    });
    expect(rev.status).toBe(200);
    expect((await token(as, { grant_type: "refresh_token", refresh_token: r1.json.refresh_token!, client_id: clientId, resource })).status).toBe(400);
  });

  it("works for a client that uses DPoP, and refuses its token without the proof", async () => {
    const { as } = await discover("/mcp");
    const clientId = await register(as);
    const { verifier, challenge } = pkce();
    const resource = `${s.origin}/mcp`;
    const { callback } = await authorize(as, clientId, resource, lena.access_token, challenge);
    const key = await dpopKey();
    const res = await fetch(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: await dpopProof(key, "POST", as.token_endpoint) },
      body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource }),
    });
    const t = (await res.json()) as Record<string, string>;
    expect(t.token_type).toBe("DPoP");
    const call = async (authorization: string, dpop?: string) =>
      (
        await fetch(resource, {
          method: "POST",
          headers: { authorization, ...(dpop ? { dpop } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        })
      ).status;
    expect(await call(`DPoP ${t.access_token}`, await dpopProof(key, "POST", resource, t.access_token))).toBe(200);
    expect(await call(`Bearer ${t.access_token}`)).toBe(401);
    expect(await call(`DPoP ${t.access_token}`)).toBe(401);
    expect(await call(`DPoP ${t.access_token}`, await dpopProof(await dpopKey(), "POST", resource, t.access_token))).toBe(401);
  });

  it("defaults to /mcp when the client sends no resource parameter", async () => {
    const { as } = await discover("/mcp");
    const clientId = await register(as);
    const { verifier, challenge } = pkce();
    const { callback } = await authorize(as, clientId, null, lena.access_token, challenge);
    const t = await token(as, { grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect(t.status).toBe(200);
    expect(decodeJwt(t.json.access_token!).aud).toBe(`${s.origin}/mcp`);
  });

  it("locks the login after five wrong codes", async () => {
    const { as } = await discover("/mcp");
    const clientId = await register(as);
    const { challenge } = pkce();
    const { callback } = await authorize(as, clientId, null, lena.access_token, challenge, { wrongCodes: 5 });
    expect(callback.searchParams.get("error")).toBe("access_denied");
  });
});

describe("OAuth for a team-pinned resource (M365 Copilot style)", () => {
  it("issues a team-only token to a member; it never reaches personal notes", async () => {
    const { as } = await discover("/t/acme/mcp");
    const clientId = await register(as);
    const { verifier, challenge } = pkce();
    const resource = `${s.origin}/t/acme/mcp`;
    const { callback, consentHtml } = await authorize(as, clientId, resource, lena.access_token, challenge);
    expect(consentHtml).toContain("not your personal notes");
    const t = await token(as, { grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource });
    expect(t.status).toBe(200);
    expect(decodeJwt(t.json.access_token!).scope).toBe("team:read");

    const client = await mcpClient(resource, t.json.access_token!);
    expect(text(await client.callTool({ name: "search", arguments: { query: "Bergmann" } }))).toContain("team:acme");
    expect(text(await client.callTool({ name: "search", arguments: { query: "Müller" } }))).not.toContain("personal");
    await client.close();

    const onPersonal = await fetch(`${s.origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.json.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(onPersonal.status).toBe(401);
  });

  it("refuses consent for a non-member", async () => {
    const eve = await signIn(s, "apple-eve", "Eve Outsider");
    const { as } = await discover("/t/acme/mcp");
    const clientId = await register(as);
    const { challenge } = pkce();
    const { callback } = await authorize(as, clientId, `${s.origin}/t/acme/mcp`, eve.access_token, challenge);
    expect(callback.searchParams.get("error")).toBe("access_denied");
  });

  it("rejects unknown resources", async () => {
    const { as } = await discover("/mcp");
    const clientId = await register(as);
    const { challenge } = pkce();
    const url = new URL(as.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "personal:read",
      resource: "https://evil.example.com/mcp",
      state: "x",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const res = await fetch(url, { redirect: "manual" });
    expect(new URL(res.headers.get("location") ?? "", s.origin).searchParams.get("error")).toBe("invalid_target");
  });
});

// Last in the file: every request here comes from 127.0.0.1, so the address's wrong codes add up
// across the tests above (five, from "locks the login after five wrong codes").
describe("sign-in codes", () => {
  it("are eight characters that can't be misread", async () => {
    const code = await pairingCode(lena.access_token);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it("stop working from an address after ten wrong ones, however many sign-ins it starts", async () => {
    const { as } = await discover("/mcp");
    const clientId = await register(as);
    let refused: Response | undefined;
    for (let i = 0; i < 12 && !refused; i++) {
      const { jar, step } = await startLogin(as, clientId, null, pkce().challenge);
      const res = await postForm(`${step.url}/login`, jar, { code: WRONG });
      if (res.status === 429) refused = res;
      else expect(res.status).toBe(401);
    }
    expect(refused, "the address was never held back").toBeDefined();
    expect(await refused!.text()).toContain("Too many wrong codes from here");

    // From here even the right code waits.
    const { jar, step } = await startLogin(as, clientId, null, pkce().challenge);
    const code = await pairingCode(lena.access_token);
    expect((await postForm(`${step.url}/login`, jar, { code })).status).toBe(429);
  });
});
