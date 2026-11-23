# Bots (first version)

Bots are loops with a face, a thread and a chat with Ambient on top. A bot is a routine with
`bot` settings: the runner starts it the same way (a systemd timer, "Run now"), and the app shows
it as a small character whose face says how it's doing. Ambient, the master bot, is a chat in the
app that answers from the brain and looks after the bots.

Bots are everyone's: there's no switch, and every routine is a bot. Claude Code and Codex are the
runtimes, behind the seams that let
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

Errors are `{ "error": code, "message": sentence }` as elsewhere.

### `GET /v1/app/features`

```json
{ "bots": true, "loopsAreBots": true }
```

Always the same now that every routine is a bot; kept for apps that ask.

### Routines carry `bot`

`GET /v1/app/routines`, `GET`/`PATCH`/`POST` of one routine: each routine has `bot` (every
routine is a bot):

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
sent and must be `claude-code` or `codex`). Without it a new routine gets a bot's defaults;
`"bot": null` on PATCH is refused (`bots_only`).

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
`{ "message": ThreadMessage, "routine": Routine }`. A personal bot's owner writes to it.

With `"question": "<message id>"` (a choice tapped under a question, and every decision's answer,
`POST /v1/app/decisions/:id`) it answers that question, even when the bot has asked something newer
since: a bot keeps one open question, so an older card's answer used to go to the newest question,
or became a plain message while the card stayed. That older question is settled with its decision
and the newer one stays open. The bot reads the answer with the question in front ("Answer to your
question “…”:"); the thread gives the answer alone with `replyTo: { id, text }` (the question and a
line of it), which the app shows as an inline reply. 404 `no_such_question`, 409 `already_answered`.

#### A team bot's thread is a group chat

