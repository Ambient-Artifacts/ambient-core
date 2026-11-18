// Bots' folders in git (docs/bots.md, "A bot's folder in git"), end to end: a person's bots into
// their own connected repo (local bare repos), a team's into its wiki repo on the team server,
// after a change once things go quiet, renames and deletes following, edits made in git
// overwritten, a bots/ folder of the repo's own left alone, and the status the app shows.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitMessage, slugify, slugsOf } from "../src/bots/mirror.ts";
import { appCall, INVITE, mcpClient, signIn, startStack, text, type AppSession, type Stack } from "./helpers.ts";

const daily = { every: "day", time: "09:00", timezone: "Europe/Vienna" };
const tmp = mkdtempSync(join(tmpdir(), "ambient-bot-mirror-"));
const sh = (args: string[], cwd?: string) =>
  execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Nik", GIT_AUTHOR_EMAIL: "n@x", GIT_COMMITTER_NAME: "Nik", GIT_COMMITTER_EMAIL: "n@x", GIT_CONFIG_NOSYSTEM: "1" },
  });
const clone = (url: string, name: string) => {
  const dir = join(tmp, name);
  rmSync(dir, { recursive: true, force: true });
  sh(["-c", "protocol.file.allow=always", "clone", "-q", url, dir]);
  return dir;
};
const enc = encodeURIComponent;

let s: Stack;
let lena: AppSession;
let ben: AppSession;
let url: string;
let blog: string;
let n = 0;
const fresh = () => clone(url, `c${n++}`);
const call = (method: string, path: string, body?: unknown, who = lena) => appCall(s, who.access_token, method, path, body);
const settle = () => s.folders.mirror!.idle();

