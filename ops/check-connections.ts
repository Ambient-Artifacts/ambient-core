// Checks every service in the connection catalogue (gateway/src/bots/mcp-catalog.ts) the way
// Ambient connects it, up to the point where a person would sign in: no account needed anywhere.
//
//   node --import tsx ops/check-connections.ts [--origin https://…] [--only figma,notion] [--json]
//
// For a service with a sign-in it finds the sign-in server, registers Ambient as a client (as
// the gateway does, with the gateway's own return address) and opens the service's sign-in page.
// That catches what the services' public metadata doesn't say: Figma advertises open client
// registration and answers 403 to anyone it hasn't approved (2026-11-27). Open services are asked
// for their tools; for token services it checks the server answers and wants the token.
//
// Each run registers a client at every sign-in service, as each person's first sign-in does.
// "check" means it got as far as the service's sign-in page and was stopped by what guards it
// against scripts (a bot check for a data-centre address): open the link in a browser to be sure.
// Exit code 1 when any service fails; "check" doesn't fail the run.
import { auth, discoverOAuthServerInfo, extractWWWAuthenticateParams, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CATALOG, type CatalogEntry } from "../gateway/src/bots/mcp-catalog.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const origin = arg("origin") ?? process.env.BRAIN_ORIGIN ?? "https://mcp.ambientartifacts.si";
const only = arg("only")?.split(",").map((s) => s.trim().toLowerCase());
const asJson = process.argv.includes("--json");
const REDIRECT = `${origin}/v1/mcp/connected`;
const TIMEOUT_MS = 20_000;

export type Stage = "reach" | "discover" | "register" | "sign-in page" | "tools" | "token";
export interface Result {
  id: string;
  name: string;
  signIn: CatalogEntry["signIn"];
  ok: boolean;
  /** "check": not refused, but a page only a browser gets past (a bot check); look at `link`. */
  unsure?: boolean;
  /** The step that failed, or the last one checked. */
  stage: Stage;
  detail: string;
  /** For a sign-in service that got that far: the sign-in page it opened (to look at in a browser). */
  link?: string;
}

/** The last answer that wasn't a success, so a failure can say what the service said. */
function recording() {
  let last: { url: string; status: number; body: string } | null = null;
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok && res.status !== 401) {
      const body = (await res.clone().text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      last = { url: String(input instanceof Request ? input.url : input), status: res.status, body };
    }
    return res;
  };
  return { fetchFn, last: () => last };
}

