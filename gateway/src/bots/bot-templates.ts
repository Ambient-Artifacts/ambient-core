// Bot templates (docs/bots.md, "Bot templates"): a whole bot to set up in a minute. Templates are
// for bots; automations are for the person. A template is a bot's folder (AGENTS.md, skills, an
// optional GOAL.md), how it works on GitHub, the secrets it needs, and two or three questions;
// the answers fill it in. The bot it makes learns on its own from the start (learning.ts).
import type { Owner } from "../routines/keys.ts";
import { z } from "zod";
import { BotInput, type BotColor, type BotFace, type BotWear, type RoutineSchedule } from "@brain/spec";
import { RoutineError, type Actor, type Routine, type RoutineService } from "../routines/service.ts";
import type { Author, BotFolder } from "./folder.ts";
import type { GitHubEvents, WatchMode } from "./github.ts";
import type { BotLearning } from "./learning.ts";

export interface TemplateQuestion {
  id: string;
  /** What the app asks. */
  label: string;
  /** repos: a list of owner/name; choice: one of `options`; text: free text. */
  kind: "repos" | "choice" | "text";
  options?: { id: string; label: string }[];
  default?: string;
  required: boolean;
  /** One line under it. */
  hint?: string;
}

export interface BotTemplate {
  id: string;
  name: string;
  face: BotFace;
  /** Its colour and what it wears for the job (docs/bots.md, "Faces"). */
  color: BotColor;
  wear: BotWear[];
  description: string;
  /** "auto": Codex when the computer has a Codex sign-in (a second model's eyes), else Claude Code. */
  runtime: "claude-code" | "auto";
  github: WatchMode[];
  secrets: { name: string; why: string }[];
  report: "news" | "every_run";
  delegate: "never" | "brain" | "most";
  schedule: RoutineSchedule;
  questions: TemplateQuestion[];
  /** Its AGENTS.md, GOAL.md (or null) and skills from the answers. */
  /** `schedule`: when the answers change it (the Builder picks up issues on weekdays only with a label). */
  build: (a: Record<string, string>) => { agents: string; goal: string | null; skills: { path: string; content: string }[]; schedule?: RoutineSchedule };
  /** How it talks and behaves: its SOUL.md to start with (docs/bots.md, "One folder for every bot"). */
  soul: string;
}

const vienna = "Europe/Vienna";
const repos: TemplateQuestion = { id: "repos", label: "Which repos?", kind: "repos", required: true, hint: "owner/name, or paste a GitHub link. Up to 10." };

const REVIEW_CHECKLIST = `---
name: review-checklist
description: What to look at in a pull request, by area. Use it on every review.
---
# Review checklist

Go through what the diff touches; skip what it doesn't.

- **Security:** secrets or tokens in code or logs; user input reaching a shell, SQL, HTML or a file path; missing auth or permission checks on new routes; anything that widens who can read what.
- **Data:** migrations that lose or lock data, run long, or can't run twice; writes without a transaction where two must succeed together; changed shapes that old clients or stored data still use.
- **Tests:** risky logic (money, permissions, deletion, time zones, retries) without a test that fails without the change; tests that test the mock instead of the code.
- **Migrations and deploys:** an order that matters (database before server, server before app) said nowhere; a flag or setting the code needs that isn't documented.
- **Performance:** work inside a loop that should be one query; unbounded lists, reads or retries; something on every request that only needs to happen once.
- **Errors:** failures swallowed or turned into success; error messages that leak internals to users.

Not your job: formatting, naming taste, anything a linter or formatter catches.
`;

const BRAIN_CHECK = `---
name: brain-check
description: Check a change against what the team decided and wrote down. Use it when a pull request changes behaviour, a product area, or something people agreed on.
---
# Brain check

1. Name the areas the pull request changes (a feature, a page, an API, pricing, sign-in…).
2. Search the brain for them: decisions, product pages, meeting notes from the last weeks (the Ambient tools: search, brief, list_decisions).
3. When the change goes against a decision or a product page, say so in your review with the page's name and the sentence that disagrees, and ask which one is right. Don't decide it yourself.
4. When the brain has nothing on it, say nothing about it.
`;

