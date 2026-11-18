// GitHub events and the PR gate (docs/bots.md, "GitHub events and the PR gate"). A bot that
// opens pull requests only marks one ready for review when nothing on it is open: every review
// comment (review bots and people) fixed or answered, and CI green. GitHub's webhooks wake the
// bot that owns the PR instead of it polling.
//
//   GitHub ──POST /v1/hooks/github/:hookId (signed)──▶ receive()
//        the repo ──▶ the owner's bots that watch it; the PR's branch ambient/<bot-slug>/… ──▶ the bot
//        events on that PR are batched (~90 s) ──▶ one message from "GitHub" in its thread, and a run
//
// One webhook per owner (a person, or a team), its id and secret sealed in records like everything
// else; which repos a bot watches is a record too: no Convex table for any of it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { sealMessage } from "./messages.ts";
import { slugsOf } from "./mirror.ts";

const HOOK = "github-hook";
const WATCH = "github-watch";
const PR = "github-pr";
/** What a run is told about one PR at most (a thread message is up to 8,000 characters). */
const MESSAGE_MAX = 7_500;
const BATCH_MS = 90_000;
/** Wake-ups per PR in an hour; after that one note, and quiet for the rest of the hour. */
const WAKES_AN_HOUR = 6;
const REPOS_MAX = 10;
export const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** The events to tick in GitHub's webhook settings. */
export const GITHUB_EVENTS = ["Pull requests", "Pull request reviews", "Pull request review comments", "Issue comments", "Check runs", "Check suites"];
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

/** The signature line a bot ends its own PR comments with (and the line GitHub events are told apart by). */
export const signature = (bot: string) => `— ${bot} (Ambient)`;
/** The branch prefix a bot's pull requests start with. */
export const branchPrefix = (slug: string) => `ambient/${slug}/`;

/**
 * A repo as people paste it, as owner/name: https or http, www., git@github.com:, .git, and links
 * into it (…/pull/12, …/tree/main) all work. Anything else comes back as written (and is refused).
 */
export function repoName(raw: string): string {
  const t = raw.trim();
  const m = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com[/:]|git@github\.com:)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(t);
  return m ? `${m[1]}/${m[2]}` : t.replace(/\.git$/, "").replace(/\/$/, "");
}

const ownerArgs = (owner: Owner) => (owner.kind === "user" ? { ownerKind: "user" as const, ownerId: owner.uid } : { ownerKind: "team" as const, ownerId: owner.teamId });

/** The hook's id in its URL: whose it is, and a random part. */
export function hookId(owner: Owner, random: string): string {
  return `${owner.kind === "user" ? "u" : "t"}.${owner.kind === "user" ? owner.uid : owner.teamId}.${random}`;
}

export function ownerOfHook(id: string): Owner | null {
  const m = /^([ut])\.([A-Za-z0-9_]{1,64})\.([A-Za-z0-9_-]{16,64})$/.exec(id);
  if (!m) return null;
  return m[1] === "u" ? { kind: "user", uid: m[2]! } : { kind: "team", teamId: m[2]! };
}

