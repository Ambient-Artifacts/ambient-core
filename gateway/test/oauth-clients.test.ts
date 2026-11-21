// Every AI app's sign-in (docs/connect-agents.md): each registers itself (dynamic client
// registration) with the redirect URIs it really uses, and the authorization request with its
// redirect is accepted, also when a loopback client picks another port the next time (RFC 8252).
// Plain http to anything but this computer is refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pkce, startStack, type Stack } from "./helpers.ts";

let s: Stack;

beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

async function register(body: Record<string, unknown>) {
  const res = await fetch(`${s.origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...body }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Whether the authorization request goes on to sign-in (accepted) or stops at an error page. */
async function authorize(clientId: string, redirectUri: string): Promise<"accepted" | "refused"> {
  const url = new URL(`${s.origin}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "personal:read",
    state: "st",
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    resource: `${s.origin}/mcp`,
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  const where = res.headers.get("location") ?? "";
  if (res.status >= 300 && res.status < 400 && where.includes("/interaction/")) return "accepted";
  return "refused";
}

const CLIENTS: { app: string; register: Record<string, unknown>; use: string[] }[] = [
  {
    app: "Claude Code (localhost, a new port each sign-in)",
    register: { client_name: "Claude Code (ambient)", redirect_uris: ["http://localhost:53123/callback"] },
    use: ["http://localhost:53123/callback", "http://localhost:60111/callback"],
  },
  {
    app: "Claude Code (127.0.0.1, registered without a port as its metadata document declares)",
    register: { client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] },
    use: ["http://127.0.0.1:49152/callback", "http://localhost:51515/callback"],
  },
  {
    app: "claude.ai, Claude Desktop, Cowork, Claude mobile",
    register: { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
    use: ["https://claude.ai/api/mcp/auth_callback"],
  },
  {
    app: "Codex",
    register: { client_name: "Codex", redirect_uris: ["http://127.0.0.1:51000/callback"] },
    use: ["http://127.0.0.1:51000/callback", "http://127.0.0.1:62000/callback"],
  },
  {
    app: "Cursor",
    register: { client_name: "Cursor", redirect_uris: ["http://localhost:8787/callback", "https://www.cursor.com/agents/mcp/oauth/callback"] },
    use: ["http://localhost:8787/callback", "https://www.cursor.com/agents/mcp/oauth/callback"],
  },
  {
    app: "VS Code",
    register: { client_name: "Visual Studio Code", redirect_uris: ["http://127.0.0.1:33418", "https://vscode.dev/redirect"] },
    use: ["http://127.0.0.1:33418", "https://vscode.dev/redirect"],
  },
  {
    app: "ChatGPT",
    register: { client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] },
    use: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  },
];

describe("each AI app's sign-in", () => {
  for (const c of CLIENTS) {
    it(`works for ${c.app}`, async () => {
      const r = await register(c.register);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      for (const uri of c.use) expect(await authorize(String(r.json.client_id), uri), uri).toBe("accepted");
    });
  }

  it("also when a loopback client calls itself a web app", async () => {
    const r = await register({ client_name: "Some CLI", application_type: "web", redirect_uris: ["http://localhost:40000/callback"] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.application_type).toBe("native");
    expect(await authorize(String(r.json.client_id), "http://localhost:41000/callback")).toBe("accepted");
  });
});

describe("what stays refused", () => {
  it("plain http to another host, at registration", async () => {
    const r = await register({ client_name: "Evil", redirect_uris: ["http://evil.example/callback"] });
    expect(r.status).toBe(400);
    expect(String(r.json.error_description)).toContain("plain http");
    expect((await register({ client_name: "Evil", redirect_uris: ["http://localhost.evil.example/callback"] })).status).toBe(400);
  });

  it("another host or path than registered, and https on another port", async () => {
    const r = await register({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost:53123/callback"] });
    const id = String(r.json.client_id);
    expect(await authorize(id, "https://evil.example/api/mcp/auth_callback")).toBe("refused");
    expect(await authorize(id, "http://localhost:53123/other")).toBe("refused");
    expect(await authorize(id, "https://claude.ai:8443/api/mcp/auth_callback")).toBe("refused");
    expect(await authorize(id, "http://evil.example:53123/callback")).toBe("refused");
  });
});
