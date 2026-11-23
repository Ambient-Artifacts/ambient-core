// A bot's own Slack app (docs/bots.md, "Slack"): one Slack app per bot, so each has its own
// @handle and face in Slack, made by Ambient with Slack's manifest API. The person connects their
// Slack workspace once (an app configuration token, which Ambient keeps fresh), then each bot is
// one tap: Ambient creates the app from a manifest, and the person taps Allow once to install it.
//
//   the app ──▶ PUT /v1/app/slack (config token + refresh token, once per workspace)
//   a bot   ──▶ POST /v1/app/routines/:id/slack ──▶ apps.manifest.create ──▶ the Allow link
//   Slack   ──▶ /v1/slack/installed (code) ──▶ oauth.v2.access ──▶ the bot's token, sealed
//   Slack   ──▶ /v1/hooks/slack/<hook> (an @mention, a DM) ──▶ the bot's thread, a run starts
//   a run's answer (its reply or its result) ──▶ back into that Slack thread
//   a run ──▶ SLACK_BOT_TOKEN in its environment (it posts as itself, e.g. a nightly digest)
//   a run with news ──▶ postNews() ──▶ the one channel its owner chose (its tool, post_to_slack)
//   a reply in the thread under such a post ──▶ the bot's thread, as an @mention would
//
// Slack's partners can skip the Allow step (managed_apps:install); that scope isn't open to
// developers, so one tap per bot stays.
//
// Everything is kept in the sealed records (no table of its own): the workspace per owner, each
// bot's app (its client secret, signing secret and bot token) and where its answer goes. The
// hook in an app's event URL is signed and names the bot, so an event finds its app without a
// lookup; each event is then checked with that app's own signing secret.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { api, type Control } from "../control.ts";
import type { MasterKey } from "../crypto.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { sealMessage } from "./messages.ts";
import type { Attachments, FileRef } from "./attachments.ts";
import { download, leftLine, takeFiles, type OfferedFile } from "../channels/channel-files.ts";
import { AMB, forAmb, type AmbDoorDeps } from "../channels/amb-doors.ts";
import type { AmbChannel, OutFile } from "../channels/reach.ts";

const WORKSPACE = "slack:workspace";
const APP = "slack:app";
const REPLY = "slack:reply";
const STATE_TTL_MS = 60 * 60_000;
/** A config token is renewed when it has less than this left (they last 12 hours). */
const RENEW_BEFORE_MS = 15 * 60_000;
/** An answer goes back to Slack only for a message this recent (a later scheduled run doesn't). */
const REPLY_FOR_MS = 6 * 60 * 60_000;
/** At most this many Slack threads wait for a bot's answer. */
const TARGETS_MAX = 10;
/** Slack's limit for an app's name. */
const NAME_MAX = 35;
/** A Slack message's text is cut at 40,000; long answers go out in parts well below that. */
const PART_MAX = 3_500;
/** `channels:read` and `groups:read`: the names of the channels it's in (for "Posts news in #anomalies"). */
/** `files:read` and `files:write`: files sent with a message reach the bot, and files it makes reach the thread. */
export const SLACK_SCOPES = ["app_mentions:read", "chat:write", "channels:history", "channels:read", "groups:history", "groups:read", "im:history", "im:read", "im:write", "reactions:write", "users:read", "files:read", "files:write"];
/** Amb's app also reads people's emails: a direct message reaches the writer's own Ambient account. */
export const SLACK_AMB_SCOPES = [...SLACK_SCOPES, "users:read.email"];
const scopesFor = (id: string) => (id === AMB ? SLACK_AMB_SCOPES : SLACK_SCOPES);
const AMB_LINK = "slack:amb-link";
/** `message.channels` and `message.groups`: replies in the thread under a post of its own reach it without an @mention. */
export const SLACK_EVENTS = ["app_mention", "message.im", "message.channels", "message.groups"];
/** Channels remembered per bot, and posts of its own whose threads it listens to. */
const CHANNELS_MAX = 20;
const POSTS_MAX = 30;
/** Slack's reasons a channel can't be posted to anymore. */
const GONE = new Set(["not_in_channel", "channel_not_found", "is_archived"]);

/** A Slack channel a bot is in: its id, and its name once Slack told it. */
export interface SlackChannel {
  id: string;
  name?: string;
}

/** Where a bot's own news goes in Slack, for its page in the app. */
export interface SlackNews {
  /** The channel it posts news in; null: only in the Ambient app. */
  channel: SlackChannel | null;
  /** The channels it was mentioned in: what can be chosen. */
  channels: SlackChannel[];
  /** It may read channel names (apps from before that need one more Allow). */
  names: boolean;
  /** It may read and send files (apps from before that need one more Allow). */
  files: boolean;
  /** Why the last post didn't go out (it was removed, the channel is archived), until another is chosen or one works. */
  broken: string | null;
}

interface Workspace {
  token: string;
  refresh: string;
  /** When the token expires (ms). */
  exp: number;
  teamId: string | null;
  userId: string | null;
}

interface AppRecord {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  name: string;
  /** Set once the person tapped Allow. */
  botToken?: string;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  /** The Slack user who installed it: the one it takes instructions from. */
  installer?: string;
  /** What Slack granted at the last Allow (none stored: an app from before channel names). */
  scopes?: string[];
  /** The channels it was mentioned in, oldest first. */
  channels?: SlackChannel[];
  /** Where its news goes: a channel's id; "": only the app; unset: the first channel it was mentioned in. */
  news?: string;
  newsBroken?: string;
  /** Posts of its own (news), whose threads it listens to. */
  posts?: { channel: string; ts: string; at: number }[];
  /** Who added it in Ambient: a click on its question's button answers as them. */
  adderUid?: string;
  /** Which manifest it has (2: buttons, Slack's interactivity). */
  manifestV?: number;
}

/** The manifest's version: an app with an older one is brought up to date before it needs it. */
const MANIFEST_V = 2;
/** A question's buttons and replies answer it for this long. */
const ASK_FOR_MS = 24 * 3600_000;

/** A question of a bot's in a Slack thread, until it's answered. */
interface Ask {
  q: string;
  channel: string;
  thread: string;
  /** The message with the buttons, to replace once it's answered. */
  msgTs?: string;
  text: string;
  at: number;
}

/** A Slack message waiting for its answer: the thread, and the run that took it (once one has). */
interface Target {
  channel: string;
  ts: string;
  at: number;
  runId?: string;
}

/** Where a bot's answers go: the Slack threads asked, each tied to the run that answers it. */
interface Replies {
  targets: Target[];
  /** The bot's current run (its id and its token's hash), so its replies find their threads. */
  run?: { id: string; hash: string };
  asks?: Ask[];
}

/** What a hook or an install's state names: the bot and its owner. */
interface Ref {
  k: "user" | "team";
  i: string;
  r: string;
}