/** Ambient as a client, as the gateway registers it (SignIn in mcp-connections.ts). */
class Probe implements OAuthClientProvider {
  link: URL | undefined;
  client: OAuthClientInformationMixed | undefined;
  verifier = "";
  constructor(private method: string) {}
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Ambient", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: this.method };
  }
  state() {
    return "connection-check";
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(c: OAuthClientInformationMixed) {
    this.client = c;
  }
  tokens(): OAuthTokens | undefined {
    return undefined;
  }
  saveTokens() {}
  redirectToAuthorization(url: URL) {
    this.link = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const ping = (url: string, fetchFn: typeof fetch) =>
  fetchFn(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });

/** Words an error page uses when it turns the client away before anyone signs in. */
const REFUSED_PAGE = /invalid[_ ]client|invalid[_ ]redirect|redirect[_ ]uri[^"]{0,40}(mismatch|invalid|not (allowed|registered))|unauthorized[_ ]client|client[^"]{0,20}not (found|allowed|approved)/i;
/** What a page that guards against scripts says (Cloudflare, Airtable): a browser gets past it. */
const BOT_CHECK = /security (check|verification)|verify (it'?s you|you are human)|unusual traffic|not a bot|cf-ray|challenge-platform|captcha/i;

/** Opens the sign-in page, following redirects until it's the service's page (or our return address with an error). */
async function signInPage(link: URL): Promise<{ ok: boolean; unsure?: boolean; detail: string }> {
  let url = link.toString();
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(url, { redirect: "manual", headers: { accept: "text/html" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (next.toString().startsWith(REDIRECT)) {
        const error = next.searchParams.get("error");
        return error ? { ok: false, detail: `sent back with ${error}${next.searchParams.get("error_description") ? `: ${next.searchParams.get("error_description")}` : ""}` } : { ok: true, detail: "sent straight back (already allowed)" };
      }
      url = next.toString();
      continue;
    }
    const body = await res.text().catch(() => "");
    const at = `${new URL(url).host}${new URL(url).pathname}`;
    const refused = body.match(REFUSED_PAGE);
    if (res.status >= 400 && refused) return { ok: false, detail: `HTTP ${res.status} at ${at} (${refused[0]})` };
    // A login page behind a bot check, or a 403 to a script: the client wasn't refused, a browser decides.
    if (res.status >= 400 && (BOT_CHECK.test(body) || /\/(log|sign)_?in|\/signin|\/authorize/i.test(at))) return { ok: true, unsure: true, detail: `HTTP ${res.status} at ${at}, a page that stops scripts: open the link in a browser` };
    if (res.status >= 400) return { ok: false, detail: `HTTP ${res.status} at ${at}` };
    return { ok: true, detail: `sign-in page at ${new URL(url).host}` };
  }
  return { ok: false, detail: "too many redirects" };
}

async function checkOAuth(entry: CatalogEntry): Promise<Result> {
  const base = { id: entry.id, name: entry.name, signIn: entry.signIn };
  const rec = recording();
  let hint: { resourceMetadataUrl?: URL; scope?: string } = {};
  try {
    const res = await ping(entry.url, rec.fetchFn as typeof fetch);
    if (res.status === 401) hint = extractWWWAuthenticateParams(res);
    else if (res.ok) return { ...base, ok: true, stage: "reach", detail: `answers without a sign-in (HTTP ${res.status})` };
    else return { ...base, ok: false, stage: "reach", detail: `HTTP ${res.status} to an MCP request` };
  } catch (err) {
    return { ...base, ok: false, stage: "reach", detail: (err as Error).message.slice(0, 160) };
  }
  const info = await discoverOAuthServerInfo(entry.url, { fetchFn: rec.fetchFn as typeof fetch, ...(hint.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}) }).catch((err: Error) => err);
  if (info instanceof Error || !info.authorizationServerMetadata) return { ...base, ok: false, stage: "discover", detail: info instanceof Error ? info.message.slice(0, 160) : "no sign-in server metadata" };
  const meta = info.authorizationServerMetadata;
  if (!meta.registration_endpoint) return { ...base, ok: false, stage: "discover", detail: "no client registration offered (an app has to be registered by hand)" };
  const methods = meta.token_endpoint_auth_methods_supported;
  const method = !methods || methods.includes("none") ? "none" : methods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
  const probe = new Probe(method);
  try {
    const result = await auth(probe, { serverUrl: entry.url, fetchFn: rec.fetchFn as typeof fetch, ...(hint.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}), ...(hint.scope ? { scope: hint.scope } : {}) });
    if (result !== "REDIRECT" || !probe.link) return { ...base, ok: false, stage: "register", detail: `no sign-in link (${result})` };
  } catch (err) {
    const said = rec.last();
    const stage: Stage = probe.client ? "sign-in page" : "register";
    return { ...base, ok: false, stage, detail: said ? `HTTP ${said.status} from ${new URL(said.url).host}${new URL(said.url).pathname}: ${said.body || "(empty)"}` : (err as Error).message.slice(0, 160) };
  }
  // The client is registered and the link made: a page that doesn't answer a script isn't a refusal.
  const page = await signInPage(probe.link).catch((err: Error) => ({ ok: true, unsure: true, detail: `the sign-in page didn't answer a script (${err.message.slice(0, 80)}): open the link in a browser` }));
  return { ...base, ok: page.ok, ...(page.unsure ? { unsure: true } : {}), stage: "sign-in page", detail: `${page.detail}; client ${method}`, link: probe.link.toString() };
}

async function checkOpen(entry: CatalogEntry): Promise<Result> {
  const base = { id: entry.id, name: entry.name, signIn: entry.signIn };
  const client = new Client({ name: "Ambient connection check", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(entry.url)));
    const { tools } = await client.listTools();
    return { ...base, ok: tools.length > 0, stage: "tools", detail: `${tools.length} tools` };
  } catch (err) {
    return { ...base, ok: false, stage: "tools", detail: (err as Error).message.slice(0, 160) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function checkKey(entry: CatalogEntry): Promise<Result> {
  const base = { id: entry.id, name: entry.name, signIn: entry.signIn };
  try {
    const res = await ping(entry.url, fetch);
    // Without the token it should turn the request away; that's as far as a check without one goes.
    return res.status === 401 || res.status === 403 ? { ...base, ok: true, stage: "token", detail: `wants a token (HTTP ${res.status}); the token itself isn't checked` } : { ...base, ok: false, stage: "token", detail: `HTTP ${res.status} without a token` };
  } catch (err) {
    return { ...base, ok: false, stage: "reach", detail: (err as Error).message.slice(0, 160) };
  }
}

export async function check(entry: CatalogEntry): Promise<Result> {
  return entry.signIn === "oauth" ? checkOAuth(entry) : entry.signIn === "none" ? checkOpen(entry) : checkKey(entry);
}

async function main() {
  const entries = CATALOG.filter((e) => !only || only.includes(e.id));
  const results: Result[] = [];
  // A few at a time: the services are many and the checks slow.
  for (let i = 0; i < entries.length; i += 6) results.push(...(await Promise.all(entries.slice(i, i + 6).map(check))));
  if (asJson) console.log(JSON.stringify({ origin, checkedAt: new Date().toISOString(), results }, null, 2));
  else {
    for (const r of results) console.log(`${!r.ok ? "FAIL " : r.unsure ? "check" : "ok   "}  ${r.name.padEnd(20)} ${r.signIn.padEnd(5)} ${r.stage.padEnd(13)} ${r.detail}`);
    const failed = results.filter((r) => !r.ok);
    const unsure = results.filter((r) => r.unsure);
    console.log(`\n${results.length - failed.length} of ${results.length} reach the point where a person signs in${unsure.length ? ` (${unsure.length} behind a bot check: ${unsure.map((r) => r.id).join(", ")})` : ""}${failed.length ? `; failing: ${failed.map((r) => r.id).join(", ")}` : ""}.`);
  }
  process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