Everyone in the team writes to a team bot's thread, and everyone sees what the others wrote, with
their names (`mine` tells one's own). The routine says so: `canMessage` (write in the thread) next
to `canEdit` (its settings, run, delete: still the team's owners and admins).

- **Pushes:**
  - a teammate's message goes to everyone else in the team ("Helper · Lab", "Ben Weiss: …");
  - the bot's answer (a run's result in the thread) goes to whoever wrote to it since it last said
    something;
  - its question goes to the whole team, but it's its maker's to answer: the decision, and
    Ambient answering from the brain (`not_yours` for anyone else's Ambient), stay with whoever
    made the bot. Another member's reply is a message the bot reads, and the question stays open.
  - A failed run still goes to whoever started it.
- **Read is each person's own** (Convex `botReads`): one person opening the thread doesn't take
  the "done" news away from the others. A personal bot keeps `routines.seenAt`.

#### Searching the bots

`GET /v1/app/bots/search?q=…` (the Bots list's search field) finds words across the person's chat
with Ambient and the threads of every bot they see, newest first, up to 50: `{ hits: [{ at, who,
where, text, botId, messageId }] }`, `botId` null for the chat with Ambient. It's the same search as
`search_history` (bots/history.ts: the gateway opens the sealed messages page by page, no index),
messages only (no handoffs). Every word must appear; accents and case don't matter.

#### Unread

The Bots list marks what's new, as Messages does. A bot is `unread` (in `bot`) when its newest
message came after the person last opened its thread (`seenAt`; a team bot's read is each person's,
`botReads`). Ambient's chat is unread when Ambient wrote after the person last opened it
(`ambientState.chatSeenAt`): `GET /v1/app/ambient/summary` answers `{ unread, last: { text, at } }`
for its row. Opening reads: `GET …/thread` and `GET /v1/app/ambient/chat` mark it, unless they're
asked with `?seen=0` (a fetch ahead nobody looks at yet). Reading and Ambient's messages move the
`routines` revision, so the person's other devices follow.

#### Live text

A bot's answer shows as it's written, like Claude's own apps. The runner (0.15.0 on) starts Claude
Code with `--include-partial-messages` and sends the block it's writing and the tool it's using,
at most five times a second, to `POST /v1/host/runs/:runId/live` `{ seq, text, tool }`. The
gateway keeps it in memory only (`gateway/src/bots/live.ts`) and sends it as `event: bot_live`
`{ routineId, runId, text, tool, seq }` on `/v1/app/events` to everyone who may read the thread
(its owner, or the team's people), and as `live` in `GET …/thread` for a thread that opens
mid-answer. When the message is in the thread (the run's result, or a reply while it goes on)
they get `{ …, done: true }`. A subagent's words aren't sent; another computer's, or a run that's
over, answers 404 and the runner stops sending. Codex runs don't send it yet.

### Ambient (the master bot)

`GET /v1/app/ambient/chat`:

```json
{ "messages": [{ "id": "…", "role": "user", "text": "How are my bots?", "via": "app", "createdAt": 1763380000000 },
               { "id": "…", "role": "ambient", "text": "Dev opened PR #41 …", "via": "app", "createdAt": 1763380000000 }],
  "pending": false }
```

`via` is where a message was written, and where Amb's answer to it went: `"app"`, or a channel
(`"imessage"`; see [Channels](#channels)).

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

There are no plain loops: every routine is a bot, for everyone (there was a switch, `BRAIN_BOTS`,
until 2026-11-20). `GET /v1/app/features` still says so for apps that ask
(`{ "bots": true, "loopsAreBots": true }`).

- A routine made without `bot` settings (app or `create_routine`) is a new bot: its own container,
  no keys until granted, news only. A bot of one's own needs a computer.
- `PATCH { "bot": null }` (back to a plain loop) answers `400 bots_only`.
- Loops from before (a server that had bots off) become bots at the gateway's start
  (`bots.adoptPlainLoops`, once and safely): each runs exactly as before, on the computer itself
  with all of its owner's keys, reporting news, with a face and colour picked from its id.
  `admin bots adopt-loops <email|user id> [--team <slug>] [--dry-run]` does the same for one
  person or team, and also records the prompt as AGENTS.md's first version ("was a loop").
- Ambient's background work (the heartbeat, Amb's nightly memory, automations, learning) is for
  everyone with bots or a chat with Ambient (Convex `bots.people`).

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

## Slack

Each bot can have its own Slack app, so in Slack it's its own @handle with its own face: `@chatty`
in a channel or a direct message reaches Chatty, and Chatty answers in that thread. Ambient makes
the app; the person taps Allow once (`gateway/src/bots/slack-apps.ts`).

- **The workspace, once.** Slack makes apps from a manifest with an app configuration token. The
  person generates one at api.slack.com/apps → "Your App Configuration Tokens" → Generate Token,
  and gives Ambient its refresh token (`xoxe-…`): `PUT /v1/app/slack` `{ "refreshToken" }`
  (`?team=<slug>` for a team's bots, by its owners and admins). Ambient renews it at once
  (`tooling.tokens.rotate`: that checks it and starts its 12 hours) and again whenever less than
  15 minutes are left; a refresh token works once, so renewals for one workspace never overlap.
  `GET /v1/app/slack` → `{ "connected", "teamId" }`; `DELETE` forgets it.
- **A bot's app, one tap.** `POST /v1/app/routines/:id/slack` → `{ "url", "installed" }`: Ambient
  creates the app from a manifest (`apps.manifest.create`: the bot's name, a bot user, the scopes
  below, events to `/v1/hooks/slack/<hook>`, the redirect to `/v1/slack/installed`) and returns
  Slack's Allow link. Asking again before it's installed gives the same app. After Allow, Slack
  sends the browser to `/v1/slack/installed`, the code becomes the bot's token (`oauth.v2.access`),
  and the page says how to reach it. `GET /v1/app/routines/:id/slack` →
  `{ "workspace": bool, "app": { "appId", "installed", "botUserId", "teamName" } | null }`.
- **Its face.** `PUT /v1/app/routines/:id/slack/icon` with a PNG (512 to 2000 px square;
  `apps.icon.set`). The app renders the bot's face and sends it.
- **Scopes:** `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`,
  `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `reactions:write`,
  `users:read`, `files:read`, `files:write` (an app from before files gets them with one more Allow:
  `POST /v1/app/routines/:id/slack/allow`; until then `news.files` is false). **Events:**
  `app_mention`, `message.im`.
- **What Slack sends.** The hook in the event URL is signed by Ambient and names the bot and its
  owner, so an event finds its app without a table; each event is then checked with that app's
  signing secret (`v0` HMAC, at most 5 minutes old). Slack's first check of the URL
  (`url_verification`, while the app is being made) only needs the hook to be Ambient's. An event
  Slack sends again is taken once.
- **Who it listens to.** Whoever installed it (the Slack user who tapped Allow): its runs hold its
  owner's secrets. An install where Slack doesn't say who allowed it is refused, and an app without
  a known installer takes instructions from no one. Anyone else who mentions it is told once per thread that it takes instructions
  from that person. Its own messages, other bots', edits and joins are left out.
- **A message.** An @mention or a DM goes into the bot's thread from "Slack" ("Lena wrote to you
  on Slack (in a channel): …", Slack's links as text), gets a 👀 on Slack, and starts a run
  like its owner's message. A paused bot says so in the Slack thread.
- **The answer.** Each Slack message waits for the run that takes it: the run that starts after
  it (a run sees everything already in its thread), or the run going at the time if it takes the
  message in mid-run (its inbox). Only that run's replies, its question with the choices, and its
  result go back to that Slack thread, as Slack's markup (bold, links, headings; code as is), in
  parts of at most 3,500 characters; its end closes the thread. Another run's output (a scheduled
  run that was already going, a GitHub wake-up) never reaches Slack. Up to 10 threads wait at
  once; one nobody answered within 6 hours goes.
- **Posting on its own.** A bot with an installed app gets its token as `SLACK_BOT_TOKEN` in every
  run (unless it has a secret of that name), so it can post as itself: a nightly digest in a
  channel it was invited to.
- **From the person's AI (MCP).** `connect_slack` (the refresh token, once; without it: whether it's
  connected and how to get one; `disconnect`) and `slack_for_bot` (the Allow link as a Markdown
  link; `remove`). The same as the app's buttons, so it works before the app has them.
- **Taking it out.** `DELETE /v1/app/routines/:id/slack` deletes the app in Slack
  (`apps.manifest.delete`) and forgets it here.
- **Where it's kept.** The workspace's tokens, each app's client secret, signing secret and bot
  token, and where its answer goes: sealed records (kinds `slack:workspace`, `slack:app`,
  `slack:reply`), no table of their own, so nothing in Convex changes.
- **Not yet:** Slack's partners can install an app without the Allow tap (`managed_apps:install`),
  but that scope isn't open to developers. Team members other than the installer, and a shared
  "Ambient" app for bots without their own, come later.

## Microsoft Teams

Each bot can have its own Microsoft Teams app, so in Teams it's its own name with its own face: a
direct message, or an @mention in a channel, reaches it, and it answers in that thread. The same
shape as Slack, with one difference: Microsoft stopped new multi-tenant bots on 2025-07-31, so a
bot can't be Ambient's. Each one is made in the company's own Microsoft tenant: a single-tenant app
registration and a free Azure Bot (F0) in the company's Azure subscription
(`gateway/src/bots/teams-apps.ts`, the package in `teams-package.ts`).

- **The company, once.** An admin opens Ambient's Microsoft sign-in:
  `POST /v1/app/teams/connect` → `{ "url" }` (`?team=<slug>` for a team's bots). Ambient's setup
  app (`BRAIN_TEAMS_APPS_CLIENT_ID`, a multi-tenant Entra app of Ambient's own) asks for the
  delegated `Application.ReadWrite.All`, `AppCatalog.ReadWrite.All`, `User.ReadBasic.All` and
  Azure's `user_impersonation`, which the admin accepts for the organisation. Back at
  `/v1/teams/connected`, Ambient keeps the tenant and the admin's refresh token (sealed), picks the
  first Azure subscription that's on, turns on `Microsoft.BotService` there and makes the resource
  group `ambient-bots` (West Europe). The admin needs: Global admin, or Application admin + Teams
  admin, and Contributor on a subscription. `GET /v1/app/teams` →
  `{ "connected", "tenantId", "admin", "subscription", "subscriptions" }`; `PUT` `{ "subscriptionId" }`
  for new bots; `DELETE` forgets it. Every token call keeps the new refresh token Microsoft hands
  back; one call per owner at a time.
- **A bot's app, one call.** `POST /v1/app/routines/:id/teams` → `{ "url", "chatUrl", "installer",
  "installed" }`, as that admin: the app registration (`<name> (Ambient bot)`, `AzureADMyOrg`), a
  secret (two years), its service principal; the Azure Bot (`ambient-<name>-<hex>`, `SingleTenant`,
  its endpoint `/v1/hooks/teams/<hook>`; asked again a few times while the new registration reaches
  Azure) with the Teams channel on; the app package (manifest 1.17, the bot's 192 px face and a
  32 px outline) into the company's Teams app catalog. Each step is kept as it's done, so asking
  again after a failure goes on where it stopped; a refusal names the role the admin lacks. `url`
  opens the app in Teams (one tap: Add); `chatUrl` opens a chat with it.
- **Who it listens to.** The person who added it in Ambient, found in the company by their
  sign-in email (`GET /users/<email>`); when they aren't there, the admin who connected Teams.
  Anyone else is told once per chat that it takes instructions from that person.
- **What Teams sends.** The hook in the endpoint is signed by Ambient and names the bot, so an
  activity finds its app without a table; it is then checked as the Bot Framework's for that bot's
  app id (`msteams/botframework.ts`), and refused from another tenant. An activity Teams sends
  again is taken once. A direct message, an @mention in a channel or a group chat, or a reply in
  the thread under a post of its own (resource-specific consent `ChannelMessage.Read.Group` in the
  manifest) goes into the bot's thread from "Teams" and starts a run; "…is typing" shows meanwhile.
  When its owner adds it, it says hello.
- **The answer.** As in Slack: only the run that took a Teams message answers it, into that chat
  or channel thread (`<channel>;messageid=<root>`), as Markdown, in parts of at most 3,500
  characters.
- **Its questions as cards.** When a run that took a Teams message asks its owner (`ask_owner`),
  the question goes to that chat or thread as an Adaptive Card: the question, what it's about, a
  button per choice and a box to write something else ("Send"). A click (`Action.Submit`, data
  `{ ambient: "answer", q, o }`) or a reply typed in that chat or thread answers it as its owner
  would in the bot's thread (the person who added it in Ambient), while it's still the open
  question; the card is then replaced by the answer ("✓ Yes · Answered by Lena"), or by "Already
  answered" when it was settled elsewhere. Anyone else who clicks is told who answers.
- **News of its own.** One channel, chosen by its owner (`PUT /v1/app/routines/:id/teams/news`
  `{ "channel": id | null }`; by default the first channel it was mentioned in), posted with its
  tool `post_to_teams` as a new post; replies under that post reach it.
- **Its face.** `PUT /v1/app/routines/:id/teams/icon` with a PNG of exactly 192 × 192 px: a new
  version of its app in the catalog (`appDefinitions`), which Teams rolls out.
- **From the person's AI (MCP).** `connect_teams` (the sign-in link; `status`, `subscription`,
  `disconnect`) and `teams_for_bot` (the Teams link; `news_channel`; `remove`).
- **Taking it out.** `DELETE /v1/app/routines/:id/teams` deletes its Teams app, its Azure Bot and
  its app registration, and forgets it here.
- **Where it's kept.** Sealed records (kinds `teams:tenant`, `teams:app`, `teams:reply`), nothing
  new in Convex. The bot's secret never leaves the gateway.
- **Not yet:** a new secret before the two years are up, and installing it for the owner without the
  Add tap.

## Files in Slack and Teams

Every bot takes and sends files wherever it's reached, as in the app (`gateway/src/channels/channel-files.ts`).

- **Coming in.** Files sent with a message to a bot (Slack: a message's `files`, also a
  `file_share` with no text; Teams: a file in a chat with the bot, a pasted picture) are
  downloaded, checked like the app's (4 files, 10 MB together; images, PDFs, text and Office
  files; HEIC photos become JPEG) and kept in the bot's thread with the message
  (`attachments.save`). Its run gets them on disk like a file sent from the app; a file that comes
  while it works too (the inbox carries them, runner 0.17.0 fetches them). What can't be passed on
  is named in the message with the reason ("not passed on to you: Budget.xlsx (…)"), so the bot
  never works from a screenshot it didn't get. Slack needs `files:read`; a file shared in a Teams
  channel or group chat stays in SharePoint, which the bot can't open: it's named, with "send it
  to me in a direct chat".
- **Going out.** Files a run sends (`send_file`) go where its words go: into the Slack thread as an
  upload (`files.getUploadURLExternal`, then `files.completeUploadExternal`, needs `files:write`;
  without it, a line that the file is in Ambient), and into the Teams chat or thread as a picture
  inline (up to 1 MB) or a card with a Download link (`/v1/teams/files/<signed>/<name>`, signed by
  Ambient, for 7 days; the file stays in the bot's thread).
- **Amb** takes and sends files in the app and on iMessage already; in Slack and Teams it will by
  the same code.

## Amb in Slack and Teams

Ambient itself gets its own app in a company's Slack or Teams, made like a bot's ("Ambient", or the
name the company gives it, like "ACME Brain"): `POST /v1/app/slack/ambient` / `POST
/v1/app/teams/ambient` `{ "name"? }` (`?team=<slug>` for a team's workspace), `GET` for its state,
`DELETE` to take it out; from the person's AI, `connect_slack` / `connect_teams` with `ambient: "add" | "remove" | "status"`.
Its records live with the owner under the key `amb` (`gateway/src/channels/amb-doors.ts`). Who it
serves depends on where it's written to, decided in code, never by the model:

- **A direct message** is matched to an Ambient account by the writer's email (Slack:
  `users:read.email`, only Amb's app asks for it; Teams: the member's email), among the people the
  owner covers (the person, or the team's members). It goes into that person's own Amb chat, as
  another door like iMessage: the same conversation, the answer goes back there, files both ways.
  That DM is kept as the person's door (`slack:amb-link` / `teams:amb-link`), so "Reach me on"
  can be Slack or Teams (`reach: "slack" | "teams"`, once they wrote there). In Teams, Amb's
  decisions come as cards (a button per answer and a box; a click files the answer as that person,
  `via: "teams"`). Someone with no account is told once that their email isn't on one.
- **A channel or group chat** (an @mention) gets the team's Amb (`gateway/src/bots/team-amb.ts`):
  only where a team connected the workspace; it runs on the team's own computer (the one for its
  bots) as a short session apart from anyone's chat, with the asker's token for that team alone
  (`resource: team`), so no personal note, bot or chat can reach a channel; what it may change, it
  may as the asker. Each thread is a **lane** (the team wiki's `product/conversations.md`): one
  Claude Code session on the team's computer (`ComputerJob.lane`, a folder `lanes/<lane>` there),
  resumed every turn with only what people said in the thread since it last answered. A new thread,
  or a computer without the session, starts cold from the whole thread and the lane's turns (the
  runner reads `history` only when it has nothing to resume). The lane's record (sealed with the
  team, kind `team-amb:thread`, no end date) keeps its session id, how far it has read, and its
  turns.
- **Sessions move with their lane.** After each answer the runner (0.18.0) sends the lane's
  session file, gzipped, to `POST /v1/host/ambient/lanes/:lane/session`; the gateway seals it with
  the lane's owner's key and keeps it in Convex (`sessionBackups`, one per lane, up to 12 MB). A
  computer that doesn't have the session (wiped, replaced, or another one) fetches it with `GET` on
  the same path before it resumes. A computer may only send or fetch a lane it was given a turn of
  in the last 2 hours. Forget chat removes the person's backups.
- **"new chat"** typed alone in iMessage, Slack or Teams starts over, as New chat in the app.
- **Turns in flight are written down** (`gateway/src/bots/turn-queue.ts`, Convex `turns`). A
  message to Amb (the app, iMessage, a Slack or Teams DM) and a team Amb's channel turn are listed
  before the answer starts and removed once it's out. A gateway that restarts in between picks
  them up again 5 seconds after it starts (at most 3 tries each): the chat's answer goes back
  through the door it was asked in, a channel's is posted in its thread. Files sent with a channel
  message aren't kept for that. A bot's messages were already durable (its thread in Convex).
- **A bot's threads are lanes too** (`gateway/src/bots/bot-lanes.ts`). A message from a Slack or
  Teams channel thread (or a group chat) carries its lane; the run it starts resumes that lane's
  session (none yet: fresh, with handoffs and the whole thread), and when the run ends its session
  is kept for the lane, with how far it has read, so the next message there brings only what's new.
  The app and DMs are the bot's main lane (the bot's last conversation, as before). Scheduled runs
  and GitHub wake-ups are work: fresh with handoffs, no lane.
- **A thread is read as a thread.** Tagged inside a Slack or Teams thread, a bot or Amb gets what
  was said there before, also what people said to each other (Slack: `conversations.replies`;
  Teams: Graph with the bot's own app and its resource-specific consent), by name, its own
  messages as "you", and where it is ("in #anomalies", "in Engineering › anomalies").
  Without a team computer, the server's key answers where the operator pays (read-only team tools),
  else it says how to connect one.

## MCP connections

A person or a team connects a service's MCP server once and gives it to individual bots, or to
Amb (`gateway/src/bots/mcp-connections.ts`). A bot starts with none. This is how a bot gets a
service Ambient has no integration of its own for: anything with an MCP server.

```
the app or an AI app ──▶ POST /v1/app/mcp-connections { name, url, key }
     ──▶ the gateway checks the address, asks the server for its tools, keeps it sealed
PUT /v1/app/mcp-connections/:id/grants { bot, on } ──▶ that bot's next run gets it
a bot's run ──▶ POST /v1/bot/mcp/:id (its run token) ──▶ the gateway checks the grant
     ──▶ calls the service with the key ──▶ the answer goes back to the run
```

- **The key never leaves the gateway.** A run is given an address at Ambient (`/v1/bot/mcp/<id>`)
  and reaches it with its own run token, good while it runs; the gateway (`bots/mcp-relay.ts`)
  makes the call to the service. Nothing the runner receives holds the key or the service's
  address. A bot is a model running commands on a machine: it shouldn't hold a token for someone's
  Notion.
- **The grant is checked on every call.** Taking a connection away, or removing it, holds from the
  bot's next tool call, also in a run that's still going. Another bot's run, a run that's over and
  a made-up token all get 404 or 401, the same answer whether the connection exists or not.
- **A person's connection goes to their own bots and to Amb; a team's to the team's bots**, added
  and given by its owners and admins. Amb uses the person's own connections only.
- **In a run** the connection is one more MCP server next to `ambient` and `ambient-bot`, named by
  the connection's slug ("Notion (Miora)" → `notion-miora`), so its tools are
  `mcp__notion-miora__…`. Runner 0.16.0 adds them for Claude Code and for Codex; it takes only
  names that can't shadow the run's own servers and only addresses at the gateway's relay.
- **Amb** gets its connections in its session on a computer, with that session's own token; a
  change takes effect with the person's next message (the session starts again and carries on).
  Without a computer (the server's key), Amb doesn't have them.
- **Addresses** must be https and public: nothing inside our own network (private, loopback and
  link-local ranges), no credentials in the address, and no redirects, so a key only ever goes to
  the host it was given for. The address is checked before every request, and the connection
  itself is made only to an address that was looked up and checked in its own lookup (an undici
  `Agent` with `connect.lookup`), so a name that answers a public address to the check and a
  private one to the connection (DNS rebinding) reaches nothing. The same holds for the sign-in's
  calls, whose addresses come from the server's own headers.
- **Tools only**, over Streamable HTTP: no resources or prompts, no server that only speaks the
  older SSE transport. Up to 200 tools per connection; a tool's description and schema are cut to
  what a model should have to read. The key goes as `Authorization: Bearer`, or in another header
  when the service wants one (`header`).
- **A sign-in instead of a key.** A server that refuses without a key and offers OAuth the way MCP
  has it (protected-resource and authorization-server metadata, PKCE) is connected by signing in
  at the service's own page: adding it answers with a link there (`signIn.url`); the service sends
  the person back to `/v1/mcp/connected` with a code and the state the sign-in was started with,
  and only then is the connection kept. Ambient registers itself as the service's client where the
  service lets clients do that (dynamic client registration); a service that wants a client
  registered by hand isn't supported yet. A state works once, for half an hour. Ambient holds the
  sign-in (never shown, never sent to a run), renews it when it ran out and keeps the new one. When
  it can't be renewed, the bot's call says so, the connection reads `needsSignIn: true`, and
  `POST …/:id/sign-in` gives a new link that mends the same connection, grants included.
- **Services by name.** `gateway/src/bots/mcp-catalog.ts` lists the services Ambient offers by
  name (Notion, Linear, Jira and Confluence, Stripe, Sentry and about forty more), each with its
  own MCP server's address, what a bot can do with it, a category and how it's signed in to.
  Connecting one takes its id alone (`{ "catalog": "notion" }`): no address to find. An entry is
  there when its server answers over Streamable HTTP and either needs no sign-in, offers MCP's
  OAuth with dynamic client registration and PKCE, or takes a token the person makes at the
  service (`signIn: "key"`, with `key: { url, help }`: where to make it and what to give it).
  GitHub is one of those (`api.githubcopilot.com/mcp/` with a fine-grained token): that's how Amb
  gets GitHub, since the bots' GitHub App tokens are only for bot runs. Connecting one without a
  token answers 400 `needs_key` with where to make it; nothing is tried at the service. Services
  that want an app registered by hand and take no personal token (Asana, HubSpot, Slack, Box)
  aren't there. A connection remembers its entry (`catalog`),
  which is how the app finds its logo; the app holds the logos, by id. Asking for a service that's
  connected gives that connection back, never a second one.
- **Clients with a secret.** Most services take Ambient as a client without a secret. Where the
  sign-in server only takes clients with one (Figma, GitLab, Supabase), Ambient registers as such,
  and the secret the service gives stays sealed with the sign-in.
- **Kept in the sealed records** under the owner's key: one record per connection, with its
  address, key, tools and grants.

The app's API (with `?team=<slug>` for a team's):

- `GET /v1/app/mcp-connections` → `{ "connections": [Connection] }`. A Connection is
  `{ id, name, slug, host, hasKey, signIn: "key" | "oauth" | "none", needsSignIn, catalog, tools: [{ name, description }], bots: [routine id], amb, addedAt }`;
  never its key, its sign-in or its whole address.
- `GET /v1/app/mcp-catalog` → `{ "categories": [{ id, name }], "services": [{ id, name, url, host,
  about, category, signIn: "oauth" | "none" | "key", key?: { url, help }, connection: { id, needsSignIn } | null }] }`.
- `POST /v1/app/mcp-connections` with `{ catalog }` (a service's id; `{ catalog, key }` for a `"key"` one), or `{ name, url, key?, header? }`
  for any other server → 201 `{ "connection" }`, or
  200 `{ "signIn": { "url" } }` when the server wants a sign-in (open the link; the connection is
  in the list once it's allowed there); 400 `bad_url`, `refused` (the key), `needs_key`, `unreachable`,
  `redirected`.
- `POST /v1/app/mcp-connections/:id/sign-in` → `{ "signIn": { "url" } }`: a new sign-in for a
  connection whose sign-in ran out.
- `GET /v1/mcp/connected?code=…&state=…` → the page the service sends the person back to; it opens
  `ambient://connections`.
- `POST /v1/app/mcp-connections/:id/refresh` → asks for the tools again.
- `DELETE /v1/app/mcp-connections/:id` → 204.
- `PUT /v1/app/mcp-connections/:id/grants` with `{ bot, on }` or `{ amb: true, on }` → `{ "connection" }`.

MCP tools: `mcp_connections` (the list; `services`, `add` by `service` or by address, `remove`,
`refresh`, `sign_in`) and `grant_mcp_connection`
(`connection`, `bot` or `amb`, `on`), for the person's AI and for Amb, only when they ask.

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
- `reach`: where Amb writes first: `"app"` (default: a push) or `"imessage"` (a text; only once
  iMessage is connected, 400 `not_connected` before). See [Channels](#channels).

`GET /v1/app/ambient/settings` → `{ "notify": "important", "reach": "app" }`; `PUT` with
`{ "notify"?, "reach"? }` → the same. MCP tool `ambient_settings` (`{ notify?, reach? }`), changed
only when the person asks.

## Channels

Amb has one conversation with a person. It's kept in the app's chat; a channel is another door to
it (`gateway/src/channels/reach.ts`). iMessage is the first; Slack and Teams for Amb, and WhatsApp,
follow the same rules. The rules are decided in code, never by the model:

- **One history.** A message written in a channel is stored in Amb's chat like one written in the
  app, with where it came from (`via` on a chat message: `"app"`, `"imessage"`). Amb answers with
  the whole conversation in view, whichever door each turn came through, and the app shows all of
  it. The channel itself only shows what was written there.
- **An answer goes back where it was asked.** Asked in the app, answered in the app (no text).
  Texted, answered by text, also when the answer takes a while. Amb is told which channel it's
  answering in, so a text comes out short and without Markdown.
- **What Amb says first goes to one place.** The heartbeat, a decision, an automation's message:
  each is stored in the chat and then rings once, where `reach` says: the channel, or the app's
  push. Never both. While the person has Amb's chat open in the app (it asked for the chat in the
  last 90 seconds), the channel stays quiet and the push goes. When the channel can't take it (not
  connected anymore, the provider refuses), the push goes out instead.
- **A decision can be answered anywhere.** A channel asks it its own way: on iMessage the question
  is a text and its answers a poll, and a tap on one files the answer (`via: "imessage"`). Where
  there's no poll it comes with its answers numbered; a reply ("2", or a few words) is a message
  to Amb, which files it with `answer_decision`.

A bot's own thread isn't part of this: a bot answers in its thread (the app, or the Slack thread it
was asked in). Pushes about a bot's thread, a failed run and approval cards stay the app's.

### iMessage

Amb's iMessage line is a hosted line at [Linq](https://linqapp.com) (`gateway/src/channels/imessage.ts`;
set up with `BRAIN_LINQ_API_KEY` and `BRAIN_LINQ_WEBHOOK_SECRET`, see
[configuration.md](configuration.md)). Without them there's no iMessage: the routes below answer
404 `not_set_up` and the MCP tool isn't offered.

```
the app or an AI app ──▶ POST /v1/app/imessage ──▶ a code ("AMB-7K2Q9F") and the line's number
the person texts the code to the line ──▶ Linq ──▶ POST /v1/hooks/linq (signed)
     ──▶ the number is theirs now, linked to their account; "You're connected" comes back
a text from a linked number ──▶ Amb's chat (via "imessage") ──▶ the answer goes back as a text
Amb writes first, reach "imessage" ──▶ a text
```

- **The person writes first.** A shared line may only text numbers that texted it, and holding the
  phone is what proves the number is theirs. A code is good for an hour and works once. A number
  that texts a code someone else is waiting with becomes that account's (and stops being the
  earlier one's).
- **A number nobody linked gets nothing**: no answer, no turn, no workspace. After five texts
  without a good code in an hour it's ignored.
- **Only a person's own texts in a chat with the line** are taken: no group chats, nothing the
  line sent itself. Each delivery is checked ([Standard Webhooks](https://www.standardwebhooks.com):
  HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<body>`, five minutes) and taken once.
- **Decisions are polls.** A bot's question or Amb's own proposal with two or more answers goes
  out as the question in a text, then a native poll with the answers. The poll's message id and
  what each option says are kept with the person's records; a tap (`poll.vote.added`) from their
  own number settles that decision and gets "Got it: …" back. A tap on one that's already
  answered gets one line saying so. When Linq won't send the poll (the chat fell back to SMS),
  the answers go as numbered text. Polls need iOS 26 on the phone to show as polls.
- **Photos and files, both ways.** What a text brings is fetched from Linq's links and goes into
  Amb's chat with the message, as files sent in the app do: pictures (JPEG, PNG, GIF, WebP), PDFs
  and text files, up to 4 and 10 MB together. An iPhone's HEIC photo is turned into a JPEG first
  (`channels/heic.ts`: in a worker thread, at most 2048 pixels on a side). Anything else (a video)
  isn't opened: a line says so and that the app takes it, and the rest of the message still goes
  through. What Amb makes with its answer (a picture, a PDF) is uploaded to Linq and sent in the
  same message; a file that can't be sent is named, with "in the Ambient app".
- **A voice memo is what was said.** With a speech-to-text key set (`BRAIN_TRANSCRIBE_API_KEY`,
  [configuration.md](configuration.md)), a voice memo's audio goes to that service and its text
  becomes the person's message to Amb, joined to anything they typed with it; Amb answers by
  text. The audio itself isn't kept. Without a key, or when nothing can be made out, one line
  says the memo couldn't be taken. Amb doesn't send voice memos.
- An answer over 3,000 characters is cut, with a line that the rest is in the app.
- While Amb works on a text the chat is marked read and shows "typing" (best effort).
- After linking, Amb shares the line's contact card (its name and picture, set up once in Linq's
  dashboard), so the thread shows "Ambient" instead of a number. Without a card nothing is sent.
- **Kept in the sealed records**: the person's link (their number, the Linq chat) under their own
  key. Finding the account for a number or a code needs a lookup that isn't under one owner: those
  rows hold only ids, keyed by an HMAC of the number, never the number itself.
- **Stop means stop.** A text that is one of Linq's opt-out keywords (STOP, UNSUBSCRIBE, OPT OUT in
  any casing; CANCEL, END, QUIT in capitals, as Linq matches them), or says the same in words
  ("please stop texting me", "schreib mir nicht mehr"), is not a message to Amb: no turn, nothing in
  the chat. The link is marked opted out, `reach` goes back to `"app"`, and one line goes out saying
  so and how to come back (the only send with `override_optout`). From then on nothing is sent by
  text, not even tried. A send Linq refuses with 403 code 2024 does the same. It ends when the
  person texts again, as it does at Linq; `reach` stays where it is until they choose iMessage again.
- **Amb doesn't text into silence.** Before it writes first (never before an answer), it asks Linq
  for the chat's health and the line's state (each at most every 15 minutes) and holds back when
  the chat is `CRITICAL` or `OPTED_OUT`, when the line is flagged or not delivering, and when its
  own messages went unanswered: two may go unanswered, the third waits a day, the fourth three
  days, then nothing until the person writes. On an `AT_RISK` chat or line it's one a day. What's
  held back goes out as a push instead. A text or a tap on a poll starts it afresh.
  `phone_number.status_updated` makes it ask for the line's state again at once.
- **What Amb writes first goes to the person, not to a chat** (`POST /v3/messages` with `to`, no
  `from`): Linq picks the line, reuses their chat while its line is healthy and moves off a flagged
  one by itself; the chat it lands in is kept. Answers go into the chat they were asked in.
- **The contact card is shared again about once a day**, with the first text of the day: there's no
  telling whether it was saved.

The app's API:

- `GET /v1/app/imessage` → `{ "connected", "handle", "number", "code", "expiresAt", "link", "optedOut" }`:
  `handle` is their number mostly hidden; `code`, `expiresAt` and `link` (opens Messages with the
  code filled in) while a code waits; `optedOut` while they've asked Amb to stop texting.
- `POST /v1/app/imessage` → the same, with a code to text (the one still waiting, when it has more
  than ten minutes left).
- `DELETE /v1/app/imessage` → forgets the number; `reach` goes back to `"app"`.

MCP tool `connect_imessage` (`{ disconnect? }`): the same three, for the person's AI and for Amb
itself. Linq's part, once per server: a webhook subscription for `message.received`, `poll.vote.added` and `phone_number.status_updated` at
`<origin>/v1/hooks/linq?version=2026-02-03`, whose signing secret is `BRAIN_LINQ_WEBHOOK_SECRET`.

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
`400 bot_needs_computer`. A team's bots run on the team's computer (its server, or a computer
an owner or admin connected for the team): a team's bot made while the team has none answers
`400 team_needs_computer`, and writing to one whose team lost it, `400 no_team_server`.

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

## Needs you

What waits for a person is their open decisions (above), shown per bot. `GET /v1/app/needs-you` returns what waits now (`items`), what's set aside (`snoozed`, each with `snoozedUntil`) and a count per bot (`counts`, Ambient's own under `ambient`).

- **Snooze** (`POST /v1/app/decisions/:id/snooze` with `hours` or `until`, five minutes to thirty days; `DELETE` brings it back): the decision stays open and leaves the list and the count until then. Snoozes are one sealed record per person, no table.
- **Dismiss** (`POST /v1/app/decisions/:id/dismiss`): settles it with "Not now." A bot hears that in its thread; a proposed change isn't applied.

From an AI app (and for Amb): `needs_you` lists the same, and `set_aside_decision` snoozes, brings back or dismisses one. The routes and the tools call the same functions. Amb's morning brief and "Waiting on me" read `needs_you`, so what's set aside isn't brought up again.

## Nightly idea

An automation with delivery `bot` starts one of the person's bots at a time, with its instructions as a message from Ambient (no turn of Amb's). The `nightly_idea` template uses it: once a night the bot may build a small first version of an idea of its own and hand it over with `ask_owner` ("My idea: …", Keep going / Drop it), so it lands in Needs you.

## Chats are live

Every message in Amb's chat goes through one function (`AmbientChat.add`), whichever door it came by (the app, iMessage, Amb writing first). It tells the person's open apps on their event stream (`GET /v1/app/events`, `event: chat`, `{"chat":"ambient","at":…}`), and the app fetches the chat. The event says only that it changed: the message stays sealed and is read through the chat's own route. Clearing or deleting the chat announces itself the same way. The app still asks now and then on its own, for when the stream is down.

## Reactions on iMessage

Amb reacts to a person's text as people do. It starts its answer with `[react: 👍]` (exactly one emoji; `splitReaction` in `bots/ambient.ts`), and the channel puts that emoji on their last message (Linq `POST /v3/messages/{id}/reactions`): one of Messages' six tapbacks where it is one (❤️ 👍 👎 😂 ‼️ ❓), a custom emoji otherwise. A reaction alone is a whole answer; with words after it, the words follow as a text. The chat keeps the words, or the emoji when that was all. In the app there are no reactions: the brackets are taken off the same way.

Only Amb decides: nothing reacts by itself (a timer that put 👀 on slow answers was taken out, 2026-11-21). To show it's on something before its answer comes, Amb calls its `react_on_imessage` tool (one emoji, on their last text) while it's still working. A person's own tapbacks on Amb's messages aren't read yet.

## A bot's own news in Slack

A bot answers a Slack message in its thread (above). News of its own (an alert, a result from a scheduled run) goes to **one channel its owner chose**, and nowhere else:

- **Which channel.** Every channel the bot is mentioned in is remembered (`AppRecord.channels`). Its news channel is the one chosen (`PUT /v1/app/routines/:id/slack/news`, or `slack_for_bot` with `news_channel`), by default the first it was mentioned in; `null` / `"none"` keeps its news in the Ambient app.
- **The bot is told.** Each run of a bot with a Slack app starts with a line saying it's in Slack as `@name`, and where its news goes (`slackLines` in `bots/folder.ts`). Before this a scheduled run had the token but no idea it was in Slack (the Anomaly watcher said it couldn't post, 2026-11-22).
- **How it posts.** Its tool `post_to_slack` (on the gateway's MCP, bots only): the gateway posts as the bot, outside any thread, and remembers the post. Questions to its owner and failures don't go there.
- **Replies under its post** reach it without an @mention (`message.channels`, `message.groups`): only threads under a post of its own, and only from whoever installed it, as with mentions.
- **A channel that's gone** (it was removed, the channel is archived): the post is refused with the reason, kept as `news.broken` for its page until another channel is chosen or a post works; the run is told no channel is chosen meanwhile.
- **Channel names** need `channels:read` / `groups:read`. Apps made before that keep working by channel id; `POST /v1/app/routines/:id/slack/allow` (or `slack_for_bot` with `allow_again`) updates the app's manifest and returns the link to tap Allow once more.