beforeAll(async () => {
  s = await startStack({ bots: { users: [], teams: [] }, mirrorDelayMs: 20 });
  lena = await signIn(s, "apple-lena-mirror", "Lena Vogel");
  ben = await signIn(s, "apple-ben-mirror", "Ben Weiss");
  s.config.bots!.users.push(lena.user.uid, ben.user.uid);
  await call("PUT", "/v1/app/routines/secrets/GH_TOKEN", { value: "ghp_secret_value" });
  // A bot of one's own runs on one of their computers.
  const code = String((await call("POST", "/v1/app/computers", { name: "Build server" })).json.code);
  const setup = await fetch(`${s.origin}/v1/host/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, info: { hostname: "srv-test", os: "Linux 6.8", runner: "0.9.0", claude: "2.1.300 (Claude Code)" } }) });
  const computer = ((await setup.json()) as { computer: { id: string } }).computer.id;
  const made = await call("POST", "/v1/app/routines", { name: "Blög Draft", prompt: "Write the weekly post.", schedule: daily, computer, bot: { secrets: ["GH_TOKEN"] } });
  blog = (made.json.routine as { id: string }).id;
  await call("PUT", `/v1/app/routines/${blog}/files/content?path=${enc("skills/tone/SKILL.md")}`, { content: "Short sentences." });
  await call("PUT", `/v1/app/routines/${blog}/files/content?path=memory.md`, { content: "- German posts." });
  await settle();
  // The repo has a bots/ file of its own before it's connected (made with an Ambient wiki marker so it connects).
  const bare = join(tmp, "wiki.git");
  sh(["init", "-q", "--bare", "-b", "main", bare]);
  url = `file://${bare}`;
});
afterAll(() => {
  s.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("helpers", () => {
  it("slugs names, keeps them unique, and writes who and why into the commit", () => {
    expect(slugify("Blög Draft!")).toBe("blog-draft");
    expect(slugify("  ")).toBe("bot");
    const slugs = slugsOf([
      { id: "aaaaaa111111", name: "Dev", createdAt: 1 },
      { id: "bbbbbb222222", name: "dev", createdAt: 2 },
    ]);
    expect([...slugs.values()]).toEqual(["dev", "dev-222222"]);
    expect(commitMessage([{ routineId: "r1", path: "memory.md", by: { kind: "bot", name: "Dev" }, why: "learned in a run" }], new Map([["r1", "Dev"]]))).toBe("Dev memory.md (the bot: learned in a run)");
  });
});

describe("a person's bots", () => {
  it("aren't mirrored without a repo, and the app says so", async () => {
    const out = await call("GET", `/v1/app/routines/${blog}/files`);
    expect(out.json.mirror).toMatchObject({ state: "not_connected", repo: null, path: null });
  });

  it("go into their repo when it's connected, with settings but no secret values", async () => {
    expect((await call("POST", "/v1/app/repo", { url, token: "t" })).status).toBe(200);
    const dir = fresh();
    expect(readFileSync(join(dir, "bots/blog-draft/AGENTS.md"), "utf8")).toBe("Write the weekly post.\n");
    expect(readFileSync(join(dir, "bots/blog-draft/memory.md"), "utf8")).toBe("- German posts.");
    expect(readFileSync(join(dir, "bots/blog-draft/skills/tone/SKILL.md"), "utf8")).toBe("Short sentences.");
    const settings = JSON.parse(readFileSync(join(dir, "bots/blog-draft/bot.json"), "utf8")) as Record<string, unknown>;
    expect(settings).toMatchObject({ name: "Blög Draft", secrets: ["GH_TOKEN"], runtime: "claude-code", mirroredFrom: "Ambient" });
    expect(sh(["ls-files"], dir)).not.toContain(".env");
    expect(readFileSync(join(dir, "bots/blog-draft/bot.json"), "utf8")).not.toContain("ghp_secret_value");
  }, 30_000);

  it("follow a change once it's quiet, and the status says where", async () => {
    await call("PUT", `/v1/app/routines/${blog}/files/content?path=memory.md`, { content: "- German posts.\n- Under 600 words." });
    await settle();
    expect(readFileSync(join(fresh(), "bots/blog-draft/memory.md"), "utf8")).toContain("Under 600 words.");
    const status = (await call("GET", `/v1/app/routines/${blog}/files`)).json.mirror as Record<string, unknown>;
    expect(status).toMatchObject({ state: "mirrored", repo: url, path: "bots/blog-draft/", lastError: null });
    expect(status.lastMirroredAt).toEqual(expect.any(Number));
  }, 30_000);

  it("go along with the worker's 15-minute sync too (built the way worker/cli.ts builds it), goal included", async () => {
    const { RoutineKeys } = await import("../src/routines/keys.ts");
    const { BotFolder } = await import("../src/bots/folder.ts");
    const { BotMirror } = await import("../src/bots/mirror.ts");
    const { PersonalRepos } = await import("../src/repos/personal.ts");
    const keys = new RoutineKeys({ control: s.control, personal: s.personal, master: s.config.masterKey });
    const folder = new BotFolder({ control: s.control, keys });
    // Written past the gateway (no debounced mirror of its own): only the worker's sync can carry it.
    await folder.write({ kind: "user", uid: lena.user.uid }, blog, "GOAL.md", "Outcome: 300 visitors a week.", { kind: "user", name: "Lena Vogel" }, null);
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(join(fresh(), "bots/blog-draft/GOAL.md"))).toBe(false);
    const mirror = new BotMirror({ control: s.control, keys, folder });
    const out = await new PersonalRepos(s.control, s.personal, { allowFile: true }, { files: (uid) => mirror.personalFiles(uid) }).syncAll();
    expect(JSON.stringify(out)).not.toContain("error");
    const dir = fresh();
    expect(readFileSync(join(dir, "bots/blog-draft/GOAL.md"), "utf8")).toBe("Outcome: 300 visitors a week.\n");
    expect(sh(["log", "-1", "--format=%s"], dir).trim()).toMatch(/^Ambient: sync \(.*bot files?\)$/);
    await settle();
  }, 30_000);

  it("carry the bot's SOUL.md once it has one", async () => {
    await call("PUT", `/v1/app/routines/${blog}/files/content?path=SOUL.md`, { content: "Warm and short." });
    await settle();
    expect(readFileSync(join(fresh(), "bots/blog-draft/SOUL.md"), "utf8")).toBe("Warm and short.\n");
  }, 30_000);

  it("overwrite edits made in git, and leave the repo's own files under bots/ alone", async () => {
    const work = fresh();
    writeFileSync(join(work, "bots/blog-draft/AGENTS.md"), "Edited in GitHub.\n");
    mkdirSync(join(work, "bots/notes"), { recursive: true });
    writeFileSync(join(work, "bots/notes/ideas.txt"), "ours\n");
    sh(["add", "-A"], work);
    sh(["commit", "-q", "-m", "edit in github"], work);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], work);
    const again = await call("POST", `/v1/app/routines/${blog}/files/mirror`);
    expect(again.json.mirror).toMatchObject({ state: "mirrored" });
    const dir = fresh();
    expect(readFileSync(join(dir, "bots/blog-draft/AGENTS.md"), "utf8")).toBe("Write the weekly post.\n");
    expect(readFileSync(join(dir, "bots/notes/ideas.txt"), "utf8")).toBe("ours\n");
    // The prompt stays Ambient's: nothing came in from git.
    expect(((await call("GET", "/v1/app/routines")).json.routines as { id: string; prompt: string }[]).find((r) => r.id === blog)!.prompt).toBe("Write the weekly post.");
  }, 30_000);

  it("move with a rename and go with a delete", async () => {
    await call("PATCH", `/v1/app/routines/${blog}`, { name: "Weekly post" });
    await settle();
    let dir = fresh();
    expect(existsSync(join(dir, "bots/blog-draft"))).toBe(false);
    expect(existsSync(join(dir, "bots/weekly-post/AGENTS.md"))).toBe(true);
    await call("DELETE", `/v1/app/routines/${blog}`);
    await settle();
    dir = fresh();
    expect(existsSync(join(dir, "bots/weekly-post"))).toBe(false);
    expect(existsSync(join(dir, "bots/notes/ideas.txt"))).toBe(true);
    expect(sh(["log", "--format=%s"], dir)).toContain("bot files");
  }, 30_000);

  it("are told to Amb in bot_files", async () => {
    const code = String((await call("POST", "/v1/app/computers", { name: "Ben's Mac" }, ben)).json.code);
    const setup = await fetch(`${s.origin}/v1/host/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, info: { hostname: "ben-mac", os: "macOS", runner: "0.9.0", claude: "2.1.300 (Claude Code)" } }) });
    const computer = ((await setup.json()) as { computer: { id: string } }).computer.id;
    const made = await call("POST", "/v1/app/routines", { name: "Inbox", prompt: "Sort mail.", schedule: daily, computer, bot: {} }, ben);
    const id = (made.json.routine as { id: string }).id;
    const pat = String((await call("POST", "/v1/app/pats", { label: "Claude" }, ben)).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, pat);
    expect(text(await client.callTool({ name: "bot_files", arguments: { id } }))).toContain("In git: not mirrored (the user has no repo connected");
  });
});

describe("a team's bots", () => {
  let id: string;

  it("go into the team's wiki repo on its server, outside the brain's pages", async () => {
    await call("POST", "/v1/app/teams/join", { code: INVITE });
    await s.t.run(async (ctx) => {
      for (const m of await ctx.db.query("members").collect()) await ctx.db.patch(m._id, { role: "admin" });
    });
    s.config.bots!.teams.push("acme");
    const made = await call("POST", "/v1/app/routines", { name: "Release notes", prompt: "Write the release notes.", schedule: daily, team: "acme", bot: {} });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    id = (made.json.routine as { id: string }).id;
    await call("PUT", `/v1/app/routines/${id}/files/content?path=${enc("skills/changelog/SKILL.md")}`, { content: "Link the changelog.", why: "readers asked" });
    await settle();
    const wiki = join(s.dataDir, "wiki");
    expect(readFileSync(join(wiki, "bots/release-notes/AGENTS.md"), "utf8")).toBe("Write the release notes.\n");
    expect(readFileSync(join(wiki, "bots/release-notes/skills/changelog/SKILL.md"), "utf8")).toBe("Link the changelog.");
    expect(readFileSync(join(wiki, "bots/README.md"), "utf8")).toContain("mirrored from Ambient");
    // Who and why go into the commit (the bot's creation may land in a commit of its own).
    const log = sh(["log", "-3", "--format=%s|%an"], wiki);
    expect(log).toMatch(/^bots: (Release notes \(someone: created\); )?Release notes skills\/changelog\/SKILL\.md \(Lena Vogel: readers asked\)\|Lena Vogel$/m);
    // Not pages of the brain: the store, search and the indexes leave bots/ out.
    expect(s.teamWiki.store.entries().some((e) => e.ref.startsWith("bots/"))).toBe(false);
    s.teamWiki.reload();
    expect(s.teamWiki.store.entries().some((e) => e.ref.startsWith("bots/"))).toBe(false);
    const found = await call("POST", "/v1/app/teams/acme/query", { op: "search", query: "changelog" });
    expect(JSON.stringify(found.json)).not.toContain("bots/");
    const status = (await call("GET", `/v1/app/routines/${id}/files`)).json.mirror;
    expect(status).toMatchObject({ state: "mirrored", repo: null, path: "bots/release-notes/" });
  }, 30_000);

  it("are pushed to the team's own repo when one is connected", async () => {
    const bare = join(tmp, "team.git");
    sh(["init", "-q", "--bare", "-b", "main", bare]);
    const teamUrl = `file://${bare}`;
    expect((await call("POST", "/v1/app/teams/acme/repo", { url: teamUrl, token: "t" })).status).toBe(200);
    await call("PUT", `/v1/app/routines/${id}/files/content?path=memory.md`, { content: "- Readers like short notes." });
    await settle();
    const dir = clone(teamUrl, "team-c1");
    expect(readFileSync(join(dir, "bots/release-notes/memory.md"), "utf8")).toBe("- Readers like short notes.");
    expect((await call("GET", `/v1/app/routines/${id}/files`)).json.mirror).toMatchObject({ state: "mirrored", repo: teamUrl, path: "bots/release-notes/" });
  }, 30_000);
});