const PR_GATE = `---
name: pr-gate
description: How a pull request of yours gets to ready for review. Use it every time you open or update one.
---
# PR gate

1. One change per pull request, small enough to review in ten minutes. Open it as a draft.
2. After each push, wait for the review bots and checks, then read everything: inline comments, reviews, PR comments, checks.
3. Every comment gets either a fix (push it, then resolve the thread) or an answer on its thread saying why not. Review bots' comments too.
4. Ready for review (gh pr ready) only when nothing is open, every check is green and the last review round brought nothing new. Then hand it to your owner with ask_owner and wait: false ("PR #<n> is ready: … Merge it?", Merge / Changes) and say in your last message what it does and how you checked it.
5. Never merge, never force-push over someone else's commits.
`;

const WHAT_TO_UPDATE = `---
name: what-to-update
description: Which docs and wiki pages a merged change touches. Use it after every merge you're started for.
---
# What to update

- A new or changed command, setting, environment variable or route → the docs page that lists them.
- Changed behaviour people notice (a screen, a flow, an email, a limit) → the product page for that part, and its "Status" line.
- A new dependency, service or deploy step → the setup or deploy docs.
- A decision that shows in the code (a new rule, a removed feature) → the product page says what and why, in a sentence.
- Nothing else. Don't rewrite pages that are still true, don't touch pages people write by hand beyond the lines that changed, never invent what the code doesn't show.
`;

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    id: "review_bot",
    soul: "- Direct and friendly. Only what matters: bugs, risks, missing tests, things that contradict the brain.\n- No nitpicks a linter or formatter would catch; no praise padding.\n- One comment per real problem, with why it matters and a concrete fix.\n- In English on GitHub; short.",
    name: "Reviewer",
    face: "pebble",
    color: "sage",
    wear: ["nerd"],
    description: "Reviews every pull request in your repos: comments on real problems only, checks the change against your team's decisions, never merges.",
    runtime: "auto",
    github: ["all_prs"],
    secrets: [{ name: "GH_TOKEN", why: "a GitHub token that can read the repos and write pull request reviews and comments (fine-grained: Contents read, Pull requests read and write); no merge rights needed" }],
    report: "news",
    delegate: "brain",
    // Its runs come from GitHub's events (docs/bots.md, "Wake-ups"): no schedule of its own.
    schedule: { every: "needed", time: "09:00", timezone: vienna },
    questions: [
      repos,
      {
        id: "strictness",
        label: "How strict?",
        kind: "choice",
        options: [
          { id: "blockers_only", label: "Only what must change" },
          { id: "everything", label: "Everything worth saying" },
        ],
        default: "blockers_only",
        required: true,
      },
      { id: "focus", label: "Anything to watch closely?", kind: "text", required: false, hint: "e.g. migrations, payments, sign-in" },
    ],
    build: (a) => ({
      agents: [
        "You review pull requests in the repos you watch, for the team. You are one pair of eyes next to people and other review bots: careful, short, useful.",
        "",
        "How you work:",
        "- Read the whole diff and the code around it before you write anything. Use the review-checklist skill on every review, and the brain-check skill when the change touches behaviour or a product area.",
        a.strictness === "everything"
          ? "- Comment on everything worth saying: real problems first, then smaller things (clarity, missing edge cases), each marked as a must or a suggestion."
          : "- Comment only on what must change: bugs, security, data loss, broken migrations, missing tests for risky logic. Leave style and taste alone.",
        a.focus?.trim() ? `- Look especially closely at: ${a.focus.trim()}.` : null,
        "- Inline comments on the line, each saying what's wrong and what to do instead. Then one review: request changes when something must change, otherwise comment.",
        "- When the change goes against a team decision or a product page, quote it and ask; don't decide.",
        "- When you're started without a pull request to review (your first run, or your owner asks), list the open pull requests nobody has reviewed for a day, review them, and say which ones in your last message.",
        "",
        "What you never do: approve a pull request whose checks aren't green, push to someone's branch, merge, or comment on formatting a linter catches.",
        "",
        "Your last message: which pull requests you reviewed, and for each the one thing that matters most.",
      ]
        .filter((l) => l !== null)
        .join("\n"),
      goal: "Outcome: every pull request reviewed within an hour of being ready, with comments people act on.\nMetric: of its comments on closed pull requests, how many led to a change (the scorecard's review line).\nTarget: 8 in 10 or more.\nLimits: never approves with red checks, never merges.",
      skills: [
        { path: "review-checklist/SKILL.md", content: REVIEW_CHECKLIST },
        { path: "brain-check/SKILL.md", content: BRAIN_CHECK },
      ],
    }),
  },
  {
    id: "builder",
    soul: "- Brief status, no filler: what you did, what you checked (tests, build, the PR gate), what's left.\n- Say plainly when something didn't work and what you'll try next.\n- Pull request descriptions: why first, then what changed, then how you checked it.",
    name: "Builder",
    face: "cap",
    color: "sky",
    wear: ["hoodie"],
    description: "Builds features and fixes bugs from your messages or labelled issues, in draft pull requests it keeps fixing until nothing's open.",
    runtime: "claude-code",
    github: ["own_prs"],
    secrets: [{ name: "GH_TOKEN", why: "a GitHub token that can push branches and open pull requests in the repos (fine-grained: Contents read and write, Pull requests read and write, Issues read); no rights on the default branch needed" }],
    report: "news",
    delegate: "brain",
    // On request; with a label it also looks for issues every weekday morning (build()).
    schedule: { every: "needed", time: "09:00", timezone: vienna },
    questions: [
      repos,
      { id: "label", label: "Which issues should it pick up?", kind: "text", default: "ambient", required: false, hint: "Issues with this label. Empty: only what you write to it." },
      { id: "goal", label: "What should it achieve?", kind: "text", required: false, hint: "Optional, e.g. close 5 bugs from the backlog every week" },
    ],
    build: (a) => {
      const label = (a.label ?? "ambient").trim();
      return {
        agents: [
          "You build features and fix bugs in the repos you watch, one small pull request at a time, and see each through review.",
          "",
          "Where work comes from:",
          "- What your owner writes to you in your thread comes first.",
          label ? `- On your weekday run, pick up open issues labelled "${label}" that nobody is working on (oldest first, one or two), and comment on the issue that you're on it.` : "- Only what your owner writes to you; don't pick up issues on your own.",
          "",
          "How you work:",
          "- Read the code and the brain (product pages, decisions) for the area before you change anything. Ask your owner (ask_owner) only when two real options remain.",
          "- Follow the pr-gate skill: a draft pull request, every review comment fixed or answered, ready only when nothing is open and checks are green.",
          "- Test what you change: run the tests, add one that fails without your change for anything risky, and say how you checked it.",
          "",
          "What you never do: merge, push to the default branch, force-push over someone else's commits, or change what you weren't asked to.",
          "",
          "Your last message: the pull requests you opened or moved, with what each does and what still waits.",
        ].join("\n"),
        goal: a.goal?.trim() ? `Outcome: ${a.goal.trim()}\nMetric: merged pull requests that came from issues or requests, per week (and how many needed a person's edits).\nTarget: as the outcome says.\nLimits: never merges; one change per pull request.` : null,
        skills: [{ path: "pr-gate/SKILL.md", content: PR_GATE }],
        ...(label ? { schedule: { every: "weekday" as const, time: "09:00", timezone: vienna } } : {}),
      };
    },
  },
  {
    id: "wiki_keeper",
    soul: "- Plain and factual: say what changed, where, and link the page; never pad or guess.\n- When a merge changes nothing worth writing down, say so in one line.\n- Keep the wiki's own voice and terms; don't rewrite what you didn't need to touch.",
    name: "Wiki keeper",
    face: "dome",
    color: "sand",
    wear: ["glasses"],
    description: "After every merge, brings the docs and your team's product pages in step with what changed, and tells you what it updated.",
    runtime: "claude-code",
    github: ["merges", "own_prs"],
    secrets: [{ name: "GH_TOKEN", why: "a GitHub token that can push branches and open pull requests in the repos and the wiki's repo (fine-grained: Contents read and write, Pull requests read and write)" }],
    report: "news",
    delegate: "brain",
    // Its runs come from merges; on Fridays it also checks the week's merges for anything missed.
    schedule: { every: "week", days: ["fri"], time: "15:00", timezone: vienna },
    questions: [
      repos,
      {
        id: "where",
        label: "What should it keep up to date?",
        kind: "choice",
        options: [
          { id: "both", label: "Docs in the repo and the team's wiki" },
          { id: "docs", label: "Only docs in the repo" },
          { id: "wiki", label: "Only the team's wiki" },
        ],
        default: "both",
        required: true,
      },
      { id: "docs", label: "Where are the docs?", kind: "text", default: "docs/", required: false, hint: "A folder in the repo, e.g. docs/" },
    ],
    build: (a) => {
      const where = a.where ?? "both";
      const docs = (a.docs ?? "docs/").trim() || "docs/";
      const targets = [where !== "wiki" ? `the docs in ${docs} of each repo` : "", where !== "docs" ? "the team wiki's product pages (product/…)" : ""].filter(Boolean).join(" and ");
      return {
        agents: [
          `You keep ${targets} in step with what's merged, so people and agents can trust them.`,
          "",
          "How you work:",
          "- When you're started with what was merged, read the merged changes (the commits, their pull requests and diffs) and decide with the what-to-update skill which pages they touch.",
          "- Change only the lines that are no longer true or are missing, in the page's own style. Your changes go in your own pull request (ready for review, not a draft; the PR gate holds for it), titled \"docs: …\", one per merge round.",
          where !== "docs" ? "- For the team wiki, find the page in the brain first (search, fetch), and change it in the wiki's repo the same way." : null,
          "- On Fridays, go through the week's merges and catch what was missed.",
          "",
          "What you never do: invent behaviour the code doesn't show, rewrite pages that are still true, touch code, or merge.",
          "",
          "Your last message: what changed in the product and which pages you updated (with links), in a few lines. If a merge needed nothing, say so in one line.",
        ]
          .filter((l) => l !== null)
          .join("\n"),
        goal: null,
        skills: [{ path: "what-to-update/SKILL.md", content: WHAT_TO_UPDATE }],
      };
    },
  },
];

