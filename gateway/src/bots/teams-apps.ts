// A bot's own Microsoft Teams app (docs/bots.md, "Microsoft Teams"): one Teams app per bot, so
// each has its own name and face in Teams, made by Ambient in the company's own Microsoft tenant.
// Microsoft stopped new multi-tenant bots on 2025-07-31, so a bot can't be Ambient's: it is the
// company's, a single-tenant app registration and a free Azure Bot (F0) in its own subscription.
//
//   an admin ──▶ POST /v1/app/teams/connect ──▶ Microsoft sign-in (once per company: admin consent
//                for Ambient's setup app) ──▶ /v1/teams/connected ──▶ tenant, Azure subscription,
//                resource group "ambient-bots", refresh token, sealed
//   a bot    ──▶ POST /v1/app/routines/:id/teams ──▶ (as that admin) app registration + secret +
//                service principal ──▶ Azure Bot + its Teams channel, pointing at its hook ──▶
//                the app package (manifest, face) ──▶ the company's Teams app catalog ──▶ a link
//                that opens it in Teams (one tap: Add)
//   Teams    ──▶ /v1/hooks/teams/<signed hook> (a message, an @mention) ──▶ checked as the Bot
//                Framework's for this bot ──▶ the bot's thread, a run starts
//   a run's answer (its reply or its result) ──▶ back into that Teams chat or channel thread
//   a run with news ──▶ postNews() ──▶ the one channel its owner chose (its tool, post_to_teams)
//   a reply in the thread under such a post ──▶ the bot's thread, as an @mention would
//
// Everything is kept in the sealed records (no table of its own): the tenant per owner, each bot's
// app (its secret too) and where its answers go. The hook in a bot's endpoint is signed and names
// the bot, so an activity finds its app without a lookup, and is then checked for that app's id.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { api, type Control } from "../control.ts";
import type { MasterKey } from "../crypto.ts";
import { BotClient, InboundError, type Activity } from "../msteams/botframework.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { sealMessage } from "./messages.ts";
import { splitText } from "./slack-apps.ts";
import { pngSize, teamsPackage } from "./teams-package.ts";
import type { Attachments, FileRef } from "./attachments.ts";
import { download, FILES_BYTES_MAX, leftLine, takeFiles, threadSoFar, THREAD_MAX, type OfferedFile, type ThreadMessage } from "../channels/channel-files.ts";
import { AMB, forAmb, type AmbDoorDeps } from "../channels/amb-doors.ts";
import type { AmbChannel, OutFile, Question } from "../channels/reach.ts";

const TENANT = "teams:tenant";
const APP = "teams:app";
const REPLY = "teams:reply";
const STATE_TTL_MS = 15 * 60_000;
/** An answer goes back to Teams only for a message this recent (a later scheduled run doesn't). */
const REPLY_FOR_MS = 6 * 60 * 60_000;
const TARGETS_MAX = 10;
/** A question's card answers for this long (a run waits a few minutes, then is woken by the answer). */
const ASK_FOR_MS = 24 * 3600_000;
const ADAPTIVE_CARD = "application/vnd.microsoft.card.adaptive";
const FILE_INFO = "application/vnd.microsoft.teams.file.download.info";
const AMB_LINK = "teams:amb-link";
/** A picture up to this size goes inline in the message; anything else as a card with a link. */
const INLINE_MAX = 1024 * 1024;
/** How long a file's download link works. */
const FILE_LINK_MS = 7 * 24 * 3600_000;
const CHANNELS_MAX = 20;
const POSTS_MAX = 30;
/** A bot's secret lasts two years (Microsoft's longest); a new one is made well before it runs out. */
const SECRET_LIFE_MS = 2 * 365 * 24 * 3600_000;
const RESOURCE_GROUP = "ambient-bots";
const LOCATION = "westeurope";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What Ambient's setup app asks the admin for, once (Microsoft Graph, delegated). */
export const TEAMS_GRAPH_SCOPES = [
  "https://graph.microsoft.com/Application.ReadWrite.All",
  "https://graph.microsoft.com/AppCatalog.ReadWrite.All",
  "https://graph.microsoft.com/User.ReadBasic.All",
];
/** And Azure, to make each bot's Azure Bot in the company's subscription. */
export const TEAMS_ARM_SCOPE = "https://management.azure.com/user_impersonation";

export interface TeamsAppsConfig {
  /** Ambient's setup app: a multi-tenant Entra app (Application (client) ID) and its secret. */
  clientId: string;
  secret: string;
  /** Where the apps' "developer" links point (privacy, terms); default: the gateway's origin. */
  website?: string;
}

/**
 * BRAIN_TEAMS_APPS_CLIENT_ID + BRAIN_TEAMS_APPS_SECRET (+ BRAIN_TEAMS_APPS_WEBSITE). Unset: bots
 * can't go to Teams on this server.
 */
export function loadTeamsApps(env: NodeJS.ProcessEnv = process.env): TeamsAppsConfig | undefined {
  const clientId = env.BRAIN_TEAMS_APPS_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  if (!GUID.test(clientId)) throw new Error("BRAIN_TEAMS_APPS_CLIENT_ID must be the setup app's Application (client) ID");
  const secret = env.BRAIN_TEAMS_APPS_SECRET?.trim();
  if (!secret) throw new Error("BRAIN_TEAMS_APPS_CLIENT_ID needs BRAIN_TEAMS_APPS_SECRET");
  const website = env.BRAIN_TEAMS_APPS_WEBSITE?.trim();
  return { clientId, secret, ...(website ? { website } : {}) };
}

/** A Teams channel a bot is in: the channel's conversation id, and its name once Teams told it. */
export interface TeamsChannel {
  id: string;
  name?: string;
  team?: string;
}

export interface TeamsNews {
  channel: TeamsChannel | null;
  channels: TeamsChannel[];
  broken: string | null;
}

interface Tenant {
  tenantId: string;
  refresh: string;
  /** Who connected it: the admin whose rights make the bots, and the fallback for who a bot listens to. */
  admin: { oid: string; name: string; email: string | null };
  subscriptionId: string;
  subscriptions: { id: string; name: string }[];
  resourceGroup: string;
  location: string;
  at: number;
}

interface AppRecord {
  name: string;
  tenantId: string;
  /** The bot's Entra app registration: its object id, its Application ID, its secret. */
  objectId?: string;
  appId?: string;
  secret?: string;
  secretExp?: number;
  servicePrincipal?: boolean;
  /** Its Azure Bot (a resource name in the company's resource group). */
  botName?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  channel?: boolean;
  /** Its app in Teams: the manifest's id, its version, and its id in the company's app catalog. */
  manifestId: string;
  version: number;
  catalogId?: string;
  /** Who it takes instructions from: an Entra user (object id) and their name. */
  installer?: string;
  installerName?: string;
  /** Their Ambient account: a click on a question's card answers as them. */
  adderUid?: string;
  /** Where Teams is reached for this tenant (the serviceUrl of the last activity). */
  serviceUrl?: string;
  /** Set when its owner first opened a chat with it. */
  installedAt?: number;
  channels?: TeamsChannel[];
  /** Where its news goes: a channel's id; "": only the app; unset: the first channel it was mentioned in. */
  news?: string;
  newsBroken?: string;
  posts?: { conv: string; id: string; at: number }[];
  /** The bot's face for its icon (192 px PNG, base64), kept so a new version keeps it. */
  icon?: string;
}

interface Target {
  conv: string;
  at: number;
  runId?: string;
}

/** A question of the bot's in a Teams chat or thread (a card), until it's answered. */
interface Ask {
  q: string;
  conv: string;
  /** The card's message, to replace once it's answered. */
  activityId?: string;
  text: string;
  at: number;
}

interface Replies {
  targets: Target[];
  run?: { id: string; hash: string };
  asks?: Ask[];
}

interface Ref {
  k: "user" | "team";
  i: string;
  r: string;
}

