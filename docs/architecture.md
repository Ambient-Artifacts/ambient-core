# Architecture

Ambient turns what happens at work (meetings, work sessions with AI agents, notes) into a wiki that people and agents share. This page describes the server side, which is this repository.

## The parts

```
 iPhone / Mac app ─┐                       ┌─▶ Convex: users, teams, members, tokens, OAuth rows,
 AI apps (MCP) ────┼─▶ gateway ────────────┤          encrypted personal pages and voices, routines, sessions
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
| `corrections/…` | One per correction a team member sent (team wikis): what a page said, what is true, how they know. For whoever keeps the page; never edited. |
| `people/`, `orgs/`, `projects/`, `topics/` | Living pages: the current truth on top, a dated timeline below, each line linking the note it came from. |
| `decisions/NNNN-….md` | Team decisions, numbered. |
| `overview.md`, `log.md`, `_index.md` files | Generated: what the wiki holds, every change, folder indexes. |
| `AGENTS.md` | How an AI agent should read and edit the wiki. |

**Living pages are kept current by Claude.** New notes go in as they arrive. The upkeep job folds them into the living pages it touches, files decisions, rewrites the overview, and lints for broken links, orphans, duplicates and stale pages. It runs every few minutes for personal wikis (opt-in per user) and nightly for team wikis. Each run is a set of structured model calls, not an open-ended agent, so it's cheap and its results can be checked.

**Upkeep on your computer.** Those model calls run on the person's own computer, with their Claude plan, never on a key of Ambient's. The gateway keeps the prompts, the merging and the writing; each call goes to the computer through the runner's long poll (the connection Ambient's chat uses) as a `complete` job, and the runner answers it with `claude -p --json-schema …` in an empty folder: no tools, no MCP servers, no settings (so no hooks or plugins of whoever's machine it is), no saved session, and, with a Claude plan or key from Ambient, a Claude config folder of its own (`~/ambient/.upkeep/claude-config`), so the machine's `~/.claude` is never read or written. The answer is checked against its shape at the gateway's end (`team/src/llm.ts`). Work-session notes are written the same way. Without a connected computer nothing is lost: notes wait, the worker records once how many (`personalWork.lastStatus` "waiting"), the app shows it (`GET /v1/app/me/upkeep`), and the next run with the computer connected catches up; work sessions wait without using up their attempts. The worker reaches computers through the gateway's internal routes (`/v1/internal/upkeep/*`, service secret only). Self-hosting with a key instead: `BRAIN_USE_SERVER_KEY=true` and `ANTHROPIC_API_KEY` on the core (also Ambient's chat without a computer, and a Teams bot without a key of its own). `admin sessions retry` gives work sessions that ran out of attempts another go.

## How notes get in

- **The apps** record and transcribe on the device and compile the note there: with Apple's model on the device, or with Apple's Private Cloud Compute where the person (personal recordings, on unless turned off) or the team's admin (team recordings, off unless turned on) allows it. The transcript goes to Apple's servers for that and nothing is kept there; the note records which wrote it (`compile.engine`: `fm-ondevice` or `fm-pcc`). A personal note syncs to the gateway; a team note goes to the team server's inbox through the gateway. Raw transcripts are stored encrypted for the owner; for teams, the team server keeps a copy outside git and sends one to the team's destination: `raw/` in the team repo by default, or a OneDrive or SharePoint folder (product/sources.md).
- **Claude Code** (the plugin) uploads a finished session. The gateway cuts it down to prompts, answers and one line per action, removes secrets in the formats it knows (tokens, keys, credentials in URLs, headers and connection strings, values named secret, token, password or key), keeps only that (encrypted) until Claude has written the note, then drops it. A session is split into working blocks at breaks of an hour or more. The user's folder and repo rules decide which blocks go to a team, after a 30-minute hold in which they can keep a block personal.
- **Any AI app** can call `save_note` and `log_work` (a summary of finished work). They pass the name of the project the conversation is in (`project`, or `"none"`). On a connection with a personal wiki and a team, both write to the team unless that name contains "privat"/"private"; then they stay personal, and nothing from that project goes to a team. Without a project they stay personal: only the app knows its project.
- **A correction** (`suggest_correction`): when someone sees a wrong fact from the team wiki, their AI app sends what was said, what is true and how they know, with the pages it came from. It goes to the team server right away as a note under `corrections/` (in the folder Ambient writes, for a repo another tool keeps), signed and dated; the page isn't edited. The nightly upkeep weighs it over older evidence for the claim it names, but not over a source document the page names: that conflict becomes an open question.
- **A connected git repo**: edits made in a user's or team's own repo come back into the wiki. A team connects its repo one of three ways: Ambient keeps the wiki (two-way); another tool keeps it and Ambient only reads it (read-only); or another tool keeps it and Ambient writes into one folder of it (`folder`, `ambient/` by default): its notes, work sessions and transcripts land there, each committed by the person they're from, for that tool to file. The fence is enforced on the team server (any write outside it is refused), and Ambient writes none of the wiki's own files there (log, folder indexes, upkeep).
- **The team's own pipeline**, when a team chooses that it writes its meeting notes (team settings, `notes: {by: "own"}`): a recording then brings only its transcript, sent to the team's folder, and the device writes no note for it. The pipeline writes the meeting page and puts the transcript's `id` in its front matter as `recording_id`; the app finds that page with the `recording` query and shows it on the recording. Work sessions and corrections are filed as usual.

Every commit the team server makes for a person (their note, recording or saved work) has that person as its author and names them in the message (`ingest: Kickoff (a1b2c3) by Lena Vogel`); Ambient's own upkeep commits as Ambient Bot. The name comes from the person's account through the gateway, never from the device.

**Voices.** The apps learn a person's voice on the device as a fingerprint: a speaker embedding (numbers, never audio). The app stores it with the gateway (`PUT /v1/app/me/voice`); the person's other devices fetch it, and so does every active member of each team they're in (`GET /v1/app/teams/<team>/voices`), so any member's app can name them in a recording. Speakers are matched on the device; the server only keeps fingerprints and hands them out. Someone who leaves or is removed drops out of the team's list at once; deleting the account, or `forget_my_voice`, deletes the fingerprint.

## How agents read it

The MCP server is at `/mcp` (personal and team, for one person) and `/t/<team>/mcp` (that team only). Its tools are `index`, `search`, `fetch`, `brief`, `get_entity`, `list_recent`, `list_decisions`, `list_action_items` and `transcript`, plus `save_note`, `log_work`, `suggest_correction`, the routine tools, the settings tools (`get_settings`, `change_team_settings`, `change_preferences`, `forget_my_voice`) and the account tools (`connect_computer`, `remove_computer`, `create_team`, `join_team`, `team_people`, `update_profile`, `set_session_rules`, `connect_microsoft`; `gateway/src/mcp/account-tools.ts`). What the app can change, an AI app can change for its user: the app's routes and the tools call the same functions (`team-admin.ts` for settings, `people.ts` for teams, their people and the person's profile, `RoutineService` for computers), with the same rules. `get_settings` also shows the person's name and about you, their computers (online, Claude signed in), where their work sessions go and whether their brain is kept current. Only in the app, on purpose: tokens, keys and secrets' values (never through a chat), recording, and deleting the account. Results carry stable ids (`personal:people/anna-mueller`, `team:acme:decisions/0001-…`) and `ambient://` links.

## Identity and tokens

| Who | How they sign in | What they get |
|---|---|---|
| AI apps (Claude, ChatGPT, …) | OAuth 2.1 through [`oidc-provider`](https://github.com/panva/node-oidc-provider): dynamic client registration, PKCE, resource indicators. The person proves who they are with a one-time code from the app or the admin CLI. | An access token bound to one MCP URL, plus a refresh token. |
| Clients without OAuth | A personal access token (`ambient_pat_…`), made in the app or with `admin token`. Stored as a SHA-256 hash. | The scopes it was made with, on one MCP URL. |
| The iPhone and Mac apps | Sign in with Apple, Microsoft or Google, against Ambient Cloud or the server set with "Use your own server". The ID token is checked, then the app gets tokens from the same OAuth server. A self-hosted server makes new accounts only for people its admin added (matched by the email Apple confirms) or allowed (`BRAIN_SIGNUPS`). | DPoP-bound tokens (RFC 9449): useless without the device's key. A sign-in lasts 180 days. |
| Routine runners | A one-time setup code, exchanged for the computer's own token. | Their routines, nothing else. |
| Team servers | They don't sign in: the gateway sends each request with a 60-second ES256 token for that team (`aud team:<id>`) and one purpose (`query`, `inbox`, `repo`, `claim`). | |

Scopes are `personal:read`, `personal:write`, `team:read`, `team:write` and `sessions:write`. Team membership is checked on every request (cached for up to a minute), so removing someone takes effect within a minute.

## Encryption

- Each user has a **data key**. Personal pages, transcripts, voice fingerprints, repo tokens, routine prompts, results and secrets are sealed with it (AES-256-GCM, bound to the user and the path) before they're stored in Convex.
- Data keys are wrapped by the **master key** (`BRAIN_MASTER_KEY`), which only the gateway and its jobs hold. A team's routine key is wrapped the same way.
- So Convex, its backups and anyone with only database access see ciphertext. The gateway decrypts in memory to serve MCP and sync.
- Team wikis are plain git on the team's own server, readable by the team's tools by design. In Ambient Cloud, each team server is a separate VM that only the gateway can reach.

## One team per person

A person is in one team at most (besides their personal space): the apps switch between
Personal and that team, and Settings has one team's page. Creating a team or joining one while
in another answers `409 one_team` with what to do (leave it first, on its page); joining one's own
team again is fine. `admin team create` refuses it too. Checked in Convex (`teams.teamOfUser`).

## A team on its own computer

Ambient's own servers don't host new teams: a team runs on a computer of its own, a Linux server its owner or an admin connects with the same one-line command as a personal computer (`POST /v1/app/computers` with `team`). Creating a team never waits for a server: it starts with none (`server: "none"` in the apps), its people can join, and its brain switches on once the computer is there.

- **What runs there.** The team server (the team's wiki in git, its search index, delivery to OneDrive or a repo) as one file, `ambient-team.mjs`: the gateway builds it from this checkout with esbuild (`gateway/src/team-bundle.ts`, Node's own SQLite in place of better-sqlite3, so the computer needs Node 22.13 or newer) and serves it at `/runner/ambient-team.mjs`. The team computer's sync names it with its sha256 (`teamBrain`); the runner fetches it, checks the checksum, and runs it as the routine user on **127.0.0.1 only** (`ambient-team.service`, data in `/var/lib/ambient-team`, a secret of its own for what it seals). Its nightly upkeep (`ambient-team-upkeep.timer`) runs `consolidate` with the computer's Claude (`claudeCodeLlm`, the runner's isolated Claude settings). The team's bots run there too.
- **How the gateway reaches it.** Not over the internet: through the runner's long poll, the connection Ambient's chat and upkeep already use (`gateway/src/relay.ts`). Once the runner says the brain answers (`info.teamBrain.ok`), the team's address becomes `computer://<hostId>`; `TeamLink` fetches it like any team server, and the request goes to the computer as an `http` job, which the runner passes to 127.0.0.1 and answers with the response as is (`POST /v1/host/relay/:jobId`). The worker relays through the gateway (`/v1/internal/relay`, service secret only). So the computer needs no domain, no open port and no certificate, and can sit behind NAT; the team server still checks the gateway's signed token on every request.
- **Never a hosted team's.** A team with a server of Ambient's keeps it; a computer only takes a team without one (`teams.setComputerServer`). Ambient's pool of hosted servers is still there for self-hosting (`BRAIN_TEAM_POOL=true`); without it, an empty pool isn't a problem.
- **When the computer is off,** the team's brain is unreachable: reads fail with the team server unavailable, and notes queue on the phones as they do for a restarting server. The health check notes it without alerting; it's the team's to see in the app.

## Deployments

| | Ambient Cloud | Self-hosted |
|---|---|---|
| Gateway | Hetzner VMs in Germany, behind Caddy ([ops/README.md](../ops/README.md)) | A container (`docker-compose.yml`) |
| Convex | Convex Cloud, EU (Dublin) | The open-source Convex backend, in a container |
| Team servers | One VM per team, from a pool | A container per team, from the same pool mechanism |
| Scheduled jobs | systemd timers (`ops/systemd/`) | `ops/docker/jobs.mjs` |

The code is the same in both. See [self-hosting.md](self-hosting.md) and [configuration.md](configuration.md).