export const FromTemplate = z.object({
  template: z.string().max(40),
  answers: z.record(z.string(), z.union([z.string().max(2_000), z.array(z.string().max(200)).max(10)])).default({}),
  /** A team's slug: the bot is the team's and runs on its server. */
  team: z.string().max(80).nullable().optional(),
  /** A computer's id or name (personal bots). */
  computer: z.string().max(80).nullable().optional(),
  schedule: z.unknown().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  /** Its look, picked when it's made (the app's first step); the template's own otherwise. */
  look: BotInput.pick({ face: true, color: true, wear: true }).optional(),
});
export type FromTemplate = z.infer<typeof FromTemplate>;

/** The catalog as the app and the MCP tools show it (without the folder's text). */
export function templateViews() {
  return BOT_TEMPLATES.map(({ build: _build, ...t }) => t);
}

/**
 * Makes a bot from a template: the loop (AGENTS.md as its prompt), its skills and goal, how it
 * works on GitHub. `enabled`: an app-made bot may start right away; one an AI app made waits.
 */
export async function createFromTemplate(
  d: { routines: RoutineService; folder: BotFolder; github?: GitHubEvents; learning?: BotLearning; githubApp?: { covers(owner: Owner, repos: string[]): Promise<boolean> } },
  actor: Actor,
  input: FromTemplate,
  o: { source: string; enabled: boolean; by: Author },
): Promise<{ routine: Routine; needs: { secrets: string[]; webhook: boolean } }> {
  const t = BOT_TEMPLATES.find((x) => x.id === input.template);
  if (!t) throw new RoutineError("no_such_template", `There's no bot template "${input.template}". Templates: ${BOT_TEMPLATES.map((x) => x.id).join(", ")}.`, 400);
  const answers: Record<string, string> = {};
  let repoList: string[] = [];
  for (const q of t.questions) {
    const raw = input.answers[q.id];
    if (q.kind === "repos") {
      repoList = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : []).map((r) => r.trim()).filter(Boolean);
      if (q.required && !repoList.length) throw new RoutineError("bad_request", `${q.label} Give at least one repo (owner/name).`, 400);
      continue;
    }
    const v = (Array.isArray(raw) ? raw.join(", ") : (raw ?? q.default ?? "")).trim();
    if (q.kind === "choice" && v && !q.options?.some((x) => x.id === v)) throw new RoutineError("bad_request", `${q.label} Pick one of: ${q.options!.map((x) => x.id).join(", ")}.`, 400);
    if (q.required && !v) throw new RoutineError("bad_request", `${q.label} needs an answer.`, 400);
    answers[q.id] = v;
  }
  const built = t.build(answers);
  const { computers } = await d.routines.list(actor);
  const team = input.team ?? null;
  const target = team ? computers.find((c) => c.team?.slug === team) : input.computer ? computers.find((c) => c.id === input.computer || c.name.toLowerCase() === input.computer!.toLowerCase()) : computers.filter((c) => !c.team && c.ready).length === 1 ? computers.find((c) => !c.team && c.ready) : undefined;
  const codex = target?.openaiAccount && (target.openaiAccount.signedIn === "chatgpt" || target.openaiAccount.signedIn === "api_key" || (target.openaiAccount.use === "key" && target.openaiAccount.key));
  const runtime = t.runtime === "auto" && codex ? "codex" : "claude-code";
  const bot: BotInput = { face: input.look?.face ?? t.face, color: input.look?.color ?? t.color, wear: input.look?.wear ?? t.wear, runtime, isolation: "container", secrets: t.secrets.map((s) => s.name), report: t.report, delegate: t.delegate } as BotInput;
  const routine = await d.routines.create(
    actor,
    {
      name: input.name ?? t.name,
      prompt: built.agents,
      schedule: (input.schedule as RoutineSchedule | undefined) ?? built.schedule ?? t.schedule,
      ...(team ? { team } : {}),
      ...(input.computer ? { computer: input.computer } : {}),
      enabled: o.enabled,
      bot,
    },
    o.source,
  );
  const f = await d.routines.folderOf(actor, routine.id, true);
  for (const s of built.skills) await d.folder.write(f.owner, f.routineId, `skills/${s.path}`, s.content, o.by, `from the ${t.name} template`);
  if (built.goal) await d.folder.write(f.owner, f.routineId, "GOAL.md", built.goal, o.by, `from the ${t.name} template`);
  if (t.soul.trim()) await d.folder.write(f.owner, f.routineId, "SOUL.md", t.soul, o.by, `from the ${t.name} template`);
  if (d.github && repoList.length) await d.github.setWatch(f.owner, f.routineId, repoList, t.github);
  if (d.learning) await d.learning.setLearn(f.owner, f.routineId, "auto");
  const have = new Set((await d.routines.secrets(actor, team).catch(() => [])).map((s) => s.name));
  // Connected through the GitHub App: events come without a webhook, and each run gets a token.
  const viaApp = Boolean(d.githubApp && repoList.length && (await d.githubApp.covers(f.owner, repoList)));
  const secrets = t.secrets.map((s) => s.name).filter((n) => !have.has(n) && !(viaApp && n === "GH_TOKEN"));
  return { routine: await d.routines.get(actor, routine.id), needs: { secrets, webhook: Boolean(d.github && repoList.length) && !viaApp } };
}
