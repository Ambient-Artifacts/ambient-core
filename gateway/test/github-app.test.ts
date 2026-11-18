// Connect GitHub (docs/bots.md, "Connect GitHub"): Ambient's GitHub App against a stand-in GitHub
// API. The App's JWT, the install link's state (signed, 30 minutes, once), the browser's way back
// that links an installation, installation events keeping the repos current, the App's webhook
// routed like an owner's own, a token per run narrowed to the bot's repos (only without its own
// GH_TOKEN), unlinking, and the MCP tools. Without the App's settings: `app: null`.
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appJwt } from "../src/bots/github-app.ts";
import { loadGitHubApp } from "../src/config.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.9.3", claude: "2.1.300 (Claude Code)" };
const APP_ID = "424242";
const SECRET = "app-webhook-secret";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

// The stand-in GitHub API: what it was asked, and the installation it describes.
const seen: { method: string; path: string; auth: string; body: unknown }[] = [];
let tokens = 0;
let selection: "selected" | "all" = "selected";
let gh: Server;
let apiBase = "";

/** The App's JWT, checked the way GitHub checks it: RS256 with the App's public key, iss = the App id. */
function jwtOk(auth: string): boolean {
  const jwt = auth.replace(/^Bearer /, "");
  const [h, b, sig] = jwt.split(".");
  if (!h || !b || !sig) return false;
  const ok = createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig, "base64url"));
  const claims = JSON.parse(Buffer.from(b, "base64url").toString()) as { iss: string; iat: number; exp: number };
  return ok && claims.iss === APP_ID && claims.exp - claims.iat <= 600;
}

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let host: string;
let builder: string;
let delivery = 0;

const call = (method: string, path: string, body?: unknown, who = lena) => appCall(s, who.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const appDeliver = async (event: string, payload: unknown, secret: string | null = SECRET) => {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": `app-${delivery++}` };
  if (secret) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const res = await fetch(`${s.origin}/v1/hooks/github-app`, { method: "POST", headers, body });
  return { status: res.status, json: (await res.json()) as { result: string } };
};
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const installations = async () => (await call("GET", "/v1/app/github")).json.installations as { id: number; account: string; repos: string[] | "all" }[];

beforeAll(async () => {
  gh = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "");
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      seen.push({ method: req.method ?? "", path: req.url ?? "", auth, body });
      const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      const inst = /^\/app\/installations\/(\d+)$/.exec(req.url ?? "");
      if (req.method === "GET" && inst) return jwtOk(auth) ? json(200, { id: Number(inst[1]), account: { login: "Acme-Org" }, repository_selection: selection }) : json(401, { message: "bad jwt" });
      if (req.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(req.url ?? "")) {
        if (!jwtOk(auth)) return json(401, { message: "bad jwt" });
        return json(201, { token: `ghs_inst_${++tokens}`, expires_at: "2026-11-18T20:00:00Z" });
      }
      if (req.method === "GET" && (req.url ?? "").startsWith("/installation/repositories")) {
        if (!auth.startsWith("Bearer ghs_inst_")) return json(401, { message: "bad token" });
        return json(200, { repositories: [{ full_name: "Acme-Org/web" }, { full_name: "Acme-Org/api" }] });
      }
      json(404, { message: "not found" });
    });
  });
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
  s = await startStack({ bots: { users: [], teams: [] }, ambient: {}, githubBatchMs: 60_000, githubApp: { appId: APP_ID, slug: "ambient-bots", privateKey, webhookSecret: SECRET, apiBase } });
  lena = await signIn(s, "apple-lena-ghapp", "Lena Vogel");
  ben = await signIn(s, "apple-ben-ghapp", "Ben Weiss");
  s.config.bots!.users.push(lena.user.uid);
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
  const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string }[])[0]!.id;
  builder = ((await call("POST", "/v1/app/routines", { name: "Web Builder", prompt: "Build.", schedule: daily, computer, bot: { isolation: "container" } })).json.routine as { id: string }).id;
});
afterAll(() => {
  s.close();
  gh.close();
});

describe("the App's settings", () => {
  it("are all four or none", () => {
    expect(loadGitHubApp({})).toBeUndefined();
    expect(() => loadGitHubApp({ BRAIN_GITHUB_APP_ID: "1" })).toThrow(/together/);
  });

  it("sign the App's JWT the way GitHub checks it", () => {
    expect(jwtOk(`Bearer ${appJwt(APP_ID, privateKey)}`)).toBe(true);
    expect(jwtOk(`Bearer ${appJwt("999", privateKey)}`)).toBe(false);
  });
});

