// Bot templates and how bots learn (docs/bots.md, "Bot templates", "How bots learn"): the
// catalog, a bot made from each template (folder, GitHub watch and mode, what's still needed),
// GitHub's trigger modes (every pull request for a reviewer, merges for a wiki keeper), the
// signals a bot's work gives (merged as it left it or edited, closed, reverted, changes requested,
// a person's push, ready; a reviewer's comments useful or false alarms; only the team's people),
// the scorecard, the weekly retro, and undoing a lesson after which things got worse.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lessonsOf, scorecard, worse, type Signal } from "../src/bots/learning.ts";
import type { Owner } from "../src/routines/keys.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.9.0", claude: "2.1.300 (Claude Code)" };
const REPO = "acme/app";
const DAY = 24 * 3600_000;

// Fake Anthropic: the weekly retro writes a few lines; everything else stays silent.
const fakeAnthropic: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("https://api.anthropic.com/")) return fetch(input, init);
  const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] };
  const first = body.messages.find((m) => m.role === "user")!;
  const prompt = typeof first.content === "string" ? first.content : JSON.stringify(first.content);
  const say = (t: string) => new Response(JSON.stringify({ content: [{ type: "text", text: t }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
  if (prompt.includes("the weekly retro")) return say("It shipped two pull requests; one needed edits. It learned to keep migrations separate.");
  return say("NOTHING");
};

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let host: string;
let hook: { url: string; secret: string };
let delivery = 0;
let reviewer: string;
let builder: string;
let keeper: string;

const call = (method: string, path: string, body?: unknown, who = lena) => appCall(s, who.access_token, method, path, body);
const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const deliver = async (event: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  const res = await fetch(hook.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": `t-${delivery++}`, "x-hub-signature-256": `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}` },
    body,
  });
  return ((await res.json()) as { result: string }).result;
};
const repository = { full_name: REPO, default_branch: "main" };
const pr = (n: number, ref: string, extra: Record<string, unknown> = {}) => ({ number: n, html_url: `https://github.com/${REPO}/pull/${n}`, head: { ref, sha: "f00ba12345" }, title: `PR ${n}`, ...extra });
const thread = async (id: string) => (await call("GET", `/v1/app/routines/${id}/thread`)).json.messages as { author: string | null; text: string }[];
type Learning = { learn: string; scorecard: { week: { merged: number; prs: number; humanEdits: number; reverts: number; changesRequested: number; medianHoursToReady: number | null; review: { useful: number; falseAlarms: number } } }; signals: { kind: string; text: string }[] };
const learningOf = async (id: string) => (await call("GET", `/v1/app/routines/${id}/learning`)).json as Learning;
const kinds = async (id: string) => (await learningOf(id)).signals.map((x) => x.kind);
const owner = (): Owner => ({ kind: "user", uid: lena.user.uid });

beforeAll(async () => {
  s = await startStack({ ambient: { apiKey: "sk-test", fetchImpl: fakeAnthropic }, githubBatchMs: 60_000 });
  lena = await signIn(s, "apple-lena-tpl", "Lena Vogel");
  ben = await signIn(s, "apple-ben-tpl", "Ben Weiss");
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
  hook = (await call("GET", "/v1/app/github-hook")).json as typeof hook;
});
afterAll(() => s.close());

describe("the catalog", () => {
  it("has the Reviewer, the Builder and the Wiki keeper, with their questions", async () => {
    const t = (await call("GET", "/v1/app/bot-templates")).json.templates as { id: string; name: string; github: string[]; questions: { id: string; kind: string; options?: { id: string }[] }[]; secrets: { name: string }[] }[];
    expect(t.map((x) => [x.id, x.name, x.github])).toEqual([
      ["review_bot", "Reviewer", ["all_prs"]],
      ["builder", "Builder", ["own_prs"]],
      ["wiki_keeper", "Wiki keeper", ["merges", "own_prs"]],
    ]);
    expect(t[0]!.questions.map((q) => q.id)).toEqual(["repos", "strictness", "focus"]);
    expect(t[0]!.questions[1]!.options!.map((o) => o.id)).toEqual(["blockers_only", "everything"]);
    expect(t.every((x) => x.secrets.some((sec) => sec.name === "GH_TOKEN"))).toBe(true);
    // Everyone has bots: the catalog is everyone's.
    expect((await call("GET", "/v1/app/bot-templates", undefined, ben)).status).toBe(200);
  });
});

describe("a bot from a template", () => {
  it("is a whole bot: instructions, skills, goal, its repos and how it works on them", async () => {
    const out = (await call("POST", "/v1/app/bots/from-template", { template: "review_bot", answers: { repos: [`https://github.com/${REPO}`], strictness: "blockers_only", focus: "migrations" } })).json as {
      routine: { id: string; name: string; enabled: boolean; prompt: string; bot: { runtime: string; face: string; secrets: string[] } };
      needs: { secrets: string[]; webhook: boolean };
    };
    reviewer = out.routine.id;
    expect(out.routine).toMatchObject({ name: "Reviewer", enabled: true, bot: { runtime: "claude-code", face: "pebble", color: "sage", wear: ["nerd"], secrets: ["GH_TOKEN"] } });
    expect(out.routine.prompt).toContain("Comment only on what must change");
    expect(out.routine.prompt).toContain("Look especially closely at: migrations.");
    expect(out.needs).toEqual({ secrets: ["GH_TOKEN"], webhook: true });
    const files = ((await call("GET", `/v1/app/routines/${reviewer}/files`)).json.files as { path: string; version: number }[]).map((f) => f.path);
    expect(files).toEqual(["SOUL.md", "AGENTS.md", "GOAL.md", "memory.md", "skills/brain-check/SKILL.md", "skills/review-checklist/SKILL.md"]);
    expect((await call("GET", `/v1/app/routines/${reviewer}/github`)).json).toMatchObject({ repos: [REPO], on: ["all_prs"], branchPrefix: "ambient/reviewer/" });
    expect((await learningOf(reviewer)).learn).toBe("auto");
  });

  it("fills in the Builder and the Wiki keeper from the answers, and refuses bad ones", async () => {
    await call("PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "ghp_x" });
    const b = (await call("POST", "/v1/app/bots/from-template", { template: "builder", answers: { repos: [REPO], label: "bot-me", goal: "close 5 bugs a week" } })).json as { routine: { id: string; prompt: string }; needs: { secrets: string[] } };
    builder = b.routine.id;
    expect(b.routine.prompt).toContain('issues labelled "bot-me"');
    expect(b.needs.secrets).toEqual([]);
    expect((await call("GET", `/v1/app/routines/${builder}/files/content?path=GOAL.md`)).json.content).toContain("Outcome: close 5 bugs a week");
    const k = (await call("POST", "/v1/app/bots/from-template", { template: "wiki_keeper", answers: { repos: [REPO], where: "docs", docs: "handbook/" } })).json as { routine: { id: string; prompt: string } };
    keeper = k.routine.id;
    expect(k.routine.prompt).toContain("the docs in handbook/ of each repo");
    expect(k.routine.prompt).not.toContain("team wiki's product pages");
    expect((await call("GET", `/v1/app/routines/${keeper}/github`)).json).toMatchObject({ on: ["merges", "own_prs"] });
    expect((await call("POST", "/v1/app/bots/from-template", { template: "builder", answers: {} })).json.error).toBe("bad_request");
    expect((await call("POST", "/v1/app/bots/from-template", { template: "review_bot", answers: { repos: [REPO], strictness: "harsh" } })).json.error).toBe("bad_request");
    expect((await call("POST", "/v1/app/bots/from-template", { template: "nope", answers: {} })).json.error).toBe("no_such_template");
  });

  it("takes the name and look picked when it's made", async () => {
    const out = (await call("POST", "/v1/app/bots/from-template", { template: "builder", name: "Fixie", look: { face: "cloud", color: "clay", wear: ["cap"] }, answers: { repos: [REPO], label: "" } })).json as {
      routine: { name: string; bot: { faceName?: string; face?: string; color: string; wear: string[] }; schedule: { every: string } };
    };
    expect(out.routine.name).toBe("Fixie");
    expect(out.routine.bot).toMatchObject({ color: "clay", wear: ["cap"] });
    expect(JSON.stringify(out.routine.bot)).toContain("cloud");
    // No label: on request only.
    expect(out.routine.schedule.every).toBe("needed");
    expect((await call("POST", "/v1/app/bots/from-template", { template: "builder", look: { face: "square" }, answers: { repos: [REPO] } })).status).toBe(400);
  });

  it("over MCP: listed, and made paused", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await client.callTool({ name: "bot_templates", arguments: {} }))).toContain("review_bot: Reviewer.");
    const made = await client.callTool({ name: "create_bot_from_template", arguments: { template: "builder", answers: { repos: ["acme/other"] }, name: "Side builder" } });
    expect(text(made)).toContain("paused");
    const id = (made.structuredContent as { routine: { id: string; enabled: boolean } }).routine;
    expect(id.enabled).toBe(false);
    expect(text(await client.callTool({ name: "bot_learning", arguments: { id: id.id, learn: "ask" } }))).toContain("asks before every improvement");
    expect(text(await client.callTool({ name: "ambient_settings", arguments: {} }))).toContain("tells them when a bot needs them");
    await call("DELETE", `/v1/app/routines/${id.id}`);
  });
});

