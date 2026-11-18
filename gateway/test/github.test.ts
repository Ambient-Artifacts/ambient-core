// GitHub events and the PR gate (docs/bots.md): the owner's webhook (signed, rotated), which repos
// a bot watches, events on a bot's pull request (known by its branch) gathered into one message
// that starts its run, comments the bot signed itself left out, the hourly cap, closed/merged as
// a note, CI failing on the default branch for automations, the gate in the bot's instructions,
// and the MCP tools.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botSystem } from "../src/bots/folder.ts";
import { ownerOfHook, prGate, signedBy } from "../src/bots/github.ts";
import { appCall, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const info = { hostname: "srv-test", os: "Linux 6.8", runner: "0.9.0", claude: "2.1.300 (Claude Code)" };
const REPO = "acme/app";

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let host: string;
let builder: string;
let writer: string;
let hook: { url: string; secret: string; events: string[] };
let delivery = 0;

const hostCall = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${s.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
};
const call = (method: string, path: string, body?: unknown, who = lena) => appCall(s, who.access_token, method, path, body);

/** GitHub's delivery: signed with the secret (or a wrong one, or none). */
const deliver = async (event: string, payload: unknown, opts: { secret?: string | null; url?: string; id?: string } = {}) => {
  const body = JSON.stringify(payload);
  const secret = opts.secret === undefined ? hook.secret : opts.secret;
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": opts.id ?? `d-${delivery++}` };
  if (secret) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const res = await fetch(opts.url ?? hook.url, { method: "POST", headers, body });
  return { status: res.status, json: (await res.json()) as { result: string } };
};

const pr = (n: number, ref: string, extra: Record<string, unknown> = {}) => ({ number: n, html_url: `https://github.com/${REPO}/pull/${n}`, head: { ref }, ...extra });
const repository = { full_name: REPO, default_branch: "main" };
const thread = async (id: string) => (await call("GET", `/v1/app/routines/${id}/thread`)).json.messages as { role: string; author: string | null; text: string }[];
const requested = async (id: string) => ((await call("GET", "/v1/app/routines")).json.routines as { id: string; runRequested: boolean }[]).find((r) => r.id === id)!.runRequested;
/** Takes the requested run and finishes it (so the next wake-up is visible). */
const runOnce = async (id: string) => {
  const start = (await hostCall(host, "POST", `/v1/host/routines/${id}/runs`)).json as { run: { id: string }; routine: { prompt: string }; resume: { message: string } | null; workspace?: { system: string } };
  await hostCall(host, "POST", `/v1/host/runs/${start.run.id}`, { status: "succeeded", summary: "Done.", sessionId: "sess-gh", handoff: "Status: done\nok" });
  return start;
};

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] }, ambient: {}, githubBatchMs: 60_000 });
  lena = await signIn(s, "apple-lena-gh", "Lena Vogel");
  ben = await signIn(s, "apple-ben-gh", "Ben Weiss");
  s.config.bots!.users.push(lena.user.uid);
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  host = String((await hostCall("", "POST", "/v1/host/setup", { code, info })).json.token);
  const computer = ((await call("GET", "/v1/app/routines")).json.computers as { id: string }[])[0]!.id;
  builder = ((await call("POST", "/v1/app/routines", { name: "Builder", prompt: "Build what's asked.", schedule: daily, computer, bot: { isolation: "container" } })).json.routine as { id: string }).id;
  writer = ((await call("POST", "/v1/app/routines", { name: "Writer", prompt: "Write.", schedule: daily, computer, bot: { isolation: "container" } })).json.routine as { id: string }).id;
});
afterAll(() => s.close());

describe("the webhook", () => {
  it("is made on first use for who may change the owner's bots, and rotates", async () => {
    const first = (await call("GET", "/v1/app/github-hook")).json as typeof hook & { id: string };
    expect(first.url).toMatch(/\/v1\/hooks\/github\/u\./);
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.events).toContain("Pull request review comments");
    expect((await call("GET", "/v1/app/github-hook")).json.url).toBe(first.url);
    expect((await call("GET", "/v1/app/github-hook", undefined, ben)).status).toBe(403);
    expect((await call("GET", "/v1/app/github-hook?team=nope")).status).toBe(403);
    hook = (await call("POST", "/v1/app/github-hook/rotate")).json as typeof hook;
    expect(hook.url).not.toBe(first.url);
    expect((await deliver("ping", { zen: "hi" }, { url: first.url, secret: first.secret })).status).toBe(404);
    expect((await deliver("ping", { zen: "hi" })).json.result).toBe("pong");
  });

  it("refuses what isn't signed with its secret, and takes a delivery once", async () => {
    expect((await deliver("ping", {}, { secret: null })).status).toBe(401);
    expect((await deliver("ping", {}, { secret: "wrong" })).status).toBe(401);
    expect((await deliver("ping", {}, { id: "same" })).json.result).toBe("pong");
    expect((await deliver("ping", {}, { id: "same" })).json.result).toBe("seen");
    expect(signedBy("k", Buffer.from("x"), `sha256=${createHmac("sha256", "k").update("x").digest("hex")}`)).toBe(true);
    expect(ownerOfHook("u.abc.short")).toBeNull();
  });
});

