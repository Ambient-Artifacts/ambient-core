# Configuration

Every setting is an environment variable. With Docker Compose they come from `.env` ([.env.example](../.env.example) has them all), and each service gets only the ones it needs. On a plain VM with systemd, they live in `/etc/brain/*.env` ([ops/README.md](../ops/README.md)).

`node ops/gen-secrets.mjs` prints a fresh set of the gateway's secrets.

## Gateway

The gateway (`gateway/src/server.ts`) and its jobs (`gateway/src/worker/cli.ts`) read the same variables.

| Variable | Default | |
|---|---|---|
| `BRAIN_ORIGIN` | required | Public URL without a trailing slash, e.g. `https://ambient.example.com`. It's also the issuer of every token, so don't change it once people have signed in. |
| `CONVEX_URL` | required | The Convex deployment, e.g. `http://convex:3210` (self-hosted) or `https://<name>.convex.cloud`. |
| `BRAIN_SERVICE_SECRET` | required | At least 32 characters, shared with the Convex functions (set there too: `npx convex env set BRAIN_SERVICE_SECRET`). Every call to Convex carries it. |
| `BRAIN_MASTER_KEY` | required | 32 random bytes, base64. Wraps every user's and team's data key. **Losing it makes stored personal pages unreadable.** |
| `BRAIN_MASTER_KEY_ID` | `mk1` | Label stored with each wrapped key. |
| `BRAIN_SIGNING_JWKS` | required | `{"keys":[…]}` with private ES256 JWKs. The first one signs; the public halves are served at `/oauth/jwks`. To rotate, put a new key first and keep the old one until its tokens have expired. |
| `BRAIN_COOKIE_KEYS` | required | Comma-separated secrets for the sign-in cookies. Rotate by prepending. |
| `BRAIN_ACCESS_TOKEN_TTL` | `3600` | Seconds an OAuth access token lives. |
| `BRAIN_DIRECTORY_TTL_MS` | `60000` | How long membership is cached: a removed member loses access within this. |
| `PORT` | `8080` | |
| `BRAIN_LISTEN_HOST` | `127.0.0.1` | `0.0.0.0` in the Docker image. |
| `BRAIN_TRUST_PROXY` | `loopback` | Which proxies' `X-Forwarded-For` to believe, in Express's [trust proxy](https://expressjs.com/en/guide/behind-proxies.html) syntax. The compose file sets `loopback, uniquelocal`. |

**Sign-in from the iPhone and Mac apps:**

| Variable | |
|---|---|
| `BRAIN_APPLE_AUDIENCES` | Comma-separated bundle ids accepted from Sign in with Apple. The compose file defaults to the App Store apps' `si.ambientartifacts.brain`; `none` turns Apple sign-in off. |
| `BRAIN_SIGNIN_NONCE` | `required`: Apple and Microsoft sign-ins must carry a nonce this server issued (`GET /v1/app/sign-in-nonce`), so an ID token the app gave some other server can't be replayed here. Turn it on once every app in use sends one (`BRAIN_MIN_APP_VERSION`); until then tokens without a nonce are taken, and a nonce from another server is always refused. |
| `BRAIN_SIGNUPS` | Who may make an account by signing in from the apps. Unset or `open`: anyone (Ambient Cloud); a server you run yourself outside the compose file should set it, since unset means open (the gateway says so in its log at start). `none` (the compose default): only people added with `admin user add`, matched by the email Apple confirms. Or a list of emails and domains, e.g. `@acme.com,anna@gmail.com`. New Microsoft accounts need `open`: Microsoft doesn't vouch for emails in every tenant. |
| `BRAIN_ADMIN_CODES` | `true`: the AI-app sign-in page also says the server's admin hands out codes (`admin connect-code`). Set in the compose file. |
| `BRAIN_APPLE_TEAM_ID`, `BRAIN_APPLE_KEY_ID`, `BRAIN_APPLE_PRIVATE_KEY`, `BRAIN_APPLE_CLIENT_ID` | A Sign in with Apple key, to revoke a deleted account's Apple token. The private key is the `.p8` text on one line with `\n` for newlines. |
| `BRAIN_MICROSOFT_CLIENT_IDS` | Microsoft Entra app registration ids for "Continue with Microsoft"; the first is the one the apps use. |
| `BRAIN_APNS_KEY_ID`, `BRAIN_APNS_PRIVATE_KEY`, `BRAIN_APNS_TEAM_ID`, `BRAIN_APNS_TOPIC` | An APNs key for push notifications. Team id defaults to `BRAIN_APPLE_TEAM_ID`, topic to the first bundle id. |
| `BRAIN_MIN_APP_VERSION`, `BRAIN_APP_UPDATE_URL` | Older apps are asked to update, pointing at this link. |

**Jobs** (work sessions, personal upkeep, repo sync, health):

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Claude writes notes from work sessions and keeps opted-in personal wikis current. Without it, those jobs skip and say so. |
| `BRAIN_SESSION_MODEL` | `claude-haiku-4-5` | Model for work-session notes. |
| `BRAIN_CONSOLIDATE_MODEL` | `claude-haiku-4-5` | Model for personal upkeep and overviews. |
| `BRAIN_ALERT_WEBHOOK` | none | Slack-compatible incoming webhook for health alerts. |
| `BRAIN_HEALTH_STATE` | `/var/lib/brain-health/state.json` | Which problems are open, so each is posted once. |
| `BRAIN_HEALTH_GATEWAY_URL` | `http://127.0.0.1:$PORT` | Where the health job finds the gateway. |
| `BRAIN_HEALTH_DAILY_AT` | `08:25` | Docker only (`ops/docker/jobs.mjs`): the daily summary, in `TZ`. |

## Team server

`team/src/server.ts` and its nightly job `team/src/cli.ts consolidate`.

| Variable | Default | |
|---|---|---|
| `BRAIN_SERVER_ID` | | A pool server's id: it waits until the gateway assigns it a team (`admin team create`), saves that to `team.json` and restarts as that team's server. |
| `BRAIN_TEAM_ID`, `BRAIN_TEAM_NAME` | | Instead of `BRAIN_SERVER_ID`: a server set up by hand for one team (its Convex id). |
| `BRAIN_GATEWAY_ISSUER` | required | The gateway's `BRAIN_ORIGIN`. Only tokens it signed are accepted. |
| `BRAIN_GATEWAY_JWKS` | `$BRAIN_GATEWAY_ISSUER/oauth/jwks` | Where to fetch the gateway's public keys. The compose file uses the internal `http://gateway:8080/oauth/jwks`. |
| `BRAIN_DATA_DIR` | `/srv/brain` (`/data` in Docker) | `wiki/` (the git repo), `raw/` (transcripts, outside git), `out/` (job results), `team.json`, `remote.json`. |
| `PORT` | `8090` | |
| `BRAIN_LISTEN_HOST` | `127.0.0.1` | `0.0.0.0` in the Docker image. |
| `ANTHROPIC_API_KEY` | none | For the nightly consolidation. In Docker: `TEAM_ANTHROPIC_API_KEY`, or else `ANTHROPIC_API_KEY`. |
| `BRAIN_TEAM_SECRET` | none | Seals the team repo's access token in `remote.json`, so a backup or copy of the data directory alone holds no usable token. Any long random string (`openssl rand -base64 32`); keep it in the env file, not the data directory. In Docker: `TEAM_SECRET`, which `init.sh` generates. A token saved before it was set is sealed the next time the server starts. |
| `BRAIN_CONSOLIDATE_MODEL` | `claude-haiku-4-5` | |
| `BRAIN_CONSOLIDATE_AT` | `02:00` | Docker only: when the nightly job runs, in `TZ`. |

## Convex functions

| Variable | |
|---|---|
| `BRAIN_SERVICE_SECRET` | The same value as the gateway's. Docker's `setup` service sets it on every start. |

## Docker Compose

| Variable | Default | |
|---|---|---|
| `BRAIN_DOMAIN` | | The name Caddy gets a certificate for. |
| `COMPOSE_PROFILES` | `caddy` | Empty: no Caddy, bring your own proxy. Add `dashboard` for Convex's dashboard. |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | | From `docker compose exec convex ./generate_admin_key.sh`, in single quotes (it contains `\|`). `setup` deploys the functions with it. |
| `TEAM_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | The team server's own key. |
| `TZ` | `UTC` | For `BRAIN_CONSOLIDATE_AT` and `BRAIN_HEALTH_DAILY_AT`. |
| `GATEWAY_PORT`, `CONVEX_PORT`, `DASHBOARD_PORT` | `8080`, `3210`, `6791` | Published on `127.0.0.1` only. |
| `AMBIENT_IMAGE` | `ambient-platform:local` | Built from the checkout. |
| `CONVEX_BACKEND_IMAGE`, `CONVEX_DASHBOARD_IMAGE` | `ghcr.io/convex/…:latest` | Pin a tag to control upgrades. |
| `CONVEX_INSTANCE_NAME` | `convex-self-hosted` | Also the Postgres database name, with `-` as `_`. |
| `CONVEX_DISABLE_BEACON` | `true` | Convex's anonymous usage ping. |
| `CONVEX_DOCUMENT_RETENTION_DELAY` | `172800` | Seconds Convex keeps old document versions. |

## Routine runner

`runner/ambient-runner.mjs setup <code>` writes `/etc/ambient-runner/runner.env`. Variables there or in the environment override it:

| Variable | Default | |
|---|---|---|
| `AMBIENT_SERVER` | the server it was downloaded from | |
| `AMBIENT_HOST_TOKEN` | set by `setup` | The computer's own token. |
| `AMBIENT_USER` | `root` | The user routines run as (`setup --user`). |
| `AMBIENT_CLAUDE`, `AMBIENT_CLAUDE_ARGS` | `claude`, `--permission-mode auto` | How Claude Code is started (`setup --claude-args`). |
| `AMBIENT_FOLDER` | `~/ambient-routines` | Where routines run unless they name a folder. |

## Claude Code plugin

`token` and `server` (default `https://mcp.ambientartifacts.si`) under `/plugin` → ambient → configure, or `AMBIENT_TOKEN` and `AMBIENT_SERVER` in the environment. See [integrations/claude-code](../integrations/claude-code).
