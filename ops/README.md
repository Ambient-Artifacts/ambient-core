# Running Ambient Cloud

How we run Ambient Cloud. **Self-hosting? Follow [docs/self-hosting.md](../docs/self-hosting.md)** instead: Docker Compose on one machine, no Hetzner, Convex or Apple accounts needed. This runbook is for the managed setup, and for anyone who wants the same layout.

One **core VM** (gateway: sign-in, OAuth for AI apps, MCP, encrypted sync) and one **team VM per beta team** (team wiki, inbox, query API, nightly consolidation), all on Hetzner Cloud in Germany. Convex (EU, Dublin) is the database behind the gateway and only ever holds encrypted note text.

```
iPhone ──▶ https://mcp.<domain> (core VM: Caddy → gateway :8080) ──▶ Convex (EU)
AI apps ─▶        same                                            ──▶ https://t-<team>.<domain> (team VM: Caddy → team :8090)
```

## What you need first
- **Hetzner Cloud:** a project, the `hcloud` CLI logged in, and SSH keys uploaded (`HCLOUD_SSH_KEY="<name> [<name>…]"`).
  - `provision.sh` tries the 2 vCPU / 4 GB types cheapest-first: `cx23` (Intel, €5.49, often sold out in 2026), then `cax11` (Arm, €5.99), then `cpx22` (AMD, €19.49).
  - Add €0.50/month for the primary IPv4 and 20% of the server price for daily backups (prices excl. VAT, June 2026).
- **Domain:** DNS you control for `mcp.<domain>` and `t-<team>.<domain>`. Use plain A records, not a proxy: a proxy would see decrypted traffic.
- **Convex:** a project created in the **EU region**. Deploy the functions and set the shared secret:
  ```sh
  cd control
  npx convex deploy                     # with CONVEX_DEPLOY_KEY for prod
  npx convex env set BRAIN_SERVICE_SECRET <value from gen-secrets>
  ```