export class TeamsError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** What checks an activity came from the Bot Framework for this bot (msteams/botframework.ts). */
export interface ActivityVerifier {
  verify(authorization: string | undefined, appId: string, activity: Activity): Promise<void>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const ownerOf = (ref: Ref): Owner => (ref.k === "team" ? { kind: "team", teamId: ref.i } : { kind: "user", uid: ref.i });
const refOf = (owner: Owner, routineId: string): Ref => ({ k: owner.kind, i: owner.kind === "user" ? owner.uid : owner.teamId, r: routineId });
const ownerArgs = (owner: Owner) => ({ ownerKind: owner.kind, ownerId: owner.kind === "user" ? owner.uid : owner.teamId });
const ownerKey = (owner: Owner) => JSON.stringify(ownerArgs(owner));

export class TeamsApps {
  private seen = new Map<string, number>();
  private warned = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private locks = new Map<string, Promise<void>>();
  private clients = new Map<string, BotClient>();
  /** Access tokens per owner and resource, kept until shortly before they expire. */
  private tokens = new Map<string, { value: string; until: number }>();
  /** One token call per owner at a time: each one hands out a new refresh token. */
  private renewing = new Map<string, Promise<unknown>>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      master: MasterKey;
      origin: string;
      config: TeamsAppsConfig;
      verifier: ActivityVerifier;
      startNow?: (hostId: string, routineId: string) => void;
      /** A person's sign-in email: who a bot they add listens to in Teams is found by it. */
      emailOf?: (uid: string) => Promise<string | null>;
      /** Where files sent with a message are kept (the bot's thread), and read back for a link. */
      attachments?: Attachments;
      /** Answers a bot's open question as `uid` (a click on its card, or a reply); "gone" when it isn't open any more. */
      answer?: (uid: string, routineId: string, questionId: string, text: string) => Promise<"answered" | "gone" | { error: string }>;
      fetchImpl?: typeof fetch;
      /** Microsoft's addresses (tests: stand-ins). */
      login?: string;
      graph?: string;
      arm?: string;
      /** How long to wait before asking Azure again while a new app registration spreads. */
      retryMs?: number;
      now?: () => number;
      /** Amb in Teams: its chat, and whose account a direct message is (channels/amb-doors.ts). */
      amb?: AmbDoorDeps;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }
  private base(): string {
    return this.d.origin.replace(/\/$/, "");
  }
  private get login() {
    return (this.d.login ?? "https://login.microsoftonline.com").replace(/\/$/, "");
  }
  private get graph() {
    return (this.d.graph ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
  }
  private get arm() {
    return (this.d.arm ?? "https://management.azure.com").replace(/\/$/, "");
  }
  private get fetch(): typeof fetch {
    return this.d.fetchImpl ?? fetch;
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private track<T>(p: Promise<T>): void {
    const q = p.catch((err: Error) => console.warn(`[teams] ${err.message}`)).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  // ---- records ----

  private async put(owner: Owner, kind: string, key: string, value: unknown, deleted = false): Promise<void> {
    const sealed = await this.d.keys.seal(owner, `record:${kind}`, JSON.stringify(value));
    await this.d.control.m(api.records.put, { ...ownerArgs(owner), kind, key, iv: sealed.iv, ct: sealed.ciphertext, size: sealed.ciphertext.length, byKind: "user", ...(deleted ? { deleted: true } : {}), keep: 1, now: this.now() });
  }

  private async get<T>(owner: Owner, kind: string, key: string): Promise<T | null> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind, key })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    const raw = await this.d.keys.open(owner, `record:${kind}`, r.iv, r.ct).catch(() => null);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  // ---- signed refs (a hook in a bot's endpoint; a sign-in's state) ----

  private key(purpose: string): Buffer {
    return createHmac("sha256", this.d.master.key).update(`ambient:teams:${purpose}`).digest();
  }

  private sign(purpose: string, value: object): string {
    const body = b64url(JSON.stringify(value));
    return `${body}.${b64url(createHmac("sha256", this.key(purpose)).update(body).digest().subarray(0, 18))}`;
  }

  private verify<T>(purpose: string, signed: string): T | null {
    const [body, sig] = signed.split(".");
    if (!body || !sig) return null;
    const want = createHmac("sha256", this.key(purpose)).update(body).digest().subarray(0, 18);
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  // ---- Microsoft: tokens as the admin who connected the tenant ----

  private async tokenCall(tenant: string, params: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; error?: string; error_description?: string }> {
    const res = await this.fetch(`${this.login}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.d.config.clientId, client_secret: this.d.config.secret, ...params }).toString(),
      signal: AbortSignal.timeout(20_000),
    }).catch((err: Error) => {
      throw new TeamsError("microsoft_unreachable", `Microsoft didn't answer (${err.message}).`, 502);
    });
    return (await res.json().catch(() => ({ error: `http_${res.status}` }))) as Awaited<ReturnType<TeamsApps["tokenCall"]>>;
  }

  /** A token for Graph or Azure as the admin; the refresh token Microsoft hands back is kept. */
  private async token(owner: Owner, resource: "graph" | "arm"): Promise<{ token: string; tenant: Tenant }> {
    const t = await this.get<Tenant>(owner, TENANT, "tenant");
    if (!t) throw new TeamsError("no_tenant", "Connect Microsoft Teams first (Settings → Connect → Microsoft Teams): an admin signs in once.", 400);
    const cacheKey = `${ownerKey(owner)}:${resource}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.until > this.now()) return { token: cached.value, tenant: t };
    const k = ownerKey(owner);
    while (this.renewing.has(k)) await this.renewing.get(k)!.catch(() => undefined);
    const again = this.tokens.get(cacheKey);
    if (again && again.until > this.now()) return { token: again.value, tenant: t };
    const p = (async () => {
      const fresh = (await this.get<Tenant>(owner, TENANT, "tenant")) ?? t;
      const scope = resource === "graph" ? [...TEAMS_GRAPH_SCOPES, "offline_access"].join(" ") : `${TEAMS_ARM_SCOPE} offline_access`;
      const out = await this.tokenCall(fresh.tenantId, { grant_type: "refresh_token", refresh_token: fresh.refresh, scope });
      if (!out.access_token) {
        const why = (out.error_description ?? out.error ?? "no reason").split("\n")[0];
        throw new TeamsError("microsoft_token", out.error === "invalid_grant" ? `Microsoft doesn't take ${fresh.admin.name}'s sign-in anymore. An admin connects Microsoft Teams again in Ambient (${why}).` : `Microsoft refused the sign-in (${why}).`, 400);
      }
      if (out.refresh_token && out.refresh_token !== fresh.refresh) await this.put(owner, TENANT, "tenant", { ...fresh, refresh: out.refresh_token });
      this.tokens.set(cacheKey, { value: out.access_token, until: this.now() + Math.max(60, (out.expires_in ?? 3600) - 300) * 1000 });
      return out.access_token;
    })().finally(() => this.renewing.delete(k));
    this.renewing.set(k, p);
    return { token: await p, tenant: t };
  }

  private async ms<T = Record<string, unknown>>(
    owner: Owner,
    resource: "graph" | "arm",
    method: string,
    path: string,
    body?: unknown,
    opts: { contentType?: string; ok?: number[] } = {},
  ): Promise<{ status: number; json: T & { error?: { code?: string; message?: string } } }> {
    const { token } = await this.token(owner, resource);
    const url = `${resource === "graph" ? this.graph : this.arm}${path}`;
    const res = await this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": opts.contentType ?? "application/json" } : {}) },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((err: Error) => {
      throw new TeamsError("microsoft_unreachable", `Microsoft didn't answer (${err.message}).`, 502);
    });
    const text = await res.text();
    let json = {} as T & { error?: { code?: string; message?: string } };
    try {
      json = text ? JSON.parse(text) : json;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  }

  private static why(r: { status: number; json: { error?: { code?: string; message?: string } } }): string {
    return `${r.status}${r.json.error?.code ? ` ${r.json.error.code}` : ""}${r.json.error?.message ? `: ${r.json.error.message.split("\n")[0]!.slice(0, 200)}` : ""}`;
  }

  // ---- the tenant (once per person or team) ----

  /** The Microsoft sign-in an admin opens once: Ambient's setup app asks for what it needs to make bots. */
  connectUrl(owner: Owner, uid: string): { url: string } {
    const state = this.sign("connect", { ...refOf(owner, ""), u: uid, n: randomBytes(9).toString("base64url"), e: this.now() + STATE_TTL_MS });
    const q = new URLSearchParams({
      client_id: this.d.config.clientId,
      response_type: "code",
      response_mode: "query",
      redirect_uri: `${this.base()}/v1/teams/connected`,
      // Azure's scope comes along for consent only; tokens for it come from the refresh token later.
      scope: [...TEAMS_GRAPH_SCOPES, TEAMS_ARM_SCOPE, "offline_access", "openid", "profile"].join(" "),
      state,
      prompt: "select_account",
    });
    return { url: `${this.login}/organizations/oauth2/v2.0/authorize?${q.toString()}` };
  }

