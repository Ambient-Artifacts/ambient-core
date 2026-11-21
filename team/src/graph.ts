// Microsoft Graph for OneDrive/SharePoint folders. Where its token comes from is a TokenSource:
// the team's own Entra app (client credentials, secret on the team server), tokens the gateway
// pushes for Ambient's own app (its credential never leaves the gateway), or a person's sign-in
// while the gateway sets up "Connect Microsoft 365". Plain fetch, injectable for tests; errors
// carry a sentence an admin can act on.
import type { MicrosoftConnection } from "@brain/spec";

const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN = "https://login.microsoftonline.com";

export class GraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DriveFolder {
  drive_id: string;
  folder_id: string;
  label: string;
}

function friendly(status: number, body: string): string {
  let detail = "";
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    detail = body.slice(0, 200);
  }
  if (status === 401 || status === 403) return "Ambient has no access to that folder. Grant the app access to the folder or its site, then try again.";
  if (status === 404) return "That folder doesn't exist, or Ambient's app can't see it.";
  if (status === 507) return "The drive is full.";
  return `Microsoft answered ${status}${detail ? `: ${detail}` : ""}`;
}

const segments = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/** Where a Graph token comes from. */
export interface TokenSource {
  token(): Promise<string>;
  /** Microsoft answered 401: drop a cached token, so the next call gets a fresh one. */
  forget(): void;
}

/** The team's own Entra app: client credentials. Cached until two minutes before expiry. */
export class ClientCredentials implements TokenSource {
  private cached: { value: string; until: number } | null = null;

  constructor(
    private conn: { tenant_id: string; client_id: string; client_secret: string },
    private fetchImpl: typeof fetch = fetch,
    private login = LOGIN,
  ) {}