- **Apple:** an App ID with Sign in with Apple enabled. Its bundle id goes into `BRAIN_APPLE_AUDIENCES`.
  - To revoke a deleted account's Apple token (App Store 5.1.1(v)): a Sign in with Apple key (Certificates, Identifiers & Profiles → Keys, with Sign in with Apple for that App ID). Add to `gateway.env`: `BRAIN_APPLE_TEAM_ID`, `BRAIN_APPLE_KEY_ID`, `BRAIN_APPLE_PRIVATE_KEY` (the .p8's text on one line, newlines as `\n`, in single quotes: systemd drops the backslash of an unquoted `\n`), and `BRAIN_APPLE_CLIENT_ID` if it isn't the first bundle id in `BRAIN_APPLE_AUDIENCES`. Without them, deleting an account still deletes everything; only the revocation is skipped (logged as `apple skipped`).
  - For push notifications to the apps (first: a routine run failed): an APNs key (Keys → Apple Push Notifications service; one key serves sandbox and production, and can be the Sign in with Apple key if both are ticked) and Push Notifications on the App ID. Add to `gateway.env`: `BRAIN_APNS_KEY_ID` and `BRAIN_APNS_PRIVATE_KEY` (the .p8's text on one line, newlines as `\n`, in single quotes like the other key); `BRAIN_APNS_TEAM_ID` only if it isn't `BRAIN_APPLE_TEAM_ID`, and `BRAIN_APNS_TOPIC` only if the apps' bundle id isn't the first in `BRAIN_APPLE_AUDIENCES`. One way, on the server: `printf "BRAIN_APNS_PRIVATE_KEY='%s'\n" "$(awk '{printf "%s\\n", $0}' AuthKey_XXXX.p8)" >> /etc/brain/gateway.env`. The gateway logs at start whether push is on; without the key nothing is pushed, and Apple's refusals show in the log as `[push]`.
- **Sign in with Microsoft (optional):** an app registration in Ambient's Microsoft Entra tenant (portal.azure.com → App registrations → New registration): supported account types "Accounts in any organizational directory and personal Microsoft accounts"; then Authentication → Add a platform → iOS / macOS with the bundle id (`si.ambientartifacts.brain`), which gives the redirect URI `msauth.si.ambientartifacts.brain://auth`. No client secret: the apps are public clients with PKCE. API permissions: Microsoft Graph `openid`, `profile`, `email`. Add the registration's Application (client) ID to `gateway.env` as `BRAIN_MICROSOFT_CLIENT_IDS`; the apps show "Continue with Microsoft" once `/v1/app/config` serves it. A verified publisher (Partner Center) removes the "unverified" note on Microsoft's consent screen. A Microsoft sign-in is its own account, not joined to an Apple one with the same email.
- **App versions (optional):** `BRAIN_MIN_APP_VERSION` (e.g. `0.2.0`) makes older apps ask for an update before they go on, pointing at `BRAIN_APP_UPDATE_URL` (the TestFlight or App Store link). Served at `GET /v1/app/config`.
- **Anthropic:** for each beta team, one workspace in the Console with a monthly spend limit, and one API key from that workspace.
- **Alerts (optional):** a Slack incoming webhook URL.

## 1. Secrets
```sh
umask 077; node ops/gen-secrets.mjs > ~/ambient-gateway.env   # outside the checkout; keep a copy in the password manager
```
Never write it into the checkout: anything there could be committed or copied to a VM by mistake (deploy.sh ships only what git tracks, as a second line of defence).
**Losing `BRAIN_MASTER_KEY` makes every stored personal page unreadable.** Back it up before the first user signs in.

## 2. Core VM
```sh
ops/provision.sh core main               # prints the IP
# DNS: mcp.<domain> A <ip>
ssh root@<ip> cloud-init status --wait
scp gateway.env root@<ip>:/etc/brain/gateway.env      # with BRAIN_ORIGIN, CONVEX_URL, BRAIN_APPLE_AUDIENCES filled in
ssh root@<ip> 'echo BRAIN_HOST=mcp.<domain> > /etc/brain/host.env; chown root:brain /etc/brain/*.env; chmod 640 /etc/brain/*.env'
ssh root@<ip> 'echo BRAIN_ALERT_WEBHOOK=https://hooks.slack.com/... > /etc/brain/alert.env'   # optional
ops/deploy.sh core root@<ip>
curl https://mcp.<domain>/health
```

## 3. Teams: a pool of free servers
People create teams in the app (Settings → Teams → Create a team). Each new team takes a free
server from the pool: the gateway tells the server which team it now serves (a signed claim), the
server saves that to `/srv/brain/team.json` and restarts as the team's server. The owner then
invites people from the app. When the pool is empty, the app says "try again later" and the
health check alerts (`pool:empty`), so keep one or two servers in it.

Add a server to the pool:
```sh
ops/provision.sh team pool-1             # brain-team-pool-1, prints the IP
# DNS: t-pool-1.<domain> A <ip>
ssh root@<ip> cloud-init status --wait
ssh root@<ip> 'cat > /etc/brain/team.env' <<EOF
BRAIN_SERVER_ID=pool-1
BRAIN_GATEWAY_ISSUER=https://mcp.<domain>
ANTHROPIC_API_KEY=<key with a spend limit; the server keeps it once claimed>
BRAIN_TEAM_SECRET=<openssl rand -base64 32: seals the team repo's token in /srv/brain>
PORT=8090
EOF
ssh root@<ip> 'printf "BRAIN_HOST=t-pool-1.<domain>\nBRAIN_GATEWAY_IP=<core ip>\n" > /etc/brain/host.env; chown root:brain /etc/brain/*.env; chmod 640 /etc/brain/*.env'
ops/deploy.sh team root@<ip>
curl https://t-pool-1.<domain>/health      # {"claimed":false,"serverId":"pool-1",…}
cd control && npx convex run teams:registerServer '{"serverId":"pool-1","url":"https://t-pool-1.<domain>"}'
```
`/srv/brain/wiki` must be empty (a fresh server): the claimed team starts its wiki there.

A team set up by hand instead (no pool): `npx convex run teams:create '{"slug":"acme","name":"Acme GmbH"}'`,
then the same steps with `BRAIN_TEAM_ID=<team id>` and `BRAIN_TEAM_NAME=Acme GmbH` in place of
`BRAIN_SERVER_ID`, then `teams:setServerUrl`, and `node ops/new-invite.mjs acme` for an invite code.

## Work sessions (Claude Code and AI apps)
- **Claude Code:** members install the plugin in `integrations/claude-code` (its README has the steps). Its hook sends each finished session to `POST /v1/sessions`; the gateway cuts it down, removes secrets, and keeps only that, sealed, until the note is written.
- **`brain-sessions.timer`** (core VM, every minute) writes the notes with Claude (`ANTHROPIC_API_KEY` from `/etc/brain/personal.env`, model `BRAIN_SESSION_MODEL`, default Haiku) and sends team copies whose 30-minute hold is over. Run it by hand: `systemctl start brain-sessions`; output in `journalctl -u brain-sessions`.
- **Other AI apps** (Claude, ChatGPT, Copilot) log finished work through the MCP tool `log_work`. Team logging needs the `team:write` scope: connections made before it existed have to reconnect.
- **Health:** the check flags sessions that keep failing to summarize, uploads waiting more than 30 minutes, and team copies that don't get through.

## Routines (prompts Claude Code runs on a schedule)
- **What:** a routine is a prompt, a schedule and a folder, owned by a person or by a team. People make them in the app's Routines tab, or through the MCP tools `list_routines`, `create_routine`, `update_routine`, `run_routine`, `delete_routine` and `set_routine_secret`. A team's owners and admins change its routines and secrets; members see them. Prompts, run results and secrets are sealed in Convex with the owner's data key (a team's key is wrapped by the master key, like a user's).
- **A person's routines** run on one of their own computers: Linux with systemd, Node 18+ and Claude Code signed in. The app's **Connect a computer** shows two commands with a one-time code (30 minutes):
  ```sh
  curl -fsSL https://mcp.<domain>/runner/ambient-runner.mjs -o ambient-runner.mjs
  sudo node ambient-runner.mjs setup ABCD-EFGH        # --user <name>, --path <dirs first on PATH>, --claude-args "<flags>"
  ```
  Before the user has an app build with Routines: `node ops/new-computer.mjs <email> "<name>"` prints a code (Apple's private-relay emails count: look the user up in Convex first).
- **A team's routines** run on the team's server, as a `routines` user with the team's Anthropic key, at most $10 per run. Set the server up once the team has it (safe to re-run):
  ```sh
  ops/routines-team-server.sh <team-slug> root@<team server ip>     # with CONVEX_DEPLOY_KEY; CLAUDE_ARGS overrides the run flags
  ```
  It installs Claude Code, gh, python3-pil and webp, makes git sign in to GitHub through gh (a `GH_TOKEN` secret is then all a routine needs to push), copies `ANTHROPIC_API_KEY` from `/etc/brain/team.env` to `/etc/ambient-runner/extra.env`, and connects the runner as the team's server.
- **How:** `ambient-runner.timer` (every minute) asks the gateway for the computer's routines (`POST /v1/host/sync`) and writes one `ambient-routine-<id>.service` + `.timer` per routine (`OnCalendar` in the routine's time zone, no catch-up after downtime), removes deleted ones, and starts "Run now" requests. A run fetches the prompt and the owner's secrets (`POST /v1/host/routines/<id>/runs`), pipes the prompt to `claude -p --output-format stream-json` in the routine's folder (default `~/ambient-routines`) with the secrets as environment variables, and reports status, cost and Claude's last message (`POST /v1/host/runs/<runId>`). Runs stop after 3 hours. The runner's own units run as root and start Claude Code as the routine's user (`setpriv`), so a routine can't read the computer's token. The runner replaces itself when the gateway serves a newer one, but only one signed with a key in its `RUNNER_KEYS`: after changing `runner/ambient-runner.mjs`, sign it on the machine that holds the release key (`node ops/sign-runner.mjs`, key in `~/.brain-secrets/runner-signing-key.pem`, never on the gateway) and commit `runner/ambient-runner.mjs.sig`; a test fails until you do.
- **On the computer:** `journalctl -u 'ambient-routine-*' -u ambient-runner`, `node /opt/ambient-runner/ambient-runner.mjs status`, and `sudo node /opt/ambient-runner/ambient-runner.mjs uninstall` to remove it all.

## 4. Connect an AI app
In the Ambient app go to **Settings → Connect an AI app** and keep the 8-character code ready, then:

| App | How to connect |
|---|---|
| Claude (web, desktop, mobile) | Settings → Connectors → Add custom connector → `https://mcp.<domain>/mcp` |
| Claude Code | `claude mcp add --transport http brain https://mcp.<domain>/mcp` |
| ChatGPT | Developer mode → add an MCP connector with the same URL |
| Codex, others without OAuth | Create a personal token in the app (Settings → Personal tokens) and send it as `Authorization: Bearer` |
| A company's Microsoft 365 Copilot | Use the team-only URL `https://mcp.<domain>/t/<team>/mcp`; it never shows personal notes |

## A new team's first day, and the pages' shape
- **Run a team command by hand** with the nightly job's user and settings: `systemd-run --wait --pipe -p User=brain -p Group=brain -p EnvironmentFile=/etc/brain/team.env -p WorkingDirectory=/opt/brain/app /usr/bin/node --import tsx team/src/cli.ts <command>`.
- **Seed the wiki from the company's website** (once, by whoever sets the team up): `seed --domain example.com`. It reads the home page and the about, team and product pages it links to (https, public addresses only, same site), writes one note with the pages it read plus org, person and project pages marked `source: web-research`, never overwriting a page that exists, and writes the first overview.
- **Pages in their kind's sections** (person: who they are, working on, how they work, relationship, contact; project: status, what it is, key decisions, what's next; org: what they do, key people, relationship): new and updated pages get them; to rewrite every existing page now, `rewrite --all` (or `rewrite people/anna-mueller …`). About one Haiku call per page.
- **One page per person and org:** the nightly job first merges pages that are one entity twice (same full name, a first name only one person has, the same email) into the page notes are recorded by, repoints every link, and drops links to pages named after a description. The run's `dedup` check lists the merges; git history has the merged pages.