  /** Microsoft sends the admin back: the tenant, its Azure subscription and a resource group for the bots. */
  async connected(code: string, state: string): Promise<{ tenantId: string; admin: string; subscription: string }> {
    const s = this.verify<Ref & { u: string; e: number }>("connect", state);
    if (!s) throw new TeamsError("bad_state", "This link isn't from Ambient.", 400);
    if (s.e < this.now()) throw new TeamsError("state_expired", "This sign-in took too long. Tap Connect Microsoft Teams again in Ambient.", 400);
    if (!code || code.length > 4000) throw new TeamsError("bad_request", "Microsoft sent no code.", 400);
    const owner = ownerOf(s);
    const out = await this.tokenCall("organizations", { grant_type: "authorization_code", code, redirect_uri: `${this.base()}/v1/teams/connected`, scope: [...TEAMS_GRAPH_SCOPES, "offline_access", "openid", "profile"].join(" ") });
    if (!out.access_token || !out.refresh_token || !out.id_token) throw new TeamsError("microsoft_token", `Microsoft didn't sign you in (${(out.error_description ?? out.error ?? "no reason").split("\n")[0]}).`, 400);
    const claims = decodeIdToken(out.id_token);
    if (!claims.tid || !claims.oid) throw new TeamsError("microsoft_token", "Microsoft's sign-in named no organisation. Sign in with a work account.", 400);
    const tenant: Tenant = {
      tenantId: claims.tid,
      refresh: out.refresh_token,
      admin: { oid: claims.oid, name: claims.name ?? claims.preferred_username ?? "the admin", email: claims.email ?? claims.preferred_username ?? null },
      subscriptionId: "",
      subscriptions: [],
      resourceGroup: RESOURCE_GROUP,
      location: LOCATION,
      at: this.now(),
    };
    await this.put(owner, TENANT, "tenant", tenant);
    this.tokens.set(`${ownerKey(owner)}:graph`, { value: out.access_token, until: this.now() + Math.max(60, (out.expires_in ?? 3600) - 300) * 1000 });
    this.tokens.delete(`${ownerKey(owner)}:arm`);
    // Azure: which subscription the bots go in (the first one that's on; changeable later).
    const subs = await this.ms<{ value?: { subscriptionId: string; displayName?: string; state?: string }[] }>(owner, "arm", "GET", "/subscriptions?api-version=2022-12-01");
    if (subs.status !== 200) throw new TeamsError("azure_failed", `Azure didn't list your subscriptions (${TeamsApps.why(subs)}).`, 502);
    const usable = (subs.json.value ?? []).filter((x) => !x.state || x.state === "Enabled").map((x) => ({ id: x.subscriptionId, name: x.displayName ?? x.subscriptionId }));
    if (!usable.length) throw new TeamsError("no_subscription", `${tenant.admin.name} has no Azure subscription that's on. Each bot needs a free Azure Bot there: sign in with someone who can create resources in one.`, 400);
    const withSub = { ...((await this.get<Tenant>(owner, TENANT, "tenant")) ?? tenant), subscriptions: usable, subscriptionId: usable[0]!.id };
    await this.put(owner, TENANT, "tenant", withSub);
    await this.prepareSubscription(owner, withSub);
    return { tenantId: tenant.tenantId, admin: tenant.admin.name, subscription: usable[0]!.name };
  }

  /** The subscription can hold Azure Bots, and has the resource group Ambient puts them in. */
  private async prepareSubscription(owner: Owner, t: Tenant): Promise<void> {
    const reg = await this.ms(owner, "arm", "POST", `/subscriptions/${t.subscriptionId}/providers/Microsoft.BotService/register?api-version=2021-04-01`);
    if (reg.status >= 300) throw new TeamsError("azure_failed", `Azure didn't turn on Azure Bots in your subscription (${TeamsApps.why(reg)}).`, 502);
    const rg = await this.ms(owner, "arm", "PUT", `/subscriptions/${t.subscriptionId}/resourcegroups/${t.resourceGroup}?api-version=2021-04-01`, { location: t.location, tags: { madeBy: "Ambient" } });
    if (rg.status >= 300) throw new TeamsError("azure_failed", `Azure didn't make the resource group ${t.resourceGroup} (${TeamsApps.why(rg)}).`, 502);
  }

  async connection(owner: Owner): Promise<{ connected: boolean; tenantId: string | null; admin: string | null; subscription: { id: string; name: string } | null; subscriptions: { id: string; name: string }[] }> {
    const t = await this.get<Tenant>(owner, TENANT, "tenant");
    if (!t) return { connected: false, tenantId: null, admin: null, subscription: null, subscriptions: [] };
    return { connected: true, tenantId: t.tenantId, admin: t.admin.name, subscription: t.subscriptions.find((x) => x.id === t.subscriptionId) ?? null, subscriptions: t.subscriptions };
  }

  /** Another of the admin's subscriptions for new bots (bots made before stay where they are). */
  async setSubscription(owner: Owner, id: string): Promise<void> {
    const t = await this.get<Tenant>(owner, TENANT, "tenant");
    if (!t) throw new TeamsError("no_tenant", "Connect Microsoft Teams first.", 400);
    if (!t.subscriptions.some((x) => x.id === id)) throw new TeamsError("no_such_subscription", "That isn't one of the subscriptions the admin can use.", 400);
    const next = { ...t, subscriptionId: id };
    await this.put(owner, TENANT, "tenant", next);
    await this.prepareSubscription(owner, next);
  }

  async disconnect(owner: Owner): Promise<void> {
    await this.put(owner, TENANT, "tenant", {}, true);
    this.tokens.delete(`${ownerKey(owner)}:graph`);
    this.tokens.delete(`${ownerKey(owner)}:arm`);
  }

  // ---- a bot's app ----

  async status(owner: Owner, routineId: string): Promise<{ tenant: boolean; app: { appId: string | null; ready: boolean; installed: boolean; installer: string | null; url: string | null } | null; news: TeamsNews | null }> {
    const [t, app] = await Promise.all([this.get<Tenant>(owner, TENANT, "tenant"), this.get<AppRecord>(owner, APP, routineId)]);
    const ready = !!app?.catalogId;
    return {
      tenant: !!t,
      app: app ? { appId: app.appId ?? null, ready, installed: !!app.installedAt, installer: app.installerName ?? null, url: ready ? this.openUrl(app) : null } : null,
      news: app?.installedAt || app?.channels?.length ? this.newsOf(app) : null,
    };
  }

  private openUrl(app: AppRecord): string {
    return `https://teams.microsoft.com/l/app/${app.manifestId}`;
  }

