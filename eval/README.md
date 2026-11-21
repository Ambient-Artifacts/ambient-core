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

# The consolidation eval

The placement eval reads the wiki; this one checks how it gets written. Every night `consolidate()` (`team/src/consolidate.ts`) folds the day's notes into the living pages, files decision pages (`decisions.ts`) and rewrites the overview (`overview.ts`). A page that misses a company, a decision or a moved date answers wrong the next day, however well an app reads it; this eval is how a change to those steps shows whether the pages got better.

- **The wiki:** the placement eval's `fixture/` as it stood the evening before, and `consolidation/batch/`: five new notes the way they land in the team wiki. A call that moves the ERP go-live and names a new contact at the vendor, an AI-app work note about a competitor (with `orgs: []`, as such notes arrive), an offer review whose "## Decisions" section holds one real decision and one trivial choice, a work note that decides something in its text only, and a trade fair meeting a teammate only sat in on. No real data.
- **The cases:** 22, in `consolidation/cases.ts`: pages that must be created or updated (with a timeline line for the note), facts that must be on a page, decision pages that must and must not exist, a corrected date that must leave the current truth and stay in the timeline, and pages that must stay as they were. One rule covers every living page the run writes: each timeline line links the note it came from (current truth carries no links by design; the timeline below it is its evidence), and no link is broken.
- **How it runs:** the real `consolidate()` with the real page, decision and overview steps (`team/src/anthropic.ts`), as `cli.ts consolidate` runs it each night, on a temporary git copy of the wiki, with the job's own model (Claude Haiku 4.5 unless `EVAL_MODEL` says otherwise). Plain code scores the pages it wrote. With `--judge`, Claude Sonnet 5.5 (`EVAL_JUDGE_MODEL`) also checks a sample of current-truth lines against the notes behind them and the page's previous version; its supported and unsupported counts are reported, not scored.
- **What it reports:** per category (entity recall, fact recall, decision recall, decision precision, supersession, untouched, link validity) the cases passed; the total, which is the mean of the seven (a category with two cases weighs as much as one with seven); timeline entries the job dropped; tokens and cost (about $0.05 a run, $0.09 with the judge). `out/consolidation-latest.json` keeps every case and every page the run wrote.

```sh
ANTHROPIC_API_KEY=… npm run eval:consolidation                       # against consolidation/baseline.json
ANTHROPIC_API_KEY=… npm run eval:consolidation -- --update-baseline  # this run becomes the baseline
ANTHROPIC_API_KEY=… npm run eval:consolidation -- --judge 20         # and the support judge on 20 lines
EVAL_MODEL=claude-haiku-5-5 npm run eval:consolidation
```

**The gate** (exit 1, also in CI on changes to the consolidation, decision and overview steps, `.github/workflows/eval.yml`): the total may not fall more than 10 points below `consolidation/baseline.json`, about one case in a small category, since answers vary from run to run. A change that closes a gap records a new baseline in the same pull request.

**Known gaps.** The baseline (93% on 2026-10-17, Claude Haiku 4.5; the runs that day scored 91 to 95%) still fails these now and then:

1. **A passing mention can still land.** Someone who only sat in on a meeting sometimes gets it on their page (u1, about half the runs).
2. **A correction can lose the old value.** The timeline line for a moved date sometimes states only the new one (s1, about one run in three).

**Closed on 2026-10-17** (the baseline was 69% before, with the corrected link rule):
- **Work notes named no companies.** Notes from AI apps arrived with `orgs: []`, so a note about a competitor never reached an org page (e2, f5). Now one structured call finds the organizations and topics of a work note that names none (`findEntities` in `team/src/consolidate.ts`), and `log_work` and the session summarizer record organizations themselves.
- **Decisions in prose weren't filed.** A work note without a "## Decisions" section gives its summary and "Worked on" lines to the decision step as prose, which files only decisions clearly made there (d2). Precision held: no extra decisions in any run.
- **Updated pages lost their timeline line.** The applier matched only the exact note ref and dropped entries naming the note by its file name, so a page changed with nothing saying why (e4 to e6, s1). It now reads the names the model uses (`noteFor`), and the prompt says each fact goes under the note that says it.