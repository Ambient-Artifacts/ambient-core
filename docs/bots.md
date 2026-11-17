# Bots (first version)

Bots are loops with a face, a thread and a chat with Ambient on top. A bot is a routine with
`bot` settings: the runner starts it the same way (a systemd timer, "Run now"), and the app shows
it as a small character whose face says how it's doing. Ambient, the master bot, is a chat in the
app that answers from the brain and looks after the bots.

The first version is switched on per account and per team (`BRAIN_BOTS`; a team's people get bots of their own too); everyone else keeps
today's loops exactly as they are. Claude Code is the only runtime, behind the seams that let
others in later: a `runtime` field, the bot spec in `spec/src/bots.ts`, the runner's adapter, run
events in Ambient's own shape, and a channel interface with the app as its first channel.

## What a bot is

| Field | Values | Meaning |
|---|---|---|
| `face` | `classic`, `round`, `tall`, `wide` | The shape of its head. The colour is always its state. |
| `runtime` | `claude-code` | What runs it. Others come as runner adapters. |
| `isolation` | `container`, `host` | `container`: its own Podman container and volume (its workspace, `HOME`), only its granted secrets. `host`: like a loop today, as the computer's routine user. |
| `secrets` | names, or `null` | The secrets its runs get. `null` (loops from before): all of its owner's. |
| `report` | `news`, `every_run` | `news`: the thread gets a run's result only when it failed, asked something or said something new; `every_run`: every result. |

State, worked out by the gateway (never stored):

| State | When | Disc |
|---|---|---|
| `working` | a run is going | sand |
| `needs_you` | it asked a question nobody answered yet | sky |
| `stuck` | its last run failed | clay |
| `done` | its last run went fine | sage |
| `asleep` | paused, never ran, or no computer | stone |

## The app's API

Everything below except `GET /v1/app/features` answers `403 {"error":"bots_not_enabled"}` for
accounts and teams the gate doesn't include (features answers `{"bots": false}`). Errors are `{ "error": code, "message": sentence }` as elsewhere.

### `GET /v1/app/features`

```json
{ "bots": true }
```

### Routines carry `bot`

`GET /v1/app/routines`, `GET`/`PATCH`/`POST` of one routine: each routine has `bot` (null for a
plain loop):

```json
"bot": {
  "face": "classic",
  "runtime": "claude-code",
  "isolation": "container",
  "secrets": ["GH_TOKEN"],
  "report": "news",
  "state": "needs_you",
  "openQuestion": { "id": "…", "text": "Which repo?", "choices": ["ambient-core", "ambient-ios"], "askedAt": 1763380000000 },
  "lastMessage": { "text": "Opened PR #41 …", "kind": "result", "at": 1763380000000 }
}
```

`POST /v1/app/routines` and `PATCH /v1/app/routines/:id` take `bot` as input:
`{ "face"?, "isolation"?, "secrets"?: [names] | null, "report"? }` (all optional; `runtime` may be
sent and must be `claude-code`). Sending `bot` on a plain loop makes it a bot; `"bot": null` on
PATCH makes it a plain loop again.

### A bot's thread

`GET /v1/app/routines/:id/thread?limit=50` (newest last, up to 100):

```json
{
  "messages": [
    { "id": "…", "role": "bot", "kind": "result", "text": "Opened PR #41.", "choices": null, "runId": "…", "author": null, "createdAt": 1763380000000, "answered": null },
    { "id": "…", "role": "bot", "kind": "question", "text": "Which repo?", "choices": ["ambient-core", "ambient-ios"], "runId": "…", "author": null, "createdAt": 1763380000000, "answered": false },
    { "id": "…", "role": "user", "kind": "answer", "text": "ambient-core", "choices": null, "runId": null, "author": "Nikolai", "createdAt": 1763380000000, "answered": null }
  ],
  "openQuestion": null,
  "routine": { "...": "the bot as GET /v1/app/routines shows it, with its current state" }
}
```

Each message also has `mine` (true for what the person asking wrote).

Kinds: `result` (a run's summary), `failure` (a run failed; the text says why), `question` (the bot
asks; `answered` true or false), `answer` (someone answered a question), `message` (someone wrote
to the bot).

`POST /v1/app/routines/:id/thread` with `{ "text": "…" }`: when the bot has an open question,
this is the answer and the bot carries on with it; otherwise it's a message, and the bot starts a
run with it (continuing its last session when it has one). Answers
`{ "message": ThreadMessage, "routine": Routine }`. Only people who may change the bot write to
it (its owner; a team's owners and admins); everyone who sees it reads.

### Ambient (the master bot)

`GET /v1/app/ambient/chat`:

```json
{ "messages": [{ "id": "…", "role": "user", "text": "How are my bots?", "createdAt": 1763380000000 },
               { "id": "…", "role": "ambient", "text": "Dev opened PR #41 …", "createdAt": 1763380000000 }],
  "pending": false }
```

`POST /v1/app/ambient/chat` with `{ "text": "…" }` answers at once with
`{ "message": ChatMessage, "pending": true }`; the reply arrives in `GET` (poll every 2 seconds
while `pending`, for up to 2 minutes). `DELETE /v1/app/ambient/chat` clears the history (204).

Ambient answers with Claude and the same tools the person gets in Claude with the Ambient
connector: their brain (personal and teams), their loops and bots, and the bots' threads. It
changes a bot only when the person asked for it in the chat. When Claude can't answer, the reply
is still an `ambient` message saying so, and `pending` turns false: the app never waits for
nothing.

### Pushes

- A bot asks: title `"<name> needs you"`, the question as body,
  `url: ambient://routine/<id>?thread=1`, collapse id `bot-question-<id>`.
- A run fails: as for loops (`ambient://routine/<id>?run=<runId>`).

## The computer's side

- `POST /v1/host/routines/:id/runs` (start) additionally returns `bot` (the settings above, without
  state), `resume` (`{ "sessionId": "…" | null, "message": "…" }` when the run continues a
  conversation, else null) and `runToken` (a token for this run only).
- `POST /v1/bot/ask` (bearer: run token) with `{ "question": "…", "choices"?: [..] }` →
  `{ "id": "…" }`; `GET /v1/bot/questions/:id` (run token) → `{ "answer": "…" | null }`. The run
  token works while its run is going.
- The runner (0.6.0) gives Claude Code an `ask_owner` tool (a small stdio MCP server, the runner
  file itself: `ambient-runner bot-mcp`). It waits up to three minutes for an answer; with none,
  Claude ends the run, and the answer later starts a run that resumes the same session.
- `isolation: container`: `podman run` with the bot's own volume as `HOME`, its granted secrets,
  limits on memory, CPU and time. The image is built on the computer from the runner's
  Containerfile (Debian, Node, Claude Code, git, gh, jq, ripgrep, Python with Pillow, webp). On a
  team's server a bot also reads the team's wiki at `/srv/brain/wiki`, read-only (it joins the
  wiki's group in its container), so a loop that read the wiki keeps working as a bot.

## Ambient on a computer: the person's own, or the team's server

Ambient's chat runs on a machine with Claude Code instead of on the gateway, with Ambient's tools
and that machine's own, so it can work there when asked. The gateway picks, for each person: their
own connected computer first, then the server of a team of theirs that has bots (Ambient's machine
for the team, one session per person), then its own `ANTHROPIC_API_KEY`; with none of these the
chat says no computer is connected.

- `POST /v1/host/sync` answers `"ambient": true` for such a machine; the runner (0.7.0) then
  installs `ambient-runner-ambient.service` (`ambient-runner ambient`, restarted by systemd).
- The service keeps one Claude Code session open per person (`--input-format stream-json`, resumed
  after a restart, in `~/ambient/<account id>`) and waits on `GET /v1/host/ambient/next` (computer
  token, a 25-second long poll). A message comes as
  `{ id, uid, text, name, instructions, fresh, history, token }`; `token` is that person's token
  for Ambient's MCP (24 hours, renewed an hour before it ends, listed in the app's tokens as
  "Ambient on <computer>"). The reply goes to `POST /v1/host/ambient/:id` as `{ text }` or
  `{ error }`.
- It runs as the machine's routine user, not in a container: Ambient is meant to work on that
  machine. `set_routine_secret` is left out; secrets go in through the app.
- Its Claude sign-in is the machine's (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in
  `/etc/ambient-runner/extra.env`), or a plan of its own: `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token` in `/etc/ambient-runner/ambient.env`, which then wins over the API key.
- Every run (a bot's, a loop's, Ambient's) uses a Claude plan's `CLAUDE_CODE_OAUTH_TOKEN` over
  `ANTHROPIC_API_KEY` when the computer has both (runner 0.7.2); in `extra.env` it signs in the
  team's bots and Ambient alike.

## Whose Claude a computer uses

Each computer (a person's own, or a team's server) signs its runs and Ambient in to Claude one
way, set in the app or by Ambient: a person's Claude plan (a token from `claude setup-token`), an
Anthropic API key, or whatever the computer itself has (`/etc/ambient-runner/extra.env`, the
default). Tokens and keys go in through the app only, sealed with the owner's key like secrets;
the computer fetches the chosen one when it changes. A plan's token wins over a key everywhere.

### The app's API

Computers in `GET /v1/app/routines` carry `claudeAccount` (`claude` stays the Claude Code
version):

```json
"claudeAccount": {
  "use": "plan",
  "plan": { "by": "Nikolai", "at": 1763380000000 },
  "key": null
}
```

`use`: `plan`, `key`, or `computer` (the computer's own sign-in; nothing stored in Ambient).
`plan` and `key` say who stored each and when (never the value), or null.

- `PUT /v1/app/computers/:id/claude` with `{ "kind": "plan" | "key", "token": "…" }` stores it
  and uses it. A plan's token starts with `sk-ant-oat`, a key with `sk-ant-api`; anything else is
  refused (400 `bad_token`). Answers `{ "computer": Computer }`.
- `POST /v1/app/computers/:id/claude/use` with `{ "use": "plan" | "key" | "computer" }` switches
  (409 `no_plan` / `no_key` when that one isn't stored). Answers `{ "computer": Computer }`.
- `DELETE /v1/app/computers/:id/claude/:kind` removes a stored plan or key (and falls back to the
  other, or the computer's own). Answers `{ "computer": Computer }`.
- Who: the person for their own computer; a team's owners and admins for its server.

### Out of credit or signed out

A thread message (and `bot.lastMessage`) has `fix`: `{ "kind": "claude", "computer": "<id>",
"reason": "credit" | "signin" }` when a run failed because the computer's Claude account is out of
credit or not signed in, else null. The app shows a button that opens the Claude sheet for that
computer ("Use my Claude plan").

### Links

`ambient://computer/<id>/claude` opens the Bots tab on that computer with its Claude sheet open.
Ambient's chat replies use it as a Markdown link ("[Add your Claude plan](ambient://computer/…/claude)").
