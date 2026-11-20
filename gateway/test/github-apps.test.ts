// GitHub Apps per role and per bot (docs/bots.md, "GitHub Apps"), against a stand-in GitHub API:
// a template role's App made with GitHub's manifest flow (nothing to copy: GitHub sends the code
// back to the gateway), a template bot working through its role's App (its connect link, its
// token with the role's access), deliveries reaching only the bots whose App they came through,
// and a bot's own App made and installed in one go.
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, signIn, startStack, type AppSession, type Stack } from "./helpers.ts";

const info = { hostname: "srv-apps", os: "Linux 6.8", runner: "0.14.0", claude: "2.1.326 (Claude Code)" };
const keyPair = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const shared = { id: "100", slug: "ambient-bots", secret: "shared-secret", ...keyPair() };
// The Apps GitHub "makes" from a manifest: by code.
const made: Record<string, { id: string; slug: string; name: string; secret: string; privateKey: string; publicKey: string; owner: string }> = {
  "code-reviewer": { id: "200", slug: "ambient-reviewer", name: "Ambient Reviewer", secret: "reviewer-secret", owner: "Ambient-Artifacts", ...keyPair() },
  "code-fixie": { id: "300", slug: "fixie-acme-org", name: "Fixie (Acme-Org)", secret: "fixie-secret", owner: "Acme-Org", ...keyPair() },
};
const byId = new Map<string, { publicKey: string }>([[shared.id, shared], ...Object.values(made).map((m) => [m.id, m] as const)]);
// Installation id → App id (each installation belongs to one App).
const installs = new Map<number, string>([[1, shared.id], [2, "200"], [3, "300"]]);

const seen: { method: string; path: string; app: string | null; body: unknown }[] = [];
let gh: Server;
let apiBase = "";
let s: Stack;
let lena: AppSession;
let host: string;
let delivery = 0;

/** Which App signed a JWT (RS256, checked with each App's public key). */
function appOf(auth: string): string | null {
  const [h, b, sig] = auth.replace(/^Bearer /, "").split(".");
  if (!h || !b || !sig) return null;
  const claims = JSON.parse(Buffer.from(b, "base64url").toString()) as { iss: string };
  const app = byId.get(claims.iss);
  return app && createVerify("RSA-SHA256").update(`${h}.${b}`).verify(app.publicKey, Buffer.from(sig, "base64url")) ? claims.iss : null;
}