describe("connecting", () => {
  it("says the App is there, for who may change the owner's bots", async () => {
    expect((await call("GET", "/v1/app/github")).json).toEqual({ app: { slug: "ambient-bots", configured: true }, installations: [] });
    expect((await call("GET", "/v1/app/github", undefined, ben)).status).toBe(403);
  });

  it("links an installation when GitHub sends the browser back with the state, once", async () => {
    const { url } = (await call("POST", "/v1/app/github/connect")).json as { url: string };
    expect(url).toMatch(/^https:\/\/github\.com\/apps\/ambient-bots\/installations\/new\?state=/);
    const state = stateOf(url);
    const back = await fetch(`${s.origin}/v1/github/installed?installation_id=77&setup_action=install&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(200);
    const page = await back.text();
    expect(page).toContain("ambient://github/connected");
    expect(page).toContain("2 repos of Acme-Org");
    expect(await installations()).toMatchObject([{ id: 77, account: "Acme-Org", repos: ["Acme-Org/web", "Acme-Org/api"] }]);
    // The same link a second time, a tampered one, one past its 30 minutes: refused.
    expect((await fetch(`${s.origin}/v1/github/installed?installation_id=77&state=${encodeURIComponent(state)}`)).status).toBe(400);
    const [body, sig] = state.split(".");
    expect((await fetch(`${s.origin}/v1/github/installed?installation_id=77&state=${encodeURIComponent(`${body}x.${sig}`)}`)).status).toBe(400);
    const key = createHmac("sha256", SECRET).update("ambient:github-app:state").digest();
    const old = Buffer.from(JSON.stringify({ k: "user", i: lena.user.uid, u: lena.user.uid, n: "old", e: Date.now() - 1 })).toString("base64url");
    const expired = await fetch(`${s.origin}/v1/github/installed?installation_id=77&state=${encodeURIComponent(`${old}.${createHmac("sha256", key).update(old).digest("base64url")}`)}`);
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain("expired");
  });

  it("keeps the repos current from GitHub's installation events, and refuses unsigned ones", async () => {
    expect((await appDeliver("installation_repositories", { action: "added", installation: { id: 77 }, repositories_added: [{ full_name: "Acme-Org/docs" }] }, "wrong")).status).toBe(401);
    expect((await appDeliver("installation_repositories", { action: "added", installation: { id: 77 }, repositories_added: [{ full_name: "Acme-Org/docs" }], repositories_removed: [{ full_name: "Acme-Org/api" }] })).json.result).toBe("repos updated");
    expect((await installations())[0]!.repos).toEqual(["Acme-Org/docs", "Acme-Org/web"]);
    expect((await appDeliver("ping", { zen: "hi", installation: { id: 77 } })).json.result).toBe("pong");
    expect((await appDeliver("pull_request", { action: "opened", installation: { id: 999 }, repository: { full_name: "Other/x" } })).json.result).toBe("not linked");
  });
});

describe("the App's deliveries", () => {
  it("go to the bots the way the owner's own webhook does", async () => {
    await call("PUT", `/v1/app/routines/${builder}/github`, { repos: ["Acme-Org/web"] });
    const repository = { full_name: "Acme-Org/web", default_branch: "main" };
    const pr = { number: 3, html_url: "https://github.com/Acme-Org/web/pull/3", head: { ref: "ambient/web-builder/login" } };
    await appDeliver("pull_request", { action: "opened", installation: { id: 77 }, repository, pull_request: pr });
    expect(
      (await appDeliver("pull_request_review", { action: "submitted", installation: { id: 77 }, repository, pull_request: pr, review: { state: "changes_requested", body: "Fix the null check.", user: { login: "review-bot" } } })).json.result,
    ).toBe("queued");
    await s.folders.github!.idle();
    const messages = (await call("GET", `/v1/app/routines/${builder}/thread`)).json.messages as { author: string | null; text: string }[];
    expect(messages.at(-1)).toMatchObject({ author: "GitHub" });
    expect(messages.at(-1)!.text).toContain("Fix the null check.");
  });
});

describe("a bot from a template", () => {
  it("asks for no webhook and no GH_TOKEN when the App reaches its repos, and for both when it doesn't", async () => {
    const covered = await call("POST", "/v1/app/bots/from-template", { template: "builder", answers: { repos: ["Acme-Org/web"] } });
    expect(covered.status, JSON.stringify(covered.json)).toBe(200);
    expect(covered.json.needs).toEqual({ secrets: [], webhook: false });
    const elsewhere = await call("POST", "/v1/app/bots/from-template", { template: "builder", answers: { repos: ["Other-Org/site"] } });
    expect(elsewhere.json.needs).toMatchObject({ webhook: true });
    expect((elsewhere.json.needs as { secrets: string[] }).secrets).toContain("GH_TOKEN");
  });
});

describe("a bot's GitHub token", () => {
  it("comes from the App for each run, for just the repos it watches", async () => {
    const before = tokens;
    const start = (await hostCall(host, "POST", `/v1/host/routines/${builder}/runs`)).json as { run: { id: string }; env: Record<string, string> };
    expect(start.env.GH_TOKEN).toBe(`ghs_inst_${before + 1}`);
    expect(start.env.GITHUB_TOKEN).toBe(start.env.GH_TOKEN);
    const asked = seen.filter((x) => x.method === "POST" && x.path === "/app/installations/77/access_tokens").at(-1)!;
    expect(asked.body).toMatchObject({ repositories: ["web"], permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" } });
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "ok" });
  });

  it("isn't made when the bot has a GH_TOKEN of its own", async () => {
    await call("PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "ghp_own" });
    await call("PATCH", `/v1/app/routines/${builder}`, { bot: { secrets: ["GH_TOKEN"] } });
    const before = tokens;
    const start = (await hostCall(host, "POST", `/v1/host/routines/${builder}/runs`)).json as { run: { id: string }; env: Record<string, string> };
    expect(start.env.GH_TOKEN).toBe("ghp_own");
    expect(tokens).toBe(before);
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "ok" });
    await call("PATCH", `/v1/app/routines/${builder}`, { bot: { secrets: [] } });
  });

  it("covers all of an account's repos when the App was installed on all of them", async () => {
    selection = "all";
    const { url } = (await call("POST", "/v1/app/github/connect")).json as { url: string };
    await fetch(`${s.origin}/v1/github/installed?installation_id=78&setup_action=install&state=${encodeURIComponent(stateOf(url))}`);
    expect((await installations()).find((i) => i.id === 78)!.repos).toBe("all");
    selection = "selected";
  });
});

describe("unlinking and the tools", () => {
  it("tells Amb to connect instead of setting up a webhook, and gives the link", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await client.callTool({ name: "github_webhook", arguments: {} }))).toContain("connect_github");
    const out = text(await client.callTool({ name: "connect_github", arguments: {} }));
    expect(out).toMatch(/^\[Connect GitHub\]\(https:\/\/github\.com\/apps\/ambient-bots\/installations\/new\?state=/);
    expect(out).toContain("Acme-Org/docs");
  });

  it("drops an installation GitHub deleted, and one the person unlinks", async () => {
    expect((await appDeliver("installation", { action: "deleted", installation: { id: 78 } })).json.result).toBe("deleted");
    expect((await installations()).map((i) => i.id)).toEqual([77]);
    expect((await call("DELETE", "/v1/app/github/installations/77")).status).toBe(204);
    expect((await call("DELETE", "/v1/app/github/installations/77")).status).toBe(404);
    expect(await installations()).toEqual([]);
    // Nothing installed covers the bot's repos now: its run gets no token.
    const start = (await hostCall(host, "POST", `/v1/host/routines/${builder}/runs`)).json as { run: { id: string }; env: Record<string, string> };
    expect(start.env.GH_TOKEN).toBeUndefined();
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "ok" });
    expect((await appDeliver("pull_request", { action: "opened", installation: { id: 77 }, repository: { full_name: "Acme-Org/web" } })).json.result).toBe("not linked");
  });
});

describe("without the App", () => {
  it("answers app: null, and the routes that need it say it isn't set up", async () => {
    const plain = await startStack({ bots: { users: [], teams: [] }, ambient: {} });
    try {
      const who = await signIn(plain, "apple-nora-ghapp", "Nora Ost");
      plain.config.bots!.users.push(who.user.uid);
      expect((await appCall(plain, who.access_token, "GET", "/v1/app/github")).json).toEqual({ app: null, installations: [] });
      expect((await appCall(plain, who.access_token, "POST", "/v1/app/github/connect")).status).toBe(404);
      expect((await fetch(`${plain.origin}/v1/hooks/github-app`, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      plain.close();
    }
  });
});
