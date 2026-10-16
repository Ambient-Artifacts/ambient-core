# Architecture

Ambient turns what happens at work (meetings, work sessions with AI agents, notes) into a wiki that people and agents share. This page describes the server side, which is this repository.

## The parts

```
 iPhone / Mac app ─┐                       ┌─▶ Convex: users, teams, members, tokens, OAuth rows,
 AI apps (MCP) ────┼─▶ gateway ────────────┤          encrypted personal pages, routines, sessions
 Claude Code ──────┘   (one per install)   │
 routine runners ──────▶                   └─▶ team server (one per team): the team wiki in git
```

- **Gateway** (`gateway/`): the only thing clients talk to. It runs sign-in, the MCP endpoints, personal-wiki sync, work-session uploads and the routines API. It holds no state of its own beyond caches, so it can be restarted or run several times over.
- **Convex** (`control/`): the control plane and the store for personal wikis. Every function takes a service secret that only the gateway has; no client calls Convex directly. Personal page text arrives already encrypted.
- **Team server** (`team/`): one per team, on its own machine in Ambient Cloud. It holds the team wiki as a git repository, searches it, takes new notes into it and consolidates it every night. It accepts only short tokens signed by the gateway.
- **Wiki store** (`wiki/`): shared by the gateway (personal wikis, in memory) and the team server (on disk). It covers parsing, the SQLite FTS5 index (umlauts folded, trigram matching), generated index pages, lint and git.
- **Contracts** (`spec/`): zod schemas for notes, living pages, decisions, the team-note payload, sync and job results, exported as JSON Schema for the Swift apps.

## The wiki

A wiki is a folder of markdown files with YAML front matter: the same format for a person's wiki and a team's.

| Path | Kind |
|---|---|
| `notes/…` | One per recorded conversation or saved note, by date. Never rewritten once it's in. |
| `sessions/…` | One per block of work with an AI agent (team wikis). |
| `people/`, `orgs/`, `projects/`, `topics/` | Living pages: the current truth on top, a dated timeline below, each line linking the note it came from. |
| `decisions/NNNN-….md` | Team decisions, numbered. |
| `overview.md`, `log.md`, `_index.md` files | Generated: what the wiki holds, every change, folder indexes. |
| `AGENTS.md` | How an AI agent should read and edit the wiki. |

**Living pages are kept current by Claude.** New notes go in as they arrive. The upkeep job folds them into the living pages it touches, files decisions, rewrites the overview, and lints for broken links, orphans, duplicates and stale pages. It runs every few minutes for personal wikis (opt-in per user) and nightly for team wikis. Each run is a set of structured model calls, not an open-ended agent, so it's cheap and its results can be checked.

## How notes get in

- **The apps** record and transcribe on the device and compile the note there. A personal note syncs to the gateway; a team note goes to the team server's inbox through the gateway. Raw transcripts are stored encrypted for the owner and, for teams, under `raw/` outside git.
- **Claude Code** (the plugin) uploads a finished session. The gateway cuts it down to prompts, answers and one line per action, removes anything that looks like a secret, keeps only that (encrypted) until Claude has written the note, then drops it. A session is split into working blocks at breaks of an hour or more. The user's folder and repo rules decide which blocks go to a team, after a 30-minute hold in which they can keep a block personal.
- **Any AI app** can call `save_note` (personal) and `log_work` (a summary of finished work, personal or team).
- **A connected git repo**: edits made in a user's or team's own repo come back into the wiki.

## How agents read it

The MCP server is at `/mcp` (personal and team, for one person) and `/t/<team>/mcp` (that team only). Its tools are `index`, `search`, `fetch`, `brief`, `get_entity`, `list_recent`, `list_decisions`, `list_action_items` and `transcript`, plus `save_note`, `log_work` and the routine tools. Results carry stable ids (`personal:people/anna-mueller`, `team:acme:decisions/0001-…`) and `ambient://` links.

## Identity and tokens

| Who | How they sign in | What they get |
|---|---|---|
| AI apps (Claude, ChatGPT, …) | OAuth 2.1 through [`oidc-provider`](https://github.com/panva/node-oidc-provider): dynamic client registration, PKCE, resource indicators. The person proves who they are with a one-time code from the app or the admin CLI. | An access token bound to one MCP URL, plus a refresh token. |
| Clients without OAuth | A personal access token (`ambient_pat_…`), made in the app or with `admin token`. Stored as a SHA-256 hash. | The scopes it was made with, on one MCP URL. |
| The iPhone and Mac apps | Sign in with Apple or Microsoft, against Ambient Cloud or the server set with "Use your own server". The ID token is checked, then the app gets tokens from the same OAuth server. A self-hosted server makes new accounts only for people its admin added (matched by the email Apple confirms) or allowed (`BRAIN_SIGNUPS`). | DPoP-bound tokens (RFC 9449): useless without the device's key. A sign-in lasts 180 days. |
| Routine runners | A one-time setup code, exchanged for the computer's own token. | Their routines, nothing else. |
| Team servers | They don't sign in: the gateway sends each request with a 60-second ES256 token for that team (`aud team:<id>`) and one purpose (`query`, `inbox`, `repo`, `claim`). | |

Scopes are `personal:read`, `personal:write`, `team:read`, `team:write` and `sessions:write`. Team membership is checked on every request (cached for up to a minute), so removing someone takes effect within a minute.

## Encryption

- Each user has a **data key**. Personal pages, transcripts, repo tokens, routine prompts, results and secrets are sealed with it (AES-256-GCM, bound to the user and the path) before they're stored in Convex.
- Data keys are wrapped by the **master key** (`BRAIN_MASTER_KEY`), which only the gateway and its jobs hold. A team's routine key is wrapped the same way.
- So Convex, its backups and anyone with only database access see ciphertext. The gateway decrypts in memory to serve MCP and sync.
- Team wikis are plain git on the team's own server, readable by the team's tools by design. In Ambient Cloud, each team server is a separate VM that only the gateway can reach.

## Deployments

| | Ambient Cloud | Self-hosted |
|---|---|---|
| Gateway | Hetzner VMs in Germany, behind Caddy ([ops/README.md](../ops/README.md)) | A container (`docker-compose.yml`) |
| Convex | Convex Cloud, EU (Dublin) | The open-source Convex backend, in a container |
| Team servers | One VM per team, from a pool | A container per team, from the same pool mechanism |
| Scheduled jobs | systemd timers (`ops/systemd/`) | `ops/docker/jobs.mjs` |

The code is the same in both. See [self-hosting.md](self-hosting.md) and [configuration.md](configuration.md).