const call = (method: string, path: string, body?: unknown) => appCall(s, lena.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const deliver = async (path: string, secret: string, event: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  const res = await fetch(`${s.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": `d-${delivery++}`, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
    body,
  });
  return { status: res.status, json: (await res.json()) as { result: string } };
};
const stateOf = (url: string) => new URL(url, "https://x").searchParams.get("state")!;
const install = async (url: string, installationId: number) => fetch(`${s.origin}/v1/github/installed?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(stateOf(url))}`);

beforeAll(async () => {
  gh = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "");
      const url = req.url ?? "";
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      const app = appOf(auth);
      seen.push({ method: req.method ?? "", path: url, app, body });
      const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      const conv = /^\/app-manifests\/([\w-]+)\/conversions$/.exec(url);
      if (req.method === "POST" && conv) {
        const m = made[conv[1]!];
        return m ? json(201, { id: Number(m.id), slug: m.slug, name: m.name, pem: m.privateKey, webhook_secret: m.secret, owner: { login: m.owner } }) : json(404, { message: "bad code" });
      }
      const user = /^\/users\/([\w-]+)$/.exec(url);
      if (req.method === "GET" && user) return json(200, { login: user[1], type: user[1] === "lena-v" ? "User" : "Organization" });
      const inst = /^\/app\/installations\/(\d+)$/.exec(url);
      if (req.method === "GET" && inst) {
        if (!app || installs.get(Number(inst[1])) !== app) return json(404, { message: "not this App's" });
        return json(200, { id: Number(inst[1]), account: { login: "Acme-Org" }, repository_selection: "selected" });
      }
      const tok = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
      if (req.method === "POST" && tok) {
        if (!app || installs.get(Number(tok[1])) !== app) return json(404, { message: "not this App's" });
        return json(201, { token: `ghs_${app}_${tok[1]}`, expires_at: "2026-11-20T20:00:00Z" });
      }
      if (req.method === "GET" && url.startsWith("/installation/repositories")) return json(200, { repositories: [{ full_name: "Acme-Org/web" }] });
      json(404, { message: "not found" });
    });
  });
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
  s = await startStack({ bots: { users: [], teams: [] }, ambient: {}, githubBatchMs: 10, githubApp: { appId: shared.id, slug: shared.slug, privateKey: shared.privateKey, webhookSecret: shared.secret, apiBase } });
  lena = await signIn(s, "apple-lena-ghapps", "Lena Vogel");
  s.config.bots!.users.push(lena.user.uid);
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
});
afterAll(() => {
  s.close();
  gh.close();
});

describe("a template role's App", () => {
  it("is made with GitHub's manifest flow: the gateway's page posts it, GitHub's code comes back to the gateway", async () => {
    const url = await s.folders.githubApp!.roleAppUrl("reviewer", "Ambient-Artifacts");
    const pageRes = await fetch(url.replace(/^https?:\/\/[^/]+/, s.origin));
    const html = await pageRes.text();
    expect(html).toContain('action="https://github.com/organizations/Ambient-Artifacts/settings/apps/new?state=');
    const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(html)![1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: "Ambient Reviewer", public: true, redirect_url: `${s.origin}/v1/github/app-created`, setup_url: `${s.origin}/v1/github/installed` });
    expect((manifest.default_permissions as Record<string, string>).pull_requests).toBe("write");
    expect(String((manifest.hook_attributes as { url: string }).url)).toMatch(new RegExp(`^${s.origin}/v1/hooks/github-app/[\\w-]+$`));
    const back = await fetch(`${s.origin}/v1/github/app-created?code=code-reviewer&state=${encodeURIComponent(stateOf(url))}`);
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("Ambient Reviewer is ready");
    // Kept sealed: the key and the secret aren't readable in Convex.
    const rows = await s.t.run(async (ctx) => ctx.db.query("githubApps").collect());
    expect(rows).toMatchObject([{ key: "reviewer", role: "reviewer", slug: "ambient-reviewer", appId: "200" }]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(rows)).not.toContain("reviewer-secret");
    // The same link again: refused.
    expect((await fetch(`${s.origin}/v1/github/app-created?code=code-reviewer&state=${encodeURIComponent(stateOf(url))}`)).status).toBe(400);
  });
});

describe("a bot from the Reviewer template", () => {
  let reviewer: string;
  let plain: string;
  const repository = { full_name: "Acme-Org/web", default_branch: "main" };
  const pr = { number: 7, html_url: "https://github.com/Acme-Org/web/pull/7", head: { ref: "feature/login" }, user: { login: "dev" } };
  let reviewerHook = "";

  it("connects through its role's App, and gets a token with the role's access", async () => {
    const made = await call("POST", "/v1/app/bots/from-template", { template: "review_bot", answers: { repos: ["Acme-Org/web"] } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    reviewer = (made.json.routine as { id: string }).id;
    const before = (await call("GET", `/v1/app/github?routine=${reviewer}`)).json as { forBot: { app: string; slug: string; connected: boolean } };
    expect(before.forBot).toMatchObject({ app: "reviewer", slug: "ambient-reviewer", connected: false });
    const { url, app } = (await call("POST", `/v1/app/github/connect?routine=${reviewer}`)).json as { url: string; app: string };
    expect(app).toBe("ambient-reviewer");
    expect(url).toMatch(/^https:\/\/github\.com\/apps\/ambient-reviewer\/installations\/new\?state=/);
    expect((await install(url, 2)).status).toBe(200);
    expect(((await call("GET", `/v1/app/github?routine=${reviewer}`)).json as { forBot: { connected: boolean } }).forBot.connected).toBe(true);
    const start = (await hostCall(host, "POST", `/v1/host/routines/${reviewer}/runs`)).json as { run: { id: string }; env: Record<string, string> };
    expect(start.env.GH_TOKEN).toBe("ghs_200_2");
    const asked = seen.filter((x) => x.path === "/app/installations/2/access_tokens").at(-1)!;
    expect(asked.body).toMatchObject({ repositories: ["web"], permissions: { contents: "read", pull_requests: "write" } });
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "ok" });
  });

  it("hears a repo's events only through its own App, while a plain bot hears them through the shared one", async () => {
    // The shared App on the same repo, and a plain bot that reviews too.
    const shareUrl = ((await call("POST", "/v1/app/github/connect")).json as { url: string }).url;
    await install(shareUrl, 1);
    const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string }[])[0]!.id;
    plain = ((await call("POST", "/v1/app/routines", { name: "Second eyes", prompt: "Review.", schedule: { every: "needed", time: "09:00", timezone: "Europe/Vienna" }, computer, bot: {} })).json.routine as { id: string }).id;
    await call("PUT", `/v1/app/routines/${plain}/github`, { repos: ["Acme-Org/web"], on: ["all_prs"] });
    reviewerHook = (await s.t.run(async (ctx) => (await ctx.db.query("githubApps").collect())[0]!.hookId)) as string;
    const thread = async (id: string) => ((await call("GET", `/v1/app/routines/${id}/thread`)).json.messages as { author: string | null; text: string }[]).filter((m) => m.author === "GitHub");
    const opened = { action: "opened", repository, pull_request: pr };
    expect((await deliver("/v1/hooks/github-app", shared.secret, "pull_request", { ...opened, installation: { id: 1 } })).status).toBe(202);
    expect((await deliver(`/v1/hooks/github-app/${reviewerHook}`, made["code-reviewer"]!.secret, "pull_request", { ...opened, installation: { id: 2 } })).status).toBe(202);
    await s.folders.github!.idle();
    // Each bot once: the Reviewer through its App, the plain bot through the shared one.
    expect(await thread(reviewer)).toHaveLength(1);
    expect(await thread(plain)).toHaveLength(1);
    // Signed with another App's secret: refused.
    expect((await deliver(`/v1/hooks/github-app/${reviewerHook}`, shared.secret, "pull_request", { ...opened, installation: { id: 2 } })).status).toBe(401);
    expect((await deliver("/v1/hooks/github-app/nope", shared.secret, "pull_request", opened)).status).toBe(404);
  });
});

describe("a bot's own App", () => {
  it("is made for the account its repos are in and goes straight on to its install", async () => {
    const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string }[])[0]!.id;
    const fixie = ((await call("POST", "/v1/app/routines", { name: "Fixie", prompt: "Fix bugs.", schedule: { every: "needed", time: "09:00", timezone: "Europe/Vienna" }, computer, bot: {} })).json.routine as { id: string }).id;
    expect((await call("POST", `/v1/app/routines/${fixie}/github/app`, {})).json.error).toBe("no_account");
    await call("PUT", `/v1/app/routines/${fixie}/github`, { repos: ["Acme-Org/web"] });
    const { url } = (await call("POST", `/v1/app/routines/${fixie}/github/app`, {})).json as { url: string };
    const html = await (await fetch(url.replace(/^https?:\/\/[^/]+/, s.origin))).text();
    expect(html).toContain("https://github.com/organizations/Acme-Org/settings/apps/new");
    expect(html).toContain("Fixie (Acme-Org)");
    const back = await fetch(`${s.origin}/v1/github/app-created?code=code-fixie&state=${encodeURIComponent(stateOf(url))}`, { redirect: "manual" });
    expect(back.status).toBe(303);
    const next = back.headers.get("location")!;
    expect(next).toMatch(/^https:\/\/github\.com\/apps\/fixie-acme-org\/installations\/new\?state=/);
    expect((await install(next, 3)).status).toBe(200);
    expect(((await call("GET", `/v1/app/github?routine=${fixie}`)).json as { forBot: { slug: string; connected: boolean } }).forBot).toMatchObject({ slug: "fixie-acme-org", connected: true });
    const start = (await hostCall(host, "POST", `/v1/host/routines/${fixie}/runs`)).json as { run: { id: string }; env: Record<string, string> };
    expect(start.env.GH_TOKEN).toBe("ghs_300_3");
    await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "ok" });
    // Deleting the bot takes its App's record with it.
    await call("DELETE", `/v1/app/routines/${fixie}`);
    expect((await s.t.run(async (ctx) => ctx.db.query("githubApps").collect())).map((a) => a.key)).toEqual(["reviewer"]);
  });
});
