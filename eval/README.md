# The placement eval

Does an AI app answer from Ambient, and does telling it who the user is and what their wikis hold (the personal part of the MCP instructions, `gateway/src/mcp/context.ts`) help or hurt? GBrain switched its always-loaded "core memory" off by default after it helped one model and hurt another; this eval is how Ambient decides the same question with a number.

- **The wiki:** `fixture/` is a fictional team wiki (a 12-person tool maker in Graz: four people, two customers and suppliers, two projects, three decisions, four meeting notes) and `personal/me.md` is the asking user's own page. No real data.
- **The questions:** ten, in `questions.ts`, the way a member asks their AI, without mentioning Ambient: who someone is, a contact person, what was decided and why, a launch date, a project's status, what someone promised and by when, an intro of the user, and two the wiki can't answer (the right answer says so).
- **How it runs:** each question goes to the model with Ambient's real read tools over the fixture, connected the way an app connects (in process, over MCP), next to stand-ins for the other apps a member has connected (web, Gmail, Drive) that find nothing, so looking in Ambient is the model's own choice. Once with the general instructions only and once with the personal part as well. The answer is graded with plain patterns.
- **What it reports:** per condition, the score out of ten, recall (right answers among the answerable questions), precision (right answers among the answers given), how often the model looked in Ambient, and the token count. `out/latest.json` keeps every answer.

```sh
ANTHROPIC_API_KEY=… npm run eval                       # both conditions, against baseline.json
ANTHROPIC_API_KEY=… npm run eval -- --update-baseline  # this run becomes the baseline
EVAL_MODEL=claude-haiku-5-5 npm run eval -- --only personal --questions q8,q9
```

**The gate** (exit 1, also in CI on changes to prompts and instructions, `.github/workflows/eval.yml`): the personal instructions may not score below the general ones, and neither condition may drop more than one question below `baseline.json` (one, because answers vary from run to run). When a change makes the personal part lose, keep it off until it wins.
