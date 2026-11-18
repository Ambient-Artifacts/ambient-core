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
//
// A bot watches its repos in one or more modes (docs/bots.md, "Bot templates"): its own pull
// requests (own_prs: the PR gate), every pull request (all_prs: a reviewer), or what's merged into
// the default branch (merges: a wiki keeper). What happens to its own pull requests (merged as it
// left them, edited by a person first, closed, reverted, changes requested) and to a reviewer's
// comments (followed by a change, or a false alarm) goes to its learning (learning.ts) as signals.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { sealMessage } from "./messages.ts";
import { slugsOf } from "./mirror.ts";

const HOOK = "github-hook";
const WATCH = "github-watch";
const PR = "github-pr";
/** Who pushed to a bot's branch (the first pusher is the bot; anyone else is a person's edit). */
const BRANCH = "github-branch";
/** A reviewer's comments on a pull request, until it's closed (followed by a change or not). */
const REVIEW = "github-review";

export const WATCH_MODES = ["own_prs", "all_prs", "merges"] as const;
export type WatchMode = (typeof WATCH_MODES)[number];

/** Something about a bot's work on GitHub worth learning from (learning.ts). */
export interface GitHubSignal {
  kind: "closed_unmerged" | "merged" | "merged_edited" | "changes_requested" | "human_push" | "reverted" | "ready" | "review_useful" | "review_false_alarm";
  text: string;
  source?: string;
  hours?: number;
  count?: number;
}

/** A person from the team (GitHub's author_association), never a bot account. */
export function trusted(association: string | undefined, login: string | undefined): boolean {
  return Boolean(login) && !login!.endsWith("[bot]") && ["OWNER", "MEMBER", "COLLABORATOR"].includes((association ?? "").toUpperCase());
}

