// Connect GitHub (docs/bots.md, "Connect GitHub"): Ambient's own GitHub App instead of a webhook
// per owner and a hand-made GH_TOKEN. A person (or a team's owner) installs the App on the repos
// their bots work on; from then on
//
//   GitHub ──▶ POST /v1/hooks/github-app (signed with the App's secret) ──▶ installation ──▶ owner
//          ──▶ the same routing as the owner's webhook (GitHubEvents: modes, batching, learning)
//   a bot's run ──▶ an installation token for just the repos it watches, as GH_TOKEN (never stored)
//
// The browser comes back from GitHub to /v1/github/installed with a signed, single-use state that
// says whose installation it is; only then is it linked. The link from an installation to its
// owner is kept as a record of its own (`github-app-install`, ids only, under an owner key that
// isn't a person or a team), since a delivery names only the installation.
import { createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { GitHubError, signedBy, type GitHubEvents } from "./github.ts";

/** What an App is for: the server's shared one, a template role's, or one bot's own. */
export type AppRole = "shared" | "builder" | "reviewer" | "wiki_keeper" | "bot";

export interface GitHubAppConfig {
  appId: string;
  slug: string;
  /** How Ambient knows it: "shared" (the configured one), a role, or a bot's own App's slug. */
  key?: string;
  role?: AppRole;
  /** The App's private key (PEM). */
  privateKey: string;
  webhookSecret: string;
  /** Tests: a stand-in GitHub API. */
  apiBase?: string;
}

export interface Installation {
  id: number;
  account: string;
  repos: string[] | "all";
  connectedAt: number;
}

/**
 * What each kind of App may do on GitHub (its manifest), and what a run's token asks for (never
 * more). The Reviewer's App can write code so it can merge once that's allowed (docs/bots.md,
 * "GitHub Apps"); its runs' tokens read code only.
 */
export const APP_PERMISSIONS: Record<AppRole, Record<string, "read" | "write">> = {
  shared: { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" },
  bot: { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", metadata: "read" },
  builder: { contents: "write", pull_requests: "write", issues: "read", checks: "read", statuses: "read", metadata: "read" },
  reviewer: { contents: "write", pull_requests: "write", issues: "read", checks: "read", statuses: "read", metadata: "read" },
  wiki_keeper: { contents: "write", pull_requests: "write", checks: "read", statuses: "read", metadata: "read" },
};
export const TOKEN_PERMISSIONS: Record<AppRole, Record<string, "read" | "write">> = {
  ...APP_PERMISSIONS,
  reviewer: { ...APP_PERMISSIONS.reviewer, contents: "read" },
};
/** The events each kind of App hears (what its bots act on). */
export const APP_EVENTS: Record<AppRole, string[]> = {
  shared: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_run", "check_suite", "push", "issues"],
  bot: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_run", "check_suite", "push", "issues"],
  builder: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_run", "check_suite", "issues"],
  reviewer: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_run", "check_suite"],
  wiki_keeper: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_run", "check_suite", "push"],
};

/** The App a state was made for (its body names it; checked by that App afterwards). */
export function stateApp(state: string): string {
  try {
    const s = JSON.parse(Buffer.from(state.split(".")[0] ?? "", "base64url").toString("utf8")) as { a?: string };
    return typeof s.a === "string" && s.a ? s.a : "shared";
  } catch {
    return "shared";
  }
}
const STATE_TTL_MS = 30 * 60_000;
const INSTALLS = "github-installation";
const INDEX = "github-app-install";
const USED = "github-app-state";
/** Where the link from an installation to its owner is kept: ids only, nothing to seal. */
const INDEX_OWNER = { ownerKind: "team" as const, ownerId: "_github_app" };

const ownerArgs = (owner: Owner) => (owner.kind === "user" ? { ownerKind: "user" as const, ownerId: owner.uid } : { ownerKind: "team" as const, ownerId: owner.teamId });
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The App's own JWT (RS256, ten minutes at most; GitHub allows a minute of clock drift). */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

export class GitHubApp {
  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      config: GitHubAppConfig;
      github: GitHubEvents;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  get slug(): string {
    return this.d.config.slug;
  }

  get key(): string {
    return this.d.config.key ?? "shared";
  }

  get role(): AppRole {
    return this.d.config.role ?? "shared";
  }

  /** Where its installations are kept per owner ("all" for the shared App, as before there were others). */
  private get installsKey(): string {
    return this.key === "shared" ? "all" : `app:${this.key}`;
  }

  // ---- GitHub's API ----

  private async gh<T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
    const base = (this.d.config.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    const res = await (this.d.fetchImpl ?? fetch)(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ambient-gateway",
        authorization: `Bearer ${init.token ?? appJwt(this.d.config.appId, this.d.config.privateKey, this.now())}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError("github_failed", `GitHub answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}.`, 502);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** An installation token; `repos` (names under the installation's account) narrows it. */
  private async installationToken(id: number, repos?: string[]): Promise<{ token: string; expiresAt: string }> {
    const out = await this.gh<{ token: string; expires_at: string }>(`/app/installations/${id}/access_tokens`, {
      method: "POST",
      body: { ...(repos?.length ? { repositories: repos } : {}), permissions: TOKEN_PERMISSIONS[this.role] },
    });
    return { token: out.token, expiresAt: out.expires_at };
  }

  /** What an installation covers, as GitHub says now. */
  private async describe(id: number): Promise<{ account: string; repos: string[] | "all" }> {
    const inst = await this.gh<{ account?: { login?: string }; repository_selection?: string }>(`/app/installations/${id}`);
    const account = inst.account?.login ?? "";
    if (inst.repository_selection === "all") return { account, repos: "all" };
    const { token } = await this.installationToken(id);
    const repos: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const out = await this.gh<{ repositories?: { full_name: string }[] }>(`/installation/repositories?per_page=100&page=${page}`, { token });
      const got = (out.repositories ?? []).map((r) => r.full_name);
      repos.push(...got);
      if (got.length < 100) break;
    }
    return { account, repos };
  }

  // ---- records ----

  private async read<T>(owner: Owner, kind: string, key: string): Promise<T | null> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind, key })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    const raw = await this.d.keys.open(owner, `record:${kind}`, r.iv, r.ct).catch(() => null);
    if (raw === null) return null;
    try {
      return JSON.parse((JSON.parse(raw) as { c: string }).c) as T;
    } catch {
      return null;
    }
  }

  private async write(owner: Owner, kind: string, key: string, value: unknown, deleted = false): Promise<void> {
    const content = JSON.stringify(value);
    const sealed = await this.d.keys.seal(owner, `record:${kind}`, JSON.stringify({ c: content }));
    await this.d.control.m(api.records.put, { ...ownerArgs(owner), kind, key, iv: sealed.iv, ct: sealed.ciphertext, size: Buffer.byteLength(content), byKind: "user", ...(deleted ? { deleted: true } : {}), keep: 1, now: this.now() });
  }

  /** Ids only (an installation and its owner): kept plainly, so a delivery can find its owner. */
  private async index(id: number): Promise<Owner | null> {
    const r = (await this.d.control.q(api.records.get, { ...INDEX_OWNER, kind: INDEX, key: String(id) })) as { ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    try {
      const o = JSON.parse(Buffer.from(r.ct, "base64url").toString("utf8")) as { k?: string; i?: string };
      if (o.k === "user" && o.i) return { kind: "user", uid: o.i };
      if (o.k === "team" && o.i) return { kind: "team", teamId: o.i };
    } catch {
      // Not ours.
    }
    return null;
  }

  private async setIndex(id: number, owner: Owner | null): Promise<void> {
    const ct = owner ? b64url(JSON.stringify({ k: owner.kind, i: owner.kind === "user" ? owner.uid : owner.teamId })) : "-";
    await this.d.control.m(api.records.put, { ...INDEX_OWNER, kind: INDEX, key: String(id), iv: "-", ct, size: ct.length, byKind: "user", ...(owner ? {} : { deleted: true }), keep: 1, now: this.now() });
  }

  async installations(owner: Owner): Promise<Installation[]> {
    return (await this.read<{ list: Installation[] }>(owner, INSTALLS, this.installsKey))?.list ?? [];
  }

  private async saveInstallations(owner: Owner, list: Installation[]): Promise<void> {
    await this.write(owner, INSTALLS, this.installsKey, { list });
  }

  // ---- connecting ----

  private stateKey(): Buffer {
    return createHmac("sha256", this.d.config.webhookSecret).update("ambient:github-app:state").digest();
  }

  /** The install link: GitHub sends the browser back with this state, signed and for 30 minutes. */
  connectUrl(owner: Owner, uid: string): string {
    const body = b64url(JSON.stringify({ a: this.key, k: owner.kind, i: owner.kind === "user" ? owner.uid : owner.teamId, u: uid, n: randomBytes(12).toString("base64url"), e: this.now() + STATE_TTL_MS }));
    const sig = b64url(createHmac("sha256", this.stateKey()).update(body).digest());
    return `https://github.com/apps/${encodeURIComponent(this.d.config.slug)}/installations/new?state=${encodeURIComponent(`${body}.${sig}`)}`;
  }

  /** The state GitHub passed back: whose it is, or why not (expired, used, not ours). */
  private async openState(state: string): Promise<{ owner: Owner; uid: string }> {
    const [body, sig] = state.split(".");
    if (!body || !sig) throw new GitHubError("bad_state", "This link isn't from Ambient.", 400);
    const want = createHmac("sha256", this.stateKey()).update(body).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new GitHubError("bad_state", "This link isn't from Ambient.", 400);
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { k: string; i: string; u: string; n: string; e: number };
    if (s.e < this.now()) throw new GitHubError("state_expired", "This link has expired. Start Connect GitHub again in the app.", 400);
    const used = (await this.d.control.q(api.records.get, { ...INDEX_OWNER, kind: USED, key: s.n })) as { deleted: boolean } | null;
    if (used && !used.deleted) throw new GitHubError("state_used", "This link was used already. Start Connect GitHub again in the app.", 400);
    await this.d.control.m(api.records.put, { ...INDEX_OWNER, kind: USED, key: s.n, iv: "-", ct: "-", size: 1, byKind: "user", keep: 1, now: this.now() });
    const owner: Owner = s.k === "team" ? { kind: "team", teamId: s.i } : { kind: "user", uid: s.i };
    return { owner, uid: s.u };
  }

  /** GitHub's browser redirect after an install or a change: links the installation to its owner. */
  async installed(installationId: number, state: string): Promise<Installation> {
    if (!Number.isInteger(installationId) || installationId <= 0) throw new GitHubError("bad_request", "GitHub sent no installation.", 400);
    const { owner } = await this.openState(state);
    // An installation belongs to one owner in Ambient: a link from elsewhere moves it.
    const before = await this.index(installationId);
    if (before && JSON.stringify(before) !== JSON.stringify(owner)) await this.unlink(before, installationId);
    const { account, repos } = await this.describe(installationId);
    const inst: Installation = { id: installationId, account, repos, connectedAt: this.now() };
    const list = (await this.installations(owner)).filter((x) => x.id !== installationId);
    await this.saveInstallations(owner, [...list, inst]);
    await this.setIndex(installationId, owner);
    return inst;
  }

  /** Unlinks an installation from its owner in Ambient (uninstalling on GitHub is separate). */
  async unlink(owner: Owner, installationId: number): Promise<boolean> {
    const list = await this.installations(owner);
    const left = list.filter((x) => x.id !== installationId);
    if (left.length === list.length) return false;
    await this.saveInstallations(owner, left);
    if (JSON.stringify(await this.index(installationId)) === JSON.stringify(owner)) await this.setIndex(installationId, null);
    return true;
  }

  // ---- deliveries ----

  /**
   * One delivery to the App's webhook. Signed with the App's secret (401 otherwise); installation
   * changes keep the repo lists current; everything else goes to the owner's bots exactly as a
   * delivery to their own webhook does.
   */
  async receive(headers: { event?: string; signature?: string; delivery?: string }, body: Buffer): Promise<{ status: number; result: string }> {
    if (!signedBy(this.d.config.webhookSecret, body, headers.signature)) return { status: 401, result: "bad signature" };
    let p: { action?: string; installation?: { id?: number; account?: { login?: string }; repository_selection?: string }; repositories_added?: { full_name: string }[]; repositories_removed?: { full_name: string }[]; repository_selection?: string };
    try {
      p = JSON.parse(body.toString("utf8"));
    } catch {
      return { status: 400, result: "not JSON" };
    }
    const event = headers.event ?? "";
    if (event === "ping") return { status: 202, result: "pong" };
    const id = p.installation?.id;
    if (!id) return { status: 202, result: "no installation" };
    const owner = await this.index(id);
    if (event === "installation") {
      if (!owner) return { status: 202, result: "not linked" };
      if (p.action === "deleted" || p.action === "suspend") {
        await this.unlink(owner, id);
        return { status: 202, result: p.action };
      }
      await this.refresh(owner, id).catch(() => undefined);
      return { status: 202, result: "refreshed" };
    }
    if (event === "installation_repositories") {
      if (!owner) return { status: 202, result: "not linked" };
      const list = await this.installations(owner);
      const inst = list.find((x) => x.id === id);
      if (!inst) return { status: 202, result: "not linked" };
      if (p.repository_selection === "all") inst.repos = "all";
      else {
        const now = new Set(inst.repos === "all" ? [] : inst.repos);
        for (const r of p.repositories_added ?? []) now.add(r.full_name);
        for (const r of p.repositories_removed ?? []) now.delete(r.full_name);
        inst.repos = [...now].sort();
      }
      await this.saveInstallations(owner, list);
      return { status: 202, result: "repos updated" };
    }
    if (!owner) return { status: 202, result: "not linked" };
    return this.d.github.deliver(owner, { event, delivery: headers.delivery ? `app:${headers.delivery}` : undefined }, body, this.key);
  }

  private async refresh(owner: Owner, id: number): Promise<void> {
    const list = await this.installations(owner);
    const inst = list.find((x) => x.id === id);
    if (!inst) return;
    const { account, repos } = await this.describe(id);
    Object.assign(inst, { account, repos });
    await this.saveInstallations(owner, list);
  }

  // ---- a bot's token ----

  /**
   * A token for a bot's run: an installation that covers the repos it watches, narrowed to those
   * repos. null when none does (it watches nothing, or nothing installed covers it).
   */
  /** Whether the owner's installations reach every one of these repos (no webhook or key needed then). */
  async covers(owner: Owner, repos: string[]): Promise<boolean> {
    if (!repos.length) return false;
    const list = await this.installations(owner).catch(() => []);
    return repos.every((r) => {
      const [acct] = r.split("/");
      return list.some((inst) => (inst.repos === "all" ? acct?.toLowerCase() === inst.account.toLowerCase() : inst.repos.some((x) => x.toLowerCase() === r.toLowerCase())));
    });
  }

  async tokenFor(owner: Owner, repos: string[]): Promise<string | null> {
    if (!repos.length) return null;
    const list = await this.installations(owner);
    let best: { inst: Installation; names: string[] } | null = null;
    for (const inst of list) {
      const covered = repos.filter((r) => {
        const [acct] = r.split("/");
        if (inst.repos === "all") return acct?.toLowerCase() === inst.account.toLowerCase();
        return inst.repos.some((x) => x.toLowerCase() === r.toLowerCase());
      });
      if (covered.length && (!best || covered.length > best.names.length)) best = { inst, names: covered.map((r) => r.split("/")[1]!) };
    }
    if (!best) return null;
    return (await this.installationToken(best.inst.id, best.names)).token;
  }
}