/** Whether `header` (X-Hub-Signature-256) signs `body` with `secret`; constant time. */
export function signedBy(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

interface Item {
  at: number;
  line: string;
}

interface Batch {
  timer: NodeJS.Timeout;
  owner: Owner;
  routineId: string;
  bot: string;
  repo: string;
  number: number;
  url: string;
  branch: string;
  items: Item[];
}

/** What GitHub sends that matters here (the fields used, all optional: payloads differ by event). */
interface Payload {
  action?: string;
  repository?: { full_name?: string; default_branch?: string };
  sender?: { login?: string };
  pull_request?: { number?: number; html_url?: string; merged?: boolean; draft?: boolean; head?: { ref?: string } };
  review?: { state?: string; body?: string | null; user?: { login?: string }; html_url?: string };
  comment?: { body?: string; path?: string; line?: number | null; original_line?: number | null; user?: { login?: string }; html_url?: string };
  issue?: { number?: number; html_url?: string; pull_request?: unknown };
  check_run?: { name?: string; conclusion?: string | null; status?: string; html_url?: string; head_sha?: string; pull_requests?: { number?: number; head?: { ref?: string } }[] };
  check_suite?: { conclusion?: string | null; status?: string; head_branch?: string | null; head_sha?: string; pull_requests?: { number?: number; head?: { ref?: string } }[] };
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export class GitHubEvents {
  private batches = new Map<string, Batch>();
  private wakes = new Map<string, number[]>();
  private paused = new Map<string, number>();
  private deliveries = new Map<string, number>();
  private flushing = new Set<Promise<unknown>>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      /** The gateway's public address (the webhook's URL). */
      origin: string;
      /** Starts a bot's run on its computer now (its long poll). */
      startNow?: (hostId: string, routineId: string) => boolean;
      /** CI failed on a watched repo's default branch: automations listening for it (docs/bots.md, "Automations"). */
      onCiFailed?: (e: { uid: string; repo: string; branch: string; url: string; sha: string }) => void;
      batchMs?: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  // ---- records ----

  private async read<T>(owner: Owner, kind: string, key: string): Promise<T | null> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind, key })) as { iv: string; ct: string; deleted: boolean } | null;
    if (!r || r.deleted) return null;
    const raw = await this.d.keys.open(owner, `record:${kind}`, r.iv, r.ct).catch(() => null);
    if (raw === null) return null;
    try {
      return JSON.parse((JSON.parse(raw) as { c: string }).c) as T;
    } catch {
      return null;
    }
  }

  private async write(owner: Owner, kind: string, key: string, value: unknown, deleted = false): Promise<void> {
    const content = JSON.stringify(value);
    const sealed = await this.d.keys.seal(owner, `record:${kind}`, JSON.stringify({ c: content }));
    await this.d.control.m(api.records.put, { ...ownerArgs(owner), kind, key, iv: sealed.iv, ct: sealed.ciphertext, size: Buffer.byteLength(content), byKind: "user", ...(deleted ? { deleted: true } : {}), keep: 1, now: this.now() });
  }

  // ---- the webhook ----

  url(id: string): string {
    return `${this.d.origin.replace(/\/$/, "")}/v1/hooks/github/${id}`;
  }

  /** The owner's webhook, made on first use. */
  async hook(owner: Owner): Promise<{ id: string; url: string; secret: string; events: string[] }> {
    let h = await this.read<{ id: string; secret: string }>(owner, HOOK, "hook");
    if (!h) {
      h = { id: hookId(owner, randomBytes(18).toString("base64url")), secret: randomBytes(32).toString("hex") };
      await this.write(owner, HOOK, "hook", h);
    }
    return { id: h.id, url: this.url(h.id), secret: h.secret, events: GITHUB_EVENTS };
  }

  /** A new URL and secret (the old ones stop working at once). */
  async rotate(owner: Owner): Promise<{ id: string; url: string; secret: string; events: string[] }> {
    const h = { id: hookId(owner, randomBytes(18).toString("base64url")), secret: randomBytes(32).toString("hex") };
    await this.write(owner, HOOK, "hook", h);
    return { ...h, url: this.url(h.id), events: GITHUB_EVENTS };
  }

  // ---- what a bot watches ----

  async watch(owner: Owner, routineId: string): Promise<string[]> {
    return (await this.read<{ repos: string[] }>(owner, WATCH, routineId))?.repos ?? [];
  }

  async setWatch(owner: Owner, routineId: string, repos: string[]): Promise<string[]> {
    const clean = [...new Set(repos.map(repoName))].filter(Boolean);
    const bad = clean.find((r) => !REPO.test(r));
    if (bad) throw new GitHubError("bad_repo", `“${bad}” isn't a GitHub repo: write it as owner/name.`);
    if (clean.length > REPOS_MAX) throw new GitHubError("bad_repo", `A bot watches up to ${REPOS_MAX} repos.`);
    await this.write(owner, WATCH, routineId, { repos: clean }, clean.length === 0);
    return clean;
  }

  /** The bot's branch prefix, whether or not it watches repos yet (null: no such bot). */
  async prefixOf(owner: Owner, routineId: string): Promise<string | null> {
    const slug = (await this.slugs(owner)).get(routineId);
    return slug ? branchPrefix(slug) : null;
  }

  /** For a run's instructions: the bot's branch prefix and the repos it watches (null: none). */
  async forRun(owner: Owner, routineId: string): Promise<{ prefix: string; repos: string[] } | null> {
    const repos = await this.watch(owner, routineId);
    if (!repos.length) return null;
    const slug = (await this.slugs(owner)).get(routineId);
    return slug ? { prefix: branchPrefix(slug), repos } : null;
  }

  private async slugs(owner: Owner): Promise<Map<string, string>> {
    const out = (await this.d.control.q(api.bots.ownerBots, ownerArgs(owner))) as { bots: { id: string; name: string; createdAt: number }[] } | null;
    return out ? slugsOf(out.bots.map((b) => ({ ...b, id: String(b.id) }))) : new Map();
  }

  /** Who hears about an owner's repos: the person, or a team's people. */
  private async peopleOf(owner: Owner): Promise<string[]> {
    if (owner.kind === "user") return [owner.uid];
    const out = (await this.d.control.q(api.bots.ownerBots, ownerArgs(owner))) as { team: { slug: string } | null } | null;
    if (!out?.team) return [];
    return ((await this.d.control.q(api.bots.heartbeatPeople, { users: [], teams: [out.team.slug] })) as string[]).map(String);
  }

  private async bots(owner: Owner): Promise<{ id: string; name: string; slug: string; repos: string[] }[]> {
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: WATCH, prefix: "" })) as { key: string }[];
    if (!rows.length) return [];
    const out = (await this.d.control.q(api.bots.ownerBots, ownerArgs(owner))) as { bots: { id: string; name: string; createdAt: number }[] } | null;
    if (!out) return [];
    const list = out.bots.map((b) => ({ ...b, id: String(b.id) }));
    const slugs = slugsOf(list);
    const result: { id: string; name: string; slug: string; repos: string[] }[] = [];
    for (const r of rows) {
      const b = list.find((x) => x.id === r.key);
      if (b) result.push({ id: b.id, name: b.name, slug: slugs.get(b.id)!, repos: await this.watch(owner, b.id) });
    }
    return result;
  }

  // ---- receiving ----

  /**
   * One delivery from GitHub. 401 when it isn't signed with the hook's secret, 404 for a hook that
   * doesn't exist (or was rotated away), 202 for everything else, also what's ignored: GitHub
   * shouldn't retry what doesn't concern a bot.
   */
  async receive(id: string, headers: { event?: string; signature?: string; delivery?: string }, body: Buffer): Promise<{ status: number; result: string }> {
    const owner = ownerOfHook(id);
    if (!owner) return { status: 404, result: "no such hook" };
    const h = await this.read<{ id: string; secret: string }>(owner, HOOK, "hook").catch(() => null);
    if (!h || h.id !== id) return { status: 404, result: "no such hook" };
    if (!signedBy(h.secret, body, headers.signature)) return { status: 401, result: "bad signature" };
    // The same delivery twice (a replay, GitHub's redelivery) is taken once.
    const now = this.now();
    for (const [k, at] of this.deliveries) if (now - at > 24 * 3600_000) this.deliveries.delete(k);
    if (headers.delivery) {
      if (this.deliveries.has(headers.delivery)) return { status: 202, result: "seen" };
      this.deliveries.set(headers.delivery, now);
    }
    let p: Payload;
    try {
      p = JSON.parse(body.toString("utf8")) as Payload;
    } catch {
      return { status: 400, result: "not JSON" };
    }
    if (headers.event === "ping") return { status: 202, result: "pong" };
    try {
      return { status: 202, result: await this.route(owner, headers.event ?? "", p) };
    } catch (err) {
      console.warn(`[github] an event wasn't handled: ${(err as Error).message}`);
      return { status: 202, result: "not handled" };
    }
  }

  private async route(owner: Owner, event: string, p: Payload): Promise<string> {
    const repo = p.repository?.full_name ?? "";
    if (!REPO.test(repo)) return "no repo";
    const watching = (await this.bots(owner)).filter((b) => b.repos.some((r) => r.toLowerCase() === repo.toLowerCase()));
    if (!watching.length) return "no bot watches this repo";

    // CI on the default branch (automations); not a bot's PR.
    if (event === "check_suite" && p.action === "completed" && p.check_suite && FAILED.has(p.check_suite.conclusion ?? "") && p.check_suite.head_branch && p.check_suite.head_branch === p.repository?.default_branch) {
      const branch = p.check_suite.head_branch;
      const sha = p.check_suite.head_sha ?? "";
      for (const uid of await this.peopleOf(owner)) this.d.onCiFailed?.({ uid, repo, branch, url: `https://github.com/${repo}/commit/${sha}`, sha });
      return "ci failed on the default branch";
    }

    const pr = await this.prOf(owner, repo, event, p);
    if (!pr) return "not a pull request";
    const bot = watching.find((b) => pr.branch.startsWith(branchPrefix(b.slug)));
    if (!bot) return "not a bot's pull request";
    const item = this.itemOf(event, p, bot.name, `${repo.toLowerCase()}#${pr.number}`);
    if (!item) return "nothing to tell";
    if (item === "closed" || item === "merged") {
      await this.note(owner, bot, repo, pr, `GitHub: pull request #${pr.number} (${repo}) was ${item}. ${pr.url}`);
      return item;
    }
    this.add(owner, bot, repo, pr, item);
    return "queued";
  }

  /** The PR an event is about, with its branch; learned from PR events for comments that don't say. */
  private async prOf(owner: Owner, repo: string, event: string, p: Payload): Promise<{ number: number; branch: string; url: string } | null> {
    const key = (n: number) => `${repo.toLowerCase()}#${n}`;
    if (p.pull_request?.number && p.pull_request.head?.ref) {
      const pr = { number: p.pull_request.number, branch: p.pull_request.head.ref, url: p.pull_request.html_url ?? `https://github.com/${repo}/pull/${p.pull_request.number}` };
      const known = await this.read<{ branch: string }>(owner, PR, key(pr.number));
      if (known?.branch !== pr.branch) await this.write(owner, PR, key(pr.number), { branch: pr.branch, url: pr.url });
      return pr;
    }
    const run = event === "check_run" ? p.check_run?.pull_requests?.[0] : event === "check_suite" ? p.check_suite?.pull_requests?.[0] : undefined;
    if (run?.number && run.head?.ref) return { number: run.number, branch: run.head.ref, url: `https://github.com/${repo}/pull/${run.number}` };
    // An issue comment on a PR carries no branch: what a PR event said about it before.
    if (event === "issue_comment" && p.issue?.pull_request && p.issue.number) {
      const known = await this.read<{ branch: string; url: string }>(owner, PR, key(p.issue.number));
      return known ? { number: p.issue.number, branch: known.branch, url: known.url } : null;
    }
    return null;
  }

  /** One line for the bot, "closed"/"merged", or null (not worth waking it for). */
  private itemOf(event: string, p: Payload, bot: string, pr: string): string | null {
    const own = (body: string | null | undefined) => (body ?? "").trim().endsWith(signature(bot));
    if (event === "pull_request") {
      if (p.action === "closed") return p.pull_request?.merged ? "merged" : "closed";
      return null;
    }
    if (event === "pull_request_review" && p.action === "submitted" && p.review) {
      if (own(p.review.body)) return null;
      const state = (p.review.state ?? "").toLowerCase().replace(/_/g, " ");
      // A review that's only the wrapper of its line comments says nothing of its own.
      if (state === "commented" && !(p.review.body ?? "").trim()) return null;
      return `Review by ${p.review.user?.login ?? "someone"} (${state || "reviewed"})${p.review.body?.trim() ? `: ${clip(p.review.body, 600)}` : ""} ${p.review.html_url ?? ""}`.trim();
    }
    if (event === "pull_request_review_comment" && p.action === "created" && p.comment) {
      if (own(p.comment.body)) return null;
      const line = p.comment.line ?? p.comment.original_line;
      return `Comment by ${p.comment.user?.login ?? "someone"} on ${p.comment.path ?? "the diff"}${line ? `:${line}` : ""}: ${clip(p.comment.body, 600)} ${p.comment.html_url ?? ""}`.trim();
    }
    if (event === "issue_comment" && p.action === "created" && p.comment) {
      if (own(p.comment.body)) return null;
      return `Comment by ${p.comment.user?.login ?? "someone"}: ${clip(p.comment.body, 600)} ${p.comment.html_url ?? ""}`.trim();
    }
    if (event === "check_run" && p.action === "completed" && p.check_run) {
      const c = p.check_run.conclusion ?? "";
      if (FAILED.has(c)) {
        this.redPRs.add(pr);
        return `✗ Check “${p.check_run.name ?? "check"}”: ${c.replace(/_/g, " ")} ${p.check_run.html_url ?? ""}`.trim();
      }
      return null;
    }
    if (event === "check_suite" && p.action === "completed" && p.check_suite) {
      // Green is news only after red: what it waits for to mark the PR ready.
      if (p.check_suite.conclusion === "success" && this.failedBefore(pr)) return "✓ All checks passed now.";
      return null;
    }
    return null;
  }

  /** PRs whose checks failed (repo#number), so green afterwards is news. */
  private redPRs = new Set<string>();
  private failedBefore(n: string): boolean {
    const was = this.redPRs.has(n);
    this.redPRs.delete(n);
    return was;
  }

  // ---- batching and waking ----

  private batchKey(routineId: string, repo: string, n: number) {
    return `${routineId}:${repo.toLowerCase()}#${n}`;
  }

  private add(owner: Owner, bot: { id: string; name: string }, repo: string, pr: { number: number; branch: string; url: string }, line: string) {
    const key = this.batchKey(bot.id, repo, pr.number);
    const open = this.batches.get(key);
    if (open) {
      open.items.push({ at: this.now(), line });
      return;
    }
    const timer = setTimeout(() => {
      const done = this.flush(key).catch((err: Error) => console.warn(`[github] a wake-up didn't go out: ${err.message}`));
      this.flushing.add(done);
      void done.finally(() => this.flushing.delete(done));
    }, this.d.batchMs ?? BATCH_MS);
    timer.unref();
    this.batches.set(key, { timer, owner, routineId: bot.id, bot: bot.name, repo, number: pr.number, url: pr.url, branch: pr.branch, items: [{ at: this.now(), line }] });
  }

  /** Everything batched (tests: then wait for what's on its way). */
  async idle(): Promise<void> {
    for (const [key, b] of this.batches) {
      clearTimeout(b.timer);
      await this.flush(key);
    }
    await Promise.all([...this.flushing]);
  }

  private async flush(key: string): Promise<void> {
    const b = this.batches.get(key);
    if (!b) return;
    this.batches.delete(key);
    const now = this.now();
    const until = this.paused.get(key);
    if (until && now < until) return;
    const recent = (this.wakes.get(key) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= WAKES_AN_HOUR) {
      this.paused.set(key, recent[0]! + 3600_000);
      await this.note(b.owner, { id: b.routineId, name: b.bot }, b.repo, { number: b.number, url: b.url }, `GitHub: pull request #${b.number} (${b.repo}) woke me ${WAKES_AN_HOUR} times this hour; I'm not woken for it again until ${new Date(recent[0]! + 3600_000).toISOString().slice(11, 16)} UTC. ${b.url}`);
      return;
    }
    this.wakes.set(key, [...recent, now]);
    let text = [`GitHub, on your pull request #${b.number} in ${b.repo} (branch ${b.branch}): ${b.url}`, ...b.items.map((i) => `- ${i.line}`), "", "Read everything open on it, fix or answer each, and follow the PR gate."].join("\n");
    if (text.length > MESSAGE_MAX) text = `${text.slice(0, MESSAGE_MAX - 60)}…\n(more on the PR itself: ${b.url})`;
    await this.send(b.owner, b.routineId, text, true);
  }

  private async note(owner: Owner, bot: { id: string; name: string }, _repo: string, _pr: { number: number; url: string }, text: string) {
    await this.send(owner, bot.id, text, false);
  }

  private async send(owner: Owner, routineId: string, text: string, run: boolean) {
    const sealed = await sealMessage(this.d.keys, owner, { text });
    const out = (await this.d.control.m(api.bots.wake, { id: routineId, iv: sealed.iv, ct: sealed.ct, authorName: "GitHub", run, now: this.now() })) as { ok: boolean; hostId?: string | null; enabled?: boolean };
    if (out.ok && run && out.enabled && out.hostId) this.d.startNow?.(String(out.hostId), routineId);
  }
}

export class GitHubError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * The PR gate in a bot's instructions (only for a bot that watches repos): how its branches are
 * named, drafts first, and ready for review only when nothing is open.
 */
export function prGate(bot: string, prefix: string, repos: string[]): string {
  return [
    `You work on ${repos.join(", ")} through pull requests, and GitHub's events on yours (reviews, comments, checks) start your runs with what came.`,
    `Name every branch you push ${prefix}<topic> (that's how your pull requests are known as yours) and open pull requests as drafts.`,
    "The PR gate: after each round, read everything on the pull request: its review comments (gh api repos/<owner>/<repo>/pulls/<n>/comments), its reviews and comments (gh pr view <n> --comments) and its checks (gh pr checks <n>). Fix or answer every comment, review bots' included: reply on the comment's thread, and resolve it once it's fixed; push the fixes.",
    "Only when nothing is open, every check is green and the latest review round brought nothing new, mark it ready (gh pr ready <n>) and say so in your last message. Never merge unless your AGENTS.md or GOAL.md says you may.",
    `End every comment you write on GitHub with the line "${signature(bot)}", so your own comments don't wake you.`,
  ].join(" ");
}
