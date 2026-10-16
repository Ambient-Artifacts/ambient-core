# Ambient server (brain-platform)

The server side of Ambient ("Brain" is the codename, kept in package names, `BRAIN_*` variables and systemd units): `spec` (shared schemas), `wiki` (store, search, indexes, git), `control` (Convex), `gateway`, `team` (team server), `runner`, `ops`, and the Claude Code plugin in `integrations/claude-code`. Start with [README.md](README.md) and [docs/architecture.md](docs/architecture.md).

## Working here

- Node 24. Checks: `npm run -s typecheck` and `npx vitest run` (the gateway tests run against the real Convex functions and real team servers). CONTRIBUTING.md has the rest.
- The code runs both Ambient Cloud and self-hosted servers (`docker-compose.yml`, [docs/self-hosting.md](docs/self-hosting.md)). A change to configuration, the Convex schema or the jobs has to work in both: update `.env.example`, [docs/configuration.md](docs/configuration.md) and `ops/docker/` with it. The `Self-host` workflow runs the compose stack and the guide's commands.
- Convex schema changes must be additive (optional fields, new indexes): self-hosted `setup` and the cloud deploy push them onto existing data.
- No secrets, customer names or personal data in code, tests, fixtures or commit messages. Fixtures use made-up people and `example.com`.
- Deploys of Ambient Cloud go through `ops/deploy.sh` and `npx convex deploy` ([ops/README.md](ops/README.md)). Production deploys and production data changes happen only when the founder asks for them by name.

## Product context (maintainers)

What Ambient is, its strategy and the reasoning behind the architecture are written up in Ambient's own team wiki under `product/` (start with `product/ambient.md`, then `product/architecture.md`), readable through the Ambient MCP (`fetch` with id `team:ambient:product/ambient`). That wiki is private. When a change alters what the product does or how it's built, update the matching `product/` page in the same piece of work; those pages are written by hand and the nightly upkeep never rewrites `product/`.

## Keep the why

Either way, a pull request or a commit straight to `main`, the reasoning goes with it, in three lines:

- **Tried:** what you attempted or ruled out on the way, dead ends included. "Nothing else, the first approach held" is a fine answer.
- **Decided:** the approach you took, and the one or two choices that shape it.
- **Why:** the evidence, constraint or trade-off that made it the right call.

A commit that changes behaviour carries them in the commit message body, below the subject line. A pull request starts with them under `## Why` (the fields are in `.github/pull_request_template.md`). Typo and formatting commits don't need them. Write them from your own session, while the dead ends are still fresh: the diff shows what changed, these lines are what a teammate or the next agent can't see in it. One sentence each, plain words, no secrets or personal data.
