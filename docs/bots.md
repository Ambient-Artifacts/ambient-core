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
| `face` | `dome`, `pebble`, `cap`, `ridge`, `cloud`, `drop` | Its shape, a piece of Yosemite peeking up from its disc (Half Dome, a pebble, El Capitan, a ridge, a cloud, a drop from the falls). The faces from before (`classic`, `round`, `tall`, `wide`) are still accepted and drawn as one of these (see "Faces"). |
| `color` | `sky`, `sage`, `sand`, `clay`, `lake`, `rose`, `moss`, `stone` | Its colour for life, one of Ambient's pastels. Absent: one picked by its name. |
| `wear` | up to 3 of `hoodie`, `nerd`, `glasses`, `headset`, `cap`, `beret`, `tie`, `bowtie`, `monocle`, `ranger`, `headlamp`, `beanie` | What it wears for its job (see "Faces"). Absent: nothing. |
| `runtime` | `claude-code`, `codex` | What runs it: Claude Code, or OpenAI's Codex (see "Codex next to Claude Code"). Others come as runner adapters. |
| `isolation` | `container`, `host` | `container`: its own Podman container and volume (its workspace, `HOME`), only its granted secrets. `host`: like a loop today, as the computer's routine user. |
| `secrets` | names, or `null` | The secrets its runs get. `null` (loops from before): all of its owner's. |
| `report` | `news`, `every_run` | `news`: the thread gets a run's result only when it failed, asked something or said something new; `every_run`: every result. |

State, worked out by the gateway (never stored). It shows only in the face and how it moves; the
colour never changes:

| State | When | Face |
|---|---|---|
| `working` | a run is going | reads: its eyes scan a line, it nods, it blinks |
| `needs_you` | it asked a question nobody answered yet | has a question: head tilted, one brow up, a "?" |
| `stuck` | its last run failed | squeezed eyes, worried brows, a sweat drop |
| `done` | its last run went fine and said something nobody has read yet | smiles, one bounce |
| `asleep` | not working: between runs once its news was read, a run with nothing new, paused, never ran, or no computer | eyes shut, dozing |

`done` is news: opening the bot's thread in the app (`GET .../thread`), writing to it, or
`bot_thread` with `mark_read` sets the routine's `seenAt`, and from then on it's asleep until its
next run says something new. A `news` run that had nothing new to say leaves it asleep.

### Faces

A bot is drawn from `face`, `color` and `wear` (`botLook` in `@brain/spec` maps the old faces:
`round` → pebble, `tall` → cap, `wide` → ridge, `classic` → one picked by its name). Looks for
jobs (`BOT_LOOKS`): Engineer hoodie; Bug fixer thick glasses and hoodie; Reviewer thick glasses;
Researcher reading glasses; Writer beret; Support headset; Sales shirt and tie; Growth baseball
cap; Finance monocle and bow tie; Monitoring ranger hat; Night jobs headlamp; Ops beanie. The
drawing (shapes, expressions, motion, the glaze) is specified in the app (`BotFace.swift`).

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
  "face": "pebble",
  "color": "sage",
  "wear": ["nerd", "hoodie"],
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
`{ "face"?, "color"?, "wear"?: [..], "isolation"?, "secrets"?: [names] | null, "report"? }` (all optional; `runtime` may be
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

## Loops are bots

With bots on for an account or team, there are no plain loops anymore: every routine is a bot.
`GET /v1/app/features` says so (`{ "bots": true, "loopsAreBots": true }`); accounts and teams
without bots keep loops exactly as they are (`loopsAreBots` false).

- A routine made without `bot` settings (app or `create_routine`) is a new bot: its own container,
  no keys until granted, news only. A bot of one's own still needs a computer.
- `PATCH { "bot": null }` (back to a plain loop) answers `400 bots_only`.
- Loops made before bots were on stay loops (`bot: null`) until they're adopted:
  `admin bots adopt-loops <email|user id> [--team <slug>] [--dry-run]` makes each one a bot that
  runs exactly as before (on the computer itself, all of the owner's keys, news only; its schedule,
  computer, folder and prompt unchanged; its prompt AGENTS.md's first version, "was a loop"), with a
  face and colour picked from its id. `--team` does the team's loops, as that person (an owner or
  admin). A personal loop without a computer is skipped: it never runs. Running it again changes
  nothing.

## The computer's side

- `POST /v1/host/routines/:id/runs` (start) additionally returns `bot` (the settings above, without
  state), `resume` (`{ "sessionId": "…" | null, "message": "…" }` when the run continues a
  conversation, else null) and `runToken` (a token for this run only).
- `POST /v1/bot/ask` (bearer: run token) with `{ "question": "…", "choices"?: [..] }` →
  `{ "id": "…" }`; `GET /v1/bot/questions/:id` (run token) → `{ "answer": "…" | null }`. The run
  token works while its run is going.
- `ask_owner` with `wait: false` (runner 0.9.1) hands something to the owner without waiting
  (a pull request ready to merge, a post to publish): the run gets an answer at once and
  finishes; the question goes the usual way (Amb looks first, then a decision with a push), and
  the answer starts the next run. Every bot's instructions say to hand over what only the owner
  can do this way, not only to mention it in the last message.
- A run's result is held back from the thread only when that same run asked a question (the
  question is the news); a question left open from an earlier run doesn't swallow it.
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
  `{ id, uid, text, name, instructions, fresh, history, token, mode }`; `token` is that person's token
  for Ambient's MCP (24 hours, renewed an hour before it ends, listed in the app's tokens as
  "Ambient on <computer>"). The reply goes to `POST /v1/host/ambient/:id` as `{ text }` or
  `{ error }`.
- `mode` is `chat` (the person's message, in their open session) or `internal` (runner 0.7.7):
  Ambient's own turn, such as looking at a bot's question or the heartbeat. An internal turn runs
  in a short session of its own beside the chat's (`claude -p`, no resume, at most 5 minutes, one
  at a time per person), never in the chat's session. So it doesn't wait behind a long chat turn
  (a bot's question has 75 seconds), the chat doesn't wait behind it, and its prompts stay out of
  the conversation's history. Runners before 0.7.7 ignore `mode` and use the chat's session.
- What Ambient then writes on its own (a decision, a heartbeat message) goes with the person's
  next message to the chat's session, as a short bracketed note before their text, so that
  session knows what "it" said. The gateway keeps that list in memory; a restart forgets it.
- It runs as the machine's routine user, not in a container: Ambient is meant to work on that
  machine. `set_routine_secret` is left out; secrets go in through the app.
- Its Claude sign-in is the machine's (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in
  `/etc/ambient-runner/extra.env`), or a plan of its own: `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token` in `/etc/ambient-runner/ambient.env`, which then wins over the API key.
- Every run (a bot's, a loop's, Ambient's) uses a Claude plan's `CLAUDE_CODE_OAUTH_TOKEN` over
  `ANTHROPIC_API_KEY` when the computer has both (runner 0.7.2); in `extra.env` it signs in the
  team's bots and Ambient alike.

## Whose Claude a computer uses

- The computer can store its own Claude plan (runner 0.10.0, `install.sh` after `claude setup-token`
  there): `POST /v1/host/claude` (computer token) with `{ "kind": "plan" | "key", "token": "…" }`
  → 204. The same checks and sealing as the app's `PUT /v1/app/computers/:id/claude`; a team
  server's is stored with `setClaudeByHost`, "by" the computer's setup.
- Sync's `info` carries `claudeSignedIn` (runner 0.10.0): whether Claude Code can run there (a token
  or key, or Claude Code's own login for the routine user). The gateway keeps it in memory, never in
  Convex; computers in the app's API carry `claudeSignedIn: true | false | null` (null: not known
  yet: an older runner, or no sync since the gateway started), true also while a stored plan or key
  is in use.
