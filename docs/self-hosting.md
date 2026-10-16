# Self-hosting Ambient

Run the whole Ambient server on one Linux machine with Docker Compose: the MCP gateway, personal wikis, a team wiki and the jobs that keep them current. It's free and MIT licensed. You run the machine and pay for your own Claude usage.

The Ambient iPhone and Mac apps work with your server too: they record meetings and write the notes on the device, and "Use your own server" on their sign-in screen points them at it. Would you rather not run a server? [Ambient Cloud](https://ambientartifacts.si) is the same software, managed.

- [What you get](#what-you-get)
- [What you need](#what-you-need)
- [Install](#install)
- [First account and your AI apps](#first-account-and-your-ai-apps)
- [The iPhone and Mac apps](#the-iphone-and-mac-apps)
- [Teams](#teams)
- [Claude: notes, upkeep, consolidation](#claude-notes-upkeep-consolidation)
- [Wikis in your own git repo](#wikis-in-your-own-git-repo)
- [Routines](#routines)
- [Operating it](#operating-it): logs, health alerts, backups, upgrades
- [Variations](#variations): your own reverse proxy, Postgres, more teams
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

## What you get

```
                      ┌──────────────── your server (docker compose) ────────────────┐
AI apps ──HTTPS──▶ caddy ──▶ gateway ──▶ convex (database: users, teams, tokens,     │
Claude Code ──────▶  :443     :8080  │             encrypted personal pages)          │
                                     └──▶ team (one team's wiki: a git repo) ◀── team-jobs (nightly)
                              jobs: work sessions, personal upkeep, repo sync, health │
                      └───────────────────────────────────────────────────────────────┘
```

| Service | What it does |
|---|---|
| `caddy` | HTTPS for your domain, certificate from Let's Encrypt. Off with `--local` or your own proxy. |
| `gateway` | Sign-in (OAuth 2.1 for AI apps, personal access tokens), MCP at `/mcp` and `/t/<team>/mcp`, encrypted personal wikis, work-session uploads, routines, the admin CLI. |
| `jobs` | Every minute: turns uploaded work sessions into notes and delivers team copies. Every 15 minutes: personal upkeep with Claude and repo sync. Every 30 minutes: health checks. |
| `team` | One team's wiki: a git repository with search, ingest and a query API that only the gateway can call. |
| `team-jobs` | The team wiki's nightly consolidation with Claude (02:00 by default). |
| `convex` | [Convex](https://github.com/convex/convex-backend), self-hosted: the database behind the gateway. SQLite in a Docker volume by default. |
| `setup` | Runs on every `docker compose up`, then exits: deploys the database functions and registers the team server. |

**Compared with Ambient Cloud:** everything on the server side is the same code, and the apps work the same once they point at your server. What a self-hosted server doesn't have:

- **Push notifications** to the apps. They need Ambient's own Apple key.
- **Continue with Microsoft**, for now. People sign in to the apps with Apple; anyone can also be given an account with the admin CLI.
- **Claude usage included.** You bring your own Anthropic API key.

## What you need

- **A Linux server** with Docker Engine and the Compose plugin (`docker compose version` shows v2). 2 vCPUs, 4 GB RAM and 20 GB of disk are plenty for a team. Any x86-64 or ARM64 machine works.
- **A domain name** with an A (and/or AAAA) record pointing at the server, e.g. `ambient.example.com`. Use a plain DNS record, not a proxy that terminates TLS: a proxy would see note text in the clear.
- **Ports 80 and 443** reachable from the internet. AI apps like Claude and ChatGPT connect from their own servers, so `/mcp` must be public. Port 80 is only for Let's Encrypt.
- **Optional: an Anthropic API key** ([console.anthropic.com](https://console.anthropic.com)) for the parts Claude does: notes from work sessions, upkeep and consolidation. Give it a monthly spend limit. Without one, everything else works.

## Install

```sh
git clone https://github.com/Ambient-Artifacts/ambient-core.git ambient
cd ambient
ops/docker/init.sh ambient.example.com
```

`init.sh` builds the image and writes `.env` with fresh secrets: the gateway's signing key, cookie keys, the master key that wraps every user's data key, and the secret the gateway shares with the database functions. It starts Convex, saves Convex's admin key in `.env`, then starts everything else. Running it again is safe: it keeps `.env` and all data.

> **Back up `.env` now** (a password manager is a good place). Losing `BRAIN_MASTER_KEY` makes every stored personal page unreadable, and nobody can recover it.

When it's done:

```
Ambient is running at https://ambient.example.com
```

`curl https://ambient.example.com/health` answers `{"status":"ok",…}`.

**Just trying it?** `ops/docker/init.sh --local` runs it at `http://localhost:8080` without a domain or Caddy. Claude Code and personal access tokens work on that machine, but claude.ai and ChatGPT can't reach `localhost`. To move to a domain later, start over with a new `.env`: `BRAIN_ORIGIN` is the issuer of every token and is fixed once people have signed in.

## First account and your AI apps

Your server lets in only the people you add. Accounts are made with the admin CLI inside the gateway container:

```sh
docker compose exec gateway admin user add you@example.com --name "Your Name" --upkeep
```

`--upkeep` lets Claude keep this person's wiki current (it needs `ANTHROPIC_API_KEY`). Leave it out for anyone who hasn't agreed to their notes going to Anthropic. `docker compose exec gateway admin` lists all commands.

Use the email of the person's Apple ID: when they sign in from the app, that's how the server knows the account is theirs (see [the iPhone and Mac apps](#the-iphone-and-mac-apps)).

### Claude, ChatGPT and other apps with OAuth

1. Make a sign-in code (it works once, for 5 minutes):
   ```sh
   docker compose exec gateway admin connect-code you@example.com
   ```
2. **Claude** (web, desktop, mobile): Settings → Connectors → Add custom connector → `https://ambient.example.com/mcp`. **ChatGPT**: turn on developer mode and add an MCP connector with the same URL.
3. The app opens Ambient's sign-in page. Type the code and approve.

### Claude Code

The [Ambient plugin](../integrations/claude-code) gives Claude Code the MCP tools and turns each finished session into a note.

```sh
docker compose exec gateway admin token you@example.com --claude-code     # copy the ambient_pat_… line
claude plugin marketplace add Ambient-Artifacts/ambient-core
claude plugin install ambient@ambient
```

Claude Code asks for the token. Set **Ambient server** to `https://ambient.example.com` under `/plugin` → ambient → configure (it defaults to Ambient Cloud). On a machine without a terminal prompt, put `{"token":"ambient_pat_…","server":"https://ambient.example.com"}` in a file only you can read and run `claude plugin configure ambient@ambient --values-stdin < that-file`. Session notes are written by Claude, so they need `ANTHROPIC_API_KEY` on the server.

To skip session capture and use MCP alone: `claude mcp add --transport http ambient https://ambient.example.com/mcp`.

### Codex and other clients without OAuth

```sh
docker compose exec gateway admin token you@example.com
```

Send it as `Authorization: Bearer ambient_pat_…` to `https://ambient.example.com/mcp`. A token is shown once and is stored only as a hash.

## The iPhone and Mac apps

The Ambient apps sign in to your server as they do to Ambient Cloud, with Sign in with Apple. It needs an app version with **Use your own server** on its sign-in screen. After that, everything in them works against your server: recording and the notes written on the device, the wiki, teams and invites, routines, and **Settings → Connect an AI app**, so people get their own sign-in codes without asking you.

1. Add the person with their Apple ID's email: `docker compose exec gateway admin user add anna@example.com`.
2. On their iPhone or Mac, at the sign-in screen: **Use your own server**, type `ambient.example.com`, then **Continue with Apple**. The server matches the account by the email Apple confirms. Someone who hides their email from Apple is turned away with the relay address Apple gave (`…@privaterelay.appleid.com`); add that address instead.

To let people in without adding each one, allow their emails in `.env` and run `docker compose up -d`:

```sh
BRAIN_SIGNUPS=@acme.com,freelancer@gmail.com   # these emails and domains can sign up themselves
BRAIN_SIGNUPS=open                              # anyone who knows the address (not for a company server)
```

The default, `none`, lets in only the people you add. The server takes Sign in with Apple from the App Store apps' bundle id (`BRAIN_APPLE_AUDIENCES`, default `si.ambientartifacts.brain`); set it to `none` to turn Apple sign-in off, or to your bundle id if you build the apps yourself. People can switch back with **Use Ambient Cloud** while signed out. Push notifications don't reach the apps from your server.

## Teams

The compose file runs one team server, `team-1`. It waits in a pool until a team claims it, either from the app (**Settings → Teams → Create a team**, then invite people from there) or with the admin CLI:

```sh
docker compose exec gateway admin team create "Acme" --owner you@example.com
docker compose exec gateway admin user add anna@example.com --name "Anna Müller"
docker compose exec gateway admin team add acme anna@example.com              # --role admin|owner
```

- Everyone in the team reads it through their own connection: `search` and `index` cover personal and team notes, and `log_work` can write to the team.
- **A team-only connection**, for example for Microsoft 365 Copilot or a shared agent: `admin token anna@example.com --team acme`, used at `https://ambient.example.com/t/acme/mcp`. It never sees personal notes.
- **Work sessions to the team:** `admin share anna@example.com "~/git/acme-*" acme` sends Anna's Claude Code sessions from those folders to the team wiki 30 minutes after they end. A pattern can also be a repo, e.g. `github.com/acme/*`.
- **Removing someone:** `admin team remove acme anna@example.com`. Access ends within a minute.

To run more than one team, see [More teams](#more-teams).

## Claude: notes, upkeep, consolidation

Put an Anthropic API key in `.env` and restart:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env
docker compose up -d
```

| Job | Where | When | Model |
|---|---|---|---|
| Notes from Claude Code sessions | `jobs` | every minute | `BRAIN_SESSION_MODEL` (Claude Haiku) |
| Personal upkeep: living pages, overview (users with `--upkeep`) | `jobs` | every 15 minutes | `BRAIN_CONSOLIDATE_MODEL` (Claude Haiku) |
| Team consolidation: living pages, decisions, overview, lint | `team-jobs` | daily at `BRAIN_CONSOLIDATE_AT` | `BRAIN_CONSOLIDATE_MODEL` |

`TEAM_ANTHROPIC_API_KEY` gives the team server its own key and spend limit. Each nightly run writes a JSON result (pages updated, tokens, cost) to `/data/out/consolidate/` in the `team-data` volume.

## Wikis in your own git repo

A wiki can live in a repository you own (GitHub, GitLab, Bitbucket, Azure DevOps; `https://` only). Ambient keeps both sides in step: edits made in the repo come back. Give it a token that can push to that one repo, piped in on stdin so it stays out of your shell history:

```sh
docker compose exec -T gateway admin repo you@example.com https://github.com/you/wiki.git < token.txt
docker compose exec -T gateway admin team repo acme https://github.com/acme/wiki.git < token.txt
```

The repo must be empty, or already an Ambient wiki. A personal wiki syncs every 15 minutes; a team wiki pushes after every change and pulls before every write.

## Routines

A routine is a prompt that Claude Code runs on a schedule on a computer you control: Linux with systemd, Node 18+ and Claude Code signed in. People create routines from any connected AI app (`create_routine`, `run_routine`, …). To connect a computer to someone's account:

```sh
docker compose exec gateway admin computer-code you@example.com --name "Build box"
```

It prints two commands to run on that computer. The runner it downloads already points at your server.

## Operating it

**Logs:** `docker compose logs -f gateway`, `docker compose logs -f jobs team team-jobs`. Each job's output is prefixed with its name (`[sessions]`, `[personal]`, `[health]`, `[consolidate]`).

**Overview:** `docker compose exec gateway admin list` shows accounts, teams and team servers.

**Health alerts:** set `BRAIN_ALERT_WEBHOOK` to a Slack-compatible incoming webhook. The health job posts new problems, recoveries and a daily summary. Problems it watches for include work sessions that keep failing, team copies that don't get through, notes waiting too long for upkeep, failing repo syncs and an empty team server pool. That last one is expected once your only team server is claimed; it only means `admin team create` has nowhere to put a new team.

**Database dashboard:** `docker compose --profile dashboard up -d dashboard`, then open `http://127.0.0.1:6791` (over an SSH tunnel from your laptop: `ssh -L 6791:127.0.0.1:6791 -L 3210:127.0.0.1:3210 you@server`). Sign in with `CONVEX_SELF_HOSTED_ADMIN_KEY` from `.env`. Personal pages are encrypted there, as intended.

### Backups

Three things hold state. Back up all three, and keep `.env` somewhere separate from the volumes.

| What | Where | Holds |
|---|---|---|
| `.env` | the checkout | the master key and every other secret |
| `ambient_convex-data` | Docker volume | users, teams, tokens, encrypted personal pages, routines |
| `ambient_team-data` | Docker volume | the team wiki (a git repo), raw transcripts, nightly results |

A consistent copy, with a short stop:

```sh
docker compose stop
for v in convex-data team-data; do
  docker run --rm -v ambient_$v:/v:ro -v "$PWD":/backup alpine tar czf /backup/$v-$(date +%F).tgz -C /v .
done
docker compose up -d
```

To restore, recreate the volumes from those archives (the same `docker run`, with `tar xzf` into an empty volume) on a checkout with the same `.env`. A team wiki connected to your own repo also has a full copy there. Convex can export its data without stopping, too: `npx convex export` with `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210` and the admin key.

### Upgrades

```sh
git pull
docker compose up -d --build
```

`setup` deploys the new database functions before the gateway starts. Read the release notes before you pull: they say when an upgrade needs more than that.

The Convex backend image is `latest` by default. To control when it changes, pin it in `.env` (`CONVEX_BACKEND_IMAGE=ghcr.io/convex/convex-backend:<tag>`), and read [Convex's self-hosting notes](https://github.com/convex/convex-backend/tree/main/self-hosted) before you move the pin. Convex moved its images from `ghcr.io/get-convex/` to `ghcr.io/convex/` in October 2026 (the old address now refuses pulls): if your `.env` pins the old one, change it.

## Variations

### Your own reverse proxy

Set `COMPOSE_PROFILES=` (empty) in `.env` so Caddy doesn't start, and proxy your domain to `127.0.0.1:8080` (`GATEWAY_PORT`):

- Pass `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. The sign-in limits count per client address.
- Don't buffer responses: MCP and the apps' event stream (`/v1/app/events`) stream them.
- Allow request bodies up to 150 MB (`/v1/sessions` takes whole Claude Code transcripts).

If your proxy isn't on the same machine or Docker network, set `BRAIN_TRUST_PROXY` on the gateway to its address (Express's [trust proxy](https://expressjs.com/en/guide/behind-proxies.html) syntax).

### Postgres for Convex

Convex uses SQLite in its volume by default. For Postgres (version 17 is what Convex tests), create a database named after the instance (`convex_self_hosted`), then add a `docker-compose.override.yml`:

```yaml
services:
  convex:
    environment:
      POSTGRES_URL: postgres://user:password@db.example.com:5432   # no database name in the URL
      # DO_NOT_REQUIRE_SSL: "1"                                   # only for a database on the same host
```

Moving existing data takes `npx convex export` and `npx convex import`; set it up before the first sign-in if you can.

### More teams

Each team has its own team server. Add one per team in `docker-compose.override.yml`:

```yaml
services:
  team-2:
    extends: { file: docker-compose.yml, service: team }
    environment: { BRAIN_SERVER_ID: team-2 }
    volumes: [team-2-data:/data]
  team-2-jobs:
    extends: { file: docker-compose.yml, service: team-jobs }
    environment: { BRAIN_SERVER_ID: team-2 }
    volumes: [team-2-data:/data]
volumes:
  team-2-data:
```

Then `docker compose up -d` and `docker compose exec gateway admin server add team-2 http://team-2:8090`. The next `admin team create` claims it. A team server can also run on another machine. It only has to be reachable from the gateway. Start it with `node --import tsx team/src/server.ts` and the variables in [configuration.md](configuration.md#team-server), and register its URL the same way.

## Security notes

- New accounts: only people you add, or whose emails `BRAIN_SIGNUPS` allows. Anyone else with the app and your server's address is turned away.
- Only Caddy listens publicly (80 and 443). The gateway and Convex ports are bound to `127.0.0.1`, and the team server is reachable only on Docker's network.
- `.env` is written with mode 600. It holds the master key, the token signing key, and Convex's admin key, which can read and change everything in the database.
- Personal pages are encrypted with a per-user data key before they reach Convex. Those keys are wrapped by `BRAIN_MASTER_KEY`, which only the gateway and its jobs get. Team wikis are plain git on the team server's volume, by design: they're meant to be read by the team's tools.
- Tokens: OAuth access tokens are short-lived and bound to one MCP URL. Personal access tokens are stored as SHA-256 hashes. Team servers accept only 60-second tokens signed by the gateway.
- What the server sends out: requests to Anthropic (if you set a key), to your git host (if you connect a repo) and to your alert webhook. No telemetry. Convex's anonymous usage ping is off unless you set `CONVEX_DISABLE_BEACON=false`.

Found a vulnerability? See [SECURITY.md](../SECURITY.md).

## Troubleshooting

| Symptom | Look at |
|---|---|
| `init.sh` stops at "Couldn't read the Convex admin key" | `docker compose logs convex`, then run `docker compose exec convex ./generate_admin_key.sh` and put the key in `.env` in single quotes. |
| The gateway doesn't start | `docker compose logs setup gateway`. `setup` must print `[setup] done`; a missing variable is named in the error. |
| Caddy has no certificate | DNS must point at this server and ports 80/443 must be open. `docker compose logs caddy`. |
| The app says "This server only lets in people its admin added" | Add the email it names (`admin user add`), even a `…@privaterelay.appleid.com` one, or allow their domain with `BRAIN_SIGNUPS`. |
| The app says it isn't an Ambient server, or can't reach it | Type the address the way people open it in a browser (`ambient.example.com`); `curl https://ambient.example.com/health` must answer `"service":"brain-gateway"`. |
| An AI app says the sign-in failed | Codes work once, for 5 minutes, and ten wrong codes from one address lock it for a while. Make a new one with `admin connect-code`. |
| `admin team create` says there's no free team server | The pool is empty: add a team server ([More teams](#more-teams)). |
| Team notes don't show up | `log_work` and shared work sessions reach the team wiki after a 30-minute hold. Then check `docker compose logs jobs team`. |
| Session notes never appear | `ANTHROPIC_API_KEY` set? `docker compose logs jobs \| grep sessions`. The plugin logs to `~/.claude/plugins/data/ambient-ambient/capture.log`. |

Still stuck? Open an issue with the output of `docker compose ps` and the relevant logs. Remove secrets and note text first.
