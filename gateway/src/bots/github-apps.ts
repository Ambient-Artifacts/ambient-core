// GitHub Apps (docs/bots.md, "GitHub Apps"): the server's shared App (its config), the template
// roles' Apps (Ambient Builder, Reviewer, Wiki keeper: each its own GitHub user with just its
// role's access) and a bot's own App. One place that knows them all:
//
//   a bot ──▶ appFor(): its own App or its role's, when the owner installed it on the bot's repos;
//             else the shared App; else none (the owner's own webhook and GH_TOKEN)
//   GitHub ──▶ /v1/hooks/github-app[/<hookId>] ──▶ that App ──▶ only the bots that work through it
//   a run ──▶ tokenFor(): a token from the bot's App, for its repos, with its role's access
//
// A new App is made with GitHub's manifest flow, nothing to copy: the gateway's page posts the
// manifest to GitHub, the person taps Create, GitHub sends the browser back to
// /v1/github/app-created with a one-time code, and the gateway trades it for the App's key and
// webhook secret (sealed with the master key, kept in Convex). A bot's own App then goes straight
// on to its install; a role's App (made once per server by its operator: `admin github-app new`)
// says it's ready.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { api, type Control } from "../control.ts";
import { decryptBytes, encryptBytes, type MasterKey } from "../crypto.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { APP_EVENTS, APP_PERMISSIONS, GitHubApp, stateApp, type AppRole, type GitHubAppConfig, type Installation } from "./github-app.ts";
import { GitHubError, type GitHubEvents } from "./github.ts";

/** The roles with an App of their own, and the template each is for. */
export const ROLE_APPS = ["builder", "reviewer", "wiki_keeper"] as const;
export type RoleApp = (typeof ROLE_APPS)[number];
export const TEMPLATE_ROLE: Record<string, RoleApp> = { builder: "builder", review_bot: "reviewer", wiki_keeper: "wiki_keeper" };
const ROLE_NAMES: Record<RoleApp, string> = { builder: "Ambient Builder", reviewer: "Ambient Reviewer", wiki_keeper: "Ambient Wiki Keeper" };
const ROLE_ABOUT: Record<RoleApp, string> = {
  builder: "Ambient's builder bots: they open pull requests on the repos you pick and fix them until nothing's open. They never merge.",
  reviewer: "Ambient's review bots: they review pull requests on the repos you pick and comment on real problems.",
  wiki_keeper: "Ambient's wiki keepers: they bring the docs in step with what's merged, in pull requests of their own.",
};
const STATE_TTL_MS = 60 * 60_000;
/** GitHub's limit for an App's name. */
const NAME_MAX = 34;

interface AppRow {
  key: string;
  role: Exclude<AppRole, "shared">;
  slug: string;
  appId: string;
  name: string;
  account: string;
  hookId: string;
  routineId: string | null;
  keyIv: string;
  keyCt: string;
  secretIv: string;
  secretCt: string;
}

