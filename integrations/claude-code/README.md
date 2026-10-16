# Ambient for Claude Code

Claude starts each session knowing what Ambient knows: who you are, what's new in your wikis since your last session and what you owe. When your prompt names a person, organization or project your wikis have a page for, that page is added too, once per session. Each Claude Code session you work in becomes a short note in your Ambient wiki: what was worked on, what was decided, what's left, and links to the repo, branch, commits and pull requests. Sessions in folders or repos you map to a team also go to that team's wiki, 30 minutes later, unless you keep them personal in the Ambient app. Claude also gets Ambient's MCP tools, so it can search your notes, meetings and team wikis.

## Install

1. In the Ambient app: **Settings → Work sessions → Create a token for Claude Code**, and copy it.
2. In a terminal:
   ```sh
   claude plugin marketplace add Ambient-Artifacts/ambient-core
   claude plugin install ambient@ambient
   ```
   Claude Code asks for the token (it's kept in your system's credential store).
3. Optional: in the app, under **Work sessions → Share with a team**, add the folders or repos whose sessions go to a team, e.g. `~/git/brain-*` or `github.com/Ambient-Artifacts/*`.

**On a self-hosted Ambient server:** make the token with `docker compose exec gateway admin token you@example.com --claude-code`, and set **Ambient server** to your server's URL (e.g. `https://ambient.example.com`) under `/plugin` → ambient → configure. See [docs/self-hosting.md](../../docs/self-hosting.md#claude-code).

If you had already added Ambient with `claude mcp add`, remove that one (`claude mcp remove ambient`): the plugin brings its own connection.

**On a server** (no terminal prompt, e.g. Claude Code over Remote Control on a VPS), set the token without typing it into the shell: put `{"token":"ambient_pat_…"}` in a file only you can read, then
```sh
claude plugin configure ambient@ambient --values-stdin < token.json
```
and delete the file. Set `CLAUDE_CONFIG_DIR` first if that account's Claude Code uses another folder. Each person on a shared server needs their own token: a token sends sessions into its owner's wiki.

## What Claude gets at the start and with your prompts

- **At the start of a session** (and again after `/clear` or `/compact`): who you are (your **About you** in the app, and what upkeep wrote from your notes), the notes and decisions that are new in your wikis since your last session, your open action items, and when to look in Ambient.
- **With a prompt that names someone or something** your wikis have a page for: that page's current truth, at most three pages per prompt, each once per session.
- **Your prompt stays on your computer.** The hook keeps the list of names in your wikis (refreshed hourly), finds them in the prompt itself, and asks Ambient only for those pages.
- To turn it off, set the plugin's **context** option to `off` (`/plugin` → ambient → configure). The hook logs what it added to `~/.claude/plugins/data/ambient-ambient/context.log`.

## What is sent, and what is kept

- When a session ends, the hook sends its transcript to Ambient. Only sessions a person typed in are sent; scheduled `claude -p` jobs are skipped.
- Ambient cuts it down to your prompts, Claude's answers and one line per action (file edited, command run), removes anything that looks like a key, token or password, writes the note with Claude, and drops the transcript. Tool output and file contents are never kept.
- A long session becomes one note per working block: a new block starts when you come back after an hour or more. Each block goes to a team (or stays personal) by its own edits, and a block that hasn't changed isn't summarized again.
- Sessions that never ended cleanly (a closed terminal, a remote session that timed out) are sent at the start of your next session. Sessions from before you installed the plugin are left alone.

## Troubleshooting

The hook never prints anything; it logs to `~/.claude/plugins/data/ambient-ambient/capture.log`. "The server refused the token" means the token was revoked or mistyped: create a new one in the app and set it under `/plugin` → ambient → configure.

To keep a session from ever being sent, add its id (the transcript's file name without `.jsonl`) on its own line to `hold` in that same folder.

The script only needs bash, curl, gzip, grep and sed. To try it without the plugin: `AMBIENT_TOKEN=… scripts/capture.sh end < hook-input.json`.