  /**
   * Gives a bot its own Teams app in the company's tenant and returns the link that opens it in
   * Teams (one tap: Add). Each step is kept as it's done, so asking again after a failure goes on
   * where it stopped; asking again when it's all there gives the same link.
   */
  async add(owner: Owner, bot: { id: string; name: string }, uid: string): Promise<{ url: string; chatUrl: string; ready: true; installed: boolean; installer: string }> {
    const { tenant: t } = await this.token(owner, "graph");
    let app = (await this.get<AppRecord>(owner, APP, bot.id)) ?? { name: bot.name, tenantId: t.tenantId, manifestId: randomUUID(), version: 0 };
    if (app.tenantId !== t.tenantId) throw new TeamsError("other_tenant", "This bot is in another company's Teams. Take it out of Teams first, then add it again.", 409);
    const save = async (next: AppRecord) => {
      app = next;
      await this.put(owner, APP, bot.id, app);
    };
    // 1. Its app registration in the company's Entra, its secret, its service principal.
    if (!app.objectId || !app.appId) {
      const r = await this.ms<{ id?: string; appId?: string }>(owner, "graph", "POST", "/applications", { displayName: `${bot.name} (Ambient bot)`.slice(0, 120), signInAudience: "AzureADMyOrg", tags: ["Ambient"] });
      if (r.status !== 201 || !r.json.id || !r.json.appId) throw this.refusal("graph", r, "make the bot's app registration");
      await save({ ...app, objectId: r.json.id, appId: r.json.appId });
    }
    if (!app.secret) {
      const r = await this.ms<{ secretText?: string; endDateTime?: string }>(owner, "graph", "POST", `/applications/${app.objectId}/addPassword`, { passwordCredential: { displayName: "Ambient", endDateTime: new Date(this.now() + SECRET_LIFE_MS).toISOString() } });
      if (r.status !== 200 || !r.json.secretText) throw this.refusal("graph", r, "make the bot's secret");
      await save({ ...app, secret: r.json.secretText, secretExp: r.json.endDateTime ? Date.parse(r.json.endDateTime) : this.now() + SECRET_LIFE_MS });
    }
    if (!app.servicePrincipal) {
      const r = await this.ms(owner, "graph", "POST", "/servicePrincipals", { appId: app.appId, tags: ["Ambient"] });
      if (r.status !== 201 && r.status !== 409) throw this.refusal("graph", r, "make the bot's service principal");
      await save({ ...app, servicePrincipal: true });
    }
    // 2. Its Azure Bot, pointing at its hook, with the Teams channel on.
    if (!app.botName) app = { ...app, botName: azureName(bot.name), subscriptionId: t.subscriptionId, resourceGroup: t.resourceGroup };
    const botPath = `/subscriptions/${app.subscriptionId}/resourceGroups/${app.resourceGroup}/providers/Microsoft.BotService/botServices/${app.botName}`;
    if (!app.channel) {
      const endpoint = `${this.base()}/v1/hooks/teams/${this.sign("hook", refOf(owner, bot.id))}`;
      const body = { location: "global", sku: { name: "F0" }, kind: "azurebot", tags: { madeBy: "Ambient" }, properties: { displayName: bot.name.slice(0, 64), endpoint, msaAppId: app.appId, msaAppType: "SingleTenant", msaAppTenantId: t.tenantId } };
      // A new app registration takes a moment to reach Azure: asked again a few times.
      let r = await this.ms(owner, "arm", "PUT", `${botPath}?api-version=2022-09-15`, body);
      for (let i = 0; i < 4 && r.status >= 400 && r.status < 500 && r.status !== 403; i++) {
        await new Promise((ok) => setTimeout(ok, this.d.retryMs ?? 5_000));
        r = await this.ms(owner, "arm", "PUT", `${botPath}?api-version=2022-09-15`, body);
      }
      if (r.status >= 300) throw this.refusal("arm", r, "make the bot's Azure Bot");
      await save(app);
      const c = await this.ms(owner, "arm", "PUT", `${botPath}/channels/MsTeamsChannel?api-version=2022-09-15`, { location: "global", properties: { channelName: "MsTeamsChannel", properties: { isEnabled: true } } });
      if (c.status >= 300) throw this.refusal("arm", c, "turn on Teams for the bot");
      await save({ ...app, channel: true });
    }
    // 3. Its app in the company's Teams app catalog.
    if (!app.catalogId) {
      const version = app.version + 1;
      const r = await this.ms<{ id?: string }>(owner, "graph", "POST", "/appCatalogs/teamsApps", this.package(app, version), { contentType: "application/zip" });
      if (r.status === 409) {
        // Published before (its id was lost): found by its manifest id.
        const found = await this.ms<{ value?: { id: string }[] }>(owner, "graph", "GET", `/appCatalogs/teamsApps?$filter=externalId eq '${app.manifestId}'`);
        const id = found.json.value?.[0]?.id;
        if (!id) throw this.refusal("graph", r, "put the bot in your Teams app catalog");
        await save({ ...app, catalogId: id, version });
      } else {
        if (r.status !== 201 && r.status !== 200) throw this.refusal("graph", r, "put the bot in your Teams app catalog");
        if (!r.json.id) throw new TeamsError("microsoft_failed", "Teams didn't say the app's id.", 502);
        await save({ ...app, catalogId: r.json.id, version });
      }
    }
    // 4. Who it listens to: the person who added it, found in the company by their email; else the admin.
    if (!app.installer) {
      let who: { id: string; name: string } | null = null;
      const email = await this.d.emailOf?.(uid).catch(() => null);
      if (email) {
        const r = await this.ms<{ id?: string; displayName?: string }>(owner, "graph", "GET", `/users/${encodeURIComponent(email)}?$select=id,displayName`);
        if (r.status === 200 && r.json.id) who = { id: r.json.id, name: r.json.displayName ?? email };
      }
      who ??= { id: t.admin.oid, name: t.admin.name };
      await save({ ...app, installer: who.id, installerName: who.name, adderUid: uid });
    }
    if (!app.adderUid) await save({ ...app, adderUid: uid });
    return { url: this.openUrl(app), chatUrl: `https://teams.microsoft.com/l/chat/0/0?users=28:${app.appId}`, ready: true, installed: !!app.installedAt, installer: app.installerName! };
  }

  private refusal(where: "graph" | "arm", r: { status: number; json: { error?: { code?: string; message?: string } } }, what: string): TeamsError {
    if (r.status === 401 || r.status === 403) {
      const role =
        where === "arm"
          ? "needs to be allowed to create resources in the Azure subscription (Contributor on it, or on the resource group ambient-bots)"
          : what.includes("catalog")
            ? "needs to be a Teams admin (or Global admin) to put apps in your company's Teams"
            : "needs to be allowed to register apps in Microsoft Entra (Application admin, or Global admin)";
      return new TeamsError("not_allowed", `Microsoft didn't let Ambient ${what}: the admin who connected Teams ${role}. (${TeamsApps.why(r)})`, 403);
    }
    return new TeamsError("microsoft_failed", `Microsoft didn't ${what} (${TeamsApps.why(r)}).`, 502);
  }

  private package(app: AppRecord, version: number): Buffer {
    return teamsPackage({ manifestId: app.manifestId, version: `1.0.${version}`, botAppId: app.appId!, name: app.name, website: this.d.config.website ?? this.base() }, app.icon ? Buffer.from(app.icon, "base64") : undefined);
  }

  /** A new version of its app in the catalog (a new face, a new name): Teams updates it everywhere. */
  private async republish(owner: Owner, routineId: string, app: AppRecord): Promise<AppRecord> {
    if (!app.catalogId) {
      await this.put(owner, APP, routineId, app);
      return app;
    }
    const version = app.version + 1;
    const r = await this.ms(owner, "graph", "POST", `/appCatalogs/teamsApps/${app.catalogId}/appDefinitions`, this.package(app, version), { contentType: "application/zip" });
    if (r.status >= 300) throw this.refusal("graph", r, "update the bot's app in Teams");
    const next = { ...app, version };
    await this.put(owner, APP, routineId, next);
    return next;
  }