export class SlackError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const ownerOf = (ref: Ref): Owner => (ref.k === "team" ? { kind: "team", teamId: ref.i } : { kind: "user", uid: ref.i });
const refOf = (owner: Owner, routineId: string): Ref => ({ k: owner.kind, i: owner.kind === "user" ? owner.uid : owner.teamId, r: routineId });
const ownerArgs = (owner: Owner) => ({ ownerKind: owner.kind, ownerId: owner.kind === "user" ? owner.uid : owner.teamId });

export class SlackApps {
  /** One renewal of a workspace's token at a time (a refresh token works once). */
  private renewing = new Map<string, Promise<Workspace>>();
  /** Event ids seen lately: Slack sends an event again when we're slow. */
  private seen = new Map<string, number>();
  private names = new Map<string, string>();
  private warned = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private locks = new Map<string, Promise<void>>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      master: MasterKey;
      origin: string;
      /** A bot's computer starts its run now (not at its next check-in). */
      startNow?: (hostId: string, routineId: string) => void;
      /** Where files sent with a message are kept (the bot's thread). */
      attachments?: Attachments;
      fetchImpl?: typeof fetch;
      /** Slack's Web API (tests: a stand-in). */
      apiBase?: string;
      now?: () => number;
      /** Amb in Slack: its chat, and whose account a direct message is (channels/amb-doors.ts). */
      amb?: AmbDoorDeps;
      /** Answers a bot's open question as `uid` (a click on its button, or a reply); "gone" when it isn't open any more. */
      answer?: (uid: string, routineId: string, questionId: string, text: string) => Promise<"answered" | "gone" | { error: string }>;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private base(): string {
    return this.d.origin.replace(/\/$/, "");
  }

  /** Tests: wait for what events started. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private track<T>(p: Promise<T>): void {
    const q = p.catch((err: Error) => console.warn(`[slack] ${err.message}`)).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  // ---- Slack's Web API ----

  private async call<T extends Record<string, unknown>>(method: string, token: string | null, args: Record<string, unknown>, opts: { form?: boolean } = {}): Promise<T & { ok: boolean; error?: string }> {
    const url = `${(this.d.apiBase ?? "https://slack.com/api").replace(/\/$/, "")}/${method}`;
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    let body: string;
    if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();
    } else {
      headers["content-type"] = "application/json; charset=utf-8";
      body = JSON.stringify(args);
    }
    const res = await (this.d.fetchImpl ?? fetch)(url, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) }).catch((err: Error) => {
      throw new SlackError("slack_unreachable", `Slack didn't answer (${err.message}).`, 502);
    });
    const out = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as T & { ok: boolean; error?: string };
    return out;
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

  // ---- signed refs (a hook in an app's event URL; an install's state) ----

  private key(purpose: string): Buffer {
    return createHmac("sha256", this.d.master.key).update(`ambient:slack:${purpose}`).digest();
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

  // ---- the workspace (once per person or team) ----

  /**
   * Connects a Slack workspace with an app configuration token's refresh token (api.slack.com/apps
   * → "Your App Configuration Tokens" → Generate Token). Renewed at once: that checks it and starts
   * the 12-hour clock.
   */
  async connect(owner: Owner, refresh: string): Promise<{ teamId: string | null }> {
    if (!refresh.trim().startsWith("xoxe-")) throw new SlackError("bad_token", "That's not the refresh token (it starts with xoxe-).", 400);
    const ws = await this.rotate(refresh.trim());
    await this.put(owner, WORKSPACE, "workspace", ws);
    return { teamId: ws.teamId };
  }

  async disconnect(owner: Owner): Promise<void> {
    await this.put(owner, WORKSPACE, "workspace", {}, true);
  }

  async workspace(owner: Owner): Promise<{ connected: boolean; teamId: string | null }> {
    const ws = await this.get<Workspace>(owner, WORKSPACE, "workspace");
    return { connected: !!ws, teamId: ws?.teamId ?? null };
  }

  private async rotate(refresh: string): Promise<Workspace> {
    const out = await this.call<{ token?: string; refresh_token?: string; exp?: number; team_id?: string; user_id?: string }>("tooling.tokens.rotate", null, { refresh_token: refresh }, { form: true });
    if (!out.ok || !out.token || !out.refresh_token) {
      throw new SlackError("slack_token", out.error === "invalid_refresh_token" ? "Slack doesn't take that refresh token anymore. Generate a new configuration token in Slack and connect again." : `Slack refused the configuration token (${out.error ?? "no reason"}).`, 400);
    }
    return { token: out.token, refresh: out.refresh_token, exp: (out.exp ?? Math.floor(this.now() / 1000) + 12 * 3600) * 1000, teamId: out.team_id ?? null, userId: out.user_id ?? null };
  }

  /** The workspace's configuration token, renewed when it's about to run out. */
  private async configToken(owner: Owner): Promise<Workspace> {
    const ws = await this.get<Workspace>(owner, WORKSPACE, "workspace");
    if (!ws) throw new SlackError("no_workspace", "Connect your Slack workspace first (Settings → Connect → Slack).", 400);
    if (ws.exp - this.now() > RENEW_BEFORE_MS) return ws;
    const id = JSON.stringify(ownerArgs(owner));
    let p = this.renewing.get(id);
    if (!p) {
      p = (async () => {
        const fresh = { ...(await this.rotate(ws.refresh)), teamId: ws.teamId, userId: ws.userId };
        await this.put(owner, WORKSPACE, "workspace", fresh);
        return fresh;
      })().finally(() => this.renewing.delete(id));
      this.renewing.set(id, p);
    }
    return p;
  }

  // ---- a bot's app ----

  /** What the app shows for a bot: whether the workspace is connected, and its app. */
  async status(owner: Owner, routineId: string): Promise<{ workspace: boolean; app: { appId: string; installed: boolean; botUserId: string | null; teamName: string | null } | null; news: SlackNews | null }> {
    const [ws, app] = await Promise.all([this.get<Workspace>(owner, WORKSPACE, "workspace"), this.get<AppRecord>(owner, APP, routineId)]);
    return { workspace: !!ws, app: app ? { appId: app.appId, installed: !!app.botToken, botUserId: app.botUserId ?? null, teamName: app.teamName ?? null } : null, news: app?.botToken ? this.newsOf(app) : null };
  }

  // ---- its own news: one channel, chosen by its owner (docs/bots.md, "Slack") ----

  private static canName(app: AppRecord): boolean {
    return app.scopes?.includes("channels:read") ?? false;
  }

  /** The channel its news goes to: the one chosen, else the first it was mentioned in; null: only the app. */
  private static newsChannel(app: AppRecord): SlackChannel | null {
    if (app.news === "") return null;
    const id = app.news ?? app.channels?.[0]?.id;
    return id ? (app.channels?.find((c) => c.id === id) ?? { id }) : null;
  }

  private static canFiles(app: AppRecord): boolean {
    return (app.scopes?.includes("files:read") && app.scopes.includes("files:write")) ?? false;
  }