describe("GitHub's modes", () => {
  it("wakes a reviewer for every pull request but drafts, and keeps the bots apart", async () => {
    expect(await deliver("pull_request", { action: "opened", repository, pull_request: pr(20, "feature/search", { user: { login: "nik" } }) })).toBe("queued");
    expect(await deliver("pull_request", { action: "opened", repository, pull_request: pr(21, "feature/wip", { draft: true }) })).toBe("a draft");
    await s.folders.github!.idle();
    const t = await thread(reviewer);
    expect(t.at(-1)).toMatchObject({ author: "GitHub" });
    expect(t.at(-1)!.text).toContain(`pull request #20 in ${REPO} (branch feature/search) for you to review`);
    expect(t.at(-1)!.text).toContain("To review: pull request #20 “PR 20” by nik (head f00ba12)");
    // The builder's own pull requests aren't the keeper's or the reviewer's own.
    expect((await thread(builder)).some((m) => m.text.includes("#20"))).toBe(false);
  });

  it("wakes a wiki keeper for what's merged, not for docs-only pushes or its own merges", async () => {
    const commits = [{ id: "abc1234567", message: "Add sign-in\n\nlonger", modified: ["src/auth.ts"] }];
    expect(await deliver("push", { ref: "refs/heads/main", repository, commits, head_commit: { message: "Merge pull request #7 from acme/ambient/builder/login" }, compare: "https://github.com/acme/app/compare/a...b" })).toBe("queued");
    expect(await deliver("push", { ref: "refs/heads/main", repository, commits: [{ id: "d", message: "Fix typo", modified: ["README.md"] }], head_commit: { message: "Fix typo" } })).toBe("nothing to tell");
    expect(await deliver("push", { ref: "refs/heads/main", repository, commits, head_commit: { message: "Merge pull request #30 from acme/ambient/wiki-keeper/docs" } })).toBe("nothing to tell");
    await s.folders.github!.idle();
    const last = (await thread(keeper)).at(-1)!;
    expect(last.text).toContain(`GitHub: new on main in ${REPO}`);
    expect(last.text).toContain("abc1234 Add sign-in");
  });
});

