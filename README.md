<p align="center">
  <img src="docs/images/hero.png" alt="Ambient: every agent knows what your team knows" width="100%">
</p>

# Ambient

**A shared memory for the people and AI agents in a company.** Meetings, work sessions and notes become a wiki that stays current on its own, and every AI app your team uses (Claude, ChatGPT, Microsoft Copilot, Claude Code, Codex) reads and writes it over MCP.

[Ambient Cloud](https://ambientartifacts.si) · [Self-host](docs/self-hosting.md) · [Architecture](docs/architecture.md) · [Configuration](docs/configuration.md) · [Security](SECURITY.md)

[![CI](https://github.com/Ambient-Artifacts/ambient-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Ambient-Artifacts/ambient-core/actions/workflows/ci.yml)
[![Self-host](https://github.com/Ambient-Artifacts/ambient-core/actions/workflows/self-host.yml/badge.svg)](https://github.com/Ambient-Artifacts/ambient-core/actions/workflows/self-host.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)

> [!TIP]
> **Rather not run servers?** [Ambient Cloud](https://www.ambientartifacts.si) is Ambient hosted for you, in the EU: nothing to install on a server or keep online, and the iPhone and Mac apps record your meetings. We're letting teams in one at a time; [book a 15-minute call](https://www.ambientartifacts.si/book) and we'll set it up together.

Agents are only as good as their context. Every agent in a company should know what the other agents and the people did and decided, and a company wiki only works if something keeps it current. Ambient does both: it turns what happens at work into wiki pages (people, projects, topics, decisions), keeps them up to date with Claude, and serves them to any AI app over MCP.

This repository is Ambient's server: the MCP gateway, the personal and team wikis, the Claude Code plugin and the routine runner. The iPhone and Mac apps that record meetings are separate.

## ✨ Features

- **One MCP server for every AI app.** OAuth 2.1 with dynamic client registration for Claude, ChatGPT and other MCP clients; personal access tokens for the rest. Tools: `index`, `search`, `fetch`, `brief`, `get_entity`, `list_recent`, `list_decisions`, `list_action_items`, `transcript`, `save_note` and `log_work`.
- **Personal wikis, encrypted at rest.** Each user's pages are sealed with their own data key (AES-256-GCM) before they reach the database. The key that wraps those keys never leaves the gateway.
- **Team wikis in git.** Each team's wiki is a git repository on the team's own server: plain markdown with front matter, one commit per change. Connect your own GitHub or GitLab repo and the wiki stays in step with it, both ways.
- **Work sessions become notes.** The [Claude Code plugin](integrations/claude-code) sends finished sessions; the gateway cuts them down, strips anything that looks like a secret, and Claude writes a short note. Folder rules route sessions to a team after a 30-minute hold.
- **Wikis that keep themselves current.** Every night Claude folds the day's notes into the living pages (people, projects, topics), files decisions and writes an overview. It also checks for broken links, orphans and stale pages.
- **Routines.** Prompts that Claude Code runs on a schedule on your own machines, with secrets, run history and live progress, managed from any AI app.
- **Search that understands German and English**: SQLite FTS5 with umlaut folding and trigram matching.

## 📦 Deploy Ambient

### Ambient Cloud

The fastest way: install the app, sign in with Apple or Microsoft, and connect your AI apps. No servers. Personal wikis are free; teams get a managed team server in Germany. See [ambientartifacts.si](https://ambientartifacts.si).

### Self-host Ambient

Run the whole server on one Linux machine with Docker. It's free and MIT licensed; you bring the machine and, for Claude's upkeep, an Anthropic API key.

```sh
git clone https://github.com/Ambient-Artifacts/ambient-core.git ambient && cd ambient
ops/docker/init.sh ambient.example.com      # or --local to try it at http://localhost:8080
docker compose exec gateway admin user add you@example.com --name "Your Name"
docker compose exec gateway admin connect-code you@example.com
```

Then add `https://ambient.example.com/mcp` as a connector in Claude (Settings → Connectors) and type the code. In the iPhone or Mac app, **Use your own server** on the sign-in screen connects it to your server. The [self-hosting guide](docs/self-hosting.md) covers DNS, the apps, teams, Claude Code, backups and upgrades.

|  | Ambient Cloud | Self-hosted |
|---|---|---|
| MCP for Claude, ChatGPT, Copilot, Claude Code, Codex | ✓ | ✓ |
| Personal wikis (encrypted at rest) and team wikis (git) | ✓ | ✓ |
| Your own GitHub/GitLab repo as the wiki | ✓ | ✓ |
| Work-session notes, nightly upkeep, overviews | ✓, included | ✓, with your Anthropic API key |
| Routines | ✓ | ✓ |
| iPhone and Mac apps: recording, on-device transcription | ✓ | ✓, "Use your own server" at sign-in |
| Sign-in | Apple, Microsoft; anyone can sign up | Apple; only people you add or allow |
| Push notifications | ✓ | – |
| Updates, backups, monitoring | We run them | You run them |

## 🔌 Connect your AI apps

| App | How |
|---|---|
| Claude (web, desktop, mobile) | Settings → Connectors → Add custom connector → `https://<server>/mcp` |
| Claude Code | The [plugin](integrations/claude-code) (also sends finished sessions), or `claude mcp add --transport http ambient https://<server>/mcp` |
| ChatGPT | Developer mode → add an MCP connector with the same URL |
| Microsoft 365 Copilot | The team-only URL `https://<server>/t/<team>/mcp`; it never shows personal notes |
| Codex and other clients without OAuth | A personal access token as `Authorization: Bearer` |

## 🏗️ How it's built

```
AI apps ──MCP──▶ gateway ──▶ Convex (users, teams, tokens, encrypted personal pages)
iPhone/Mac ────▶    │
Claude Code ───▶    └──signed 60 s tokens──▶ team server (git wiki, search, nightly upkeep)
```

| Path | What |
|---|---|
| `gateway/` | Sign-in (OAuth 2.1 via `oidc-provider`, DPoP-bound app tokens), MCP, encrypted personal sync, work sessions, routines, the admin CLI |
| `team/` | A team's server: gateway-signed inbox and query API, ingest into a git-backed wiki, nightly consolidation with Claude |
| `control/` | Convex functions and schema: the control plane. Every call carries a service secret; clients never talk to Convex directly |
| `wiki/` | The wiki store: SQLite FTS5 search, indexes, git |
| `spec/` | Shared contracts: zod schemas, JSON Schema export for the Swift apps, fixture wikis |
| `runner/` | `ambient-runner.mjs`: runs routines on a user's computer with systemd and `claude -p`. One file, no dependencies |
| `integrations/claude-code/` | The Claude Code plugin |
| `ops/` | `docker/` for self-hosting; the rest is how we run Ambient Cloud on Hetzner ([runbook](ops/README.md)) |

More in [docs/architecture.md](docs/architecture.md).

## 🧑‍💻 Develop

Node 24.

```sh
npm install
npm test             # the gateway tests run against the real Convex functions (convex-test) and real team servers
npm run typecheck
npm run schemas      # regenerate spec/json-schema/*.json
cd control && CONVEX_AGENT_MODE=anonymous npx convex dev   # a local Convex backend, no account needed
```

## 🤝 Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it covers the setup, the tests, the three lines of "why" every change carries, and the sign-off (DCO).

## 🔒 Security and privacy

- Note text is readable only on the user's devices, in the gateway's memory and on the team's own server. Convex stores personal pages encrypted.
- Team servers accept only 60-second tokens signed by the gateway.
- An AI app's token is bound to one URL, so a token for `/t/<team>/mcp` can't read personal notes, and team membership is checked on every request.
- Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

**Telemetry:** this code sends none. Self-hosted Convex has an anonymous usage ping, which the compose file turns off (`CONVEX_DISABLE_BEACON=true`). The only outside services a self-hosted server calls are the ones you configure: Anthropic, your git host, your alert webhook.

## 🥇 License and trademarks

The code is [MIT licensed](LICENSE). The license doesn't cover the Ambient name or logo: if you run a modified version as a service for others, give it a different name.