  private newsOf(app: AppRecord): SlackNews {
    return { channel: SlackApps.newsChannel(app), channels: app.channels ?? [], names: SlackApps.canName(app), files: SlackApps.canFiles(app), broken: app.newsBroken ?? null };
  }

  /** "#anomalies", or "the channel you were first mentioned in" while its name isn't known. */
  private static label(c: SlackChannel): string {
    return c.name ? `#${c.name}` : "the Slack channel you were mentioned in";
  }

  /** What a run is told about Slack (folder.ts, wake): its handle, its workspace, where its news goes. Null: not in Slack. */
  async forRun(owner: Owner, routineId: string): Promise<{ handle: string; workspace: string | null; news: string | null } | null> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app?.botToken) return null;
    const c = SlackApps.newsChannel(app);
    return { handle: app.name, workspace: app.teamName ?? null, news: c && !app.newsBroken ? SlackApps.label(c) : null };
  }

  /** Chooses where its news goes: one of the channels it was mentioned in, or null for only the app. */
  async setNews(owner: Owner, routineId: string, channel: string | null): Promise<SlackNews> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app?.botToken) throw new SlackError("not_in_slack", "This bot isn't in Slack yet.", 400);
    if (channel !== null && !app.channels?.some((c) => c.id === channel)) throw new SlackError("no_such_channel", "It hasn't been mentioned in that channel. Invite it there and mention it once, then choose it.", 400);
    const { newsBroken: _was, ...rest } = app;
    const next: AppRecord = { ...rest, news: channel ?? "" };
    await this.put(owner, APP, routineId, next);
    return this.newsOf(next);
  }

  /**
   * The bot posts news of its own (its tool, post_to_slack): into the one channel its owner chose,
   * as itself, outside any thread. The post is remembered, so replies in its thread reach it.
   * Refused when no channel is chosen; when Slack says the channel is gone, that's kept for its page.
   */
  async postNews(owner: Owner, routineId: string, text: string): Promise<{ channel: SlackChannel }> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app?.botToken) throw new SlackError("not_in_slack", "You're not in Slack: what you report is in the Ambient app.", 400);
    const channel = SlackApps.newsChannel(app);
    if (!channel) throw new SlackError("no_channel", "No Slack channel is chosen for your news, so it stays in the Ambient app. Your owner chooses one on your Slack page.", 400);
    let first: string | undefined;
    for (const part of splitText(markdownToSlack(text))) {
      const out = await this.call<{ ts?: string }>("chat.postMessage", app.botToken, { channel: channel.id, text: part, unfurl_links: false });
      if (!out.ok) {
        if (GONE.has(out.error ?? "")) await this.put(owner, APP, routineId, { ...app, newsBroken: out.error });
        throw new SlackError("slack_failed", GONE.has(out.error ?? "") ? `You can't post in ${SlackApps.label(channel)} anymore (${out.error}). It stays in the Ambient app; your owner sees that on your Slack page.` : `Slack didn't take the message (${out.error ?? "no reason"}).`, 502);
      }
      first ??= out.ts;
    }
    const { newsBroken: _was, ...rest } = app;
    const posts = first ? [...(app.posts ?? []), { channel: channel.id, ts: first, at: this.now() }].slice(-POSTS_MAX) : (app.posts ?? []);
    await this.put(owner, APP, routineId, { ...rest, posts });
    return { channel };
  }

  /** A channel it was mentioned in: kept, with its name when Slack gives it. */
  private async remember(owner: Owner, routineId: string, app: AppRecord, channelId: string): Promise<AppRecord> {
    const known = app.channels?.find((c) => c.id === channelId);
    if (known && (known.name || !SlackApps.canName(app))) return app;
    let name: string | undefined;
    if (SlackApps.canName(app) && app.botToken) {
      const out = await this.call<{ channel?: { name?: string } }>("conversations.info", app.botToken, { channel: channelId }, { form: true }).catch(() => null);
      name = out?.ok ? out.channel?.name : undefined;
    }
    if (known && !name) return app;
    const others = (app.channels ?? []).filter((c) => c.id !== channelId);
    const channels = known ? (app.channels ?? []).map((c) => (c.id === channelId ? { id: channelId, ...(name ? { name } : {}) } : c)) : [...others, { id: channelId, ...(name ? { name } : {}) }].slice(-CHANNELS_MAX);
    const next = { ...app, channels };
    await this.put(owner, APP, routineId, next);
    return next;
  }

  /**
   * An app from before channel names: its manifest gets today's permissions and events, and the
   * link asks for Allow once more. The bot stays in Slack meanwhile.
   */
  async reallow(owner: Owner, bot: { id: string; name: string }, uid: string): Promise<{ url: string }> {
    const app = await this.get<AppRecord>(owner, APP, bot.id);
    if (!app) throw new SlackError("no_app", "This bot has no Slack app yet.", 404);
    const ws = await this.configToken(owner);
    const hook = this.sign("hook", refOf(owner, bot.id));
    const out = await this.call("apps.manifest.update", ws.token, { app_id: app.appId, manifest: JSON.stringify(this.manifest(app.name, hook, bot.id)) }, { form: true });
    if (!out.ok) throw new SlackError("slack_failed", `Slack didn't update the app (${out.error ?? "no reason"}).`, 502);
    await this.put(owner, APP, bot.id, { ...app, manifestV: MANIFEST_V });
    return { url: this.installUrl(owner, bot.id, uid, app, ws.teamId) };
  }

  /** The manifest Slack gets: the bot's name, Ambient's addresses, what it may read and say. */
  manifest(name: string, hook: string, id = ""): Record<string, unknown> {
    const shown = name.trim().slice(0, NAME_MAX) || "Bot";
    const about = id === AMB ? `${shown}: Ambient, your team's brain. Message it directly, or mention it in a channel.` : `${shown}, a bot in Ambient. Mention it or send it a message.`;
    return {
      display_information: { name: shown, description: about.slice(0, 140), background_color: "#2f2f31" },
      features: {
        app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: shown, always_online: true },
      },
      oauth_config: { redirect_urls: [`${this.base()}/v1/slack/installed`], scopes: { bot: scopesFor(id) } },
      settings: {
        event_subscriptions: { request_url: `${this.base()}/v1/hooks/slack/${hook}`, bot_events: SLACK_EVENTS },
        // Buttons (a question's answers): Slack sends the click here, signed like the events.
        interactivity: { is_enabled: true, request_url: `${this.base()}/v1/hooks/slack/${hook}/interact` },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    };
  }

  /**
   * Gives a bot its own Slack app and returns the link that installs it (one tap: Allow). The app
   * is made once; asking again before it's installed gives the same link.
   */
  async add(owner: Owner, bot: { id: string; name: string }, uid: string): Promise<{ url: string; installed: boolean }> {
    let app = await this.get<AppRecord>(owner, APP, bot.id);
    if (app?.botToken) return { url: this.installUrl(owner, bot.id, uid, app), installed: true };
    const ws = await this.configToken(owner);
    if (!app) {
      const hook = this.sign("hook", refOf(owner, bot.id));
      const out = await this.call<{ app_id?: string; credentials?: { client_id?: string; client_secret?: string; signing_secret?: string }; errors?: { message?: string; pointer?: string }[] }>("apps.manifest.create", ws.token, { manifest: JSON.stringify(this.manifest(bot.name, hook, bot.id)) }, { form: true });
      if (!out.ok || !out.app_id || !out.credentials?.client_id || !out.credentials.client_secret || !out.credentials.signing_secret) {
        const why = out.errors?.map((e) => `${e.pointer ?? ""} ${e.message ?? ""}`.trim()).join("; ");
        throw new SlackError("slack_failed", `Slack didn't make the app (${out.error ?? "no reason"}${why ? `: ${why}` : ""}).`, 502);
      }
      app = { appId: out.app_id, clientId: out.credentials.client_id, clientSecret: out.credentials.client_secret, signingSecret: out.credentials.signing_secret, name: bot.name, adderUid: uid, manifestV: MANIFEST_V };
      await this.put(owner, APP, bot.id, app);
    }
    return { url: this.installUrl(owner, bot.id, uid, app, ws.teamId), installed: false };
  }

  private installUrl(owner: Owner, routineId: string, uid: string, app: AppRecord, teamId?: string | null): string {
    const state = this.sign("install", { ...refOf(owner, routineId), u: uid, n: randomBytes(9).toString("base64url"), e: this.now() + STATE_TTL_MS });
    const q = new URLSearchParams({ client_id: app.clientId, scope: scopesFor(routineId).join(","), redirect_uri: `${this.base()}/v1/slack/installed`, state });
    if (teamId ?? app.teamId) q.set("team", (teamId ?? app.teamId)!);
    return `https://slack.com/oauth/v2/authorize?${q.toString()}`;
  }

  /** Slack sends the browser back after Allow: the code becomes the bot's token. */
  async installed(code: string, state: string): Promise<{ name: string; botUserId: string; teamName: string | null }> {
    const s = this.verify<Ref & { u: string; e: number }>("install", state);
    if (!s) throw new SlackError("bad_state", "This link isn't from Ambient.", 400);
    if (s.e < this.now()) throw new SlackError("state_expired", "This link has expired. Tap Add to Slack again in Ambient.", 400);
    if (!code || code.length > 200) throw new SlackError("bad_request", "Slack sent no code.", 400);
    const owner = ownerOf(s);
    const app = await this.get<AppRecord>(owner, APP, s.r);
    if (!app) throw new SlackError("no_app", "This bot's Slack app is gone. Tap Add to Slack again in Ambient.", 404);
    const out = await this.call<{ access_token?: string; scope?: string; bot_user_id?: string; team?: { id?: string; name?: string }; authed_user?: { id?: string } }>(
      "oauth.v2.access",
      null,
      { client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: `${this.base()}/v1/slack/installed` },
      { form: true },
    );
    if (!out.ok || !out.access_token || !out.bot_user_id || !out.authed_user?.id) throw new SlackError("slack_failed", `Slack didn't install it (${out.error ?? "no reason"}). Tap Add to Slack again in Ambient.`, 502);
    const done: AppRecord = { ...app, adderUid: app.adderUid ?? s.u, botToken: out.access_token, botUserId: out.bot_user_id, teamId: out.team?.id, teamName: out.team?.name, installer: out.authed_user.id, scopes: (out.scope ?? "").split(",").map((x) => x.trim()).filter(Boolean) };
    await this.put(owner, APP, s.r, done);
    return { name: app.name, botUserId: out.bot_user_id, teamName: out.team?.name ?? null };
  }

  /** The bot's face as its app's icon (a PNG, 512 to 2000 px square). */
  async setIcon(owner: Owner, routineId: string, png: Buffer): Promise<void> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app) throw new SlackError("no_app", "This bot has no Slack app yet.", 404);
    const ws = await this.configToken(owner);
    const form = new FormData();
    form.set("app_id", app.appId);
    form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "icon.png");
    const url = `${(this.d.apiBase ?? "https://slack.com/api").replace(/\/$/, "")}/apps.icon.set`;
    const res = await (this.d.fetchImpl ?? fetch)(url, { method: "POST", headers: { authorization: `Bearer ${ws.token}` }, body: form, signal: AbortSignal.timeout(20_000) });
    const out = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string };
    if (!out.ok) throw new SlackError("slack_failed", out.error === "invalid_icon_size" ? "The icon must be a square PNG of 512 to 2000 pixels." : `Slack didn't take the icon (${out.error ?? "no reason"}).`, 400);
  }

  /** Takes the bot out of Slack: its app is deleted there, and forgotten here. */
  async remove(owner: Owner, routineId: string): Promise<boolean> {
    const app = await this.get<AppRecord>(owner, APP, routineId);
    if (!app) return false;
    const ws = await this.configToken(owner).catch(() => null);
    if (ws) {
      const out = await this.call("apps.manifest.delete", ws.token, { app_id: app.appId }, { form: true });
      if (!out.ok && out.error !== "app_not_found") console.warn(`[slack] couldn't delete the app ${app.appId}: ${out.error}`);
    }
    await this.put(owner, APP, routineId, {}, true);
    await this.put(owner, REPLY, routineId, {}, true);
    return true;
  }

  /** A run's Slack token (SLACK_BOT_TOKEN): it posts as the bot itself. */
  async botToken(owner: Owner, routineId: string): Promise<string | null> {
    return (await this.get<AppRecord>(owner, APP, routineId))?.botToken ?? null;
  }

  // ---- what Slack sends ----

  /**
   * An event for a bot's app (`hook` from its event URL). Checked with that app's signing secret;
   * Slack's first check of the URL (url_verification, while the app is being made and its secret
   * isn't known yet) only needs the hook to be Ambient's.
   */
  async receive(hook: string, headers: { signature?: string; timestamp?: string; retry?: string }, raw: Buffer): Promise<{ status: number; body: unknown }> {
    const ref = this.verify<Ref>("hook", hook);
    if (!ref) return { status: 404, body: { error: "not_found" } };
    let payload: { type?: string; challenge?: string; event_id?: string; event?: SlackEvent; team_id?: string };
    try {
      payload = JSON.parse(raw.toString("utf8")) as typeof payload;
    } catch {
      return { status: 400, body: { error: "bad_request" } };
    }
    if (payload.type === "url_verification") return { status: 200, body: { challenge: payload.challenge ?? "" } };
    const owner = ownerOf(ref);
    const app = await this.get<AppRecord>(owner, APP, ref.r);
    if (!app) return { status: 404, body: { error: "not_found" } };
    if (!this.signed(app.signingSecret, headers, raw)) return { status: 401, body: { error: "bad_signature" } };
    if (payload.type !== "event_callback" || !payload.event) return { status: 200, body: { ok: true } };
    // Slack sends again after 3 s without an answer: taken once.
    const id = payload.event_id ?? `${payload.event.channel}:${payload.event.ts}`;
    const now = this.now();
    for (const [k, at] of this.seen) if (now - at > 30 * 60_000) this.seen.delete(k);
    if (this.seen.has(id)) return { status: 200, body: { ok: true } };
    this.seen.set(id, now);
    this.track(this.onEvent(owner, ref.r, app, payload.event));
    return { status: 200, body: { ok: true } };
  }

  private signed(secret: string, h: { signature?: string; timestamp?: string }, raw: Buffer): boolean {
    const ts = Number(h.timestamp);
    if (!h.signature || !Number.isFinite(ts) || Math.abs(this.now() / 1000 - ts) > 5 * 60) return false;
    const want = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${h.timestamp}:`).update(raw).digest("hex")}`);
    const got = Buffer.from(h.signature);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private async onEvent(owner: Owner, routineId: string, app: AppRecord, e: SlackEvent): Promise<void> {
    if (routineId === AMB) return this.onAmbEvent(owner, app, e);
    const dm = e.type === "message" && e.channel_type === "im";
    // A reply in the thread under a post of its own counts as written to it. One that also
    // mentions it comes as an app_mention too, and is taken there.
    const underOwnPost =
      e.type === "message" && !dm && !!e.thread_ts && (app.posts ?? []).some((p) => p.channel === e.channel && p.ts === e.thread_ts) && !(e.text ?? "").includes(`<@${app.botUserId}>`);
    if (e.type !== "app_mention" && !dm && !underOwnPost) return;
    // Its own messages, other bots', edits and joins: not for it.
    // A message with files is subtype "file_share"; other subtypes (edits, joins) aren't for it.
    if (e.bot_id || (e.subtype && e.subtype !== "file_share") || !e.user || !e.channel || !e.ts || !app.botToken) return;
    if (e.user === app.botUserId) return;
    // A channel it's mentioned in is one it can post its news in.
    if (e.type === "app_mention") {
      const before = app;
      app = await this.remember(owner, routineId, before, e.channel).catch(() => before);
    }
    if (!app.botToken) return;
    const thread = e.thread_ts ?? e.ts;
    // It takes instructions from whoever installed it (its runs hold its owner's secrets).
    if (!app.installer || e.user !== app.installer) {
      const warnKey = `${routineId}:${e.channel}:${thread}`;
      if (!this.warned.has(warnKey)) {
        this.warned.add(warnKey);
        await this.post(app.botToken, e.channel, thread, app.installer ? `I only take instructions from <@${app.installer}> for now.` : "I don't know who installed me, so I'm not taking instructions. Add me to Slack again from Ambient.", true);
      }
      return;
    }
    const text = (e.text ?? "").replace(new RegExp(`<@${app.botUserId}>`, "g"), "").trim();
    // A reply where its question waits answers it (Answered, or refused with the reason: done).
    if (text && !(e.files ?? []).length) {
      const r = await this.get<Replies>(owner, REPLY, routineId);
      const now = this.now();
      const waiting = [...(r?.asks ?? [])].reverse().find((x) => x.channel === e.channel && x.thread === thread && now - x.at < ASK_FOR_MS);
      if (waiting && (await this.answerAsk(owner, routineId, app, waiting, slackToPlain(text), await this.nameOf(app.botToken, e.user))) !== "gone") return;
    }
    const offered = (e.files ?? []).filter((f) => f.mode !== "tombstone" && f.mode !== "external");
    if (!text && !offered.length) return;
    const who = await this.nameOf(app.botToken, e.user);
    const where = dm ? "in a direct message" : underOwnPost ? "in the thread under your post" : "in a channel";
    // Its files, kept in its thread like a file sent from the app: its run gets them on disk.
    const canRead = SlackApps.canFiles(app);
    const token = app.botToken;
    const { files: incoming, left } = await takeFiles(
      offered.map((f): OfferedFile => ({
        name: f.name ?? f.title ?? "file",
        type: f.mimetype,
        size: f.size,
        fetch: canRead && (f.url_private_download ?? f.url_private) ? () => download(this.d.fetchImpl ?? fetch, (f.url_private_download ?? f.url_private)!, { authorization: `Bearer ${token}` }) : null,
        why: canRead ? "Slack gave no link to it" : "this bot's Slack app may not open files yet; its owner taps Allow again on its Slack page in Ambient",
      })),
    );
    const files: FileRef[] = incoming.length && this.d.attachments ? await this.d.attachments.save(owner, { routineId }, incoming) : [];
    const said = text ? slackToPlain(text) : `sent ${files.length === 1 ? "a file" : "files"}`;
    const body = `${who} wrote to you on Slack (${where}): ${said}${leftLine(left)}\n\n(Your answer goes back to that Slack thread on its own.)`;
    await this.replies(owner, routineId, (r) => {
      const now = this.now();
      // Old ones nobody answered go; the newest stay.
      const kept = r.targets.filter((t) => now - t.at <= REPLY_FOR_MS && !(t.channel === e.channel && t.ts === thread && !t.runId));
      return { ...r, targets: [...kept, { channel: e.channel!, ts: thread, at: now }].slice(-TARGETS_MAX) };
    });
    void this.call("reactions.add", app.botToken, { channel: e.channel, timestamp: e.ts, name: "eyes" }).catch(() => undefined);
    const sealed = await sealMessage(this.d.keys, owner, { text: body, ...(files.length ? { files } : {}) });
    const out = (await this.d.control.m(api.bots.wake, { id: routineId, iv: sealed.iv, ct: sealed.ct, authorName: "Slack", run: true, now: this.now() })) as { ok: boolean; hostId?: string | null; enabled?: boolean };
    if (out.ok && out.enabled && out.hostId) this.d.startNow?.(String(out.hostId), routineId);
    if (out.ok && !out.enabled) await this.post(app.botToken, e.channel, thread, "I'm paused in Ambient right now, so I won't get to this until I'm switched back on.", true);
  }

  // ---- buttons (Slack's interactivity) ----

  /** An app from before buttons gets today's manifest (no new permission, so no Allow). */
  private async ensureManifest(owner: Owner, routineId: string, app: AppRecord): Promise<AppRecord> {
    if ((app.manifestV ?? 1) >= MANIFEST_V) return app;
    const ws = await this.configToken(owner).catch(() => null);
    if (!ws) return app;
    const out = await this.call("apps.manifest.update", ws.token, { app_id: app.appId, manifest: JSON.stringify(this.manifest(app.name, this.sign("hook", refOf(owner, routineId)), routineId)) }, { form: true });
    if (!out.ok) {
      console.warn(`[slack] couldn't bring ${app.name}'s app up to date: ${out.error}`);
      return app;
    }
    const next = { ...app, manifestV: MANIFEST_V };
    await this.put(owner, APP, routineId, next);
    return next;
  }

  /** A click on a button (`hook` from its interactivity URL), checked with that app's signing secret. */
  async interact(hook: string, headers: { signature?: string; timestamp?: string }, raw: Buffer): Promise<{ status: number; body: unknown }> {
    const ref = this.verify<Ref>("hook", hook);
    if (!ref) return { status: 404, body: { error: "not_found" } };
    const owner = ownerOf(ref);
    const app = await this.get<AppRecord>(owner, APP, ref.r);
    if (!app?.botToken) return { status: 404, body: { error: "not_found" } };
    if (!this.signed(app.signingSecret, headers, raw)) return { status: 401, body: { error: "bad_signature" } };
    let payload: SlackAction;
    try {
      payload = JSON.parse(new URLSearchParams(raw.toString("utf8")).get("payload") ?? "{}") as SlackAction;
    } catch {
      return { status: 400, body: { error: "bad_request" } };
    }
    if (payload.type !== "block_actions") return { status: 200, body: {} };
    this.track(this.onAction(owner, ref.r, app, payload));
    return { status: 200, body: {} };
  }

  private async onAction(owner: Owner, routineId: string, app: AppRecord, p: SlackAction): Promise<void> {
    const token = app.botToken!;
    const action = p.actions?.[0];
    const channel = p.channel?.id ?? p.container?.channel_id;
    const msgTs = p.message?.ts ?? p.container?.message_ts;
    const user = p.user?.id;
    if (!action?.value || !channel || !msgTs || !user) return;
    let v: { k?: string; q?: string; d?: string; o?: string };
    try {
      v = JSON.parse(action.value) as typeof v;
    } catch {
      return;
    }
    const thread = p.message?.thread_ts ?? msgTs;
    const say = (text: string) => this.post(token, channel, thread === msgTs && p.channel?.id?.startsWith("D") ? "" : thread, text, true).catch(() => undefined);
    const question = p.message?.text ?? "";
    // Amb's decision (its own app): answered as whoever clicked, by their email.
    if (v.k === "d" && routineId === AMB && v.d && v.o) {
      const email = await this.emailOf(token, user);
      const account = email && this.d.amb ? await this.d.amb.accountByEmail(owner, email).catch(() => null) : null;
      if (!account || !this.d.amb?.answer) return void (await say("I don't know who you are in Ambient, so I can't take that answer."));
      try {
        await this.d.amb.answer(account.uid, v.d, v.o, "slack");
        await this.replaceButtons(token, channel, msgTs, question, v.o, account.name);
      } catch (err) {
        if (/already answered|no such decision/i.test((err as Error).message)) await this.replaceButtons(token, channel, msgTs, question, null, null);
        else await say((err as Error).message);
      }
      return;
    }
    // A bot's question: only the person who added it answers.
    if (v.k === "q" && v.q && v.o) {
      if (!app.installer || user !== app.installer) return void (await say(app.installer ? `Only <@${app.installer}> answers my questions.` : "I don't know who added me, so I can't take answers."));
      const ask: Ask = { q: v.q, channel, thread, msgTs, text: question, at: this.now() };
      await this.answerAsk(owner, routineId, app, ask, v.o, await this.nameOf(token, user));
    }
  }

  /** Answers the bot's question as the person who added it; the buttons then say what was answered. */
  private async answerAsk(owner: Owner, routineId: string, app: AppRecord, ask: Ask, text: string, by: string): Promise<"answered" | "gone" | "failed"> {
    const token = app.botToken!;
    const out = app.adderUid && this.d.answer ? await this.d.answer(app.adderUid, routineId, ask.q, text).catch((err: Error) => ({ error: err.message })) : { error: "This bot doesn't know whose answers to take. Add it to Slack again from Ambient." };
    if (out === "answered" || out === "gone") {
      await this.replies(owner, routineId, (cur) => ({ ...cur, asks: (cur.asks ?? []).filter((x) => x.q !== ask.q) }));
      if (ask.msgTs) await this.replaceButtons(token, ask.channel, ask.msgTs, ask.text, out === "answered" ? text : null, out === "answered" ? by : null);
      return out;
    }
    await this.post(token, ask.channel, ask.thread, out.error, true).catch(() => undefined);
    return "failed";
  }

  private async replaceButtons(token: string, channel: string, ts: string, question: string, answer: string | null, by: string | null): Promise<void> {
    const out = await this.call("chat.update", token, { channel, ts, text: question || "Question", blocks: answeredBlocks(question, answer, by) });
    if (!out.ok) console.warn(`[slack] couldn't replace the buttons: ${out.error}`);
  }

  /** A question with its answers as buttons, into a thread (or a DM with `thread` ""). Returns the message's ts. */
  private async postQuestion(token: string, channel: string, thread: string, text: string, choices: string[], value: (choice: string) => Record<string, string>): Promise<string | undefined> {
    const out = await this.call<{ ts?: string }>("chat.postMessage", token, { channel, ...(thread ? { thread_ts: thread } : {}), text: text.slice(0, 3000), blocks: questionBlocks(text, choices, value), unfurl_links: false });
    if (!out.ok) throw new SlackError("slack_failed", `Slack didn't take the question (${out.error ?? "no reason"}).`, 502);
    return out.ts;
  }

  // ---- Amb in Slack (channels/amb-doors.ts) ----

  /** Amb's app in the workspace, made like a bot's, under the key "amb" (one tap: Allow). */
  async addAmb(owner: Owner, uid: string, name = "Ambient"): Promise<{ url: string; installed: boolean }> {
    if (!this.d.amb) throw new SlackError("not_set_up", "Amb isn't set up for Slack on this server.", 404);
    return this.add(owner, { id: AMB, name }, uid);
  }

  /** Whether Amb is in the workspace, and under which name. */
  async ambStatus(owner: Owner): Promise<{ workspace: boolean; app: { name: string; installed: boolean } | null }> {
    const [ws, app] = await Promise.all([this.get<Workspace>(owner, WORKSPACE, "workspace"), this.get<AppRecord>(owner, APP, AMB)]);
    return { workspace: !!ws, app: app ? { name: app.name, installed: !!app.botToken } : null };
  }

  /** Someone writes to Amb in Slack: a direct message goes to their own Amb chat; a channel to the team's Amb. */
  private async onAmbEvent(owner: Owner, app: AppRecord, e: SlackEvent): Promise<void> {
    const amb = this.d.amb;
    const dm = e.type === "message" && e.channel_type === "im";
    if (!amb || (e.type !== "app_mention" && !dm)) return;
    if (e.bot_id || (e.subtype && e.subtype !== "file_share") || !e.user || !e.channel || !e.ts || !app.botToken) return;
    if (e.user === app.botUserId) return;
    const token = app.botToken;
    const thread = e.thread_ts ?? e.ts;
    const reply = (text: string) => this.post(token, e.channel!, dm ? "" : thread, text, true);
    const email = await this.emailOf(token, e.user);
    const account = email ? await amb.accountByEmail(owner, email).catch(() => null) : null;
    if (!account) {
      const warnKey = `amb:${e.user}`;
      if (!this.warned.has(warnKey)) {
        this.warned.add(warnKey);
        await reply(email ? `I don't know you yet: no Ambient account here has the email ${email}. Ask your team's admin to invite you to Ambient.` : "I can't see your email in Slack, so I don't know who you are in Ambient.");
      }
      return;
    }
    const text = slackToPlain((e.text ?? "").replace(new RegExp(`<@${app.botUserId}>`, "g"), "").trim());
    const canRead = SlackApps.canFiles(app);
    const taken = await takeFiles(
      (e.files ?? [])
        .filter((f) => f.mode !== "tombstone" && f.mode !== "external")
        .map((f): OfferedFile => ({ name: f.name ?? f.title ?? "file", type: f.mimetype, size: f.size, fetch: canRead && (f.url_private_download ?? f.url_private) ? () => download(this.d.fetchImpl ?? fetch, (f.url_private_download ?? f.url_private)!, { authorization: `Bearer ${token}` }) : null, why: "Amb's Slack app may not open files yet" })),
    );
    const { files, left } = forAmb(taken.files);
    const all = [...taken.left, ...left];
    if (!text && !files.length && !all.length) return;
    void this.call("reactions.add", token, { channel: e.channel, timestamp: e.ts, name: "eyes" }).catch(() => undefined);
    if (!dm) {
      // A channel: the team's Amb, with the team's brain only.
      if (owner.kind !== "team" || !amb.teamTurn) {
        await reply("In a channel I answer from a team's brain, and this workspace is connected for one person. Write to me directly instead.");
        return;
      }
      const answer = await amb.teamTurn(owner.teamId, account, `slack:${e.channel}:${thread}`, `${text}${leftLine(all)}`, files).catch((err: Error) => ({ text: `That didn't work just now (${err.message}).` }));
      if (answer?.text) await this.post(token, e.channel, thread, answer.text);
      return;
    }
    // A direct message: their own Amb, and this chat is their Slack door to it.
    await this.put({ kind: "user", uid: account.uid }, AMB_LINK, "link", { ...refOf(owner, AMB), channel: e.channel, lastTs: e.ts, at: this.now() } satisfies AmbLink);
    await amb.inbox.sendQueued(account.uid, await amb.inbox.nameOf(account.uid).catch(() => account.name), `${text || `sent ${files.length === 1 ? "a file" : "files"}`}${leftLine(all)}`, "slack", files);
  }

  /** The Slack user's email (Amb's app may read it: users:read.email). */
  private async emailOf(token: string, user: string): Promise<string | null> {
    const out = await this.call<{ user?: { profile?: { email?: string } } }>("users.info", token, { user }, { form: true }).catch(() => null);
    return out?.user?.profile?.email?.toLowerCase() ?? null;
  }

  /** Amb's Slack door for one person: their direct message with Amb's app, for answers and for what Amb says first. */
  ambChannel(): AmbChannel {
    const link = async (uid: string) => {
      const l = await this.get<AmbLink>({ kind: "user", uid }, AMB_LINK, "link");
      if (!l) return null;
      const app = await this.get<AppRecord>(ownerOf(l), APP, AMB);
      return app?.botToken ? { l, app, token: app.botToken } : null;
    };
    return {
      kind: "slack",
      linked: async (uid) => !!(await link(uid)),
      send: async (uid: string, text: string, opts: { first?: boolean; files?: OutFile[]; react?: string } = {}) => {
        const found = await link(uid);
        if (!found) throw new SlackError("not_linked", "Not linked to Slack.", 400);
        if (opts.react) await this.call("reactions.add", found.token, { channel: found.l.channel, timestamp: found.l.lastTs, name: slackEmoji(opts.react) }).catch(() => undefined);
        if (text.trim()) await this.post(found.token, found.l.channel, "", text);
        for (const f of opts.files ?? []) await this.upload(found.app, found.l.channel, "", { name: f.name, type: f.type, data: f.bytes.toString("base64") });
      },
      // Amb's decisions with their answers as buttons; a click files the answer as that person.
      ask: async (uid: string, text: string, question: { decisionId: string; choices: string[] }) => {
        const found = await link(uid);
        if (!found) throw new SlackError("not_linked", "Not linked to Slack.", 400);
        const app = await this.ensureManifest(ownerOf(found.l), AMB, found.app);
        await this.postQuestion(app.botToken ?? found.token, found.l.channel, "", text, question.choices, (o) => ({ k: "d", d: question.decisionId, o }));
      },
    };
  }

  /**
   * A file the bot made (send_file) into a Slack thread, as itself: Slack's upload URL, the bytes,
   * then the file shared in the thread. An app that may not send files says where it is instead.
   */
  private async upload(app: AppRecord, channel: string, threadTs: string, f: { name: string; type: string; data: string }): Promise<void> {
    if (!app.botToken) return;
    const bytes = Buffer.from(f.data, "base64");
    const fallback = () => this.post(app.botToken!, channel, threadTs, `📎 ${f.name}: in my thread in Ambient (I may not send files in Slack yet; my owner taps Allow again on my Slack page).`, true);
    if (!SlackApps.canFiles(app)) return fallback();
    const url = await this.call<{ upload_url?: string; file_id?: string }>("files.getUploadURLExternal", app.botToken, { filename: f.name, length: String(bytes.length) }, { form: true });
    if (!url.ok || !url.upload_url || !url.file_id) {
      if (url.error === "missing_scope") return fallback();
      throw new SlackError("slack_failed", `Slack didn't take the file (${url.error ?? "no reason"}).`, 502);
    }
    const put = await (this.d.fetchImpl ?? fetch)(url.upload_url, { method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60_000) });
    if (!put.ok) throw new SlackError("slack_failed", `Slack didn't take the file (HTTP ${put.status}).`, 502);
    const done = await this.call("files.completeUploadExternal", app.botToken, { files: JSON.stringify([{ id: url.file_id, title: f.name }]), channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}) }, { form: true });
    if (!done.ok) throw new SlackError("slack_failed", `Slack didn't share the file (${done.error ?? "no reason"}).`, 502);
  }

  private async nameOf(token: string, user: string): Promise<string> {
    const cached = this.names.get(user);
    if (cached) return cached;
    const out = await this.call<{ user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } } }>("users.info", token, { user }, { form: true }).catch(() => null);
    const name = out?.user?.profile?.display_name || out?.user?.real_name || out?.user?.profile?.real_name || "Someone";
    this.names.set(user, name);
    return name;
  }

  /** Into a Slack thread: a bot's Markdown (`mrkdwn`: Ambient's own notice, already Slack's markup). */
  private async post(token: string, channel: string, threadTs: string, text: string, mrkdwn = false): Promise<void> {
    for (const part of splitText(mrkdwn ? text : markdownToSlack(text))) {
      const out = await this.call("chat.postMessage", token, { channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: part, unfurl_links: false });
      if (!out.ok) throw new SlackError("slack_failed", `Slack didn't take the message (${out.error ?? "no reason"}).`, 502);
    }
  }

  /** Read, change and write a bot's reply targets, one change at a time per bot. */
  private async replies(owner: Owner, routineId: string, change: (r: Replies) => Replies | null): Promise<Replies> {
    const key = `${JSON.stringify(ownerArgs(owner))}:${routineId}`;
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

  /**
   * A bot's run starts: it sees every message already in its thread, so the Slack messages
   * waiting for an answer are now its to answer. Only when the bot has a Slack app.
   */
  async runStarted(owner: Owner, routineId: string, runId: string, tokenHash: string): Promise<void> {
    if (!(await this.get<AppRecord>(owner, APP, routineId))?.botToken) return;
    await this.replies(owner, routineId, (r) => ({ ...r, run: { id: runId, hash: tokenHash }, targets: r.targets.map((t) => (t.runId ? t : { ...t, runId })) }));
  }

  /** A running bot took Slack messages from its thread mid-run (its inbox): they're its to answer. */
  async runTook(owner: Owner, routineId: string, tokenHash: string): Promise<void> {
    await this.replies(owner, routineId, (r) => {
      if (r.run?.hash !== tokenHash) return null;
      const now = this.now();
      return { ...r, targets: r.targets.map((t) => (t.runId || t.at > now ? t : { ...t, runId: r.run!.id })) };
    });
  }

  /**
   * A run said something (its reply, its question, or its result): it goes to the Slack threads
   * that run took, and nowhere else, so another run's output never lands in a Slack thread. The
   * run is named by its id (its result) or its token's hash (while it runs). Its end (`final`)
   * closes its threads.
   */
  said(owner: Owner, routineId: string, text: string, final: boolean, run: { id?: string; hash?: string }, files: { name: string; type: string; data: string }[] = [], question?: { id: string; text: string; choices: string[] }): void {
    this.track(
      (async () => {
        const r = await this.get<Replies>(owner, REPLY, routineId);
        if (!r?.targets?.length) return;
        const runId = run.id ?? (run.hash && r.run?.hash === run.hash ? r.run.id : undefined);
        if (!runId) return;
        const mine = r.targets.filter((t) => t.runId === runId);
        if (!mine.length) return;
        const app = await this.get<AppRecord>(owner, APP, routineId);
        if (!app?.botToken) return;
        if (question) {
          // Its question with its answers as buttons; a click or a reply in the thread answers it.
          const current = await this.ensureManifest(owner, routineId, app);
          const asks: Ask[] = [];
          for (const t of mine) {
            const msgTs = await this.postQuestion(current.botToken!, t.channel, t.ts, question.text, question.choices, (o) => ({ k: "q", q: question.id, o }));
            asks.push({ q: question.id, channel: t.channel, thread: t.ts, ...(msgTs ? { msgTs } : {}), text: question.text, at: this.now() });
          }
          const now = this.now();
          await this.replies(owner, routineId, (cur) => ({ ...cur, asks: [...(cur.asks ?? []).filter((a) => now - a.at < ASK_FOR_MS), ...asks].slice(-TARGETS_MAX) }));
        } else if (text.trim()) for (const t of mine) await this.post(app.botToken, t.channel, t.ts, text);
        for (const f of files) for (const t of mine) await this.upload(app, t.channel, t.ts, f);
        if (final) await this.replies(owner, routineId, (cur) => ({ targets: cur.targets.filter((t) => t.runId !== runId), ...(cur.run && cur.run.id !== runId ? { run: cur.run } : {}), ...(cur.asks ? { asks: cur.asks } : {}) }));
      })(),
    );
  }
}

