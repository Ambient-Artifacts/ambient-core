# Contributing to Ambient

Thanks for helping. This guide covers how to get the code running, how changes are made here, and what happens to your contribution.

## Before you start

- **Bugs:** open an issue with steps to reproduce, what you expected and what happened. For a self-hosted server, add `docker compose ps` and the relevant logs, with secrets and note text removed.
- **Security problems:** never in a public issue. See [SECURITY.md](SECURITY.md).
- **Features and larger changes:** open an issue first and describe the problem you're solving. We'll say whether it fits before you spend time on a pull request.
- Small fixes (typos, docs, an obvious bug with a test) can go straight to a pull request.

## Setup

Node 24 and git.

```sh
npm install
npm run typecheck
npm test
```

The tests need no accounts or network. The gateway tests run the real Convex functions in-process (`convex-test`) against real team servers on temporary git repos. `npx vitest run gateway/test/mcp.test.ts` runs one file.

To click through the whole server, run the Docker stack (`ops/docker/init.sh --local`, see [docs/self-hosting.md](docs/self-hosting.md)). Alternatively, run a local Convex backend with `cd control && CONVEX_AGENT_MODE=anonymous npx convex dev` and start the gateway and a team server with the variables in [docs/configuration.md](docs/configuration.md).

## Making a change

- **Keep it focused.** One change per pull request. Refactors go in their own.
- **Tests:** behaviour changes come with a test, written against the real thing where the suite already does that (Convex functions, team servers, git), not mocks of it.
- **Contracts:** if you change a schema in `spec/`, run `npm run schemas` and commit the JSON Schema; the Swift apps build against it.
- **Convex:** schema changes must work with the data already there: new fields optional, new indexes additive. A self-hosted `setup` and Ambient Cloud deploy them as they are.
- **Style:** match the code around you. Comments say why, in plain sentences; names are spelled out. There is no formatter run in CI; keep diffs free of unrelated reformatting.
- **Secrets and personal data** never go into code, tests, fixtures, commit messages or issues. Fixtures use made-up people and `example.com`.

### Keep the why

Every behaviour change carries its reasoning, in three lines, in the pull request under `## Why` (the template has the fields) or in the commit message:

- **Tried:** what you attempted or ruled out on the way. "Nothing else, the first approach held" is a fine answer.
- **Decided:** the approach you took, and the one or two choices that shape it.
- **Why:** the evidence, constraint or trade-off that made it the right call.

The diff shows what changed; these lines are what the next person, or the next agent, can't see in it.

### Using AI to write code

Welcome, since this project is about working with agents. You are still the author: you've read every line, you can explain it, and you ran the tests. Pull requests that are clearly unreviewed model output will be closed.

## Sign-off (DCO)

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/). Sign off each commit to confirm you wrote it or have the right to submit it under the project's license:

```sh
git commit -s -m "Fix the thing"
```

That adds `Signed-off-by: Your Name <you@example.com>` with your real name. Forgot? `git commit --amend -s` for the last commit, or `git rebase --signoff main` for all of them.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE), like the rest of the project.

## Code of conduct

Be kind and assume good intent. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