## Briefs, reminders and what apps know (core VM)
- **What apps know:** an app connecting over MCP gets who the user is (their About you and `me` page, else their page in a team wiki), a map of their wikis and when to look in Ambient, in the server's instructions. The Claude Code plugin's hooks read `GET /v1/context/start`, `/names` and `/pages` with its token.
- **`brain-digest.timer`** (hourly at :05) sends "Waiting on you" on workdays from 8 o'clock in each user's time zone (from their app), once a day, counts only; needs the APNs key. Run it by hand: `systemctl start brain-digest`.
- **The placement eval:** `npm run eval` (needs `ANTHROPIC_API_KEY`) before changing the MCP instructions or the upkeep prompts; `eval/README.md`.

## Wikis in a user's or team's own repo
- **Personal:** the user connects a repo in the app (Settings → Wiki repo). The token and sync state are stored in Convex, encrypted with the user's key. `brain-personal.timer` syncs every connected repo every 15 minutes in a throwaway clone: pages go to `wiki/`, transcripts to `raw/`, edits made in the repo come back. Sync by hand: `systemctl start brain-personal`.
- **Team:** an owner or admin connects it (Settings → Teams → <team> repo). The token stays on the team server in `/srv/brain/remote.json` (mode 600). Two ways:
  - **Ambient keeps this wiki (two-way):** the server pushes after every commit and pulls before every write.
  - **Another tool keeps it (read-only):** for a company whose own pipeline writes the wiki. The server follows the repo (fetch, reset, every few minutes as it's read) and never writes, commits or pushes; the nightly upkeep skips the team. Notes shared to it go only to the team's destinations (below): a recording's transcript when a transcript folder is set, a work session when a work log folder is set; anything else is turned away (403 to the app, kept personal for work sessions). Only for a team without notes yet: the repo's content replaces the new team's empty wiki. A Code (Read) token is enough.
  - By hand: `admin team repo <slug> <url> [--existing] [--read-only] < token.txt`.
- **Both:** only `https://` URLs to public hosts. A repo with files of its own (not an Ambient wiki, no shared history) is connected only once someone has seen what's in it: the first try answers 409 `has_content` with the file count and a few names, and the app asks; the second sends `existing: true`. Two-way, Ambient then never writes the repo's own `AGENTS.md` or `index.md` (personal: `wiki/index.md`), and keeps the folder catalogs (`_index.md`) and, for personal repos, `wiki/` and `raw/`. Failures show up in the health check.

## Team settings and destinations
- An owner or admin sets them in the app (Settings → Teams → <team> → Transcripts and work logs); see `product/sources.md` in the team wiki. The team server keeps them in `/srv/brain/settings.json`, mode 600; the Microsoft 365 client secret in it is sealed with `BRAIN_TEAM_SECRET` (when set) and never returned by the API.
- **Transcripts** of team recordings go to `raw/YYYY-MM/` in the team repository by default, committed (and pushed) with the note and linked as `raw:` from it, but not indexed as pages. Wikis Ambient created earlier get the `raw/` line dropped from their `.gitignore` once ("chore: track raw/ for meeting transcripts"). With a read-only repo they go nowhere until a folder is set.
- **A OneDrive or SharePoint folder** instead (and, for **work logs**, the only option): written through Microsoft Graph with the team's own Entra app, app-only. The app needs write access to that folder only: `Sites.Selected` with a `write` grant on the site, or a grant on the one folder (then enter the drive and folder IDs, since a link can't be resolved without access to the site). The files: `YYYY-MM/YYYY-MM-DD-<title>-<id6>.md`, front matter in the app's style (`meeting: {title: …, attendees: […]}`, `locale`), then `[HH:MM:SS] Speaker: text` lines; work logs have `type: "work"` and the summary as Markdown.
- Delivery goes through `/srv/brain/outbox/` and is retried every minute with backoff (1 min, 5 min, 30 min, then every 2 hours); `outbox/done/` remembers what was delivered, so a note sent twice isn't written twice. `/health` reports `delivery` (destinations, waiting, last error), and the health check alerts after three failed attempts.

## Operating it
- **Logs:** `journalctl -u brain-gateway -f` on the core VM, `journalctl -u brain-team -u brain-consolidate` on a team VM.
- **Nightly results:** one JSON per run in `/srv/brain/out/consolidate/` (status, pages updated, tokens, cost). Run it by hand with `systemctl start brain-consolidate`.
- **Team wiki:** a git repo in `/srv/brain/wiki`; every change is one commit by "Brain Bot". The server's own copy of each transcript (for the MCP `transcript` tool) is in `/srv/brain/raw`, outside git; the team's copy is in `raw/` of the repo or its chosen folder.
- **Updates:** `ops/deploy.sh <role> root@<ip>` again; it rsyncs the current checkout and restarts.
- **Restore:** Hetzner's daily backups restore the whole VM. The gateway keeps no state of its own; everything is in Convex.
- **Remove someone from a team:** the owner or an admin does it in the app (Settings → Teams → the team). By hand: `npx convex run teams:removeMember '{"slug":"acme","uid":"<user id>"}'`. Their access ends within a minute.