describe("a bot's repos and pull requests", () => {
  it("watches repos it's given, and its branches start with its name", async () => {
    expect((await call("PUT", `/v1/app/routines/${builder}/github`, { repos: ["not a repo"] })).json.error).toBe("bad_repo");
    const set = (await call("PUT", `/v1/app/routines/${builder}/github`, { repos: [`https://github.com/${REPO}.git`] })).json;
    expect(set).toEqual({ repos: [REPO], branchPrefix: "ambient/builder/" });
    expect((await call("GET", `/v1/app/routines/${builder}/github`)).json).toEqual({ repos: [REPO], branchPrefix: "ambient/builder/" });
    expect((await call("PUT", `/v1/app/routines/${builder}/github`, { repos: [REPO] }, ben)).status).toBe(404);
  });

  it("gathers the events on its PR into one message from GitHub that starts a run", async () => {
    expect((await deliver("pull_request", { action: "opened", repository, pull_request: pr(7, "ambient/builder/login") })).json.result).toBe("nothing to tell");
    expect((await deliver("pull_request_review_comment", { action: "created", repository, pull_request: pr(7, "ambient/builder/login"), comment: { body: "This leaks the token.", path: "src/auth.ts", line: 42, user: { login: "review-bot" }, html_url: "https://x/c1" } })).json.result).toBe("queued");
    await deliver("pull_request_review", { action: "submitted", repository, pull_request: pr(7, "ambient/builder/login"), review: { state: "changes_requested", body: "Two problems.", user: { login: "review-bot" } } });
    // An issue comment carries no branch: the PR event before told it.
    expect((await deliver("issue_comment", { action: "created", repository, issue: { number: 7, pull_request: {} }, comment: { body: "Also update the docs.", user: { login: "nik" } } })).json.result).toBe("queued");
    await deliver("check_run", { action: "completed", repository, check_run: { name: "test", conclusion: "failure", html_url: "https://x/run", pull_requests: [{ number: 7, head: { ref: "ambient/builder/login" } }] } });
    // Its own comment (signed) and an empty wrapper review don't count.
    expect((await deliver("issue_comment", { action: "created", repository, issue: { number: 7, pull_request: {} }, comment: { body: "Fixed.\n— Builder (Ambient)", user: { login: "nik" } } })).json.result).toBe("nothing to tell");
    expect((await deliver("pull_request_review", { action: "submitted", repository, pull_request: pr(7, "ambient/builder/login"), review: { state: "commented", body: "", user: { login: "review-bot" } } })).json.result).toBe("nothing to tell");
    expect(await requested(builder)).toBe(false);
    await s.folders.github!.idle();
    const last = (await thread(builder)).at(-1)!;
    expect(last).toMatchObject({ role: "user", author: "GitHub" });
    expect(last.text).toContain(`GitHub, on your pull request #7 in ${REPO} (branch ambient/builder/login)`);
    expect(last.text).toContain("- Comment by review-bot on src/auth.ts:42: This leaks the token. https://x/c1");
    expect(last.text).toContain("- Review by review-bot (changes requested): Two problems.");
    expect(last.text).toContain("- Comment by nik: Also update the docs.");
    expect(last.text).toContain("- ✗ Check “test”: failure https://x/run");
    expect(last.text).not.toContain("Fixed.");
    expect(await requested(builder)).toBe(true);
    const start = await runOnce(builder);
    // The run starts with GitHub's message as it is (not "wrote to you in the app"), and the gate in its instructions.
    expect(start.resume?.message ?? start.routine.prompt).toContain("GitHub, on your pull request #7");
    expect(start.resume?.message ?? "").not.toContain("wrote to you in the Ambient app");
    expect(start.workspace!.system).toContain("The PR gate:");
    expect(start.workspace!.system).toContain("ambient/builder/<topic>");
  });

  it("says when checks are green again after red", async () => {
    await deliver("check_suite", { action: "completed", repository, check_suite: { conclusion: "success", head_branch: "ambient/builder/login", pull_requests: [{ number: 7, head: { ref: "ambient/builder/login" } }] } });
    await s.folders.github!.idle();
    expect((await thread(builder)).at(-1)!.text).toContain("✓ All checks passed now.");
    await runOnce(builder);
    // Green again without red before: nothing to tell.
    expect((await deliver("check_suite", { action: "completed", repository, check_suite: { conclusion: "success", pull_requests: [{ number: 7, head: { ref: "ambient/builder/login" } }] } })).json.result).toBe("nothing to tell");
  });

  it("leaves out other branches and repos the bot doesn't watch", async () => {
    expect((await deliver("pull_request_review_comment", { action: "created", repository, pull_request: pr(8, "feature/x"), comment: { body: "hm", user: { login: "a" } } })).json.result).toBe("not a bot's pull request");
    expect((await deliver("pull_request_review_comment", { action: "created", repository: { full_name: "acme/other" }, pull_request: pr(1, "ambient/builder/x"), comment: { body: "hm", user: { login: "a" } } })).json.result).toBe("no bot watches this repo");
  });

  it("wakes a bot at most 6 times an hour per PR, then says so once", async () => {
    for (let i = 0; i < 8; i++) {
      await deliver("issue_comment", { action: "created", repository, issue: { number: 7, pull_request: {} }, comment: { body: `round ${i}`, user: { login: "review-bot" } } });
      await s.folders.github!.idle();
    }
    const msgs = (await thread(builder)).filter((m) => m.author === "GitHub");
    // 2 wake-ups before (the batch, green again), 4 more this hour, then the note.
    expect(msgs.filter((m) => m.text.includes("round ")).length).toBe(4);
    expect(msgs.filter((m) => m.text.includes("I'm not woken for it again")).length).toBe(1);
    await runOnce(builder);
  });

  it("tells it about a merge without starting a run", async () => {
    expect((await deliver("pull_request", { action: "closed", repository, pull_request: pr(9, "ambient/builder/other", { merged: true }) })).json.result).toBe("merged");
    expect((await thread(builder)).at(-1)!.text).toContain("pull request #9 (acme/app) was merged");
    expect(await requested(builder)).toBe(false);
  });

  it("hands CI failing on the default branch to automations", async () => {
    const seen: unknown[] = [];
    const auto = s.automations!;
    const original = auto.onEvent.bind(auto);
    auto.onEvent = async (e) => {
      seen.push(e);
    };
    expect((await deliver("check_suite", { action: "completed", repository, check_suite: { conclusion: "failure", head_branch: "main", head_sha: "abc123" } })).json.result).toBe("ci failed on the default branch");
    auto.onEvent = original;
    expect(seen).toEqual([{ kind: "github_ci_failed", uid: lena.user.uid, repo: REPO, branch: "main", url: `https://github.com/${REPO}/commit/abc123`, sha: "abc123" }]);
  });
});