describe("what a bot learns from", () => {
  it("its own pull requests: a person's push, changes requested by the team, ready, merged after edits, merged as it left it, closed, reverted", async () => {
    const opened = new Date(Date.now() - 2 * 3600_000).toISOString();
    await deliver("pull_request", { action: "opened", repository, pull_request: pr(7, "ambient/builder/login", { created_at: opened, title: "Login" }) });
    expect(await deliver("push", { ref: "refs/heads/ambient/builder/login", repository, sender: { login: "builder-gh" } })).toBe("noted");
    expect(await deliver("push", { ref: "refs/heads/ambient/builder/login", repository, sender: { login: "nik" } })).toBe("noted");
    await deliver("pull_request_review", { action: "submitted", repository, pull_request: pr(7, "ambient/builder/login"), review: { state: "changes_requested", body: "Split the migration.", user: { login: "nik" }, author_association: "MEMBER" } });
    // Not the team's people: a bot account, someone outside.
    await deliver("pull_request_review", { action: "submitted", repository, pull_request: pr(7, "ambient/builder/login"), review: { state: "changes_requested", body: "x", user: { login: "lint[bot]" }, author_association: "COLLABORATOR" } });
    await deliver("pull_request_review", { action: "submitted", repository, pull_request: pr(7, "ambient/builder/login"), review: { state: "changes_requested", body: "x", user: { login: "stranger" }, author_association: "NONE" } });
    await deliver("pull_request", { action: "ready_for_review", repository, pull_request: pr(7, "ambient/builder/login", { created_at: opened }) });
    await deliver("pull_request", { action: "closed", repository, pull_request: pr(7, "ambient/builder/login", { merged: true, title: "Login" }) });
    await deliver("pull_request", { action: "opened", repository, pull_request: pr(8, "ambient/builder/fix") });
    await deliver("pull_request", { action: "closed", repository, pull_request: pr(8, "ambient/builder/fix", { merged: true }) });
    await deliver("pull_request", { action: "closed", repository, pull_request: pr(10, "ambient/builder/nope", { merged: false }) });
    await deliver("pull_request", { action: "closed", repository, pull_request: pr(9, "revert-7-login", { merged: true, title: 'Revert "Login"', body: "Reverts acme/app#7" }) });
    await s.folders.github!.idle();
    expect((await kinds(builder)).sort()).toEqual(["changes_requested", "closed_unmerged", "human_push", "merged", "merged_edited", "ready", "reverted"]);
    const card = (await learningOf(builder)).scorecard.week;
    expect(card).toMatchObject({ prs: 3, merged: 2, humanEdits: 1, reverts: 1, changesRequested: 1 });
    expect(card.medianHoursToReady).toBeCloseTo(2, 0);
  });

  it("a reviewer's comments: followed by a change, or a false alarm the team said so", async () => {
    const signed = (id: number, body: string) => ({ action: "created", repository, pull_request: pr(20, "feature/search"), comment: { id, body: `${body}\n— Reviewer (Ambient)`, path: "src/a.ts", line: 3, user: { login: "rev-gh" } } });
    expect(await deliver("pull_request_review_comment", signed(501, "This leaks the token."))).toBe("noted");
    expect(await deliver("pull_request_review_comment", signed(502, "Rename this."))).toBe("noted");
    // A bot's "won't fix" doesn't count; a team member's does.
    await deliver("pull_request_review_comment", { action: "created", repository, pull_request: pr(20, "feature/search"), comment: { id: 601, in_reply_to_id: 502, body: "won't fix", user: { login: "x[bot]" }, author_association: "MEMBER" } });
    await deliver("pull_request_review_comment", { action: "created", repository, pull_request: pr(20, "feature/search"), comment: { id: 602, in_reply_to_id: 502, body: "Won't fix, that's intended.", user: { login: "nik" }, author_association: "MEMBER" } });
    await deliver("pull_request", { action: "synchronize", repository, pull_request: pr(20, "feature/search") });
    await deliver("pull_request", { action: "closed", repository, pull_request: pr(20, "feature/search", { merged: true }) });
    await s.folders.github!.idle();
    const card = (await learningOf(reviewer)).scorecard.week;
    expect(card.review).toMatchObject({ useful: 1, falseAlarms: 1 });
  });
});