  forget(): void {
    this.cached = null;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.value;
    const body = new URLSearchParams({
      client_id: this.conn.client_id,
      client_secret: this.conn.client_secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.login}/${this.conn.tenant_id}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GraphError(503, `Microsoft sign-in unreachable: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new GraphError(400, `Microsoft didn't accept the app's tenant ID, app ID or secret: ${(json.error_description ?? `HTTP ${res.status}`).split("\n")[0]}`);
    }
    this.cached = { value: json.access_token, until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 120) * 1000 };
    return json.access_token;
  }
}

/** Tokens for Ambient's own Microsoft app, per tenant, as the gateway pushes them (every 20 minutes). */
export class GraphTokens {
  private byTenant = new Map<string, { value: string; until: number }>();

  set(tenantId: string, value: string, expiresAt: number): void {
    this.byTenant.set(tenantId.toLowerCase(), { value, until: expiresAt });
  }

  /** A token still good for two minutes, or null. */
  get(tenantId: string, now = Date.now()): string | null {
    const t = this.byTenant.get(tenantId.toLowerCase());
    return t && t.until - 120_000 > now ? t.value : null;
  }
}

export const WAITING_FOR_TOKEN = "Waiting for Ambient's Microsoft access for this company (the gateway renews it every 20 minutes).";

/** A tenant's token from GraphTokens. */
export class PushedToken implements TokenSource {
  constructor(
    private tokens: GraphTokens,
    private tenantId: string,
  ) {}

  forget(): void {
    // A 401 with a fresh pushed token means access was taken away; the next push will tell.
  }

  async token(): Promise<string> {
    const t = this.tokens.get(this.tenantId);
    if (!t) throw new GraphError(503, WAITING_FOR_TOKEN);
    return t;
  }
}

/** A token someone already has (the admin's sign-in during "Connect Microsoft 365"). */
export const staticToken = (value: string): TokenSource => ({ token: async () => value, forget: () => undefined });

/** The Graph client for a team's connection: its own app, or Ambient's app through pushed tokens. */
export function graphFor(conn: MicrosoftConnection, tokens: GraphTokens, fetchImpl: typeof fetch = fetch): MicrosoftGraph {
  return conn.kind === "ambient" ? new MicrosoftGraph(new PushedToken(tokens, conn.tenant_id), fetchImpl) : new MicrosoftGraph(new ClientCredentials(conn, fetchImpl), fetchImpl);
}

export class MicrosoftGraph {
  constructor(
    private source: TokenSource,
    private fetchImpl: typeof fetch = fetch,
    private graph = GRAPH,
  ) {}

  accessToken(): Promise<string> {
    return this.source.token();
  }

  async request(method: string, path: string, init: { body?: string; contentType?: string } = {}, retry = 2): Promise<Response> {
    const res = await this.fetchImpl(path.startsWith("http") ? path : `${this.graph}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(init.contentType ? { "content-type": init.contentType } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(60_000),
    }).catch((err: Error) => {
      throw new GraphError(503, `Microsoft Graph unreachable: ${err.message}`);
    });
    if ((res.status === 429 || res.status === 503) && retry > 0) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 2, 30);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(method, path, init, retry - 1);
    }
    if (res.status === 401 && retry > 1) {
      this.source.forget();
      return this.request(method, path, init, 1);
    }
    if (!res.ok) throw new GraphError(res.status, friendly(res.status, await res.text()));
    return res;
  }

  private async item(path: string): Promise<DriveFolder> {
    const it = (await (await this.request("GET", `${path}?$select=id,name,folder,webUrl,parentReference`)).json()) as {
      id: string;
      name: string;
      folder?: unknown;
      parentReference?: { driveId?: string; path?: string };
    };
    if (!it.folder) throw new GraphError(400, `"${it.name}" is a file, not a folder.`);
    const driveId = it.parentReference?.driveId;
    if (!driveId) throw new GraphError(400, "Microsoft didn't say which drive that folder is in.");
    const parent = (it.parentReference?.path ?? "").replace(/^\/drives\/[^/]+\/root:?/, "").replace(/^\//, "");
    const where = [parent, it.name].filter(Boolean).join("/");
    let label = where;
    try {
      label = decodeURIComponent(where);
    } catch {
      // a literal "%" in a folder name: show it as it is
    }
    return { drive_id: driveId, folder_id: it.id, label: label.replace(/\//g, " / ").slice(0, 300) };
  }

  /** A folder by its IDs (checks that the app can see it). */
  folder(driveId: string, folderId: string): Promise<DriveFolder> {
    return this.item(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}`);
  }

  /**
   * A folder from what an admin pastes: a sharing link or the browser URL. Tried first as a share
   * (works when the app was granted only that folder), then by site and path.
   */
  async resolveFolder(url: string): Promise<DriveFolder> {
    const notALink = new GraphError(400, "That doesn't look like a OneDrive or SharePoint folder link.");
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      throw notALink;
    }
    if (u.protocol !== "https:" || url.length > 2000) throw notALink;
    const share = `u!${Buffer.from(url.trim()).toString("base64url")}`;
    try {
      return await this.item(`/shares/${share}/driveItem`);
    } catch (err) {
      if (!(err instanceof GraphError) || ![400, 401, 403, 404].includes(err.status)) throw err;
    }
    const idParam = u.searchParams.get("id") ?? u.searchParams.get("RootFolder");
    let parts: string[];
    try {
      parts = decodeURIComponent(idParam ?? u.pathname).split("/").filter(Boolean);
    } catch {
      throw notALink;
    }
    if (!u.hostname.endsWith(".sharepoint.com") || parts.length < 3 || !["personal", "sites", "teams"].includes(parts[0]!)) {
      throw notALink;
    }
    const site = (await (await this.request("GET", `/sites/${u.hostname}:/${segments(parts.slice(0, 2).join("/"))}?$select=id`)).json()) as { id: string };
    const drives = ((await (await this.request("GET", `/sites/${site.id}/drives?$select=id,name,webUrl`)).json()) as { value: { id: string; name: string; webUrl: string }[] }).value;
    const library = parts[2]!.toLowerCase();
    const drive = drives.find((d) => decodeURIComponent(d.webUrl).toLowerCase().replace(/\/+$/, "").endsWith(`/${library}`)) ??
      drives.find((d) => d.name.toLowerCase() === library);
    if (!drive) throw new GraphError(404, `No document library "${parts[2]}" in that site.`);
    const rest = parts.slice(3).join("/");
    return this.item(rest ? `/drives/${drive.id}/root:/${segments(rest)}:` : `/drives/${drive.id}/root`);
  }

  /** Write a text file below a folder (sub-folders are created), replacing an older version. */
  async upload(folder: { drive_id: string; folder_id: string }, relPath: string, text: string): Promise<{ id: string; webUrl: string }> {
    const res = await this.request(
      "PUT",
      `/drives/${encodeURIComponent(folder.drive_id)}/items/${encodeURIComponent(folder.folder_id)}:/${segments(relPath)}:/content?@microsoft.graph.conflictBehavior=replace`,
      { body: text, contentType: "text/markdown; charset=utf-8" },
    );
    const out = (await res.json()) as { id: string; webUrl: string };
    return { id: out.id, webUrl: out.webUrl };
  }
}