  /** The bot's face as its app's icon: a 192 × 192 PNG (Teams' size for an app's colour icon). */
  async setIcon(owner: Owner, routineId: string, png: Buffer): Promise<void> {
    const size = pngSize(png);
    if (!size || size.width !== 192 || size.height !== 192) throw new TeamsError("bad_icon", "Teams wants the icon as a PNG of exactly 192 × 192 pixels.", 400);
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app) throw new TeamsError("no_app", "This bot isn't in Teams yet.", 404);
    await this.republish(owner, routineId, { ...app, icon: png.toString("base64") });
  }

  /** Takes the bot out of Teams: its app, its Azure Bot and its app registration are deleted. */
  async remove(owner: Owner, routineId: string): Promise<boolean> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app) return false;
    const steps: [string, () => Promise<{ status: number }>][] = [];
    if (app.catalogId) steps.push(["its Teams app", () => this.ms(owner, "graph", "DELETE", `/appCatalogs/teamsApps/${app.catalogId}`)]);
    if (app.botName && app.subscriptionId) steps.push(["its Azure Bot", () => this.ms(owner, "arm", "DELETE", `/subscriptions/${app.subscriptionId}/resourceGroups/${app.resourceGroup}/providers/Microsoft.BotService/botServices/${app.botName}?api-version=2022-09-15`)]);
    if (app.objectId) steps.push(["its app registration", () => this.ms(owner, "graph", "DELETE", `/applications/${app.objectId}`)]);
    for (const [what, run] of steps) {
      const r = await run().catch((err: Error) => ({ status: 0, err }));
      if (r.status >= 300 && r.status !== 404) console.warn(`[teams] couldn't delete ${what} of ${app.name}: ${r.status}`);
    }
    if (app.appId) this.clients.delete(app.appId);
    await this.put(owner, APP, routineId, {}, true);
    await this.put(owner, REPLY, routineId, {}, true);
    return true;
  }

  // ---- its own news: one channel, chosen by its owner ----

  private static newsChannel(app: AppRecord): TeamsChannel | null {
    if (app.news === "") return null;
    const id = app.news ?? app.channels?.[0]?.id;
    return id ? (app.channels?.find((c) => c.id === id) ?? { id }) : null;
  }

  private newsOf(app: AppRecord): TeamsNews {
    return { channel: TeamsApps.newsChannel(app), channels: app.channels ?? [], broken: app.newsBroken ?? null };
  }

  private static label(c: TeamsChannel): string {
    return c.name ? `${c.team ? `${c.team} › ` : ""}${c.name}` : "the Teams channel you were mentioned in";
  }

  /** What a run is told about Teams (folder.ts, wake): its name, and where its news goes. Null: not in Teams. */
  async forRun(owner: Owner, routineId: string): Promise<{ handle: string; news: string | null } | null> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app?.catalogId) return null;
    const c = TeamsApps.newsChannel(app);
    return { handle: app.name, news: c && !app.newsBroken ? TeamsApps.label(c) : null };
  }

  async setNews(owner: Owner, routineId: string, channel: string | null): Promise<TeamsNews> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app?.catalogId) throw new TeamsError("not_in_teams", "This bot isn't in Teams yet.", 400);
    if (channel !== null && !app.channels?.some((c) => c.id === channel)) throw new TeamsError("no_such_channel", "It hasn't been mentioned in that channel. Add it to the team and mention it there once, then choose it.", 400);
    const { newsBroken: _was, ...rest } = app;
    const next: AppRecord = { ...rest, news: channel ?? "" };
    await this.put(owner, APP, routineId, next);
    return this.newsOf(next);
  }

  /** The bot posts news of its own (post_to_teams): a new post in the one channel its owner chose. */
  async postNews(owner: Owner, routineId: string, text: string): Promise<{ channel: TeamsChannel }> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app?.catalogId || !app.secret) throw new TeamsError("not_in_teams", "You're not in Teams: what you report is in the Ambient app.", 400);
    const channel = TeamsApps.newsChannel(app);
    if (!channel || !app.serviceUrl) throw new TeamsError("no_channel", "No Teams channel is chosen for your news, so it stays in the Ambient app. Your owner chooses one on your Teams page.", 400);
    const client = this.client(app);
    let first: string | undefined;
    try {
      for (const part of splitText(text)) {
        if (!first) first = await client.send(app.serviceUrl, channel.id, { text: part, textFormat: "markdown" });
        else await client.send(app.serviceUrl, `${channel.id};messageid=${first}`, { text: part, textFormat: "markdown" });
      }
    } catch (err) {
      const gone = /\b(403|404)\b/.test((err as Error).message);
      if (gone) await this.put(owner, APP, routineId, { ...app, newsBroken: "removed" });
      throw new TeamsError("teams_failed", gone ? `You can't post in ${TeamsApps.label(channel)} anymore (you were removed from the team or the channel is gone). It stays in the Ambient app; your owner sees that on your Teams page.` : `Teams didn't take the message (${(err as Error).message}).`, 502);
    }
    const { newsBroken: _was, ...rest } = app;
    const posts = first ? [...(app.posts ?? []), { conv: channel.id, id: first, at: this.now() }].slice(-POSTS_MAX) : (app.posts ?? []);
    await this.put(owner, APP, routineId, { ...rest, posts });
    return { channel };
  }

  private client(app: AppRecord): BotClient {
    let c = this.clients.get(app.appId!);
    if (!c) {
      c = new BotClient({ tenantId: app.tenantId, appId: app.appId!, secret: app.secret! }, this.d.fetchImpl);
      this.clients.set(app.appId!, c);
    }
    return c;
  }

  // ---- what Teams sends ----

  /** An activity for a bot (`hook` from its endpoint), checked as the Bot Framework's for that bot. */
  async receive(hook: string, authorization: string | undefined, a: Activity): Promise<{ status: number; body: unknown }> {
    const ref = this.verify<Ref>("hook", hook);
    if (!ref) return { status: 404, body: { error: "not_found" } };
    if (!a || typeof a !== "object" || typeof a.serviceUrl !== "string" || !a.recipient?.id || !a.conversation?.id || !a.from?.id) return { status: 400, body: { error: "invalid_request" } };
    const owner = ownerOf(ref);
    const app = await this.get<AppRecord>(owner, APP, ref.r);
    if (!app?.appId || !app.secret) return { status: 404, body: { error: "not_found" } };
    try {
      await this.d.verifier.verify(authorization, app.appId, a);
    } catch (err) {
      if (err instanceof InboundError) {
        console.warn(`[teams] refused an activity for ${app.name}: ${err.message}`);
        return { status: 401, body: { error: "unauthorized" } };
      }
      throw err;
    }
    // A single-tenant bot answers no one outside its company.
    const tenant = a.conversation.tenantId ?? a.channelData?.tenant?.id;
    if (tenant && tenant !== app.tenantId) return { status: 403, body: { error: "wrong_tenant" } };
    if (a.id) {
      const now = this.now();
      for (const [k, at] of this.seen) if (now - at > 30 * 60_000) this.seen.delete(k);
      const id = `${app.appId}:${a.id}`;
      if (this.seen.has(id)) return { status: 200, body: {} };
      this.seen.set(id, now);
    }
    this.track(this.onActivity(owner, ref.r, app, a));
    return { status: 200, body: {} };
  }

  private async onActivity(owner: Owner, routineId: string, app: AppRecord, a: Activity): Promise<void> {
    if (app.serviceUrl !== a.serviceUrl) {
      app = { ...app, serviceUrl: a.serviceUrl };
      await this.put(owner, APP, routineId, app);
    }
    const kind = a.conversation.conversationType ?? (a.channelData?.channel ? "channel" : a.conversation.isGroup ? "groupChat" : "personal");
    const client = this.client(app);
    if (routineId === AMB) return this.onAmbActivity(owner, app, client, a, kind);
    if (a.type === "conversationUpdate") {
      const added = a.membersAdded?.some((m) => m.id === a.recipient.id);
      if (!added) return;
      if (kind === "personal") {
        if (!app.installedAt && a.from.aadObjectId === app.installer) await this.put(owner, APP, routineId, (app = { ...app, installedAt: this.now() }));
        await client.send(a.serviceUrl, a.conversation.id, { text: `Hi, I'm ${app.name}, your bot from Ambient. Write to me here, or mention me in a channel: I answer in the thread.`, textFormat: "markdown" }).catch(() => undefined);
      }
      return;
    }
    if (a.type !== "message") return;
    if (a.from.id === a.recipient.id) return;
    // A click on a question's card: the answer, from its owner only.
    const submit = cardSubmit(a.value);
    if (submit) {
      await this.onCardAnswer(owner, routineId, app, a, submit);
      return;
    }
    const mentioned = (a.entities ?? []).some((e) => e.type === "mention" && e.mentioned?.id === a.recipient.id);
    const [conv, root] = a.conversation.id.split(";messageid=") as [string, string | undefined];
    const underOwnPost = kind === "channel" && !mentioned && !!root && (app.posts ?? []).some((p) => p.conv === conv && p.id === root);
    // A reply where its question waits (the chat, or the card's thread) answers it.
    const waiting = a.from.aadObjectId === app.installer ? await this.waitingAsk(owner, routineId, a.conversation.id) : null;
    if (waiting) {
      const typed = teamsToPlain(a.text ?? "");
      // Answered (or refused, with the reason said): done. Gone: it was a new message after all.
      if (typed && (await this.answerAsk(owner, routineId, app, waiting, typed, a.from.name ?? "you", a.serviceUrl)) !== "gone") return;
    }
    if (kind !== "personal" && !mentioned && !underOwnPost) return;
    if (kind === "channel" && mentioned) app = await this.remember(owner, routineId, app, conv, a).catch(() => app);
    const target = kind === "channel" ? `${conv};messageid=${root ?? a.id}` : a.conversation.id;
    // It takes instructions from the person who added it (its runs hold its owner's secrets).
    if (!app.installer || a.from.aadObjectId !== app.installer) {
      const warnKey = `${routineId}:${target}`;
      if (!this.warned.has(warnKey)) {
        this.warned.add(warnKey);
        await client.send(a.serviceUrl, target, { text: app.installerName ? `I only take instructions from ${app.installerName} for now.` : "I don't know who added me, so I'm not taking instructions. Add me to Teams again from Ambient.", textFormat: "markdown" }).catch(() => undefined);
      }
      return;
    }
    if (kind === "personal" && !app.installedAt) await this.put(owner, APP, routineId, (app = { ...app, installedAt: this.now() }));
    const text = teamsToPlain(a.text ?? "");
    const offered = this.offered(client, a, kind);
    if (!text && !offered.length) return;
    const who = a.from.name ?? "Someone";
    const placeName = a.channelData?.channel?.name ?? app.channels?.find((c) => c.id === (a.channelData?.channel?.id ?? conv))?.name;
    const placeLabel = placeName ? `${a.channelData?.team?.name ? `${a.channelData.team.name} › ` : ""}${placeName}` : "";
    const where = kind === "personal" ? "in a direct message" : underOwnPost ? `in the thread under your post${placeLabel ? ` in ${placeLabel}` : ""}` : kind === "groupChat" ? "in a group chat" : placeLabel ? `in ${placeLabel}` : "in a channel";
    // Its files, kept in its thread like a file sent from the app: its run gets them on disk.
    const { files: incoming, left } = await takeFiles(offered);
    const files: FileRef[] = incoming.length && this.d.attachments ? await this.d.attachments.save(owner, { routineId }, incoming) : [];
    const said = text || `sent ${files.length === 1 ? "a file" : "files"}`;
    const before = kind === "channel" && root ? await this.threadLines(app, a, root) : "";
    const body = `${who} wrote to you on Microsoft Teams (${where}): ${said}${leftLine(left)}${before}\n\n(Your answer goes back to that Teams thread on its own.)`;
    await this.replies(owner, routineId, (r) => {
      const now = this.now();
      const kept = r.targets.filter((t) => now - t.at <= REPLY_FOR_MS && !(t.conv === target && !t.runId));
      return { ...r, targets: [...kept, { conv: target, at: now }].slice(-TARGETS_MAX) };
    });
    void client.typing(a.serviceUrl, target).catch(() => undefined);
    const sealed = await sealMessage(this.d.keys, owner, { text: body, ...(files.length ? { files } : {}) });
    const out = (await this.d.control.m(api.bots.wake, { id: routineId, iv: sealed.iv, ct: sealed.ct, authorName: "Teams", run: true, now: this.now() })) as { ok: boolean; hostId?: string | null; enabled?: boolean };
    if (out.ok && out.enabled && out.hostId) this.d.startNow?.(String(out.hostId), routineId);
    if (out.ok && !out.enabled) await client.send(a.serviceUrl, target, { text: "I'm paused in Ambient right now, so I won't get to this until I'm switched back on.", textFormat: "markdown" });
  }

  /**
   * The files a message brings. In a chat with the bot a file comes with a download link of its
   * own; a pasted picture is behind the bot's token. A file shared in a channel or group chat stays
   * in SharePoint, which the bot can't open: it's named, with where to send it instead.
   */
  private offered(client: BotClient, a: Activity, kind: string): OfferedFile[] {
    const out: OfferedFile[] = [];
    for (const att of a.attachments ?? []) {
      if (att.contentType === FILE_INFO) {
        const c = (att.content ?? {}) as { downloadUrl?: string; fileType?: string };
        const name = att.name ?? `file.${c.fileType ?? "bin"}`;
        out.push({ name, fetch: c.downloadUrl ? () => download(this.fetch, c.downloadUrl!) : null, why: "Teams gave no link to it" });
      } else if (att.contentType.startsWith("image/") && att.contentUrl) {
        const url = att.contentUrl;
        const ext = att.contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        out.push({ name: att.name ?? `picture.${ext}`, type: att.contentType, fetch: () => client.fetchFile(url, FILES_BYTES_MAX) });
      } else if (att.contentType === "reference" || (att.name && att.contentUrl && att.contentType !== "text/html" && att.contentType !== ADAPTIVE_CARD)) {
        out.push({ name: att.name ?? "file", fetch: null, why: kind === "personal" ? "Teams kept it in SharePoint" : "a file shared in a channel stays in SharePoint, where I can't open it: send it to me in a direct chat" });
      }
    }
    return out;
  }

  // ---- Amb in Teams (channels/amb-doors.ts) ----

  /** Amb's app in the company's Teams, made like a bot's, under the key "amb". */
  async addAmb(owner: Owner, uid: string, name = "Ambient"): Promise<{ url: string; chatUrl: string; ready: true; installed: boolean; installer: string }> {
    if (!this.d.amb) throw new TeamsError("not_set_up", "Amb isn't set up for Teams on this server.", 404);
    return this.add(owner, { id: AMB, name }, uid);
  }

  async ambStatus(owner: Owner): Promise<{ tenant: boolean; app: { name: string; ready: boolean; url: string | null } | null }> {
    const [t, app] = await Promise.all([this.get<Tenant>(owner, TENANT, "tenant"), this.get<AppRecord>(owner, APP, AMB)]);
    return { tenant: !!t, app: app ? { name: app.name, ready: !!app.catalogId, url: app.catalogId ? this.openUrl(app) : null } : null };
  }

  /** Someone writes to Amb in Teams: a direct chat goes to their own Amb chat; a channel to the team's Amb. */
  private async onAmbActivity(owner: Owner, app: AppRecord, client: BotClient, a: Activity, kind: string): Promise<void> {
    const amb = this.d.amb;
    if (!amb) return;
    if (a.type === "conversationUpdate") {
      if (kind === "personal" && a.membersAdded?.some((m) => m.id === a.recipient.id)) {
        await client.send(a.serviceUrl, a.conversation.id, { text: `Hi, I'm ${app.name}. Write to me here like in the Ambient app: it's the same conversation. In a channel, mention me and I answer from your team's brain.`, textFormat: "markdown" }).catch(() => undefined);
      }
      return;
    }
    if (a.type !== "message" || a.from.id === a.recipient.id) return;
    const mentioned = (a.entities ?? []).some((e) => e.type === "mention" && e.mentioned?.id === a.recipient.id);
    const submit = decisionSubmit(a.value);
    if (kind !== "personal" && !mentioned && !submit) return;
    const member = await client.member(a.serviceUrl, a.conversation.id, a.from.id).catch(() => null);
    const email = (member?.email ?? member?.userPrincipalName ?? "").toLowerCase();
    const account = email ? await amb.accountByEmail(owner, email).catch(() => null) : null;
    const [conv, root] = a.conversation.id.split(";messageid=") as [string, string | undefined];
    const target = kind === "channel" ? `${conv};messageid=${root ?? a.id}` : a.conversation.id;
    if (!account) {
      const warnKey = `amb:${a.from.aadObjectId ?? a.from.id}`;
      if (!this.warned.has(warnKey)) {
        this.warned.add(warnKey);
        await client.send(a.serviceUrl, target, { text: email ? `I don't know you yet: no Ambient account here has the email ${email}. Ask your team's admin to invite you to Ambient.` : "I can't see your email in Teams, so I don't know who you are in Ambient.", textFormat: "markdown" }).catch(() => undefined);
      }
      return;
    }
    // A click on one of Amb's decision cards: the decision's answer, as that person.
    if (submit) {
      if (!amb.answer || !submit.text) return;
      try {
        await amb.answer(account.uid, submit.d, submit.text, "teams");
        if (a.replyToId) await client.update(a.serviceUrl, a.conversation.id, a.replyToId, { attachments: [{ contentType: ADAPTIVE_CARD, content: answeredCard(submit.q ?? "", submit.text, account.name) }] }).catch(() => undefined);
      } catch (err) {
        const gone = /already answered|no such decision/i.test((err as Error).message);
        if (gone && a.replyToId) await client.update(a.serviceUrl, a.conversation.id, a.replyToId, { attachments: [{ contentType: ADAPTIVE_CARD, content: answeredCard(submit.q ?? "", null, null) }] }).catch(() => undefined);
        else await client.send(a.serviceUrl, a.conversation.id, { text: (err as Error).message, textFormat: "markdown" }).catch(() => undefined);
      }
      return;
    }
    const text = teamsToPlain(a.text ?? "");
    const taken = await takeFiles(this.offered(client, a, kind));
    const { files, left } = forAmb(taken.files);
    const all = [...taken.left, ...left];
    if (!text && !files.length && !all.length) return;
    void client.typing(a.serviceUrl, target).catch(() => undefined);
    if (kind !== "personal") {
      // A channel or group chat: the team's Amb, with the team's brain only.
      if (owner.kind !== "team" || !amb.teamTurn) {
        await client.send(a.serviceUrl, target, { text: "In a channel I answer from a team's brain, and Teams is connected for one person here. Write to me directly instead.", textFormat: "markdown" });
        return;
      }
      const before = kind === "channel" && root ? await this.threadMessages(app, a, root) : [];
      const answer = await amb.teamTurn(owner.teamId, account, `teams:${target}`, `${text}${leftLine(all)}`, files, before).catch((err: Error) => ({ text: `That didn't work just now (${err.message}).` }));
      if (answer?.text) for (const part of splitText(answer.text)) await client.send(a.serviceUrl, target, { text: part, textFormat: "markdown" });
      return;
    }
    // A direct chat: their own Amb, and this chat is their Teams door to it.
    await this.put({ kind: "user", uid: account.uid }, AMB_LINK, "link", { ...refOf(owner, AMB), conv: a.conversation.id, serviceUrl: a.serviceUrl, at: this.now() } satisfies AmbLink);
    await amb.inbox.sendQueued(account.uid, await amb.inbox.nameOf(account.uid).catch(() => account.name), `${text || `sent ${files.length === 1 ? "a file" : "files"}`}${leftLine(all)}`, "teams", files);
  }

  /** Amb's Teams door for one person: their chat with Amb's app, for answers, what Amb says first, and decisions as cards. */
  ambChannel(): AmbChannel {
    const link = async (uid: string) => {
      const l = await this.get<AmbLink>({ kind: "user", uid }, AMB_LINK, "link");
      if (!l) return null;
      const app = await this.get<AppRecord>(ownerOf(l), APP, AMB);
      return app?.catalogId && app.secret ? { l, app, client: this.client(app) } : null;
    };
    const must = async (uid: string) => {
      const found = await link(uid);
      if (!found) throw new TeamsError("not_linked", "Not linked to Teams.", 400);
      return found;
    };
    return {
      kind: "teams",
      linked: async (uid) => !!(await link(uid)),
      send: async (uid: string, text: string, opts: { first?: boolean; files?: OutFile[]; react?: string } = {}) => {
        const { l, client } = await must(uid);
        // Teams has no reactions a bot can put: a lone emoji is said.
        const said = text.trim() || opts.react || "";
        if (said) for (const part of splitText(said)) await client.send(l.serviceUrl, l.conv, { text: part, textFormat: "markdown" });
        const files = (opts.files ?? []).filter((f) => f.id).map((f) => ({ ref: { id: f.id!, name: f.name, type: f.type, size: f.bytes.length }, data: f.bytes.toString("base64") }));
        if (files.length) await this.sendFiles({ kind: "user", uid }, AMB, client, l.serviceUrl, l.conv, files);
      },
      ask: async (uid: string, text: string, question: Question) => {
        const { l, client } = await must(uid);
        await client.send(l.serviceUrl, l.conv, { attachments: [{ contentType: ADAPTIVE_CARD, content: decisionCard(text, question) }], summary: text.slice(0, 200) });
      },
    };
  }

  /** A link to one of its files that works for a week (a file it sends that isn't shown inline). */
  fileLink(owner: Owner, routineId: string, ref: FileRef): string {
    return `${this.base()}/v1/teams/files/${this.sign("file", { ...refOf(owner, routineId), f: ref.id, e: this.now() + FILE_LINK_MS })}/${encodeURIComponent(ref.name)}`;
  }

  /** The file a link names, while it works. */
  async linkedFile(token: string): Promise<{ name: string; type: string; bytes: Buffer }> {
    const s = this.verify<Ref & { f: string; e: number }>("file", token);
    if (!s || s.e < this.now() || !this.d.attachments) throw new TeamsError("not_found", "This link doesn't work (any more).", 404);
    return this.d.attachments.read(ownerOf(s), s.r === AMB ? {} : { routineId: s.r }, s.f);
  }

  /** Files it made (send_file) into a Teams chat or thread: a small picture inline, anything else as a card with its link. */
  private async sendFiles(owner: Owner, routineId: string, client: BotClient, serviceUrl: string, conv: string, files: { ref: FileRef; data: string }[]): Promise<void> {
    for (const f of files) {
      if (f.ref.type.startsWith("image/") && f.ref.size <= INLINE_MAX && f.ref.type !== "image/heic") {
        await client.send(serviceUrl, conv, { attachments: [{ contentType: f.ref.type, contentUrl: `data:${f.ref.type};base64,${f.data}`, name: f.ref.name }] });
        continue;
      }
      const card = {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.5",
        body: [
          { type: "TextBlock", text: `📎 ${f.ref.name}`, wrap: true, weight: "Bolder" },
          { type: "TextBlock", text: `${sizeLabel(f.ref.size)} · the link works for 7 days, and the file stays in my thread in Ambient`, wrap: true, isSubtle: true, size: "Small" },
        ],
        actions: [{ type: "Action.OpenUrl", title: "Download", url: this.fileLink(owner, routineId, f.ref) }],
      };
      await client.send(serviceUrl, conv, { attachments: [{ contentType: ADAPTIVE_CARD, content: card }], summary: f.ref.name });
    }
  }

  /** A Graph token as the bot's own app (its resource-specific consent lets it read its teams' channels). */
  private graphTokens = new Map<string, { value: string; until: number }>();
  private async botGraphToken(app: AppRecord): Promise<string | null> {
    const cached = this.graphTokens.get(app.appId!);
    if (cached && cached.until > this.now()) return cached.value;
    const out = await this.tokenCall(app.tenantId, { grant_type: "client_credentials", client_id: app.appId!, client_secret: app.secret!, scope: "https://graph.microsoft.com/.default" }).catch(() => null);
    if (!out?.access_token) return null;
    this.graphTokens.set(app.appId!, { value: out.access_token, until: this.now() + Math.max(60, (out.expires_in ?? 3600) - 300) * 1000 });
    return out.access_token;
  }

  /** A channel thread's messages before this one (its root and replies), by name: Graph, as the bot. */
  private async threadLines(app: AppRecord, a: Activity, root: string): Promise<string> {
    return threadSoFar(await this.threadMessages(app, a, root));
  }

  private async threadMessages(app: AppRecord, a: Activity, root: string): Promise<ThreadMessage[]> {
    const teamId = a.channelData?.team?.aadGroupId;
    const channelId = a.channelData?.channel?.id;
    if (!teamId || !channelId || !app.secret) return [];
    const token = await this.botGraphToken(app);
    if (!token) return [];
    type GraphMessage = { id?: string; from?: { user?: { displayName?: string }; application?: { id?: string; displayName?: string } }; body?: { content?: string }; attachments?: { name?: string }[]; createdDateTime?: string };
    const get = async (path: string) => {
      const res = await this.fetch(`${this.graph}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      return res?.ok ? ((await res.json().catch(() => null)) as GraphMessage & { value?: GraphMessage[] }) : null;
    };
    const base = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(root)}`;
    const [first, replies] = await Promise.all([get(base), get(`${base}/replies?$top=${THREAD_MAX}`)]);
    const all = [...(first ? [first] : []), ...[...(replies?.value ?? [])].sort((x, y) => String(x.createdDateTime).localeCompare(String(y.createdDateTime)))].filter((m) => m.id !== a.id);
    return all.map((m) => ({
      who: m.from?.application?.id === app.appId ? "you" : (m.from?.user?.displayName ?? m.from?.application?.displayName ?? "someone"),
      text: `${teamsToPlain(m.body?.content ?? "")}${m.attachments?.some((x) => x.name) ? ` [${m.attachments.filter((x) => x.name).map((x) => x.name).join(", ")}]` : ""}`,
      at: Date.parse(m.createdDateTime ?? "") || 0,
    }));
  }

  /** The question waiting in this chat or thread, if any (24 hours at most). */
  private async waitingAsk(owner: Owner, routineId: string, conv: string): Promise<Ask | null> {
    const r = await this.get<Replies>(owner, REPLY, routineId);
    const now = this.now();
    return [...(r?.asks ?? [])].reverse().find((x) => x.conv === conv && now - x.at < ASK_FOR_MS) ?? null;
  }

  /** A click on a card's button (or its "Send"): checked, answered, and the card shows the answer. */
  private async onCardAnswer(owner: Owner, routineId: string, app: AppRecord, a: Activity, submit: { q: string; text: string }): Promise<void> {
    const client = this.client(app);
    if (!app.installer || a.from.aadObjectId !== app.installer) {
      await client.send(a.serviceUrl, a.conversation.id, { text: `Only ${app.installerName ?? "the person who added me"} answers my questions.`, textFormat: "markdown" }).catch(() => undefined);
      return;
    }
    const r = await this.get<Replies>(owner, REPLY, routineId);
    const ask = (r?.asks ?? []).find((x) => x.q === submit.q && x.conv === a.conversation.id) ?? { q: submit.q, conv: a.conversation.id, ...(a.replyToId ? { activityId: a.replyToId } : {}), text: "", at: this.now() };
    if (!ask.activityId && a.replyToId) ask.activityId = a.replyToId;
    if (!submit.text) return;
    await this.answerAsk(owner, routineId, app, ask, submit.text, a.from.name ?? "you", a.serviceUrl);
  }

  /** Answers the question as the bot's owner; the card then says what was answered, or that it's gone. */
  private async answerAsk(owner: Owner, routineId: string, app: AppRecord, ask: Ask, text: string, by: string, serviceUrl: string): Promise<"answered" | "gone" | "failed"> {
    const client = this.client(app);
    const uid = app.adderUid;
    const out = uid && this.d.answer ? await this.d.answer(uid, routineId, ask.q, text).catch((err: Error) => ({ error: err.message })) : { error: "This bot doesn't know whose answers to take. Add it to Teams again from Ambient." };
    const forget = () => this.replies(owner, routineId, (cur) => ({ ...cur, asks: (cur.asks ?? []).filter((x) => !(x.q === ask.q && x.conv === ask.conv)) }));
    if (out === "answered" || out === "gone") {
      await forget();
      if (ask.activityId) {
        const card = out === "answered" ? answeredCard(ask.text, text, by) : answeredCard(ask.text, null, null);
        await client.update(serviceUrl, ask.conv, ask.activityId, { attachments: [{ contentType: ADAPTIVE_CARD, content: card }] }).catch(() => undefined);
      }
      if (out === "gone" && !ask.activityId) await client.send(serviceUrl, ask.conv, { text: "That question is already answered.", textFormat: "markdown" }).catch(() => undefined);
      return out;
    }
    await client.send(serviceUrl, ask.conv, { text: out.error, textFormat: "markdown" }).catch(() => undefined);
    return "failed";
  }

  /** A channel it was mentioned in: kept with its name and team, so its news can go there. */
  private async remember(owner: Owner, routineId: string, app: AppRecord, conv: string, a: Activity): Promise<AppRecord> {
    const id = a.channelData?.channel?.id ?? conv;
    const name = a.channelData?.channel?.name ?? (a.channelData?.team && id === a.channelData.team.id ? "General" : undefined);
    const team = a.channelData?.team?.name;
    const known = app.channels?.find((c) => c.id === id);
    if (known && (known.name || !name)) return app;
    const entry: TeamsChannel = { id, ...(name ? { name } : {}), ...(team ? { team } : {}) };
    const channels = known ? (app.channels ?? []).map((c) => (c.id === id ? entry : c)) : [...(app.channels ?? []), entry].slice(-CHANNELS_MAX);
    const next = { ...app, channels };
    await this.put(owner, APP, routineId, next);
    return next;
  }

  private async replies(owner: Owner, routineId: string, change: (r: Replies) => Replies | null): Promise<Replies> {
    const key = `${ownerKey(owner)}:${routineId}`;
    const before = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = before.then(() => mine);
    this.locks.set(key, chained);
    await before;
    try {
      const raw = await this.get<Replies>(owner, REPLY, routineId);
      const cur: Replies = { targets: Array.isArray(raw?.targets) ? raw.targets : [], ...(raw?.run ? { run: raw.run } : {}), ...(Array.isArray(raw?.asks) ? { asks: raw.asks } : {}) };
      const next = change(cur);
      if (next) await this.put(owner, REPLY, routineId, next);
      return next ?? cur;
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  /** A bot's run starts: the Teams messages waiting for an answer are now its to answer. */
  async runStarted(owner: Owner, routineId: string, runId: string, tokenHash: string): Promise<void> {
    if (!(await this.get<AppRecord>(owner, APP, routineId))?.catalogId) return;
    await this.replies(owner, routineId, (r) => ({ ...r, run: { id: runId, hash: tokenHash }, targets: r.targets.map((t) => (t.runId ? t : { ...t, runId })) }));
  }

  /** A running bot took Teams messages from its thread mid-run (its inbox). */
  async runTook(owner: Owner, routineId: string, tokenHash: string): Promise<void> {
    await this.replies(owner, routineId, (r) => {
      if (r.run?.hash !== tokenHash) return null;
      const now = this.now();
      return { ...r, targets: r.targets.map((t) => (t.runId || t.at > now ? t : { ...t, runId: r.run!.id })) };
    });
  }

  /** A run said something: it goes to the Teams threads that run took, and nowhere else. */
  said(owner: Owner, routineId: string, text: string, final: boolean, run: { id?: string; hash?: string }, question?: { id: string; text: string; choices: string[]; details?: string }, files: { ref: FileRef; data: string }[] = []): void {
    this.track(
      (async () => {
        const r = await this.get<Replies>(owner, REPLY, routineId);
        if (!r?.targets?.length) return;
        const runId = run.id ?? (run.hash && r.run?.hash === run.hash ? r.run.id : undefined);
        if (!runId) return;
        const mine = r.targets.filter((t) => t.runId === runId);
        if (!mine.length) return;
        const app = await this.get<AppRecord>(owner, APP, routineId);
        if (!app?.secret || !app.serviceUrl) return;
        const client = this.client(app);
        if (question) {
          // Its question as a card: a button per choice, and a box to write something else.
          const asks: Ask[] = [];
          for (const t of mine) {
            const activityId = await client.send(app.serviceUrl, t.conv, { attachments: [{ contentType: ADAPTIVE_CARD, content: questionCard(question) }], summary: `${app.name} asks: ${question.text}`.slice(0, 200) });
            asks.push({ q: question.id, conv: t.conv, ...(activityId ? { activityId } : {}), text: question.text, at: this.now() });
          }
          const now = this.now();
          await this.replies(owner, routineId, (cur) => ({ ...cur, asks: [...(cur.asks ?? []).filter((a) => now - a.at < ASK_FOR_MS && !mine.some((t) => t.conv === a.conv)), ...asks].slice(-TARGETS_MAX) }));
        } else if (text.trim()) for (const t of mine) for (const part of splitText(text)) await client.send(app.serviceUrl, t.conv, { text: part, textFormat: "markdown" });
        if (files.length) for (const t of mine) await this.sendFiles(owner, routineId, client, app.serviceUrl, t.conv, files);
        if (final) await this.replies(owner, routineId, (cur) => ({ targets: cur.targets.filter((t) => t.runId !== runId), ...(cur.run && cur.run.id !== runId ? { run: cur.run } : {}), ...(cur.asks ? { asks: cur.asks } : {}) }));
      })(),
    );
  }
}

/** An Azure resource name for a bot: its name, safe, and unique enough (Azure Bot names are global). */
function azureName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "bot";
  return `ambient-${slug}-${randomBytes(4).toString("hex")}`;
}

function decodeIdToken(jwt: string): { tid?: string; oid?: string; name?: string; email?: string; preferred_username?: string } {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as ReturnType<typeof decodeIdToken>;
  } catch {
    return {};
  }
}

/** What Teams sends as a message's text (HTML, <at> mentions), as plain text for the bot. */
export function teamsToPlain(text: string): string {
  return text
    .replace(/<at>[^<]*<\/at>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, (_m, href: string, label: string) => (label && label !== href ? `${label} (${href})` : href))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A person's Teams door to Amb: whose app, and their chat with it. */
interface AmbLink extends Ref {
  conv: string;
  serviceUrl: string;
  at: number;
}

/** A click on one of Amb's decision cards. */
function decisionSubmit(value: unknown): { d: string; text: string; q?: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { ambient?: unknown; d?: unknown; o?: unknown; other?: unknown; q?: unknown };
  if (v.ambient !== "decision" || typeof v.d !== "string" || v.d.length > 64) return null;
  const text = typeof v.o === "string" && v.o.trim() ? v.o.trim() : typeof v.other === "string" ? v.other.trim() : "";
  return { d: v.d, text: text.slice(0, 4000), ...(typeof v.q === "string" ? { q: v.q.slice(0, 500) } : {}) };
}

/** A decision Amb brings to the person, as a card: its text, a button per answer, and a box. */
export function decisionCard(text: string, question: Question): Record<string, unknown> {
  const short = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      { type: "TextBlock", text, wrap: true },
      { type: "Input.Text", id: "other", placeholder: question.choices.length ? "Or write something else" : "Your answer", isMultiline: true, maxLength: 4000 },
    ],
    actions: [
      ...question.choices.map((c) => ({ type: "Action.Submit", title: c, data: { ambient: "decision", d: question.decisionId, o: c, q: short } })),
      { type: "Action.Submit", title: "Send", data: { ambient: "decision", d: question.decisionId, q: short } },
    ],
  };
}

