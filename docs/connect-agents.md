# Connect your agent

Ambient is an MCP server at `<origin>/mcp` (personal) and `<origin>/t/<team>/mcp` (a team's).
Every AI app that speaks MCP can use it. This page covers how each one connects in a single step
from the Ambient app, which sign-ins the server accepts, how the app knows what's connected, and
what's left to get Ambient listed in Anthropic's and OpenAI's directories.

The links and commands below come from the server (`GET /v1/app/connect-links`), built from its
own address, so a self-hosted server hands out its own. Nobody hard-codes `mcp.ambientartifacts.si`.

## One step per app

| App | What the Ambient app does | Then |
|---|---|---|
| **Claude** (claude.ai, Desktop, Cowork, mobile) | Opens `claude` from connect-links: claude.ai's "Add custom connector" dialog, prefilled with name and URL | **Add** → **Connect** → Ambient's sign-in. The connector lives on the Claude account, so it shows up everywhere Claude runs, Claude Code included for subscription logins. |
| **Claude** for a Team/Enterprise organisation | Opens `claudeAdmin` (same, in Admin settings) | An Owner adds it once for everyone. |
| **Claude Code** | `POST /v1/app/connect/claude-code`, then runs the returned `command` (no shell) | Installs the `ambient` plugin from the public marketplace `Ambient-Artifacts/ambient-core` with its token and server filled in. Loads on the next start or `/reload-plugins`. Hooks (context in, sessions out) plus the MCP tools. |
| **Codex** (CLI, IDE, the ChatGPT desktop app's Codex) | Runs `codex.command`: `codex mcp add ambient --url <origin>/mcp` | Codex signs in on first use (`codex mcp login ambient` to do it now). |
| **Cursor** | Opens `cursor` (`cursor://anysphere.cursor-deeplink/mcp/install?name=ambient&config=<base64 {"url":…}>`) | Cursor asks to install → sign-in. |
| **VS Code** (Copilot) | Opens `vscode` (`vscode:mcp/install?<URL-encoded {"name","type":"http","url"}>`); web pages use `vscodeWeb` (through vscode.dev/redirect) | Review → **Install** → sign-in. |
| **ChatGPT** | Shows `mcpUrl` with the steps: chatgpt.com/plugins → **+** → **Add custom MCP server** | ChatGPT has no prefill link. Adding a custom server is web-only and depends on the plan; once Ambient is in OpenAI's plugin directory this becomes open listing → **+** → connect. |

### Claude Code without copying a token

The plugin can't use OAuth (its hooks need a token too), so the Mac app asks the server for one:

```
POST /v1/app/connect/claude-code   { "device": "Lena's MacBook" }   (device optional, ≤60 chars)
→ { token, id, server, command, plugin: { marketplace, plugin } }
```

- `token` is a personal token with `personal:read personal:write team:read sessions:write`, the same
  as `POST /v1/app/pats` with `purpose: "claude-code"`. It's shown once.
- `command` is an argument list:
  `claude plugin install ambient --marketplace Ambient-Artifacts/ambient-core --config token=<token> --config server=<origin>`.
  Run it without a shell, so nothing in it is interpreted, and honour `CLAUDE_CONFIG_DIR` by passing the environment through.
- The token is listed under connections (below), and disconnecting it there revokes it.

## Sign-in: which redirect URIs are accepted

Every app registers itself (dynamic client registration) and signs in with the authorization code
flow and PKCE. These are the redirects each one really uses, all tested in
`gateway/test/oauth-clients.test.ts`:

| App | Redirect URIs |
|---|---|
| Claude Code | `http://localhost:<any port>/callback`, `http://127.0.0.1:<any port>/callback` |
| claude.ai (and Desktop, Cowork, mobile) | `https://claude.ai/api/mcp/auth_callback` |
| Codex | `http://127.0.0.1:<any port>/callback` |
| Cursor | `http://localhost:8787/callback`, `https://www.cursor.com/agents/mcp/oauth/callback` |
| VS Code | `http://127.0.0.1:33418`, `https://vscode.dev/redirect` |
| ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` |

The rules (`redirectPolicy` in `gateway/src/oauth/provider.ts`):

- **Plain http only to this computer.** `http://` redirects must be on `localhost`, `127.0.0.1` or
  `[::1]`; anything else is refused at registration. Everything else is https.
- **Loopback clients may change port** (RFC 8252 §7.3). A client with a loopback redirect is
  registered as a native app, so the port it picks for a sign-in doesn't have to match the one it
  registered. Claude Code and Codex pick a fresh port every time. Host and path still have to match.
- **Exact match everywhere else.** https redirects match exactly, port included. No wildcards.

## Connected apps

`GET /v1/app/connections` lists every app connected to the account:

```json
{ "connections": [
  { "id": "…", "clientId": "…", "name": "Claude", "since": 1763500000000, "kind": "claude", "via": "oauth", "lastUsedAt": null },
  { "id": "…", "clientId": null, "name": "Claude Code on Lena's MacBook", "since": 1763500000000, "kind": "claude-code", "via": "token", "lastUsedAt": null }
] }
```

- `kind` is one of `claude`, `claude-code`, `codex`, `cursor`, `vscode`, `chatgpt`, `other`. For
  OAuth clients it comes from the redirect URIs first (claude.ai, chatgpt.com, cursor.com,
  vscode.dev or port 33418 are unique to their app), then from the client's name, since loopback
  redirects alone don't say which app it is (`clientKind` in `gateway/src/connect-agents.ts`).
- Claude Code plugin tokens (`sessions:write`) are listed with `via: "token"`. Other personal
  tokens stay under `/v1/app/pats` only.
- `lastUsedAt` is always `null` for now: neither grants nor tokens record their last use yet.
- `DELETE /v1/app/connections/:id` revokes a grant or a plugin token.

## Directory readiness

Both directories need every tool to say what it does. Each MCP tool has a `title` and either
`readOnlyHint: true` or a `destructiveHint`, checked for a personal connection with bots, one
without, and a team-only one (`gateway/test/tool-annotations.test.ts`). A new tool without them
fails that test.

### Anthropic: Connectors Directory (for Nikolai)

Submit at **https://claude.ai/directory/manage** → **Submit new** → **MCP connector**, from a paid
Claude account (on Team/Enterprise, an Owner). Then a second submission, **Plugin bundle**, for
the Claude Code plugin from the public repo, paired with the connector so people with both see one
set of tools.

- [ ] Server URL: `https://mcp.ambientartifacts.si/mcp` (remote, https, OAuth: done)
- [ ] Every tool has a title and readOnlyHint/destructiveHint (done, tested)
- [ ] Tested as a custom connector on claude.ai (use the `claude` connect link)
- [ ] Documentation URL (a public page on how to connect and what the tools do)
- [ ] Privacy policy URL
- [ ] Support contact (email)
- [ ] Icon (square, the Ambient mark)
- [ ] Listing: name (≤100), one-liner (≤200), description (≤2,000), 1–5 categories, slug (permanent)
- [ ] Use cases (a few example prompts)
- [ ] Company details
- [ ] Authentication: dynamic registration works as is; Anthropic recommends a client ID
      metadata document (CIMD) or handing them a fixed client for high-traffic connectors (later)
- [ ] Data handling answers, Test & launch, the 7 compliance acknowledgements
- [ ] Plugin bundle: repo `Ambient-Artifacts/ambient-core`, plugin `ambient`; its MCP entry points at the same URL

After approval the permanent link is `https://claude.ai/directory/connectors/<slug>`; the app can
switch `claude` to it. Escalations: mcp-review@anthropic.com.

### OpenAI: plugin directory (ChatGPT and Codex)

Submit at **https://platform.openai.com/plugins** → **Upload new or existing plugin** → **With MCP**.
Organisation owners can submit (others need Apps Management Write).

- [ ] Identity verification (individual or business) in the organisation settings
- [ ] Server URL `https://mcp.ambientartifacts.si/mcp`, OAuth via `dcr`
- [ ] Domain verification: serve the challenge token as plain text at the URL the portal shows
- [ ] Plugin ZIP: `plugin.json` + `mcp.json` (one MCP server per plugin)
- [ ] Five positive and three negative test cases
- [ ] A video walkthrough
- [ ] Release notes
- [ ] Reviewer account that signs in without MFA, email or SMS codes, or magic links (Ambient's
      sign-in is Apple/Google + a pairing code, so this needs a dedicated review path or account)
- [ ] Website, support, privacy policy and terms of service URLs
- [ ] Policy attestations

After approval, **Publish plugin** makes it visible in ChatGPT (web, desktop, mobile) and Codex.
OpenAI rescans the server daily; tool changes go live without resubmitting.