/** What a manifest flow is for, carried in its signed state. */
interface Making {
  /** "role": a template role's App (the operator); "bot": a bot's own. */
  p: "role" | "bot";
  role?: RoleApp;
  /** A bot's: its owner, its id and name, and who started it. */
  k?: "user" | "team";
  i?: string;
  r?: string;
  b?: string;
  u?: string;
  /** The GitHub account it's made under, and whether that's an organization. */
  acct: string;
  org: boolean;
  /** Its webhook's path part, fixed before GitHub knows the App. */
  h: string;
  n: string;
  e: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class GitHubApps {
  private apps = new Map<string, GitHubApp>();
  private byHook = new Map<string, GitHubApp>();
  private loaded: Promise<void> | null = null;
  private used = new Set<string>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      master: MasterKey;
      origin: string;
      github: GitHubEvents;
      /** The server's shared App, from its config (BRAIN_GITHUB_APP_*). */
      shared?: GitHubAppConfig;
      fetchImpl?: typeof fetch;
      apiBase?: string;
      now?: () => number;
    },
  ) {
    if (d.shared) this.apps.set("shared", this.make({ ...d.shared, key: "shared", role: "shared" }));
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private make(config: GitHubAppConfig): GitHubApp {
    return new GitHubApp({ control: this.d.control, keys: this.d.keys, config: { ...config, apiBase: config.apiBase ?? this.d.apiBase }, github: this.d.github, fetchImpl: this.d.fetchImpl, now: this.d.now });
  }

  private seal(label: string, text: string) {
    return encryptBytes(this.d.master.key, "github-app", label, Buffer.from(text, "utf8"));
  }

  private open(label: string, iv: string, ct: string): string {
    return decryptBytes(this.d.master.key, "github-app", label, iv, ct).toString("utf8");
  }

  private add(row: AppRow): GitHubApp {
    const app = this.make({
      appId: row.appId,
      slug: row.slug,
      key: row.key,
      role: row.role,
      privateKey: this.open(`key:${row.key}`, row.keyIv, row.keyCt),
      webhookSecret: this.open(`secret:${row.key}`, row.secretIv, row.secretCt),
    });
    this.apps.set(row.key, app);
    this.byHook.set(row.hookId, app);
    return app;
  }

  /** The Apps in Convex, once (a new one is added as it's made). */
  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      const rows = ((await this.d.control.q(api.githubApps.list, {}).catch(() => [])) as unknown as AppRow[]) ?? [];
      for (const r of rows) {
        try {
          this.add({ ...r, routineId: r.routineId ? String(r.routineId) : null });
        } catch (err) {
          console.warn(`[github-apps] couldn't open the App ${r.slug}: ${(err as Error).message}`);
        }
      }
    })();
    await this.loaded;
  }

  /** Whether any App is set up (Connect GitHub shows at all). */
  async any(): Promise<boolean> {
    await this.load();
    return this.apps.size > 0;
  }

  get shared(): GitHubApp | undefined {
    return this.apps.get("shared");
  }

  async app(key: string): Promise<GitHubApp | undefined> {
    await this.load();
    return this.apps.get(key);
  }

  /** The Apps there are, for the app's GitHub page. */
  async list(): Promise<{ key: string; slug: string; role: AppRole }[]> {
    await this.load();
    return [...this.apps.values()].map((a) => ({ key: a.key, slug: a.slug, role: a.role }));
  }

  // ---- which App a bot works through ----

  /**
   * The App a bot works through now: its own or its role's (the watch record's `app`) when the
   * owner installed it on all its repos, else the shared App when that covers them, else none.
   */
  async appFor(owner: Owner, bot: { id: string; repos: string[]; app?: string }): Promise<GitHubApp | null> {
    if (!bot.repos.length) return null;
    await this.load();
    const chosen = bot.app ? this.apps.get(bot.app) : undefined;
    for (const a of [chosen, this.shared]) {
      if (a && (await a.covers(owner, bot.repos).catch(() => false))) return a;
    }
    return null;
  }

  /** The App a bot is meant to work through (installed or not): for Connect GitHub. */
  async intendedFor(bot: { app?: string }): Promise<GitHubApp | undefined> {
    await this.load();
    return (bot.app ? this.apps.get(bot.app) : undefined) ?? this.shared;
  }

  /** A run's token: from the bot's App, for its repos, with its role's access. */
  async tokenFor(owner: Owner, bot: { id: string; repos: string[]; app?: string }): Promise<string | null> {
    const a = await this.appFor(owner, bot);
    return a ? a.tokenFor(owner, bot.repos) : null;
  }

  /** Whether the bot's repos are reached through an App (no webhook or GH_TOKEN needed then). */
  async covers(owner: Owner, bot: { id: string; repos: string[]; app?: string }): Promise<boolean> {
    return Boolean(await this.appFor(owner, bot));
  }

  /** Every installation an owner has, by App. */
  async installations(owner: Owner): Promise<(Installation & { app: string; slug: string })[]> {
    await this.load();
    const out: (Installation & { app: string; slug: string })[] = [];
    for (const a of this.apps.values()) for (const i of await a.installations(owner).catch(() => [])) out.push({ ...i, app: a.key, slug: a.slug });
    return out;
  }

  async unlink(owner: Owner, installationId: number): Promise<boolean> {
    await this.load();
    for (const a of this.apps.values()) if (await a.unlink(owner, installationId)) return true;
    return false;
  }

  // ---- GitHub's side ----

  /** A delivery to the shared App's webhook (no hook id) or another App's. */
  async receive(hookId: string | null, headers: { event?: string; signature?: string; delivery?: string }, body: Buffer): Promise<{ status: number; result: string }> {
    await this.load();
    const app = hookId ? this.byHook.get(hookId) : this.shared;
    if (!app) return { status: 404, result: "no such app" };
    return app.receive(headers, body);
  }

  /** GitHub's browser redirect after an install: the App its state names links it. */
  async installed(installationId: number, state: string): Promise<{ inst: Installation; app: GitHubApp }> {
    await this.load();
    const app = this.apps.get(stateApp(state));
    if (!app) throw new GitHubError("bad_state", "This link isn't from Ambient.", 400);
    return { inst: await app.installed(installationId, state), app };
  }

  // ---- making an App (GitHub's manifest flow) ----

  private stateKey(): Buffer {
    return createHmac("sha256", this.d.master.key).update("ambient:github-apps:making").digest();
  }

  private sign(m: Making): string {
    const body = b64url(JSON.stringify(m));
    return `${body}.${b64url(createHmac("sha256", this.stateKey()).update(body).digest())}`;
  }

  private verify(state: string): Making {
    const [body, sig] = state.split(".");
    if (!body || !sig) throw new GitHubError("bad_state", "This link isn't from Ambient.", 400);
    const want = createHmac("sha256", this.stateKey()).update(body).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new GitHubError("bad_state", "This link isn't from Ambient.", 400);
    const m = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Making;
    if (m.e < this.now()) throw new GitHubError("state_expired", "This link has expired. Start again in Ambient.", 400);
    return m;
  }

  private base(): string {
    return this.d.origin.replace(/\/$/, "");
  }

  /** The gateway's page that hands the manifest to GitHub (GitHub only takes it as a form post). */
  private startUrl(m: Making): string {
    return `${this.base()}/v1/github/new-app?state=${encodeURIComponent(this.sign(m))}`;
  }

  /** Whether a GitHub account is an organization (its Apps are made in its settings then). */
  private async isOrg(account: string): Promise<boolean> {
    const base = (this.d.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    const res = await (this.d.fetchImpl ?? fetch)(`${base}/users/${encodeURIComponent(account)}`, { headers: { accept: "application/vnd.github+json", "user-agent": "ambient-gateway" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res?.ok) throw new GitHubError("no_such_account", `There's no GitHub account “${account}”.`, 400);
    return ((await res.json()) as { type?: string }).type === "Organization";
  }

  /** The operator's link to make a template role's App (once per server; `admin github-app new`). */
  async roleAppUrl(role: RoleApp, account: string): Promise<string> {
    if (!(ROLE_APPS as readonly string[]).includes(role)) throw new GitHubError("bad_request", `Roles: ${ROLE_APPS.join(", ")}.`, 400);
    return this.startUrl({ p: "role", role, acct: account, org: await this.isOrg(account), h: randomBytes(18).toString("base64url"), n: randomBytes(12).toString("base64url"), e: this.now() + STATE_TTL_MS });
  }

  /** A bot's own App: made under `account` (the owner of its repos), then installed. */
  async botAppUrl(owner: Owner, bot: { id: string; name: string }, uid: string, account: string): Promise<string> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(account)) throw new GitHubError("bad_request", "Say which GitHub account its repos are in (an organization or a user).", 400);
    return this.startUrl({
      p: "bot",
      k: owner.kind,
      i: owner.kind === "user" ? owner.uid : owner.teamId,
      r: bot.id,
      b: bot.name,
      u: uid,
      acct: account,
      org: await this.isOrg(account),
      h: randomBytes(18).toString("base64url"),
      n: randomBytes(12).toString("base64url"),
      e: this.now() + STATE_TTL_MS,
    });
  }

  /** The manifest GitHub gets: name, Ambient's addresses, the role's access and events. */
  private manifest(m: Making): Record<string, unknown> {
    const role: Exclude<AppRole, "shared"> = m.p === "role" ? m.role! : "bot";
    const name = m.p === "role" ? ROLE_NAMES[m.role!] : `${m.b ?? "Bot"} (${m.acct})`.slice(0, NAME_MAX);
    return {
      name,
      url: this.base(),
      description: m.p === "role" ? ROLE_ABOUT[m.role!] : `${m.b ?? "A bot"}, one of ${m.acct}'s bots in Ambient: it works on the repos it's installed on.`,
      hook_attributes: { url: `${this.base()}/v1/hooks/github-app/${m.h}`, active: true },
      redirect_url: `${this.base()}/v1/github/app-created`,
      setup_url: `${this.base()}/v1/github/installed`,
      setup_on_update: true,
      request_oauth_on_install: false,
      // A role's App is installed by everyone using Ambient; a bot's own only where it was made.
      public: m.p === "role",
      default_permissions: APP_PERMISSIONS[role],
      default_events: APP_EVENTS[role],
    };
  }

  /** The page that posts the manifest to GitHub (it opens on its own; a button if it doesn't). */
  newAppPage(state: string): string {
    const m = this.verify(state);
    const action = m.org ? `https://github.com/organizations/${encodeURIComponent(m.acct)}/settings/apps/new` : "https://github.com/settings/apps/new";
    const manifest = JSON.stringify(this.manifest(m)).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    return page(
      "Create it on GitHub",
      `<p>GitHub opens with everything filled in. Tap <b>Create GitHub App</b> there.</p>
<form id="f" action="${action}?state=${encodeURIComponent(state)}" method="post"><input type="hidden" name="manifest" value="${manifest}"><button type="submit">Continue to GitHub</button></form>
<script>document.getElementById("f").submit()</script>`,
    );
  }

  /**
   * GitHub's redirect after Create: trades the code for the App, keeps it, and goes on. A bot's own
   * App: to its install (the bot works through it from then on). A role's App: done.
   */
  async created(code: string, state: string): Promise<{ redirect?: string; html?: string }> {
    const m = this.verify(state);
    if (this.used.has(m.n)) throw new GitHubError("state_used", "This App was made already. Look for it in Ambient.", 400);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new GitHubError("bad_request", "GitHub sent no code.", 400);
    const base = (this.d.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    const res = await (this.d.fetchImpl ?? fetch)(`${base}/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": "ambient-gateway" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new GitHubError("github_failed", "GitHub didn't hand over the App (the link is used or older than an hour). Start again in Ambient.", 502);
    const out = (await res.json()) as { id?: number; slug?: string; name?: string; pem?: string; webhook_secret?: string; owner?: { login?: string } };
    if (!out.id || !out.slug || !out.pem || !out.webhook_secret) throw new GitHubError("github_failed", "GitHub answered without the App's key.", 502);
    this.used.add(m.n);
    const key = m.p === "role" ? m.role! : out.slug;
    const role: Exclude<AppRole, "shared"> = m.p === "role" ? m.role! : "bot";
    const sealedKey = this.seal(`key:${key}`, out.pem);
    const sealedSecret = this.seal(`secret:${key}`, out.webhook_secret);
    const row: AppRow = {
      key,
      role,
      slug: out.slug,
      appId: String(out.id),
      name: out.name ?? out.slug,
      account: out.owner?.login ?? m.acct,
      hookId: m.h,
      routineId: m.r ?? null,
      keyIv: sealedKey.iv,
      keyCt: sealedKey.ciphertext,
      secretIv: sealedSecret.iv,
      secretCt: sealedSecret.ciphertext,
    };
    const saved = (await this.d.control.m(api.githubApps.add, { ...row, routineId: row.routineId ?? undefined, now: this.now() })) as { ok: boolean; error?: string };
    if (!saved.ok) throw new GitHubError(saved.error ?? "failed", "The bot is gone; its App stays on GitHub, where you can delete it.", 400);
    await this.load();
    const old = this.apps.get(key);
    if (old) for (const [h, a] of this.byHook) if (a === old) this.byHook.delete(h);
    const app = this.add(row);
    if (m.p === "role") {
      return {
        html: page(
          `${row.name} is ready`,
          `<p>People install it from Ambient, in a ${m.role!.replace("_", " ")} bot's GitHub step. Its icon: <a href="https://github.com/${m.org ? `organizations/${encodeURIComponent(row.account)}/` : ""}settings/apps/${encodeURIComponent(row.slug)}">its settings on GitHub</a> → Display information.</p>`,
        ),
      };
    }
    const owner: Owner = m.k === "team" ? { kind: "team", teamId: m.i! } : { kind: "user", uid: m.i! };
    await this.d.github.setApp(owner, m.r!, key);
    return { redirect: app.connectUrl(owner, m.u ?? "") };
  }
}

/** A small page in Ambient's look (the gateway's GitHub pages). */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.25rem;color:#1d1d1f;background:#fbfaf7}a{color:inherit}button{font:600 17px system-ui;padding:12px 20px;border-radius:999px;border:0;background:#2f2f31;color:#fff}@media(prefers-color-scheme:dark){body{color:#f5f5f7;background:#141414}button{background:#fbfbfa;color:#0b0b0c}}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}