/** What a card's button sends back (Action.Submit's data, with the text box's value). */
function cardSubmit(value: unknown): { q: string; text: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { ambient?: unknown; q?: unknown; o?: unknown; other?: unknown };
  if (v.ambient !== "answer" || typeof v.q !== "string" || v.q.length > 64) return null;
  const text = typeof v.o === "string" && v.o.trim() ? v.o.trim() : typeof v.other === "string" ? v.other.trim() : "";
  return { q: v.q, text: text.slice(0, 4000) };
}

/** A bot's question as an Adaptive Card: the question, what it's about, a button per choice, and a box. */
export function questionCard(q: { id: string; text: string; choices: string[]; details?: string }): Record<string, unknown> {
  const body: Record<string, unknown>[] = [{ type: "TextBlock", text: q.text, wrap: true, weight: "Bolder" }];
  if (q.details) body.push({ type: "TextBlock", text: q.details.length > 1500 ? `${q.details.slice(0, 1500)}…` : q.details, wrap: true, isSubtle: true, size: "Small" });
  body.push({ type: "Input.Text", id: "other", placeholder: q.choices.length ? "Or write something else" : "Your answer", isMultiline: true, maxLength: 4000 });
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    actions: [
      ...q.choices.map((c) => ({ type: "Action.Submit", title: c, data: { ambient: "answer", q: q.id, o: c } })),
      { type: "Action.Submit", title: "Send", data: { ambient: "answer", q: q.id } },
    ],
  };
}

/** The card once it's answered (`answer` null: answered elsewhere, or no longer asked). */
export function answeredCard(question: string, answer: string | null, by: string | null): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      ...(question ? [{ type: "TextBlock", text: question, wrap: true, weight: "Bolder" }] : []),
      answer
        ? { type: "TextBlock", text: `✓ ${answer}`, wrap: true, color: "Good" }
        : { type: "TextBlock", text: "Already answered, or no longer asked.", wrap: true, isSubtle: true },
      ...(answer && by ? [{ type: "TextBlock", text: `Answered by ${by}`, wrap: true, isSubtle: true, size: "Small" }] : []),
    ],
  };
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
