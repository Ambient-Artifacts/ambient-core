// Microsoft Teams through the Bot Framework: checking what Teams sends us, and sending back.
//
//   Teams ──POST /teams/messages, Bearer JWT──▶ verifyInbound(): signed by the Bot Framework,
//                                               for this bot, endorsed for msteams, same serviceUrl
//   bot ──token from the bot's own tenant──▶ BotClient: replies, direct messages, team roster
//
// One bot per customer, registered in the customer's own Microsoft Entra tenant (single tenant),
// so the outbound token comes from that tenant, not from botframework.com.
import { importJWK, jwtVerify, decodeProtectedHeader, type JWK } from "jose";

export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
export const BOT_FRAMEWORK_KEYS = "https://login.botframework.com/v1/.well-known/keys";

export interface Activity {
  type: string;
  id?: string;
  timestamp?: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name?: string; aadObjectId?: string };
  conversation: { id: string; conversationType?: string; tenantId?: string; isGroup?: boolean };
  recipient: { id: string; name?: string };
  text?: string;
  value?: unknown;
  replyToId?: string;
  membersAdded?: { id: string; name?: string }[];
  membersRemoved?: { id: string; name?: string }[];
  entities?: { type: string; mentioned?: { id: string }; text?: string }[];
  channelData?: {
    tenant?: { id: string };
    team?: { id: string; name?: string; aadGroupId?: string };
    channel?: { id: string; name?: string };
    eventType?: string;
  };
}

export interface Member {
  id: string;
  name: string;
  aadObjectId?: string;
  email?: string;
  userPrincipalName?: string;
}

type KeySet = { at: number; keys: (JWK & { kid?: string; endorsements?: string[] })[] };

export class InboundError extends Error {}

/** Checks the Bot Framework's signature on what Teams sends; keys cached for a day. */
export class InboundVerifier {
  private keys?: KeySet;

  constructor(
    private fetchImpl: typeof fetch = fetch,
    private keysUrl = BOT_FRAMEWORK_KEYS,
  ) {}

  private async keySet(refresh = false): Promise<KeySet> {
    if (!refresh && this.keys && Date.now() - this.keys.at < 24 * 3600_000) return this.keys;
    const res = await this.fetchImpl(this.keysUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new InboundError(`Bot Framework keys answered ${res.status}`);
    this.keys = { at: Date.now(), keys: ((await res.json()) as { keys: KeySet["keys"] }).keys ?? [] };
    return this.keys;
  }

  /** Throws InboundError unless `authorization` is a Bot Framework token for `appId` that fits `activity`. */
  async verify(authorization: string | undefined, appId: string, activity: Activity): Promise<void> {
    const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    if (!token) throw new InboundError("no bearer token");
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new InboundError("not a JWT");
    }
    let jwk = (await this.keySet()).keys.find((k) => k.kid === kid);
    // Keys roll over: a kid we don't know yet means fetching again, once.
    if (!jwk) jwk = (await this.keySet(true)).keys.find((k) => k.kid === kid);
    if (!jwk) throw new InboundError("unknown signing key");
    if (!jwk.endorsements?.includes(activity.channelId)) throw new InboundError(`key not endorsed for ${activity.channelId}`);
    const { endorsements: _e, ...plain } = jwk;
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, await importJWK({ ...plain, alg: plain.alg ?? "RS256" }), {
        issuer: BOT_FRAMEWORK_ISSUER,
        audience: appId,
        clockTolerance: 300,
      }));
    } catch (err) {
      throw new InboundError(`token rejected: ${(err as Error).message}`);
    }
    const serviceUrl = String(payload.serviceUrl ?? payload.serviceurl ?? "");
    if (serviceUrl && trimSlash(serviceUrl) !== trimSlash(activity.serviceUrl)) throw new InboundError("serviceUrl doesn't match the token");
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export interface BotCredentials {
  tenantId: string;
  appId: string;
  secret: string;
}

/** Calls to Teams as the bot: a token from the bot's tenant, kept until shortly before it expires. */
export class BotClient {
  private token?: { value: string; until: number };

  constructor(
    private creds: BotCredentials,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get botId(): string {
    return `28:${this.creds.appId}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.creds.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.creds.appId,
        client_secret: this.creds.secret,
        scope: "https://api.botframework.com/.default",
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`bot token: ${res.status} ${(body.error_description ?? "").split("\n")[0]}`.trim());
    this.token = { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
    return this.token.value;
  }

  private async call(method: string, url: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Teams ${method} ${new URL(url).pathname}: ${res.status} ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as unknown) : {};
  }

  /** A new message in a conversation (a channel, a chat); returns its id. */
  async send(serviceUrl: string, conversationId: string, activity: Record<string, unknown>): Promise<string | undefined> {
    const out = (await this.call("POST", `${trimSlash(serviceUrl)}/v3/conversations/${encodeURIComponent(conversationId)}/activities`, { type: "message", ...activity })) as { id?: string };
    return out.id;
  }

  /** Replace a message the bot sent earlier (a card after someone clicked it). */
  async update(serviceUrl: string, conversationId: string, activityId: string, activity: Record<string, unknown>): Promise<void> {
    await this.call("PUT", `${trimSlash(serviceUrl)}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`, {
      type: "message",
      id: activityId,
      ...activity,
    });
  }

  /** The one-to-one chat with a team member (Teams returns the existing one when there is one). */
  async directChat(serviceUrl: string, memberId: string): Promise<string> {
    const out = (await this.call("POST", `${trimSlash(serviceUrl)}/v3/conversations`, {
      isGroup: false,
      bot: { id: this.botId },
      members: [{ id: memberId }],
      tenantId: this.creds.tenantId,
      channelData: { tenant: { id: this.creds.tenantId } },
    })) as { id?: string };
    if (!out.id) throw new Error("Teams returned no conversation id for the direct chat");
    return out.id;
  }

  /** Everyone in the team the bot is installed in. */
  async members(serviceUrl: string, teamId: string): Promise<Member[]> {
    const out: Member[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ pageSize: "200", ...(token ? { continuationToken: token } : {}) });
      const page = (await this.call("GET", `${trimSlash(serviceUrl)}/v3/conversations/${encodeURIComponent(teamId)}/pagedmembers?${q}`)) as {
        members?: Member[];
        continuationToken?: string;
      };
      out.push(...(page.members ?? []));
      token = page.continuationToken;
    } while (token && out.length < 5_000);
    return out;
  }
}
