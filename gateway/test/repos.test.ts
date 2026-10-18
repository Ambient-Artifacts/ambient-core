// Personal wikis in the user's own git repo, end to end against local bare repos.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePage, splitCompiled } from "@brain/spec";
import { checkout } from "@brain/wiki";
import { appCall, fixturePersonalOps, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
let token: string;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const tmp = mkdtempSync(join(tmpdir(), "ambient-repos-"));
const sh = (args: string[], cwd?: string) =>
  execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Nik", GIT_AUTHOR_EMAIL: "n@x", GIT_COMMITTER_NAME: "Nik", GIT_COMMITTER_EMAIL: "n@x", GIT_CONFIG_NOSYSTEM: "1" },
  });
const bare = (name: string) => {
  const dir = join(tmp, `${name}.git`);
  sh(["init", "-q", "--bare", "-b", "main", dir]);
  return `file://${dir}`;
};
const clone = (url: string, name: string) => {
  const dir = join(tmp, name);
  rmSync(dir, { recursive: true, force: true });
  sh(["-c", "protocol.file.allow=always", "clone", "-q", url, dir]);
  return dir;
};
const raw = "---\nid: 01JBRAWTRANSCRIPT0000000001\nscope: personal\n---\n[00:00:01] Anna: Hallo zusammen.\n";
let url: string;