describe("measuring it", () => {
  it("works out the scorecard and reads lessons", () => {
    const at = (d: number) => Date.parse("2026-11-01T00:00:00Z") + d * DAY;
    const sig: Signal[] = [
      { at: at(1), kind: "merged", text: "" },
      { at: at(2), kind: "merged_edited", text: "" },
      { at: at(3), kind: "closed_unmerged", text: "" },
      { at: at(3), kind: "ready", text: "", hours: 1 },
      { at: at(4), kind: "ready", text: "", hours: 3 },
      { at: at(5), kind: "review_useful", text: "", count: 3 },
      { at: at(5), kind: "review_false_alarm", text: "", count: 1 },
    ];
    expect(scorecard(sig, at(0), at(7))).toMatchObject({ prs: 3, merged: 2, mergeRate: 2 / 3, humanEditRate: 0.5, medianHoursToReady: 2, review: { useful: 3, falseAlarms: 1, precision: 0.75 } });
    const good = scorecard([{ at: at(1), kind: "merged", text: "" }, { at: at(2), kind: "merged", text: "" }], at(0), at(7));
    const bad = scorecard([{ at: at(1), kind: "closed_unmerged", text: "" }, { at: at(2), kind: "merged_edited", text: "" }], at(0), at(7));
    expect(worse(good, bad)).toBe(true);
    expect(worse(bad, good)).toBe(false);
    expect(lessonsOf("# Memory\n- PR #41 (2026-11-18): migrations go in their own PR.\n- Node 24 only.\nprose")).toEqual([
      { source: "PR #41", date: "2026-11-18", text: "migrations go in their own PR." },
      { source: null, date: null, text: "Node 24 only." },
    ]);
  });

  it("writes a weekly retro into the bot's thread, once a week", async () => {
    const l = s.folders.learning!;
    expect(await l.retro(owner(), builder, { force: true })).toBe("sent");
    const last = (await thread(builder)).at(-1)!;
    expect(last.text).toContain("This week: It shipped two pull requests");
    expect(last.text).toContain("2 of 3 pull requests merged");
    expect(await l.retro(owner(), builder)).toBe("skipped");
  });

  it("proposes undoing a lesson after which the scorecard got worse", async () => {
    const l = s.folders.learning! as unknown as { d: { now?: () => number } };
    const f = s.folders.folder as unknown as { d: { now?: () => number } };
    const now = Date.now();
    const made = (await call("POST", "/v1/app/bots/from-template", { template: "builder", answers: { repos: ["acme/third"] }, name: "Third" })).json as { routine: { id: string } };
    const id = made.routine.id;
    const at = (daysAgo: number) => now - daysAgo * DAY;
    const sig = async (daysAgo: number, kind: Signal["kind"]) => {
      l.d.now = () => at(daysAgo);
      await s.folders.learning!.signal(owner(), id, { kind, text: kind });
    };
    f.d.now = () => at(40);
    await s.folders.folder.write(owner(), id, "memory.md", "- Keep pull requests small.", { kind: "user", name: "Lena Vogel" }, null);
    f.d.now = () => at(20);
    await s.folders.folder.write(owner(), id, "memory.md", "- Keep pull requests small.\n- Bundle related fixes into one PR.", { kind: "amb", name: "Ambient" }, "bundle fixes");
    f.d.now = undefined;
    await sig(30, "merged");
    await sig(25, "merged");
    await sig(15, "closed_unmerged");
    await sig(10, "merged_edited");
    l.d.now = () => now;
    await s.folders.learning!.retro(owner(), id, { force: true });
    l.d.now = undefined;
    const d = ((await call("GET", "/v1/app/decisions")).json.decisions as { question: string; change: { path?: string; content?: string } | null }[]).find((x) => x.change?.path === "memory.md")!;
    expect(d.change!.content).toBe("- Keep pull requests small.");
    expect(d.question).toContain("bundle fixes");
  });
});
