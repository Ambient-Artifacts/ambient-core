// "Connect your agent" (docs/connect-agents.md): which AI app each connection is, the one-click
// links for every app, and installing the Claude Code plugin without copying a token by hand.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeInstall, clientKind, connectLinks } from "../src/connect-agents.ts";
import { appCall, mcpClient, signIn, startStack, type Stack } from "./helpers.ts";

describe("which AI app a connection is", () => {
  it("from the redirect URIs each app registers", () => {
    expect(clientKind("Some name", ["https://claude.ai/api/mcp/auth_callback"])).toBe("claude");
    expect(clientKind(undefined, ["https://chatgpt.com/connector_platform_oauth_redirect"])).toBe("chatgpt");
    expect(clientKind("x", ["http://localhost:8787/callback", "https://www.cursor.com/agents/mcp/oauth/callback"])).toBe("cursor");
    expect(clientKind("x", ["http://127.0.0.1:33418", "https://vscode.dev/redirect"])).toBe("vscode");
    expect(clientKind("x", ["http://127.0.0.1:33418"])).toBe("vscode");
  });

  it("from the name when the redirect is a loopback", () => {
    const loop = ["http://localhost:53123/callback"];
    expect(clientKind("Claude Code (ambient)", loop)).toBe("claude-code");
    expect(clientKind("claude-code", loop)).toBe("claude-code");
    expect(clientKind("Codex", ["http://127.0.0.1:51000/callback"])).toBe("codex");
    expect(clientKind("Cursor", loop)).toBe("cursor");
    expect(clientKind("Visual Studio Code", loop)).toBe("vscode");
    expect(clientKind("GitHub Copilot", loop)).toBe("vscode");
    expect(clientKind("ChatGPT", [])).toBe("chatgpt");
    expect(clientKind("Claude", [])).toBe("claude");
    expect(clientKind("Test MCP Client", loop)).toBe("other");
    expect(clientKind(undefined)).toBe("other");
  });
});

describe("one-click links", () => {
  const links = connectLinks("https://ambient.example/");

  it("all point at this server's /mcp", () => {
    expect(links.mcpUrl).toBe("https://ambient.example/mcp");
    for (const l of [links.claude, links.claudeAdmin]) {
      const u = new URL(l);
      expect(u.searchParams.get("modal")).toBe("add-custom-connector");
      expect(u.searchParams.get("connectorName")).toBe("Ambient");
      expect(u.searchParams.get("connectorUrl")).toBe(links.mcpUrl);
    }
    expect(new URL(links.claude).pathname).toBe("/customize/connectors");
    expect(new URL(links.claudeAdmin).pathname).toBe("/admin-settings/connectors");
  });

  it("Cursor: base64 config in its deeplink", () => {
    expect(links.cursor.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?")).toBe(true);
    const q = new URLSearchParams(links.cursor.split("?")[1]);
    expect(q.get("name")).toBe("ambient");
    expect(JSON.parse(Buffer.from(q.get("config")!, "base64").toString())).toEqual({ url: links.mcpUrl });
  });

  it("VS Code: URL-encoded JSON, directly and through vscode.dev", () => {
    expect(links.vscode.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(links.vscode.slice("vscode:mcp/install?".length)))).toEqual({ name: "ambient", type: "http", url: links.mcpUrl });
    const web = new URL(links.vscodeWeb);
    expect(web.origin + web.pathname).toBe("https://vscode.dev/redirect");
    expect(web.searchParams.get("url")).toBe(links.vscode);
  });

  it("Codex and Claude Code: commands", () => {
    expect(links.codex.command).toEqual(["codex", "mcp", "add", "ambient", "--url", "https://ambient.example/mcp"]);
    expect(links.claudeCode).toEqual({ marketplace: "Ambient-Artifacts/ambient-core", plugin: "ambient" });
    expect(claudeCodeInstall("https://ambient.example/", "pat_x")).toEqual([
      "claude", "plugin", "install", "ambient", "--marketplace", "Ambient-Artifacts/ambient-core", "--config", "token=pat_x", "--config", "server=https://ambient.example",
    ]);
  });
});

describe("the app's endpoints", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.close());

  it("connect links come from this server's address", async () => {
    const lena = await signIn(s, "apple-lena-links", "Lena Vogel");
    const r = await appCall(s, lena.access_token, "GET", "/v1/app/connect-links");
    expect(r.status).toBe(200);
    expect(r.json).toEqual(connectLinks(s.origin));
  });

  it("Claude Code: a plugin token and the install command; listed as a connection, disconnect revokes it", async () => {
    const lena = await signIn(s, "apple-lena-cc", "Lena Vogel");
    const ben = await signIn(s, "apple-ben-cc", "Ben Weiss");
    const r = await appCall(s, lena.access_token, "POST", "/v1/app/connect/claude-code", { device: "Lena's MacBook" });
    expect(r.status).toBe(200);
    const token = String(r.json.token);
    expect(r.json.server).toBe(s.origin);
    expect(r.json.command).toEqual(claudeCodeInstall(s.origin, token));

    const client = await mcpClient(`${s.origin}/mcp`, token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();

    // A plain personal token (not the plugin's) isn't listed as an AI app.
    await appCall(s, lena.access_token, "POST", "/v1/app/pats", { label: "Script" });
    const listed = (await appCall(s, lena.access_token, "GET", "/v1/app/connections")).json.connections as Record<string, unknown>[];
    expect(listed).toEqual([{ id: r.json.id, clientId: null, name: "Claude Code on Lena's MacBook", since: expect.any(Number), kind: "claude-code", via: "token", lastUsedAt: null }]);

    expect((await appCall(s, ben.access_token, "DELETE", `/v1/app/connections/${r.json.id}`)).status).toBe(404);
    expect((await appCall(s, lena.access_token, "DELETE", `/v1/app/connections/${r.json.id}`)).status).toBe(204);
    expect((await appCall(s, lena.access_token, "GET", "/v1/app/connections")).json.connections).toEqual([]);
    const after = await fetch(`${s.origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  });
});