beforeAll(async () => {
  s = await startStack();
  token = (await signIn(s, "apple-repo-user", "Repo User")).access_token;
  await appCall(s, token, "POST", "/v1/app/personal/sync", {
    device_id: "iphone",
    ops: [...fixturePersonalOps(), { op: "upsert", path: "raw/2026/10/01JBRAWTRANSCRIPT0000000001.md", hash: sha(raw), content: raw, updated: "2026-10-07" }],
    since_seq: 0,
  });
  url = bare("wiki");
});
afterAll(() => {
  s.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("personal repo", () => {
  it("refuses http, private addresses and repos with other content", async () => {
    // Also loopback and cloud metadata written as IPv6 (URL parsing turns them into ::ffff:7f00:1 etc.).
    for (const bad of ["http://github.com/x/y.git", "https://10.0.0.5/x.git", "https://127.0.0.1/x.git", "https://[::ffff:127.0.0.1]/x.git", "https://[::ffff:169.254.169.254]/x.git", "https://[::1]/x.git", "https://[2002:a9fe:a9fe::1]/x.git", "https://[64:ff9b::a9fe:a9fe]/x.git", "https://[fec0::1]/x.git"]) {
      const r = await appCall(s, token, "POST", "/v1/app/repo", { url: bad, token: "t" });
      expect(r.status, bad).toBe(400);
      expect(r.json.error).toBe("bad_url");
    }
    const foreign = bare("foreign");
    const work = clone(foreign, "foreign-work");
    writeFileSync(join(work, "README.md"), "my code\n");
    sh(["add", "-A"], work);
    sh(["commit", "-q", "-m", "init"], work);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], work);
    const r = await appCall(s, token, "POST", "/v1/app/repo", { url: foreign, token: "t" });
    expect(r).toMatchObject({ status: 409, json: { error: "has_content", files: 1, sample: ["README.md"] } });
  });

  it("connects a repo with files of its own once asked to, and leaves its own AGENTS.md alone", async () => {
    const theirs = bare("theirs");
    const work = clone(theirs, "theirs-work");
    writeFileSync(join(work, "README.md"), "my notes\n");
    writeFileSync(join(work, "AGENTS.md"), "# My agent rules\n");
    sh(["add", "-A"], work);
    sh(["commit", "-q", "-m", "init"], work);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], work);
    const other = await signIn(s, "apple-existing-repo", "Erik Existing");
    expect((await appCall(s, other.access_token, "POST", "/v1/app/repo", { url: theirs, token: "t" })).status).toBe(409);
    await appCall(s, other.access_token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps() });
    const r = await appCall(s, other.access_token, "POST", "/v1/app/repo", { url: theirs, token: "t", existing: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const after = clone(theirs, "theirs-check");
    expect(readFileSync(join(after, "AGENTS.md"), "utf8")).toBe("# My agent rules\n");
    expect(readFileSync(join(after, "README.md"), "utf8")).toBe("my notes\n");
    expect(existsSync(join(after, "wiki/index.md"))).toBe(true);
    // And on the next sync too.
    expect((await appCall(s, other.access_token, "POST", "/v1/app/repo/sync")).status).toBe(200);
    expect(readFileSync(join(clone(theirs, "theirs-check2"), "AGENTS.md"), "utf8")).toBe("# My agent rules\n");
  });

  it("connects and pushes the whole wiki: pages, transcripts, indexes and AGENTS.md", async () => {
    const r = await appCall(s, token, "POST", "/v1/app/repo", { url, token: "secret-token" });
    expect(r.status).toBe(200);
    expect(r.json.repo).toMatchObject({ url, branch: "main", status: "ok" });
    const dir = clone(url, "check1");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("Start with `wiki/index.md`");
    expect(existsSync(join(dir, "wiki/index.md"))).toBe(true);
    expect(existsSync(join(dir, "wiki/people/_index.md"))).toBe(true);
    expect(existsSync(join(dir, "wiki/people/anna-mueller.md"))).toBe(true);
    expect(readFileSync(join(dir, "raw/2026/10/01JBRAWTRANSCRIPT0000000001.md"), "utf8")).toBe(raw);
    expect(sh(["log", "--format=%an"], dir).trim()).toBe("Ambient Bot");
    expect(readFileSync(join(dir, ".git/config"), "utf8")).not.toContain("secret-token");
    expect((await appCall(s, token, "GET", "/v1/app/repo")).json.repo).toMatchObject({ status: "ok" });
  });

  it("brings edits made in the repo back, merges a page changed on both sides, and pushes phone changes", async () => {
    // An agent edits the repo: a note, a new page, and a person's current truth.
    const dir = clone(url, "agent");
    const notePath = "wiki/notes/2026/10/2026-10-01-preisgespraech-mit-anna-1xq7zk.md";
    writeFileSync(join(dir, notePath), readFileSync(join(dir, notePath), "utf8") + "\nAdded by Claude Code.\n");
    writeFileSync(join(dir, "wiki/topics/pricing-ideas.md"), "---\ntitle: Pricing ideas\ntype: topic\nsummary: Ideas for pricing.\nupdated: 2026-10-08\n---\n# Pricing ideas\n\n- Annual billing from 10 seats.\n\n## Timeline\n");
    const annaPath = "wiki/people/anna-mueller.md";
    const anna = readFileSync(join(dir, annaPath), "utf8");
    const { currentTruth } = splitCompiled(parsePage(anna).body);
    writeFileSync(join(dir, annaPath), anna.replace(currentTruth.split("\n").find((l) => l.startsWith("- "))!, "- Edited in the repo: leads pricing."));
    sh(["add", "-A"], dir);
    sh(["commit", "-q", "-m", "agent edits"], dir);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], dir);

    // Meanwhile the phone adds a timeline line to the same person.
    const phoneAnna = fixturePersonalOps().find((o) => o.path === annaPath)!.content.replace(/\n*$/, "\n- 2026-10-08: Sent the draft ([note](../notes/2026/10/x.md))\n");
    await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: [{ op: "upsert", path: annaPath, hash: sha(phoneAnna), content: phoneAnna, updated: "2026-10-08" }] });

    const res = await appCall(s, token, "POST", "/v1/app/repo/sync");
    expect(res.status).toBe(200);
    expect(res.json.result).toMatchObject({ imported: 3, merged: 1 });

    // The phone pulls the repo's edits and the merged page.
    const pulled = await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: [], since_seq: 0 });
    const changes = new Map((pulled.json.changes as { path: string; content: string }[]).map((c) => [c.path, c.content]));
    expect(changes.get(notePath)).toContain("Added by Claude Code.");
    expect(changes.get("wiki/topics/pricing-ideas.md")).toContain("Annual billing from 10 seats.");
    const merged = splitCompiled(parsePage(changes.get(annaPath)!).body);
    expect(merged.currentTruth).toContain("Edited in the repo: leads pricing.");
    expect(merged.timeline).toContain("- 2026-10-08: Sent the draft ([note](../notes/2026/10/x.md))");

    // The repo has the merged page too, and the new page is in the generated index.
    const after = clone(url, "check2");
    expect(readFileSync(join(after, annaPath), "utf8")).toContain("Sent the draft");
    expect(readFileSync(join(after, "wiki/topics/_index.md"), "utf8")).toContain("[Pricing ideas](pricing-ideas.md)");

    // Nothing changed since: the next sync is quiet.
    const quiet = await appCall(s, token, "POST", "/v1/app/repo/sync");
    expect(quiet.json.result).toMatchObject({ exported: 0, imported: 0, commit: null });
  });

  it("removes pages deleted on the phone and restores files deleted only in the repo", async () => {
    await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: [{ op: "delete", path: "wiki/topics/preisstrategie.md" }] });
    const dir = clone(url, "agent2");
    rmSync(join(dir, "wiki/projects/onboarding-redesign.md"));
    sh(["add", "-A"], dir);
    sh(["commit", "-q", "-m", "oops"], dir);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], dir);

    await appCall(s, token, "POST", "/v1/app/repo/sync");
    const after = clone(url, "check3");
    expect(existsSync(join(after, "wiki/topics/preisstrategie.md"))).toBe(false);
    expect(existsSync(join(after, "wiki/projects/onboarding-redesign.md"))).toBe(true);
  });

  it("doesn't import a file too large to be one of Ambient's pages", async () => {
    const dir = clone(url, "agent-huge");
    writeFileSync(join(dir, "wiki/topics/huge.md"), `---\ntitle: Huge\ntype: topic\n---\n${"x".repeat(700_000)}\n`);
    sh(["add", "-A"], dir);
    sh(["commit", "-q", "-m", "huge"], dir);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], dir);
    expect((await appCall(s, token, "POST", "/v1/app/repo/sync")).status).toBe(200);
    const paths = await s.t.run(async (ctx) => (await ctx.db.query("personalPages").collect()).map((p) => p.path));
    expect(paths).not.toContain("wiki/topics/huge.md");
  });

  it("never follows a symlink committed to the repo out of the checkout", async () => {
    // A link to a file of the server's own (the gateway's env file, in real life) must not land in
    // the wiki: git checks it out as a plain file holding the link's target, and only that comes in.
    const secret = join(tmp, "gateway.env");
    writeFileSync(secret, "BRAIN_MASTER_KEY=top-secret-value\n");
    const dir = clone(url, "agent3");
    symlinkSync(secret, join(dir, "wiki/topics/leak.md"));
    symlinkSync(tmp, join(dir, "wiki/linked-dir"));
    sh(["add", "-A"], dir);
    sh(["commit", "-q", "-m", "links"], dir);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], dir);

    expect((await appCall(s, token, "POST", "/v1/app/repo/sync")).status).toBe(200);
    const pulled = await appCall(s, token, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: [], since_seq: 0 });
    const contents = (pulled.json.changes as { path: string; content: string }[]).map((c) => c.content ?? "").join("\n");
    expect(contents).not.toContain("top-secret-value");
    expect(readFileSync(secret, "utf8")).toBe("BRAIN_MASTER_KEY=top-secret-value\n");
  });

  it("stops a clone that takes more disk than allowed", async () => {
    const bigUrl = bare("big");
    const work = clone(bigUrl, "big-work");
    // Random bytes don't compress: the clone takes about what the file is.
    writeFileSync(join(work, "blob.bin"), randomBytes(2 * 1024 * 1024));
    sh(["add", "-A"], work);
    sh(["commit", "-q", "-m", "big"], work);
    sh(["push", "-q", "origin", "HEAD:main"], work);
    const into = mkdtempSync(join(tmpdir(), "ambient-big-"));
    await expect(checkout({ url: bigUrl, token: "t" }, join(into, "c"), { allowFile: true, maxCloneBytes: 512 * 1024 })).rejects.toMatchObject({ code: "too_large" });
    await expect(checkout({ url: bigUrl, token: "t" }, join(into, "d"), { allowFile: true })).resolves.toMatchObject({ branch: "main" });
    rmSync(into, { recursive: true, force: true });
  });

  it("disconnects", async () => {
    expect((await appCall(s, token, "DELETE", "/v1/app/repo")).status).toBe(204);
    expect((await appCall(s, token, "GET", "/v1/app/repo")).json.repo).toBeNull();
  });
});