describe("the gate in a bot's instructions", () => {
  it("is there only for a bot that watches repos", async () => {
    const start = await runOnce(writer);
    expect(start.workspace!.system).not.toContain("PR gate");
    expect(botSystem("Builder", "srv", "manual", true, false, { prefix: "ambient/builder/", repos: [REPO] })).toContain(prGate("Builder", "ambient/builder/", [REPO]));
    expect(prGate("Builder", "ambient/builder/", [REPO])).toContain('End every comment you write on GitHub with the line "— Builder (Ambient)"');
  });
});

describe("the MCP tools", () => {
  it("give the webhook's URL without its secret, and set the repos", async () => {
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["github_webhook", "watch_github"]));
    const hookText = text(await client.callTool({ name: "github_webhook", arguments: {} }));
    expect(hookText).toContain(hook.url);
    expect(hookText).not.toContain(hook.secret);
    const watched = text(await client.callTool({ name: "watch_github", arguments: { id: writer, repos: [REPO] } }));
    expect(watched).toContain("its branches start with ambient/writer/");
    expect((await call("GET", `/v1/app/routines/${writer}/github`)).json.repos).toEqual([REPO]);
  });
});

describe("repo names as people paste them", () => {
  it("come back as owner/name", async () => {
    const { repoName } = await import("../src/bots/github.ts");
    for (const raw of ["acme/web", "https://github.com/acme/web", "http://www.github.com/acme/web.git", "git@github.com:acme/web.git", "https://github.com/acme/web/pull/12", "github.com/acme/web/tree/main", " acme/web/ "]) expect(repoName(raw)).toBe("acme/web");
    expect(repoName("https://gitlab.com/acme/web")).toBe("https://gitlab.com/acme/web");
  });
});