/** A reply that says a reviewer's comment isn't a real problem. */
const NOT_A_PROBLEM = /\b(won'?t fix|wontfix|not a bug|false positive|false alarm|intended|by design|works as intended|not an issue)\b/i;
/** What a run is told about one PR at most (a thread message is up to 8,000 characters). */
const MESSAGE_MAX = 7_500;
const BATCH_MS = 90_000;
/** Wake-ups per PR in an hour; after that one note, and quiet for the rest of the hour. */
const WAKES_AN_HOUR = 6;
const REPOS_MAX = 10;
export const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** The events to tick in GitHub's webhook settings. */
export const GITHUB_EVENTS = ["Pull requests", "Pull request reviews", "Pull request review comments", "Issue comments", "Check runs", "Check suites", "Pushes"];
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
  /** own: its own pull request (the PR gate); review: one to review; merges: what was merged. */
  kind: "own" | "review" | "merges";
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
  pull_request?: { number?: number; html_url?: string; merged?: boolean; draft?: boolean; title?: string; body?: string | null; created_at?: string; user?: { login?: string }; head?: { ref?: string; sha?: string } };
  review?: { state?: string; body?: string | null; user?: { login?: string }; html_url?: string; author_association?: string };
  comment?: { id?: number; in_reply_to_id?: number; body?: string; path?: string; line?: number | null; original_line?: number | null; user?: { login?: string }; html_url?: string; author_association?: string };
  /** push */
  ref?: string;
  compare?: string;
  head_commit?: { id?: string; message?: string } | null;
  commits?: { id?: string; message?: string; added?: string[]; modified?: string[]; removed?: string[] }[];
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
      /** What a bot's work on GitHub teaches it (docs/bots.md, "How bots learn"). */
      onSignal?: (owner: Owner, routineId: string, signal: GitHubSignal) => void;
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
    return (await this.watchOf(owner, routineId)).repos;
  }

  /** The repos a bot watches and how (its own PRs by default). */
  async watchOf(owner: Owner, routineId: string): Promise<{ repos: string[]; on: WatchMode[] }> {
    const w = await this.read<{ repos: string[]; on?: WatchMode[] }>(owner, WATCH, routineId);
    return { repos: w?.repos ?? [], on: w?.on?.length ? w.on : ["own_prs"] };
  }

  /** `on` left out: as it was (its own PRs for a bot that watched nothing yet). */
  async setWatch(owner: Owner, routineId: string, repos: string[], on?: WatchMode[]): Promise<string[]> {
    const clean = [...new Set(repos.map(repoName))].filter(Boolean);
    const bad = clean.find((r) => !REPO.test(r));
    if (bad) throw new GitHubError("bad_repo", `“${bad}” isn't a GitHub repo: write it as owner/name.`);
    if (clean.length > REPOS_MAX) throw new GitHubError("bad_repo", `A bot watches up to ${REPOS_MAX} repos.`);
    const modes = on ? [...new Set(on.filter((m) => (WATCH_MODES as readonly string[]).includes(m)))] : (await this.watchOf(owner, routineId)).on;
    if (!modes.length) throw new GitHubError("bad_mode", `Say how it works on them: ${WATCH_MODES.join(", ")}.`);
    await this.write(owner, WATCH, routineId, { repos: clean, on: modes }, clean.length === 0);
    return clean;
  }

  /** The bot's branch prefix, whether or not it watches repos yet (null: no such bot). */
  async prefixOf(owner: Owner, routineId: string): Promise<string | null> {
    const slug = (await this.slugs(owner)).get(routineId);
    return slug ? branchPrefix(slug) : null;
  }

  /** For a run's instructions: the bot's branch prefix, the repos it watches and how (null: none). */
  async forRun(owner: Owner, routineId: string): Promise<{ prefix: string; repos: string[]; on: WatchMode[] } | null> {
    const { repos, on } = await this.watchOf(owner, routineId);
    if (!repos.length) return null;
    const slug = (await this.slugs(owner)).get(routineId);
    return slug ? { prefix: branchPrefix(slug), repos, on } : null;
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

  private async bots(owner: Owner): Promise<Watcher[]> {
    const rows = (await this.d.control.q(api.records.list, { ...ownerArgs(owner), kind: WATCH, prefix: "" })) as { key: string }[];
    if (!rows.length) return [];
    const out = (await this.d.control.q(api.bots.ownerBots, ownerArgs(owner))) as { bots: { id: string; name: string; createdAt: number }[] } | null;
    if (!out) return [];
    const list = out.bots.map((b) => ({ ...b, id: String(b.id) }));
    const slugs = slugsOf(list);
    const result: Watcher[] = [];
    for (const r of rows) {
      const b = list.find((x) => x.id === r.key);
      if (b) result.push({ id: b.id, name: b.name, slug: slugs.get(b.id)!, ...(await this.watchOf(owner, b.id)) });
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
    return this.deliver(owner, headers, body);
  }

  /**
   * A delivery that's known to be the owner's (their webhook's, signed; or the GitHub App's, for an
   * installation linked to them): to the bots watching that repo.
   */
  async deliver(owner: Owner, headers: { event?: string; delivery?: string }, body: Buffer): Promise<{ status: number; result: string }> {
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
    if (event === "push") return this.onPush(owner, repo, p, watching);

    const pr = await this.prOf(owner, repo, event, p);
    if (!pr) return "not a pull request";
    // A merged "Revert …" of a bot's pull request: the strongest thing it can learn from.
    if (event === "pull_request" && p.action === "closed" && p.pull_request?.merged) await this.revertOf(owner, repo, p, watching);
    const results: string[] = [];
    const mine = watching.find((b) => b.on.includes("own_prs") && pr.branch.startsWith(branchPrefix(b.slug)));
    if (mine) results.push(await this.ownPr(owner, repo, event, p, pr, mine));
    for (const b of watching) {
      if (!b.on.includes("all_prs") || pr.branch.startsWith(branchPrefix(b.slug))) continue;
      const r = await this.toReview(owner, repo, event, p, pr, b);
      if (r) results.push(r);
    }
    if (!results.length) return mine ? "nothing to tell" : "not a bot's pull request";
    return results.find((r) => r !== "nothing to tell") ?? results[0]!;
  }

  private signal(owner: Owner, routineId: string, s: GitHubSignal) {
    try {
      this.d.onSignal?.(owner, routineId, s);
    } catch {
      // Learning never stands in the way of a wake-up.
    }
  }

  /** An event on a bot's own pull request: what it learns from, and what wakes it (the PR gate). */
  private async ownPr(owner: Owner, repo: string, event: string, p: Payload, pr: { number: number; branch: string; url: string }, bot: Watcher): Promise<string> {
    const title = p.pull_request?.title ? ` “${clip(p.pull_request.title, 120)}”` : "";
    if (event === "pull_request" && p.action === "ready_for_review") {
      const opened = Date.parse(p.pull_request?.created_at ?? "");
      this.signal(owner, bot.id, { kind: "ready", text: `PR #${pr.number}${title} marked ready for review`, source: pr.url, ...(Number.isFinite(opened) ? { hours: Math.max(0, (this.now() - opened) / 3600_000) } : {}) });
    }
    if (event === "pull_request" && p.action === "closed") {
      if (p.pull_request?.merged) {
        const b = await this.read<{ first: string | null; humans: string[] }>(owner, BRANCH, `${repo.toLowerCase()}:${pr.branch}`);
        const humans = b?.humans ?? [];
        this.signal(owner, bot.id, humans.length
          ? { kind: "merged_edited", text: `PR #${pr.number}${title} merged after ${humans.join(", ")} pushed changes to it`, source: pr.url }
          : { kind: "merged", text: `PR #${pr.number}${title} merged as it left it`, source: pr.url });
      } else this.signal(owner, bot.id, { kind: "closed_unmerged", text: `PR #${pr.number}${title} closed without merging`, source: pr.url });
    }
    if (event === "pull_request_review" && p.action === "submitted" && (p.review?.state ?? "").toLowerCase() === "changes_requested" && trusted(p.review?.author_association, p.review?.user?.login)) {
      this.signal(owner, bot.id, { kind: "changes_requested", text: `${p.review!.user!.login} asked for changes on PR #${pr.number}${p.review?.body?.trim() ? `: ${clip(p.review.body, 300)}` : ""}`, source: p.review?.html_url ?? pr.url });
    }
    const item = this.itemOf(event, p, bot.name, `${repo.toLowerCase()}#${pr.number}`);
    if (!item) return "nothing to tell";
    if (item === "closed" || item === "merged") {
      await this.note(owner, bot, repo, pr, `GitHub: pull request #${pr.number} (${repo}) was ${item}. ${pr.url}`);
      return item;
    }
    this.add(owner, bot, repo, pr, item, "own");
    return "queued";
  }

  /**
   * A pull request for a reviewer (all_prs): opened, ready or new commits wake it; its comments
   * are kept until the PR closes, then each counts as useful (a change followed) or a false alarm
   * (none did, or the team answered "won't fix").
   */
  private async toReview(owner: Owner, repo: string, event: string, p: Payload, pr: { number: number; branch: string; url: string }, bot: Watcher): Promise<string | null> {
    const key = `${bot.id}/${repo.toLowerCase()}#${pr.number}`;
    const st = (await this.read<{ comments: { id: number; at: number; verdict?: "useful" | "false_alarm" }[]; lastPushAt: number | null }>(owner, REVIEW, key)) ?? { comments: [], lastPushAt: null };
    if (event === "pull_request") {
      const a = p.action ?? "";
      if (a === "synchronize") {
        st.lastPushAt = this.now();
        if (st.comments.length) await this.write(owner, REVIEW, key, st);
      }
      if (a === "opened" || a === "reopened" || a === "ready_for_review" || a === "synchronize") {
        if (p.pull_request?.draft) return "a draft";
        const who = p.pull_request?.user?.login ? ` by ${p.pull_request.user.login}` : "";
        const sha = p.pull_request?.head?.sha ? ` (head ${p.pull_request.head.sha.slice(0, 7)})` : "";
        this.add(owner, bot, repo, pr, `${a === "synchronize" ? "New commits on" : "To review:"} pull request #${pr.number}${p.pull_request?.title ? ` “${clip(p.pull_request.title, 120)}”` : ""}${who}${sha}`, "review");
        return "queued";
      }
      if (a === "closed") {
        const open = st.comments.filter((c) => !c.verdict);
        const useful = open.filter((c) => st.lastPushAt !== null && st.lastPushAt > c.at).length;
        const missed = open.length - useful;
        if (useful) this.signal(owner, bot.id, { kind: "review_useful", count: useful, text: `${useful} of its comments on PR #${pr.number} were followed by a change`, source: pr.url });
        if (missed) this.signal(owner, bot.id, { kind: "review_false_alarm", count: missed, text: `${missed} of its comments on PR #${pr.number} led to no change`, source: pr.url });
        if (st.comments.length) await this.write(owner, REVIEW, key, st, true);
      }
      return null;
    }
    if (event === "pull_request_review_comment" && p.action === "created" && p.comment) {
      const body = p.comment.body ?? "";
      if (body.trim().endsWith(signature(bot.name)) && typeof p.comment.id === "number") {
        st.comments = [...st.comments, { id: p.comment.id, at: this.now() }].slice(-200);
        await this.write(owner, REVIEW, key, st);
        return "noted";
      }
      const to = st.comments.find((c) => c.id === p.comment!.in_reply_to_id && !c.verdict);
      if (to && NOT_A_PROBLEM.test(body) && trusted(p.comment.author_association, p.comment.user?.login)) {
        to.verdict = "false_alarm";
        await this.write(owner, REVIEW, key, st);
        this.signal(owner, bot.id, { kind: "review_false_alarm", text: `${p.comment.user!.login} answered “${clip(body, 160)}” to its comment on PR #${pr.number}`, source: p.comment.html_url ?? pr.url });
        return "noted";
      }
    }
    return null;
  }

  /**
   * A push: to the default branch, what was merged wakes bots that keep things in step with it
   * (merges); to a bot's own branch, who pushed (a person's push is an edit it learns from).
   */
  private async onPush(owner: Owner, repo: string, p: Payload, watching: Watcher[]): Promise<string> {
    const ref = p.ref ?? "";
    if (!ref.startsWith("refs/heads/")) return "not a branch";
    const branch = ref.slice("refs/heads/".length);
    if (branch === p.repository?.default_branch) {
      const commits = p.commits ?? [];
      if (!commits.length) return "nothing to tell";
      const message = p.head_commit?.message ?? "";
      const files = commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
      const docsOnly = files.length > 0 && files.every((f) => /\.md$/i.test(f) || f.startsWith("docs/"));
      let queued = false;
      for (const b of watching.filter((x) => x.on.includes("merges"))) {
        // Its own merged work, or a change only to docs: nothing to bring the docs in step with.
        if (message.includes(branchPrefix(b.slug)) || message.includes(signature(b.name)) || docsOnly) continue;
        const lines = commits.slice(-10).map((c) => `${(c.id ?? "").slice(0, 7)} ${clip((c.message ?? "").split("\n")[0], 160)}`);
        this.add(owner, b, repo, { number: 0, branch, url: p.compare ?? `https://github.com/${repo}/commits/${branch}` }, `Merged into ${branch}: ${lines.join(" · ")}`, "merges");
        queued = true;
      }
      return queued ? "queued" : "nothing to tell";
    }
    const own = watching.find((b) => b.on.includes("own_prs") && branch.startsWith(branchPrefix(b.slug)));
    if (!own) return "not a bot's branch";
    const sender = p.sender?.login ?? "";
    const key = `${repo.toLowerCase()}:${branch}`;
    const info = (await this.read<{ first: string | null; humans: string[] }>(owner, BRANCH, key)) ?? { first: null, humans: [] };
    if (!info.first) {
      await this.write(owner, BRANCH, key, { ...info, first: sender || null });
      return "noted";
    }
    if (sender && sender !== info.first && !sender.endsWith("[bot]") && !info.humans.includes(sender)) {
      await this.write(owner, BRANCH, key, { ...info, humans: [...info.humans, sender] });
      this.signal(owner, own.id, { kind: "human_push", text: `${sender} pushed changes to its branch ${branch}`, source: p.compare });
      return "noted";
    }
    return "nothing to tell";
  }

  /** A merged pull request titled Revert "…" whose body says "Reverts owner/repo#N", N a bot's. */
  private async revertOf(owner: Owner, repo: string, p: Payload, watching: Watcher[]) {
    if (!/^Revert "/.test(p.pull_request?.title ?? "")) return;
    const m = /Reverts\s+([\w.-]+\/[\w.-]+)#(\d+)/i.exec(p.pull_request?.body ?? "");
    if (!m || m[1]!.toLowerCase() !== repo.toLowerCase()) return;
    const known = await this.read<{ branch: string; url: string }>(owner, PR, `${repo.toLowerCase()}#${m[2]}`);
    if (!known) return;
    const b = watching.find((x) => known.branch.startsWith(branchPrefix(x.slug)));
    if (b) this.signal(owner, b.id, { kind: "reverted", text: `PR #${m[2]} was reverted`, source: p.pull_request?.html_url ?? known.url });
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

  private add(owner: Owner, bot: { id: string; name: string }, repo: string, pr: { number: number; branch: string; url: string }, line: string, kind: Batch["kind"]) {
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
    this.batches.set(key, { timer, kind, owner, routineId: bot.id, bot: bot.name, repo, number: pr.number, url: pr.url, branch: pr.branch, items: [{ at: this.now(), line }] });
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
    const head =
      b.kind === "review"
        ? `GitHub: pull request #${b.number} in ${b.repo} (branch ${b.branch}) for you to review: ${b.url}`
        : b.kind === "merges"
          ? `GitHub: new on ${b.branch} in ${b.repo}: ${b.url}`
          : `GitHub, on your pull request #${b.number} in ${b.repo} (branch ${b.branch}): ${b.url}`;
    const ask =
      b.kind === "review"
        ? "Review it as your instructions say: comments only on real problems, inline where they are, then one review."
        : b.kind === "merges"
          ? "Bring the docs and the wiki in step with what changed, as your instructions say; if nothing needs it, say so in one line."
          : "Read everything open on it, fix or answer each, and follow the PR gate.";
    let text = [head, ...b.items.map((i) => `- ${i.line}`), "", ask].join("\n");
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

interface Watcher {
  id: string;
  name: string;
  slug: string;
  repos: string[];
  on: WatchMode[];
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
/** A bot's instructions for the ways it works on GitHub (its own PRs, reviewing, merges). */
export function githubInstructions(bot: string, g: { prefix: string; repos: string[]; on?: WatchMode[] }): string {
  const on = g.on?.length ? g.on : ["own_prs"];
  return [on.includes("own_prs") ? prGate(bot, g.prefix, g.repos) : "", on.includes("all_prs") ? reviewGate(bot, g.repos) : "", on.includes("merges") ? mergesText(bot, g.prefix, g.repos) : ""].filter(Boolean).join(" ");
}

/** A reviewer's rules: comments only on real problems, inline, signed; never merges or pushes. */
export function reviewGate(bot: string, repos: string[]): string {
  return [
    `You review pull requests in ${repos.join(", ")}: GitHub's events start your runs when one is opened, marked ready or gets new commits.`,
    "Read the diff (gh pr diff <n>) and what it touches. Comment only on real problems (bugs, security, data loss, missing tests for risky code, broken migrations), inline on the line (gh api repos/<owner>/<repo>/pulls/<n>/comments), with what to do instead; then one review with gh pr review <n>: --request-changes when something must change, --comment otherwise. Never --approve a pull request whose checks aren't green, never push to it, never merge it.",
    `End every comment and review you write on GitHub with the line "${signature(bot)}". Whether your comments led to a change is how you learn which of them were worth making.`,
  ].join(" ");
}

/** A keeper's rules for what was merged: in step, in its own pull requests, never inventing. */
export function mergesText(bot: string, prefix: string, repos: string[]): string {
  return [
    `What's merged into the default branch of ${repos.join(", ")} starts your runs.`,
    `Your own changes go in pull requests from branches named ${prefix}<topic>, and every one ends with the line "${signature(bot)}", so your own merges don't start you again.`,
  ].join(" ");
}

export function prGate(bot: string, prefix: string, repos: string[]): string {
  return [
    `You work on ${repos.join(", ")} through pull requests, and GitHub's events on yours (reviews, comments, checks) start your runs with what came.`,
    `Name every branch you push ${prefix}<topic> (that's how your pull requests are known as yours) and open pull requests as drafts.`,
    "The PR gate: after each round, read everything on the pull request: its review comments (gh api repos/<owner>/<repo>/pulls/<n>/comments), its reviews and comments (gh pr view <n> --comments) and its checks (gh pr checks <n>). Fix or answer every comment, review bots' included: reply on the comment's thread, and resolve it once it's fixed; push the fixes.",
    "Only when nothing is open, every check is green and the latest review round brought nothing new, mark it ready (gh pr ready <n>), then hand it to your owner with ask_owner and wait: false (“PR #<n> is ready: <what it does>. Merge it?”, choices Merge / Changes) and say so in your last message. Never merge unless your AGENTS.md or GOAL.md says you may.",
    `End every comment you write on GitHub with the line "${signature(bot)}", so your own comments don't wake you.`,
  ].join(" ");
}