- Runs with a token or key get a Claude Code settings folder of the runner's
  ([What the setup leaves alone](self-hosting.md#what-the-setup-leaves-alone)).

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

## Codex next to Claude Code

A bot runs on Claude Code (`runtime: "claude-code"`, the default) or on OpenAI's Codex CLI
(`runtime: "codex"`). Everything around the run stays the same: its thread, `ask_owner` and
`search_history`, its folder, memory and handoffs, its container and grants. Amb itself stays on
Claude Code.

**A bot's model.** `bot.model.model` is a Claude model for Claude Code (`claude-…`) and an
OpenAI model for Codex (`gpt-…`, `o3…`, `codex-…`); the other runtime's model is refused
(`400 model_runtime`), and switching a bot's runtime drops a model of the other one. `effort`
becomes Codex's reasoning effort (`max` is Codex's `xhigh`); `fallback` is Claude Code's only. A
Codex bot without a model of its own uses Codex's default: a computer's default model is Claude
Code's (`set_computer_model` takes only `claude-…`, `400 claude_model_only` otherwise).

### How Codex signs in on a computer

Each computer has `openaiAccount` next to `claudeAccount`:

```json
"codex": "codex-cli 0.169.0",
"openaiAccount": { "use": "plan", "key": null, "signedIn": "chatgpt" }
```

- `codex`: Codex's version there; `"not found"` when it isn't installed; null from runners before 0.9.0.
- `use: "plan"` (the default): the computer's own Codex sign-in, normally the person's **ChatGPT
  plan**. `signedIn` says how Codex is signed in there: `chatgpt`, `api_key`, `none` (null: not known yet).
- `use: "key"`: an **OpenAI API key** stored in Ambient (sealed with the owner's data key, like a
  Claude key; `key: { by, at }`, never the value), passed to Codex as `CODEX_API_KEY`.

The ChatGPT plan is signed in on the computer itself, with Codex's device code, because ChatGPT's
sign-in refreshes itself on the machine that uses it (there's no long-lived token to paste like
`claude setup-token`'s):

- `POST /v1/app/computers/:id/openai/login` → `{ "computer": "Build server", "url": "https://auth.openai.com/…", "code": "ABCD-12345", "expiresAt": 1763380000000 }`.
  The app shows "Open this link, sign in, enter this code" (15 minutes). The computer's runner
  starts `codex login --device-auth` as the loops' user and sends the link and code back through
  its long poll (a `codex-login` job), so the computer must be connected to Ambient (it runs Amb,
  `409 not_connected` otherwise: the message says how to sign in there by hand). Once the person
  entered the code, the computer syncs and `openaiAccount.signedIn` turns `chatgpt`: poll
  `GET /v1/app/routines` (its `computers`) every few seconds while the sheet is open.
- `PUT /v1/app/computers/:id/openai` with `{ "key": "sk-…" }` stores a key and uses it (`400 bad_openai_key` for anything else).
- `POST /v1/app/computers/:id/openai/use` with `{ "use": "plan" | "key" }` (`409 no_openai_key` when none is stored).
- `DELETE /v1/app/computers/:id/openai/key` removes the key; the computer's own sign-in is used.

All answer `{ "computer": Computer }` (login: the object above); who may change them is who may
change the computer's Claude sign-in. App link: `ambient://computer/<id>/openai`.

**In a bot's container** Codex is in the image (bots' image version 3). With `use: "plan"` the
runner copies the computer's sign-in (`~/.codex/auth.json` of the loops' user) into the run and,
after it, keeps the refreshed one if Codex renewed it, so the computer always holds the newest.
Several busy Codex bots on one computer can race on that refresh: an API key is the steadier
choice there. With `use: "key"` only the key goes in. A bot that runs on the computer itself uses
the loops' user's Codex and its sign-in directly, in Codex's own workspace sandbox (network on, its
memory and handoff folder writable).

**When Codex can't sign in** (no sign-in, an expired one, a key that's wrong, a plan's usage limit
or no credit) the run fails with a message that names Codex, and the thread's failure carries
`fix: { "kind": "openai", "computer": "<id>", "reason": "signin" | "credit" }` (Claude's are
`kind: "claude"`): the app offers the sign-in sheet.

**The computer's side** (runner 0.9.0): sync reports `info.codex` and `info.codexLogin`; sync's
answer has `openai` (a version: the stored key changed, null: the computer's own sign-in), and
`GET /v1/host/openai` → `{ "version", "env": { "CODEX_API_KEY": "…" } }`. A Codex run is
`codex exec --json` (or `codex exec resume <thread> --json`) with the prompt on stdin, the bot's
instructions as Codex's `developer_instructions`, and `ambient-bot` (`ask_owner`,
`search_history`) as an MCP server whose run token comes from Codex's environment, never its
command line. The bot's secrets reach its commands; the run's token and the sign-ins don't.

**For Amb:** `update_routine` with `bot.runtime: "codex"` (and an OpenAI model), `use_openai_account`,
and `sign_in_chatgpt` (returns the link and code to give the person). Keys go in through the app only.

## Files in the chat

