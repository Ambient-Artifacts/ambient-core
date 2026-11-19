// Connecting AI apps to Ambient in one step (docs/connect-agents.md): which app an OAuth client or
// a token is, and the one-click links and commands for each app, built from this server's own
// address so a self-hosted server hands out its own.

export type AgentKind = "claude" | "claude-code" | "codex" | "cursor" | "vscode" | "chatgpt" | "other";

/** The plugin for Claude Code: a marketplace in a public repo (hooks + MCP). */
export const CLAUDE_CODE_PLUGIN = { marketplace: "Ambient-Artifacts/ambient-core", plugin: "ambient" } as const;

/**
 * Which AI app an OAuth client is, from what it registered: its redirect URIs first (they're
 * fixed per app), then its name. Loopback redirects alone don't say which app it is (Claude Code,
 * Codex and others all use them), so the name decides there.
 */
export function clientKind(name: string | undefined, redirectUris: string[] = []): AgentKind {
  const n = (name ?? "").toLowerCase();
  const hosts = redirectUris.map((u) => URL.parse(u)?.host ?? "");
  if (hosts.includes("claude.ai")) return "claude";
  if (hosts.includes("chatgpt.com") || hosts.includes("chat.openai.com")) return "chatgpt";
  if (hosts.some((h) => h === "www.cursor.com" || h === "cursor.com")) return "cursor";
  if (hosts.includes("vscode.dev") || redirectUris.some((u) => /^http:\/\/127\.0\.0\.1:33418(\/|$)/.test(u))) return "vscode";
  if (/claude[ -]?code/.test(n)) return "claude-code";
  if (/\bcodex\b/.test(n)) return "codex";
  if (/\bcursor\b/.test(n)) return "cursor";
  if (/visual studio code|\bvs ?code\b|vscode|copilot/.test(n)) return "vscode";
  if (/chatgpt|openai/.test(n)) return "chatgpt";
  if (/\bclaude\b|anthropic/.test(n)) return "claude";
  return "other";
}

export interface ConnectLinks {
  /** claude.ai's "Add custom connector" dialog, prefilled: web, Desktop, Cowork, mobile; Claude Code via sync. */
  claude: string;
  /** The same for a Team/Enterprise organisation's Owner (adds it for everyone). */
  claudeAdmin: string;
  /** Cursor's "Add to Cursor" install link. */
  cursor: string;
  /** VS Code's install link (opens VS Code). */
  vscode: string;
  /** The same through vscode.dev, for web pages that can't link a vscode: URL. */
  vscodeWeb: string;
  mcpUrl: string;
  claudeCode: { marketplace: string; plugin: string };
  codex: { command: string[] };
}

export function connectLinks(origin: string): ConnectLinks {
  const mcpUrl = `${origin.replace(/\/+$/, "")}/mcp`;
  const prefill = `modal=add-custom-connector&connectorName=Ambient&connectorUrl=${encodeURIComponent(mcpUrl)}`;
  const vscodeConfig = encodeURIComponent(JSON.stringify({ name: "ambient", type: "http", url: mcpUrl }));
  const vscode = `vscode:mcp/install?${vscodeConfig}`;
  return {
    claude: `https://claude.ai/customize/connectors?${prefill}`,
    claudeAdmin: `https://claude.ai/admin-settings/connectors?${prefill}`,
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=ambient&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url: mcpUrl })).toString("base64"))}`,
    vscode,
    vscodeWeb: `https://vscode.dev/redirect?url=${encodeURIComponent(vscode)}`,
    mcpUrl,
    claudeCode: { ...CLAUDE_CODE_PLUGIN },
    codex: { command: ["codex", "mcp", "add", "ambient", "--url", mcpUrl] },
  };
}

/**
 * The command that installs the Claude Code plugin with its token and server filled in, as an
 * argument list (the Mac app runs it without a shell, so nothing in it is interpreted).
 */
export function claudeCodeInstall(origin: string, token: string): string[] {
  return ["claude", "plugin", "install", CLAUDE_CODE_PLUGIN.plugin, "--marketplace", CLAUDE_CODE_PLUGIN.marketplace, "--config", `token=${token}`, "--config", `server=${origin.replace(/\/+$/, "")}`];
}