/** A click on a button, as Slack sends it. */
interface SlackAction {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts?: string; thread_ts?: string; text?: string };
  actions?: { action_id?: string; value?: string }[];
}

/** A question as Block Kit: the text, a button per answer, and that a reply in the thread works too. */
export function questionBlocks(text: string, choices: string[], value: (choice: string) => Record<string, string>): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: markdownToSlack(text).slice(0, 3000) } },
    ...(choices.length ? [{ type: "actions", elements: choices.slice(0, 25).map((c, i) => ({ type: "button", action_id: `choice-${i}`, text: { type: "plain_text", text: c.slice(0, 75) }, value: JSON.stringify(value(c)).slice(0, 2000) })) }] : []),
    { type: "context", elements: [{ type: "mrkdwn", text: choices.length ? "Or reply in this thread." : "Reply in this thread." }] },
  ];
}

/** The question once it's answered (`answer` null: answered elsewhere, or no longer asked). */
export function answeredBlocks(question: string, answer: string | null, by: string | null): unknown[] {
  return [
    ...(question ? [{ type: "section", text: { type: "mrkdwn", text: markdownToSlack(question).slice(0, 3000) } }] : []),
    { type: "context", elements: [{ type: "mrkdwn", text: answer ? `✓ *${answer.replace(/[*_~`]/g, "").slice(0, 300)}*${by ? ` · ${by}` : ""}` : "Already answered, or no longer asked." }] },
  ];
}

/** A person's Slack door to Amb: whose workspace app, and their direct message with it. */
interface AmbLink extends Ref {
  channel: string;
  /** Their last message there (Amb's reaction goes on it). */
  lastTs: string;
  at: number;
}

/** Slack's name for a few emoji Amb reacts with (others: a thumbs up). */
function slackEmoji(e: string): string {
  const names: Record<string, string> = { "👍": "+1", "❤️": "heart", "😂": "joy", "🙏": "pray", "🎉": "tada", "🔥": "fire", "🤝": "handshake", "👀": "eyes", "✅": "white_check_mark", "🙂": "slightly_smiling_face" };
  return names[e] ?? "+1";
}

interface SlackEvent {
  type?: string;
  /** Files sent with the message. */
  files?: { id?: string; name?: string; title?: string; mimetype?: string; size?: number; mode?: string; url_private?: string; url_private_download?: string }[];
  subtype?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

/** Slack's markup in a message, as plain text for the bot (<url|label>, <#C1|name>, &amp;). */
export function slackToPlain(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A bot's Markdown as Slack's mrkdwn: bold, links, headings; code stays as it is. */
export function markdownToSlack(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith("```")
        ? part
        : part
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
            .replace(/\*\*(.+?)\*\*/g, "*$1*")
            .replace(/__(.+?)__/g, "*$1*")
            .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>"),
    )
    .join("");
}

/** Long answers in parts, cut at a line where it can. */
export function splitText(text: string, max = PART_MAX): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