`POST /v1/app/ambient/chat` and `POST /v1/app/routines/:id/thread` (a bot's thread) also take
`attachments`: up to 4 files, 10 MB together, each
`{ "name": "plan.pdf", "type": "application/pdf", "data": "<base64>" }`. Images (JPEG, PNG, GIF,
WebP), PDFs and text files (text/*, JSON, CSV, Markdown). Refused: 400 `bad_attachment` with the
reason.

The files are kept, so the message shows them again on every device, like Claude shows them
(`gateway/src/bots/attachments.ts`). Each is sealed with its owner's key (the person's; a team bot's
thread: the team's) and stored in Convex file storage (`attachments` table, actions
`attachments.store`/`read`); its name and type are sealed beside it. The message lists them as
`files: [{ id, name, type, size }]`, and the app fetches each:

- `GET /v1/app/ambient/chat/files/:id`: a file of the person's chat with Ambient, only theirs.
- `GET /v1/app/routines/:id/thread/files/:id`: a file of a bot's thread, to whoever may read it.

Both answer with the file's own type, inline, cached for good (an id never changes), in a sandbox
(`content-security-policy: sandbox`). An id from another chat or thread is 404, never someone
else's file.

Where the files go:
- Ambient on a computer: saved in the person's Ambient folder there, Claude Code reads them; on the
  server they go to Claude with the message. The history for the model says which files came.
- A bot: the run its message starts gets them in its out folder (runner 0.12.1 fetches each with the
  run's token from `GET /v1/bot/files/:id`), named in the message. Files in messages a run gets
  while it's working (steering) are only in the thread, not in that run.
- Gone with: Forget chat (`DELETE /v1/app/ambient/chat?forget=1`; New chat keeps them with the
  history), the bot (`routines.remove`), and the account.

Not yet: files Ambient or a bot makes on the computer (a chart, a PDF) coming back into the chat.

## A computer's model, and what Ambient may do there

### Model

A computer has a default model for its bots and loops (and Ambient there): `model` (e.g.
`claude-opus-5-5`), `effort` (`low`, `medium`, `high`, `xhigh`, `max`, or null for the model's
default) and `fallback` (a model Claude Code switches to when the first refuses or is overloaded,
or null). None set: Claude Code's own default. A bot can override it with `bot.model` (same
shape; null: the computer's default).

Computers in `GET /v1/app/routines` carry `model`: `{ "model": "claude-opus-5-5", "effort":
"medium", "fallback": "claude-opus-4-6" }` or null. `PUT /v1/app/computers/:id/model` with that
object (or `null` to clear) answers `{ "computer": Computer }`. Bots: `bot.model` in the
create/update input and in the routine's `bot` (null when it follows the computer).

The models offered in the app: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`,
`claude-opus-4-6`. The server accepts any `claude-…` id.

### Access: Standard, Admin, Full root

Computers carry `access`: `standard` (default), `admin` or `full`, and `allowed`: the commands
approved with "Always" (exact command lines).

- **standard:** Ambient works as the computer's routine user with its tools; it can't run commands
  as root.
- **admin:** Ambient may ask to run a command as root (`run_on_computer`); it runs only after an
  approval (or when it's in `allowed`).
- **full:** root commands run without asking. Only set in the app.

`PUT /v1/app/computers/:id/access` with `{ "access": "standard" | "admin" | "full" }` (raising it
only from the app; an AI app may only lower it). `DELETE /v1/app/computers/:id/allowed` with
`{ "command": "…" }` removes an always-approved command. Who: the computer's person, or a team's
owners and admins for its server.

### Approval cards

`GET /v1/app/approvals` → `{ "approvals": [Approval] }`, the pending ones for this person (newest
first):

```json
{ "id": "…", "computer": { "id": "…", "name": "Ambient's server", "team": "Ambient" },
  "command": "apt-get install -y ffmpeg", "reason": "To cut the demo video.",
  "requestedAt": 1763380000000, "expiresAt": 1763380600000 }
```

`POST /v1/app/approvals/:id` with `{ "decision": "once" | "session" | "always" | "deny" }` answers
`{ "approval": Approval & { "status": "approved" | "denied" } }`. `session`: approved for this
command until Ambient's session there restarts; `always`: added to the computer's `allowed`.
Approvals expire after 10 minutes (status `expired`).

A new approval sends a push: title "Ambient wants to run a command", body "<computer>: <command>",
`url: ambient://approval/<id>`, collapse id `approval-<id>`. The app shows pending approvals as
cards in Ambient's chat, above the message bar: the computer, the command in monospace, the
reason, and buttons **Allow once**, **Allow for this session**, **Always allow**, **Deny**.

## Decisions: bots report to Ambient, Ambient reports to you

Conversation first: Ambient is the one who talks to you, in the app's chat today and in iMessage,
Slack or Teams later (each a channel). What needs you comes as a **decision** inside that
conversation, and an answer anywhere settles it everywhere.

### The chain

1. A bot asks (`ask_owner`). The question lands in its thread as before.
2. Ambient looks at it first (an internal turn, see "Ambient on a computer"), by the bot's `delegate` setting:
   - `never`: it goes straight to you (a decision with Ambient's suggestion when it has one).
   - `brain` (default): Ambient answers itself when the answer is clear from your brain (wiki,
     decisions, earlier answers); otherwise it goes to you with its suggestion.
   - `most`: Ambient answers everything except spending money, publishing, deleting or anything
     that can't be undone; those go to you.
3. Ambient's own answer shows in the bot's thread as a message from Ambient ("Answered for
   Nikolai: …", role `ambient`), and you can overrule it there or in the chat.
4. What goes to you: a decision message in Ambient's chat, plus a push "<bot> needs you".

### Questions show the work

A question for approval carries what's to be approved: `ask_owner`'s `details` (markdown, up to 20,000 characters) holds the draft itself, the pull request's link, the file's link, the numbers and where each comes from. It's sealed with the question and shown with it: in the bot's thread (`details` on the question message), on the decision (`details`) and in Ambient's chat message about it. Ambient's look at the question (the triage) gets it too, and without it is told not to suggest approving work it hasn't seen. Bots are told to put the work there and never write "see my last message" (2026-11-19: a draft was only "in my last message", which wasn't shown).

A run's result with substance of its own (over 400 characters: a draft, a report) shows in the thread even when the same run asked something, just before the question; only a short one that would repeat the question is held back.

### The decision

```json
{ "id": "…", "status": "open" | "answered" | "expired",
  "from": { "kind": "bot", "id": "<routine id>", "name": "Blog draft", "face": "cap", "color": "rose", "wear": ["beret"] } | { "kind": "ambient" },
  "question": "Which topic for Monday?",
  "options": ["Wiki in git", "AI is multiplayer"],
  "recommendation": { "option": "AI is multiplayer", "why": "You wanted more variety (2026-10-16)." } | null,
  "answer": { "text": "AI is multiplayer", "by": "Nikolai", "via": "app" | "ambient" | "thread", "at": 1763380000000 } | null,
  "urgent": true, "createdAt": 1763380000000 }
```

- `GET /v1/app/decisions` → `{ "decisions": [Decision] }`: open ones, oldest first (the stack).
- `POST /v1/app/decisions/:id` with `{ "option": "…" }` or `{ "text": "…" }` → `{ "decision": Decision }`.
  The bot gets it as your answer (its run carries on, or its next run resumes with it).
- Ambient's chat messages can carry one: `GET /v1/app/ambient/chat` messages have `decision`
  (the Decision, current status) or null. The app shows it as a card inside Ambient's message:
  the question, the options as buttons with the recommended one marked ("Suggested"), Ambient's
  why in small text, and once answered, the answer with who and where instead of the buttons.
- Answering in words in the chat ("take the second one") works too: Ambient files it with its
  `answer_decision` tool.

### Bot setting

`bot.delegate`: `never`, `brain` (default) or `most`, in the routine's `bot` and in create/update.

### The heartbeat

Every 30 minutes between 08:00 and 21:00 (Europe/Vienna for now), code gathers what happened for
each person with bots: runs that failed, decisions waiting longer than two hours, approvals waiting.
Only when that isn't empty does Ambient get a turn (an internal one, see "Ambient on a computer"); it writes a short message into the chat (with a
push) or stays silent. Nothing twice, at most 6 such messages a day, none at night.

## One folder for every bot, Amb included

Every bot has the same folder, and so has Amb, the master agent (one per person):

| File | What goes in it | Bots | Amb |
|---|---|---|---|
| `SOUL.md` | How it talks and behaves: tone, length, language, style | ✓ | ✓ |
| `AGENTS.md` | What it does and how | ✓ (its prompt) | ✓ (the person's additions; Amb's base rules stay in code and win) |
| `GOAL.md` | What it should achieve | ✓ | – |
| `memory.md` | What it learned: facts, corrections, lessons, with their source | ✓ | ✓ |
| `skills/<name>/…` | Know-how it uses again | ✓ | ✓ |

Where things go: how it talks goes in `SOUL.md`, what it does in `AGENTS.md`, what it should
achieve in `GOAL.md`, what it learned in `memory.md`. "Text me short" is a line in Amb's
`SOUL.md`, not in its memory; a bot's tone goes in that bot's `SOUL.md`.

- A bot's `SOUL.md` is in its system text every run (it stays the same between runs, so the prompt
  cache keeps it). The templates start with one each. While Amb improves a bot on its own, `SOUL.md`
  is a proposal only, like `AGENTS.md` and `GOAL.md`. The git mirror writes it too.
- Amb's `SOUL.md`, `AGENTS.md` and `memory.md` are in its instructions (each only when it has text);
  its skills are written into the person's session folder on the computer as Claude Code project
  skills (`<folder>/.claude/skills/`, runner 0.9.3; the ones Ambient put there last time are
  replaced, ones made there by hand stay).

Amb's folder in the app, with the same shapes as a bot's file endpoints (only the person themself):

- `GET /v1/app/ambient/files` → `{ "files": [FileInfo] }` (`SOUL.md`, `AGENTS.md`, `memory.md`
  always, then skills).
- `GET /v1/app/ambient/files/content?path=…[&version=n]` → FileView; `PUT …?path=…` with
  `{ "content", "why"? }` → FileView; `DELETE …?path=…` → 204 (skills only; the others are only
  emptied: `bad_path`).
- `GET /v1/app/ambient/files/history?path=…` → `{ "versions": [...] }`;
  `POST /v1/app/ambient/files/revert` with `{ "path", "version" }` → FileView.
- `GET /v1/app/ambient/learning` → `{ "lessons": [{ "text", "source", "date" }], "changes": [{ "path",
  "version", "by": { "kind", "name" }, "why", "at" }] }`: the lessons in its memory.md and the
  latest versions of its files.
- Limits: `SOUL.md` 8 KB, `AGENTS.md` 20,000 characters, `memory.md` 16 KB, skills 64 KB a file;
  60 files and 512 KB in all.

## A bot's folder, its memory and its handoffs

A bot is a folder of files that Ambient keeps for its owner (a person, or a team), sealed like
everything else, with a version for every change: who made it (the owner, the bot itself, or Amb,
the master agent), why, and when. Undo is restoring an earlier version. A team bot's folder can be
mirrored into the team's git repo later; the store here stays the source, so a broken repo token
never stops a bot.

| File | What | Who writes it |
|---|---|---|
| `SOUL.md` | How it talks and behaves: tone, length, language, style (up to 8 KB; in its system text every run) | the owner; Amb when the owner asked for another tone |
| `AGENTS.md` | What the bot does and how: its instructions (a loop's prompt, up to 20,000 characters) | the owner; Amb |
| `GOAL.md` | The outcome it owns, if any: metric, target, by when, limits (see "Outcomes, not tasks") | the owner; Amb |
| `skills/<name>/SKILL.md` (and other text files in `skills/<name>/`) | Know-how it uses when it fits, as Claude Code skills | the owner; Amb |
| `memory.md` | What it has learned: the owner's preferences, corrections, lessons (up to 16 KB) | the bot, during its runs; the owner; Amb |

Limits: text files only, 64 KB each, 60 files and 512 KB a bot. Paths: `AGENTS.md`, `memory.md`,
or `skills/<name>/<file>` (`<name>`: lowercase letters, digits, dashes; one more folder level is
allowed). Each file keeps its last 50 versions.

`AGENTS.md` is the routine's prompt: editing the prompt (app or `update_routine`) is a new version
of `AGENTS.md`, and the other way round.

**Handoffs.** A run ends by writing a handoff for its next run: the first line `Status: done` or
`Status: continue`, then what it did, what's open, what comes next and what it's waiting for (up
to 8 KB). The last 30 are kept. A run that writes none gets its summary as its handoff.

### How a bot wakes up

Code decides, every run:

1. **It continues its session** when the run starts with the owner's answer or message (as
   before), or when its last handoff said `Status: continue`, that run ended less than 6 hours
   ago, and its session is known. It's told what's new in its thread since.
2. **Otherwise it starts fresh with a handoff:** its `AGENTS.md`, its `memory.md`, its last three
   handoffs, and every message in its thread since its last run (the owner's, and Amb's answers
   for them). Anything older it finds with `search_history`.

So a bot knows what it did yesterday and what's next, without dragging weeks of transcript
around: a wrong turn is fixed by correcting its memory or handoff, not by wiping it.

### Wake-ups

A bot plans its own time. A schedule is optional: `schedule.every: "needed"` ("When it needs
to", the default in the app) means no timer at all; the bot runs when someone writes to it, on
its events (GitHub), and at the wake-ups it books itself. A bot with a schedule can book them
too.

- **Booking:** the runner's `wake_me` tool (ambient-bot MCP, runner 0.14.0) with `at` (a local
  time like `2026-11-24 09:00`, read in the bot's `schedule.timezone`, or ISO with an offset) and
  a `note` (what to do then). `cancel_wake_up` takes one back. The instructions say: a next step
  on a date gets a wake-up; plan backwards from deadlines and leave the owner time to review.
- **Guardrails** (Convex, `control/convex/wakes.ts`): 10 minutes to 30 days ahead, at most 5
  booked, an hour apart (`too_soon`, `too_far`, `too_many`, `too_close`, each with a message the
  bot can act on).
- **Firing:** the gateway's ticker (`gateway/src/bots/wakes.ts`, every 30 seconds) fires what's
  due: the note goes into the thread as a message from `Wake-up` and, when the bot is on, a run
  starts with it at once (its computer's long poll), resuming its session like a message does
  (`Wake-up: <note>`). A paused bot only gets the note.
- **What a run knows:** its first message (and a resumed session's) says the time now in its
  zone and lists what's booked, with ids.
- **The first run:** a bot without a schedule starts right after it's made (or, made paused,
  when it's first turned on), with a message from `Wake-up` that asks it to do what's due and
  book the rest. One with a schedule waits for it.
- **Shown:** a routine's `nextRunAt` is its next wake-up when that comes before its schedule (or
  it has none), so the app's "Next: …" covers both.

The app's API (whoever sees a bot sees its wake-ups; whoever may change it books and cancels):

- `GET /v1/app/routines/:id/wakes` → `{ "timezone", "wakes": [{ "id", "at", "when": "Tue 24 Nov, 09:00", "note", "byBot" }] }`
- `POST /v1/app/routines/:id/wakes` with `{ "at", "note" }` → `{ "wake" }`
- `DELETE /v1/app/routines/:id/wakes/:wake` → `204`

The run's side, with its run token: `GET /v1/bot/wakes`, `POST /v1/bot/wakes` (`{ "at", "note" }`
→ `{ "wake", "booked" }`), `DELETE /v1/bot/wakes/:id`. MCP: `bot_wake_ups` (list, book, cancel).

A computer gets `onCalendar: ""` for a bot without a schedule: runner 0.14.0 writes its service
and no timer (and removes a timer it had); older runners skip it until they've updated
themselves, on the same sync.

### Outcomes, not tasks

A bot can own an outcome instead of running a task list: `GOAL.md` in its folder says the result
in one sentence, the metric and how to measure it, the target, by when, and its limits (budget,
what needs a yes). Up to 8 KB; it can be emptied, not deleted; the owner and Amb write it, never
the bot itself.

- A run of a bot with a goal starts with the goal and the metric over its last ten runs (from
  their handoffs), and is told to measure first and then do what moves the metric most.
- Its handoff then has a second line, `Metric: <value>` (short, with its unit). Handoffs carry
  it as `metric` (null when there's none), so the app can draw the curve and Amb can tell
  whether it's working.
- It says when the target holds, and asks its owner when the goal looks wrong or out of reach.

### The app's API

Paths go in the query (`?path=skills/release/SKILL.md`), since they hold slashes. Who may read and
write is who may read and change the bot.

- `GET /v1/app/routines/:id/files` →
  `{ "files": [{ "path": "AGENTS.md", "size": 1834, "version": 4, "updatedAt": 1763380000000, "by": { "kind": "amb", "name": "Amb" } }] }`
  (`by.kind`: `user`, `bot`, `amb`; `AGENTS.md`, `GOAL.md` and `memory.md` are always listed,
  version 0 when never written).
- `GET /v1/app/routines/:id/files/content?path=…[&version=n]` →
  `{ "path", "content", "version", "by", "why", "updatedAt" }`.
- `PUT /v1/app/routines/:id/files/content?path=…` with `{ "content": "…", "why"?: "…" }` → the
  file as above. Creates the file when it's new.
- `DELETE /v1/app/routines/:id/files/content?path=…` → 204 (a version that deletes it; `AGENTS.md`
  and `memory.md` can't be deleted, only emptied).
- `GET /v1/app/routines/:id/files/history?path=…` →
  `{ "versions": [{ "version": 4, "by", "why", "updatedAt", "size", "deleted": false }] }` (newest
  first).
- `POST /v1/app/routines/:id/files/revert` with `{ "path": "…", "version": 3 }` → the file: a new
  version with version 3's content.
- `GET /v1/app/routines/:id/handoffs?limit=10` →
  `{ "handoffs": [{ "runId": "…", "status": "done" | "continue", "metric": "180 visitors" | null, "text": "…", "createdAt": 1763380000000 }] }`
  (newest first).

When Amb changes a bot's `AGENTS.md` or a skill, the bot's thread says so in an `ambient` message
(what changed and why), so the owner sees it where they talk to the bot.

### The computer's side

`POST /v1/host/routines/:id/runs` for a bot also returns, from runner 0.8.0 on:

```json
"workspace": {
  "system": "…the bot's instructions for this run; {{OUT}} stands for the run's out folder…",
  "skills": [{ "path": "release/SKILL.md", "content": "…" }],
  "memory": "…memory.md as it is now…"
}
```

`routine.prompt` is what the run starts with: for a fresh run the wake-up message above (with
`AGENTS.md` in it), for a continued one what's new. The runner:

- writes `memory.md` (as given) and an empty `handoff.md` into the run's out folder (in a container
  `/opt/ambient/out`), replaces `{{OUT}}` in `system` with that folder and appends `system` to
  Claude Code's system prompt instead of its own;
- puts `skills` into `~/.claude/skills/` (in a container; skills it put there before and that are
  gone now are removed, skills the bot made itself stay). A bot that runs on the computer itself
  (`isolation: host`) gets no skills: the runner never writes into the routine user's own
  `~/.claude`;
- after the run sends `memory` and `handoff` (the files' text) with the result:
  `POST /v1/host/runs/:runId` `{ …, "memory"?: "…", "handoff"?: "…" }`.

Older runners ignore `workspace` and run `routine.prompt` as before.

The bot's `ask_owner` MCP server gets a second tool, `search_history` (run token):
`GET /v1/bot/history?q=…&from=…&to=…&limit=20` → `{ "results": [{ "at", "who", "where", "text" }] }`
over its own thread and handoffs (`at` in milliseconds, newest first; `from`/`to` a date,
`YYYY-MM-DD`, meaning the whole day, or an ISO moment; every word of `q` must appear, case and
accents don't matter). The run token works while the run is going.

### A bot's folder in git

Every bot's folder is also mirrored into git, so its owner has it in a repo of their own, with the
history git gives. Ambient's store stays the source: a broken repo or token never stops a bot, and
the mirror is **one way**: an edit made in git is overwritten the next time the bot changes.
Bringing edits back from git is a later step.

```
bots/
  README.md          generated: what this is, and to change bots in Ambient
  .mirrored          generated: the files Ambient wrote (only those are ever removed)
  blog-draft/
    AGENTS.md
    GOAL.md          when it owns an outcome
    memory.md
    bot.json         generated: name, face, runtime, isolation, schedule, enabled, report,
                     the granted secrets' names (never values; "all" for a loop from before
                     grants), model, delegate
    skills/tone/SKILL.md
```

A bot's folder name is its name in lowercase letters, digits and dashes (`Blög Draft` →
`blog-draft`); when two bots would share one, the newer gets the end of its id. Handoffs aren't
mirrored: they're run logs. A `bots/` folder the repo had of its own keeps its files.

- **A person's bots** go into their own connected repo (the one their personal wiki syncs with),
  in its sync: every 15 minutes, and within half a minute of a change. Without a connected repo
  they aren't mirrored.
- **A team's bots** go into the team's wiki repo on its server, in one commit with who changed
  what and why (`bots: Release notes skills/changelog/SKILL.md (Lena Vogel: readers asked)`, by
  that person when it was one person's change), pushed to the team's own repo when one is
  connected. When another tool keeps the team's repo and Ambient writes one folder of it, they go
  inside that folder (`ambient/bots/`); when it's read-only, nowhere. The brain leaves `bots/` out:
  no pages, no search, no indexes, and the nightly upkeep doesn't touch it.
- **When:** after any change to a bot (a file, its prompt, its name or settings, its memory after a
  run, deleting it), once things have been quiet for 30 seconds, so a run's memory makes one commit.
  A renamed bot's old folder goes; a deleted bot's folder goes.

`GET /v1/app/routines/:id/files` also returns where the bot is mirrored:

```json
"mirror": {
  "state": "mirrored",
  "repo": "https://github.com/acme/brain.git",
  "path": "bots/blog-draft/",
  "lastMirroredAt": 1763380000000,
  "lastError": null
}
```

`state`: `mirrored`; `pending` (a change waits, or it hasn't run yet); `not_connected` (a person
without a connected repo: the app can offer to connect one); `read_only` (another tool keeps the
team's repo); `error` (`lastError` says why; the bot itself is fine). `repo` is null for a team
without a repo of its own: then the folder is in the brain's git on the team's server. `null`
instead of the object: the gateway doesn't mirror at all.

`POST /v1/app/routines/:id/files/mirror` mirrors the owner's bots now (who may change the bot) and
answers `{ "mirror": … }` as above. `bot_files` tells Amb the same in a line.

The team server takes the folder as `PUT /v1/bots` (purpose `bots` in the gateway's token):
`{ "bots": [{ "slug", "files": [{ "path", "content" }] }], "readme", "message", "author"? }`, every
bot of the team at once; it answers `{ "commit", "folder", "files", "repo": { "url", "mode",
"status", "lastError", "lastPushAt" } | null }`, or 409 `read_only`.

## Messages while a bot works

A message to a bot that's working goes into the run that's going, not into a second run after
it (runner 0.9.2, Claude Code bots):

- The run keeps Claude Code's input open (`--input-format stream-json`) and asks every 2 seconds
  for what came into its thread since it started: `GET /v1/bot/inbox[?after=<cursor>]` with its
  run token → `{ "messages": [{ "text", "who", "at" }], "cursor" }`. The owner's, Amb's and
  GitHub's messages count; answers to the run's own questions come back through `ask_owner`.
  What's handed over is taken: its pending message is called off, so no run starts for it later.
- The runner writes each into the session ("<who> wrote to you in the Ambient app: …"); Claude
  Code takes it in at its next step, in the same turn (one answer to both).
- After a turn, the run waits 3 seconds for one more message, then closes. An answer to a turn
  that's followed by another goes to the thread at once: `POST /v1/bot/reply` `{ "text" }`; the
  last one is the run's result as before.
- Each run logs where its time went: `Timing: api …s, spawn …s, ready …s, text …s, result …s,
  end …s; tokens in …, cache read …, cache write …, out …`.

Codex bots keep the old way for now (a message starts the next run).

## The brain for bots

Every bot's run reads the brain, the way an employee's AI app does (gateway/src/mcp/bot-principal.ts). Its MCP config has Ambient's MCP next to `ambient-bot` (ask_owner, search_history), signed in with the run's token, so it works only while the run goes (`mcp__ambient` in `--allowedTools`; for Codex `mcp_servers.ambient.url` with `bearer_token_env_var = "AMBIENT_RUN_TOKEN"`).

- **What it reads:** what its owner may read. A personal bot gets the owner's wiki and their teams'; a team bot gets that team's only, never a member's personal wiki.
- **What it may do:** `index`, `search`, `fetch`, `brief`, `get_entity`, `list_recent`, `list_decisions`, `list_action_items` and `transcript` to read; `suggest_correction` and `log_work` to write, as anyone may (`BOT_TOOLS`). It can't change pages, save notes in someone's name or share them, and none of the settings, bots, computers, accounts or secrets tools exist for it. Amb keeps all of them; it acts for the person.
- **Who wrote it:** a correction says "the bot <name>", a work log's tool is "<name> (bot)"; both carry the owner as the person they're from.
- **Its instructions** tell it to look in the brain before it answers or decides anything about people, projects, customers or earlier decisions.

## Files agents make

Bots and Ambient hand the person what they made (a picture for a post, a chart, a PDF) as files in the chat, stored like the files people send (sealed, Convex file storage; "Files in the chat").

- **A bot:** the `send_file` tool (ambient-bot MCP, runner 0.13.0) reads up to 4 files (10 MB together; pictures, PDFs, text) from its container or folder and posts them into its thread (`POST /v1/bot/reply` with `files`). `ask_owner` takes `files` too, so a question shows the picture it asks about; Ambient's message about the question points to them in the bot's thread.
- **Ambient:** files it saves in `./outbox/` of the person's folder on the computer go with its reply (`POST /v1/host/ambient/:jobId` with `files`) and show in the chat; sent ones move to `outbox/sent/`.
- **Where files last:** a contained bot's home, `/home/bot`, is its own volume (`ambient-bot-<id>`), kept from run to run; the out folder (`{{OUT}}`) only carries memory.md and handoff.md back and is emptied after every run. Their instructions say so (2026-11-19: a picture made in the out folder was gone with the run).

## History: nothing is forgotten

Amb's chat and every bot's thread are kept in full (sealed), no longer cut at the newest 200 or 300
messages. `DELETE /v1/app/ambient/chat` starts a new chat: Amb starts a new session and the app
shows the chat from there, but the old messages stay findable. `DELETE /v1/app/ambient/chat?forget=1`
deletes the whole history for good.

`search_history` (an MCP tool for Amb and for AI apps with bots switched on) searches Amb's chat,
the threads of every bot the person sees, and the bots' handoffs, by words and dates, newest first.
The gateway opens and searches the messages; nothing is stored unsealed.

## Amb's memory

Amb, the master agent, has a `memory.md` of its own per person (16 KB, versioned the same way):
what it knows about them that isn't in the brain (how they like things, what they decided in the
chat, standing instructions). It's in Amb's instructions whenever a session starts, and Amb keeps
it with the `write_amb_file` tool (one of its files; see "One folder for every bot, Amb included").

Code makes sure it's kept up: every night (03:00 Vienna) Amb gets a short background turn to go
through the day's chat and threads and update it, and when a chat is started anew, Amb first gets
a turn to save what's worth keeping from the old one.

- `GET /v1/app/ambient/memory[?version=n]` → the file (as above; `by.name` is the person's name
  for their own edits); `PUT` with `{ "content", "why"? }`; `GET /v1/app/ambient/memory/history`;
  `POST /v1/app/ambient/memory/revert` with `{ "version" }`. Only the person reads and changes it.
  These stay for older apps; they're the same file as `memory.md` in `/v1/app/ambient/files`.

MCP tools (for Amb, and AI apps with bots switched on): `search_history`, `read_amb_file`
(one of Amb's files, a version, `history: true`, or the list without a path), `write_amb_file`
(content, `delete` for a skill, or `restore_version`, always with a `why`), `bot_files` (files and the last three handoffs), `read_bot_file` (a version,
or `history: true`), `write_bot_file` (content, `delete`, or `restore_version`, always with a
`why`). A change through them is by `amb` (`by.name` "Ambient" from Amb's chat, otherwise the AI
app). A version that deleted a file has empty content and `deleted: true`; restoring the one before
it brings the file back.

## GitHub events and the PR gate

A bot that works through pull requests only marks one ready for review when nothing on it is open:
every review comment (review bots and people) fixed or answered, and every check green. It doesn't
poll for that: GitHub's events on its pull request wake it.

**How a bot works on its repos** (`on`, one or more): `own_prs` (its own pull requests and the
gate below; the default), `all_prs` (it reviews every pull request: see "Bot templates"),
`merges` (what's merged into the default branch starts it: a wiki keeper).

**Which pull requests are a bot's.** A bot watches repos (`owner/name`, up to 10). Its branches
start with `ambient/<bot>/` (its name as the git mirror spells it: `Blög Draft` →
`ambient/blog-draft/`), and a pull request from such a branch is its own. Its instructions say
so, and the gate.

**The gate, in a watching bot's instructions** (code-owned text): name branches
`ambient/<bot>/<topic>`; open pull requests as drafts; after each round read everything on it
(`gh api repos/<o>/<r>/pulls/<n>/comments`, `gh pr view <n> --comments`, `gh pr checks <n>`); fix
or answer every comment, reply on its thread and resolve it once fixed; push; only when nothing is
open, every check is green and the latest review round brought nothing new, `gh pr ready <n>` and
say so; never merge unless its `AGENTS.md` or `GOAL.md` says it may; end every comment it writes on
GitHub with `— <bot name> (Ambient)`.

**The webhook.** One per owner (a person, or a team), for all their repos: `POST
/v1/hooks/github/<id>`, signed by GitHub with the hook's secret (`X-Hub-Signature-256`,
HMAC-SHA256; unsigned or wrongly signed: 401; an unknown or rotated hook: 404). In the repo:
Settings → Webhooks → Add webhook, content type `application/json`, the secret, and "Let me
select individual events": Pull requests, Pull request reviews, Pull request review comments,
Issue comments, Check runs, Check suites, Pushes. A delivery GitHub sends twice (`X-GitHub-Delivery`) is
taken once; everything that doesn't concern a bot gets 202 with what it was (`result`).

**What wakes the bot**, gathered per pull request for 90 seconds into one message from "GitHub" in
its thread, which starts a run (like its owner's message; it continues its session):

- a review submitted (its state and text; an empty "commented" review, the wrapper of line
  comments, is left out),
- a review comment (who, `file:line`, the text, the link), a comment on the pull request,
- a check that failed (its name, conclusion and link), and all checks green again after one failed.

Left out: comments ending with the bot's own signature line, other branches, repos it doesn't
watch. A comment on the pull request carries no branch, so it's matched by what an earlier pull
request event said about that number (the bot's PR events: opened, synchronize). Merged or closed:
a note in the thread, no run. At most 6 wake-ups per pull request an hour; then one note says it
won't be woken for it until the hour is over. A message the owner left that no run has taken yet
stays what the run starts with; GitHub's comes along as new in its thread.

**App API** (who may change the owner's bots; a team's: its owners and admins):

- `GET /v1/app/github-hook[?team=<slug>]` → `{ "id", "url", "secret", "events": [..] }` (made on
  first use); `POST /v1/app/github-hook/rotate[?team=<slug>]` → the same with a new URL and
  secret (the old ones stop at once).
- `GET /v1/app/routines/:id/github` → `{ "repos": ["owner/name"], "on": ["own_prs"], "branchPrefix": "ambient/<bot>/" }`
  (the prefix always, also before it watches a repo); `PUT` with `{ "repos": [..], "on"?: [..] }`
  (`on` left out: as it was): owner/name,
  or any github.com link to the repo (http or https, www., `git@github.com:`, `.git`, a link to a
  pull request or a branch in it); `400 bad_repo` otherwise; an empty list stops it. The same
  cleanup holds for the MCP tool. Everyone who sees the bot reads its repos; who may change it
  writes them.
- App link: `ambient://github-hook[?team=<slug>]` (the webhook's page with the secret).

MCP tools for Amb: `github_webhook` (the URL and the events to tick; the secret only in the app)
and `watch_github` (`{ id, repos, on? }`).

**Every pull request (`all_prs`).** Opened, reopened, marked ready or new commits (not drafts, not
its own branch) wake the bot with the pull request's number, title, author and head, gathered and
capped like the gate's wake-ups. Its instructions: comments only on real problems, inline, then one
review (`gh pr review`); never approve with red checks, never push or merge; every comment ends
with its signature line.

**Merges (`merges`).** A push to the default branch wakes it with the commits (id and first line)
and the compare link. Left out: pushes that only change Markdown or `docs/`, and merges of its own
work (the merge message names its branch prefix, or carries its signature).

## Connect GitHub

Ambient's own GitHub App, instead of a webhook per owner and a GitHub token made by hand. A person
(or a team's owner or admin) taps Connect GitHub, picks the repos on GitHub, and that's all: GitHub's
events on those repos reach the bots working on them, and each bot's run gets a GitHub token for
just its repos. The owner's own webhook ([above](#github-events-and-the-pr-gate)) keeps working
next to it, and is what's left when the server has no App (`app: null`).

- `GET /v1/app/github[?team=<slug>]` → `{ "app": { "slug": "ambient-bots", "configured": true } | null,
  "installations": [{ "id": 123, "account": "Ambient-Artifacts", "repos": ["Ambient-Artifacts/ambient-core"] | "all", "connectedAt": 1763380000000 }] }`
  (403 for someone who may not change that owner's bots).
- `POST /v1/app/github/connect[?team=<slug>]` → `{ "url": "https://github.com/apps/<slug>/installations/new?state=…" }`:
  open it in the browser. The state says whose installation it will be; it's signed, lasts
  30 minutes and works once. 404 `not_set_up` without the App.
- `GET /v1/github/installed?installation_id=…&setup_action=install|update&state=…`: where GitHub
  sends the browser back. It checks the state, links the installation to its owner, reads which
  repos it covers, and shows a short "Connected" page that goes on to `ambient://github/connected`
  (the app then reloads `GET /v1/app/github`). A link that expired or was used shows why.
- `DELETE /v1/app/github/installations/:id[?team=]` → 204: unlinks it in Ambient. Uninstalling
  the App on GitHub (the account's Settings → Applications) is separate; GitHub then tells
  Ambient, which unlinks it too.
- `POST /v1/hooks/github-app`: the App's deliveries, signed with its webhook secret. An
  installation's added or removed repos keep its list current; a deleted or suspended one is
  unlinked. Everything else goes to the owner's bots exactly as a delivery to their own webhook
  does (watch modes, the PR gate, batching, the hourly cap, learning signals).
- **Tokens:** a bot that watches repos an installation covers gets, for each run, a GitHub
  installation token narrowed to those repos (contents, pull requests and issues to write; checks,
  statuses and metadata to read), as `GH_TOKEN` and `GITHUB_TOKEN`. It lasts an hour and isn't
  stored. A bot with a `GH_TOKEN` of its own granted keeps using that one.
- MCP: `connect_github` gives Amb the link to hand over; `github_webhook` points to it when the
  App is there.

## GitHub Apps

Besides the shared App above, each template role has an App of its own, and a bot can have its own
too, so on GitHub each shows as its own user with just its role's access. A Reviewer can then
approve a Builder's pull request (GitHub refuses a review of one's own).

- **The role Apps:** Ambient Builder, Ambient Reviewer and Ambient Wiki Keeper. A server's
  operator makes each once: `admin github-app new <builder|reviewer|wiki_keeper> --account <org>
  [--name <name>]` prints a link, the operator taps Create on GitHub, and GitHub sends the browser back to
  `/v1/github/app-created`. The gateway trades the one-time code for the App's key and webhook
  secret, seals both with its master key into Convex (`githubApps`), and the App works at once,
  with no restart and nothing to copy. Each is public, so anyone using the server installs it.
  App names are unique across all of GitHub, so by default the name carries the account
  ("Ambient Reviewer (acme)", shortened to GitHub's 34 characters); Ambient's own server uses
  `--name "Ambient Reviewer"`.
- **What each may do:**

  | App | Code | Pull requests | Issues | Events |
  |---|---|---|---|---|
  | Builder | write | write | read | PRs, reviews, comments, checks, issues |
  | Reviewer | write in the App, **read in each run's token** (write is for merging later) | write | read | PRs, reviews, comments, checks |
  | Wiki keeper | write | write | none | PRs, reviews, comments, checks, push |
  | shared and a bot's own | write | write | write | all of these |

- **Which App a bot works through:** a bot from a template has its role (`app` in its GitHub watch
  record). It works through its role's App once the owner installed that App on all its repos;
  otherwise through the shared App when that covers them; otherwise through the owner's webhook
  and `GH_TOKEN`. A bot's own App comes first.
- **One event, once:** a delivery reaches only the bots whose App it came through. A delivery to
  the owner's webhook reaches only bots no App covers. A failed CI run on the default branch is
  told once, whichever App brings it first.
- **Connecting:**
  - `GET /v1/app/github?routine=<id>` adds `forBot: { app, slug, role, connected }` (the App that
    bot is meant to work through, and whether it does) and `apps`.
  - `POST /v1/app/github/connect?routine=<id>` gives that App's install link. Without `routine`
    it gives the shared App's.
  - The same `routine` goes on the MCP tool `connect_github` as `bot`.
- **A bot's own App:** `POST /v1/app/routines/:id/github/app` with `{ "account"? }` (default: the
  owner of its first repo) → `{ "url" }`; the MCP tool `github_app_for_bot` (`bot`, `account`?)
  gives the same link. That's the gateway's page, which posts the manifest to
  GitHub (an organization's settings, or the user's). After Create, GitHub comes back to the
  gateway, which keeps the App and sends the browser straight on to its install. The App is
  private to that account and named "<bot> (<account>)". Deleting the bot drops the App's record;
  the App itself stays on GitHub until someone deletes it there. GitHub doesn't let a service set
  an App's icon: that's uploaded by hand in its settings (Display information).
- **Webhooks:** the shared App at `/v1/hooks/github-app`; every other App at
  `/v1/hooks/github-app/<hookId>`, signed with its own secret.

## Automations

Things Amb does **for the person** without being asked each time. The rule: templates are for
bots ("Bot templates"), automations are only for the person. Watching their bots is part of Amb's
job (its settings, below), and every bot learns on its own ("How bots learn"); neither is an
automation to find and switch on.

One automation is **when** (a time, or an event) + **what** (instructions) + **where** (delivery),
and Amb stays silent (`NOTHING`) when there's nothing worth saying. Code decides when; Amb decides
what to say, in an internal turn of its own (a short session beside the chat). Personal (per
person); stored as sealed records, so new templates need no Convex deploy.

### Templates

| id | Name | When | Delivery |
|---|---|---|---|
| `morning_brief` | Morning brief | weekdays 08:00 | `chat` |
| `waiting_on_me` | Waiting on me (decisions, bots asking, action items, approvals) | weekdays 12:30 | `chat` |
| `after_meeting` | After every meeting | event `meeting_note` | `chat` |
| `weekly_review` | Weekly review | Fridays 16:00 | `chat` |
| `new_in_brain` | New in the brain | daily 18:00 | `chat_silent` |

Times are in Europe/Vienna until changed. "Watch my bots" and "Improve my bots" were templates
once: stored ones are left out of the list and never run (`POST` with those ids: 400,
`no_such_template`, saying where they went); a "Watch my bots" that was switched off becomes
`notify: "never"` until Amb's settings are changed.

### An automation

```json
{
  "id": "a3f9c1d2e4b5a",
  "template": "morning_brief",
  "name": "Morning brief",
  "enabled": true,
  "trigger": { "kind": "time", "schedule": { "every": "weekday", "time": "08:00", "timezone": "Europe/Vienna" } },
  "instructions": "…",
  "delivery": "chat",
  "when": "Weekdays at 08:00 (Europe/Vienna)",
  "nextRunAt": 1763449200000,
  "lastRun": { "at": 1763362800000, "by": "schedule", "event": null, "result": "sent", "text": "…" },
  "createdAt": 1763300000000,
  "updatedAt": 1763300000000
}
```

- `trigger`: `{ "kind": "time", "schedule": <a loop's schedule> }` or `{ "kind": "event", "events": [..], "hours"?: n, "bot"?: id | null }`.
  Events: `bot_failed` (a bot's run failed), `bot_corrected` (the person wrote to a bot, not
  answering its question), `bot_asked_twice` (a bot asked much the same question it asked before),
  `decision_waiting` (a decision waited `hours`, default 4), `meeting_note` (a recorded meeting or
  call landed in their brain or a team's brain they recorded for), `github_ci_failed` (CI failed on
  the default branch of a repo one of their bots watches, through the owner's GitHub webhook; a
  team's webhook tells the team's people). `bot` limits bot events to one bot. (Bot events are for
  the person's own automations, "tell me when Blog fails"; the bot's learning gets them anyway.)
- `delivery`: `chat` (a message in Amb's chat and a push, collapse id `automation-<id>`; no push
  22:00–07:00), `chat_silent` (the message, no push), `thread` (bot events: a note in the bot's
  thread).
- `lastRun.by`: `schedule`, `event`, `manual`; `result`: `sent`, `silent` (Amb said NOTHING),
  `failed` (`text` says why).

A time automation runs once per due time: the due time is recorded before it runs, so a restart
never runs it twice; one missed while the gateway was down runs late only within two hours, and
only the latest missed time. An event runs an automation once (its key is remembered), at most 20
event runs per automation a day. A person's automations run one at a time.

### The app's API

- `GET /v1/app/automations` → `{ "templates": [{ "id", "name", "description", "trigger", "instructions", "delivery" }], "automations": [Automation] }`
- `POST /v1/app/automations` with `{ "template": "morning_brief" }` (and any of `name`, `enabled`,
  `trigger`, `instructions`, `delivery` to change it), or from scratch `{ "name", "trigger", "instructions", "delivery"? }`
  → `{ "automation": Automation }`. Up to 30.
- `PATCH /v1/app/automations/:id` with any of `name`, `enabled`, `trigger`, `instructions`,
  `delivery` → `{ "automation": Automation }`. A new time, or switching one on again, starts from
  now (nothing missed meanwhile runs).
- `DELETE /v1/app/automations/:id` → 204.
- `POST /v1/app/automations/:id/run` → 202 `{ "status": "started" }`: runs now in the background;
  the result shows in `lastRun` and the runs.
- `GET /v1/app/automations/:id/runs` → `{ "runs": [AutomationRun] }` (newest first, the last 20).

MCP tools for Amb: `list_automations` (with an `id`: its instructions and runs), `create_automation`,
`update_automation`, `delete_automation`, `run_automation` (waits for the result). Amb creates or
changes automations only when the person asks.

## Amb's settings

Per person, a sealed record:

- `notify`: `"important"` (default: the heartbeat, every half hour 08–21, tells them when a bot
  failed, a decision waited over two hours, or a command waits for approval; at most six messages
  a day, none at night) or `"never"`.

`GET /v1/app/ambient/settings` → `{ "notify": "important" }`; `PUT` with `{ "notify" }` → the same.
MCP tool `ambient_settings` (`{ notify? }`), changed only when the person asks.

## Bot templates

A whole bot to set up in a minute: its `AGENTS.md`, skills, an optional `GOAL.md`, how it works
on GitHub, the secrets it needs, and two or three questions whose answers fill it in. It learns on
its own from the start (`learn: "auto"`).

| id | Name | Face | GitHub | Runtime | Schedule (besides GitHub's events) |
|---|---|---|---|---|---|
| `review_bot` | Reviewer | sage pebble, thick glasses | `all_prs` | Codex when the computer has a Codex sign-in (a second model's eyes), else Claude Code | none (`needed`): its first run reviews what nobody reviewed for a day |
| `builder` | Builder | sky cap, hoodie | `own_prs` | Claude Code | with a `label`, weekdays 09:00: labelled issues; without, none (`needed`): what the owner writes |
| `wiki_keeper` | Wiki keeper | sand dome, reading glasses | `merges`, `own_prs` | Claude Code | Fridays 15:00: the week's merges |

Questions (`id`, kind, default):

- `review_bot`: `repos` (repos, required); `strictness` (choice `blockers_only` | `everything`,
  default `blockers_only`); `focus` (text, optional: areas to watch closely).
- `builder`: `repos`; `label` (text, default `ambient`: issues with this label; empty: only what
  the owner writes to it); `goal` (text, optional: becomes its `GOAL.md`).
- `wiki_keeper`: `repos`; `where` (choice `both` | `docs` | `wiki`, default `both`); `docs` (text,
  default `docs/`).

Skills: the Reviewer `review-checklist` (security, data, tests, migrations, performance, errors)
and `brain-check` (search the brain for decisions and product pages the change touches, quote
them, ask); the Builder `pr-gate`; the Wiki keeper `what-to-update`. Each needs `GH_TOKEN`; the
template says which rights in words (no merge rights for any).

- `GET /v1/app/bot-templates` → `{ "templates": [{ "id", "name", "face", "color", "wear", "description", "runtime", "github": [..], "secrets": [{ "name", "why" }], "report", "delegate", "schedule", "questions": [{ "id", "label", "kind": "repos"|"choice"|"text", "options"?: [{ "id", "label" }], "default"?, "required", "hint"? }] }] }`
- `POST /v1/app/bots/from-template` with `{ "template", "answers": { "<question id>": "…" | ["owner/name"] }, "team"?, "computer"?, "name"?, "look"?: { "face"?, "color"?, "wear"? }, "schedule"? }`
  → `{ "routine": Routine, "needs": { "secrets": ["GH_TOKEN"], "webhook": true } }`: made in the
  app it's on at once; `needs` says what's still missing (secrets not stored yet for that owner,
  and the webhook on its repos). `400 bad_request` for missing or wrong answers,
  `no_such_template` for an unknown id, `400 bot_needs_computer` for a bot of one's own without
  a computer (the `computer` given, or the person's only ready one).

A bot of one's own always has a computer: creating one without (here, `POST /v1/app/routines`,
the MCP tools), making a loop without one a bot, or taking a bot's computer away answers
`400 bot_needs_computer`. A team's bots run on the team's server.

MCP tools: `bot_templates`, `create_bot_from_template` (made paused, as anything an AI app
creates).

## How bots learn

Built into every bot, always on: nothing to switch on or find.

**Signals** (kept per bot, the last 200, sealed records): a run failed; its owner corrected it (a
message after a result); it asked the same thing twice; on GitHub, its pull request merged as it
left it (`merged`), merged after a person pushed to it (`merged_edited`), closed without merging,
reverted (a merged `Revert "…"` whose body says `Reverts owner/repo#N`), changes requested by a
person, a person's push to its branch (the branch's first pusher is the bot), marked ready (with
the hours since it was opened); for a reviewer, each of its comments when the pull request
closes: followed by a change (a push after it) or a false alarm (no push after it, or the team
answered "won't fix", "not a bug", "intended"…). Only people from the team count (GitHub's
`author_association` OWNER, MEMBER or COLLABORATOR), never accounts ending in `[bot]`.

**Lessons.** A few minutes after a negative signal (a failure, a correction, a question twice,
closed, edited, reverted, changes requested, a person's push, a false alarm), Amb looks at what
went wrong (its own short session) and improves the bot: with `learn: "auto"` (default) it writes
`memory.md` and skills itself (a version each, undo in Files, a note in the thread for skills);
with `"ask"` every improvement is a proposal. `AGENTS.md`, `GOAL.md` and settings are always
proposals (`propose_bot_change`: a decision with Apply / Not now; while Amb works on a bot, writing
them is refused). A lesson is one line in `memory.md`: `- <source> (<date>): <lesson>`, merged
with one that says the same, dropped when no longer true.

**The scorecard** (last 7 and 28 days): pull requests merged and closed, merge rate, merged after
a person's edits (count and rate), median hours to ready, reverts, changes requested, failed runs,
corrections; for a reviewer, comments that led to a change vs false alarms (precision).

**Monday mornings** (08:00 Vienna, once a week per bot with something to say): a retro in the
bot's thread, "This week: …" with its scorecard. And a lesson two to four weeks old after which
things got worse (merge rate down 20 points or more, edits by people up 20 or more, a revert more,
or a reviewer's precision down 20 points; at least two pull requests or three comments each side)
is proposed for undoing: a decision to restore `memory.md` as it was before.

- `GET /v1/app/routines/:id/learning` → `{ "learn": "auto"|"ask", "lessons": [{ "text", "source", "date" }], "scorecard": { "week": Scorecard, "month": Scorecard }, "signals": [{ "at", "kind", "text", "source"?, "hours"?, "count"? }] (newest first, 20), "changes": [{ "path", "version", "by": { "kind", "name" }, "why", "at" }] (memory.md and skills by Amb or the bot, newest 10) }`
- `PUT /v1/app/routines/:id/learning` with `{ "learn": "auto"|"ask" }` → the same (who may change
  the bot; everyone who sees it reads).
- `Scorecard`: `{ "days", "prs", "merged", "closedUnmerged", "mergeRate", "humanEdits", "humanEditRate", "medianHoursToReady", "reverts", "changesRequested", "runsFailed", "corrections", "review": { "useful", "falseAlarms", "precision" } }`
  (rates and the median null without data).

MCP tool `bot_learning` (`{ id, learn? }`).

Next: a team conventions page in the brain, where lessons that hold for every bot of a team (and
for people and their AI apps) go instead of into one bot's memory.

### Proposals

A proposal is a decision like a bot's question, with `change` set:

```json
"change": { "routineId": "…", "bot": "Blog", "path": "AGENTS.md", "content": "…the new file…" }
```

(or `"settings": { … }` instead of `path`/`content`; `change` is null for questions). Answering
`Apply` (or "yes", "ja", "ok", "do it", in the app or in words) makes the change as the person and
the answer records what came of it (`"Apply → AGENTS.md changed (version 4)."`); anything else
leaves the bot as it is.
