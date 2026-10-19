// A team wiki in the team's own repo, end to end: admins connect it, every team commit is
// pushed, and edits made in the repo are pulled in before the next write.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

let s: Stack;
let lena: string;
const tmp = mkdtempSync(join(tmpdir(), "ambient-team-repo-"));
const sh = (args: string[], cwd?: string) =>
  execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Jonas", GIT_AUTHOR_EMAIL: "j@x", GIT_COMMITTER_NAME: "Jonas", GIT_COMMITTER_EMAIL: "j@x", GIT_CONFIG_NOSYSTEM: "1" },
  });
const clone = (url: string, name: string) => {
  const dir = join(tmp, name);
  rmSync(dir, { recursive: true, force: true });
  sh(["-c", "protocol.file.allow=always", "clone", "-q", url, dir]);
  return dir;
};
const note = (id: string, title: string) => ({
  schema: "brain.team-note/v1",
  note_id: id,
  team_id: "x",
  recorded_by: "x",
  recorded_at: "2026-10-08T09:00:00+02:00",
  duration_s: 600,
  language: "en-US",
  kind: "meeting",
  consent: { mode: "all-agreed", confirmed_at: "2026-10-08T09:11:00+02:00" },
  entry_page: { frontmatter: { title, summary: `${title}.`, people: [], projects: [] }, body_md: `# ${title}\n\nWe talked.\n` },
  transcript: null,
  participants_hint: [],
  client: { app: "1.0 (1)", transcriber: "SpeechTranscriber en-US", compiler: "fm-ondevice" },
});
let url: string;

beforeAll(async () => {
  s = await startStack();
  lena = (await signIn(s, "apple-lena-team-repo", "Lena Vogel")).access_token;
  await appCall(s, lena, "POST", "/v1/app/teams/join", { code: INVITE });
  const dir = join(tmp, "team.git");
  sh(["init", "-q", "--bare", "-b", "main", dir]);
  url = `file://${dir}`;
});
afterAll(() => {
  s.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("team repo", () => {
  it("only team owners and admins can connect it", async () => {
    const r = await appCall(s, lena, "POST", "/v1/app/teams/acme/repo", { url, token: "t" });
    expect(r).toMatchObject({ status: 403, json: { error: "admins_only" } });
  });

  it("an admin connects it and the team wiki's history is pushed", async () => {
    await s.t.run(async (ctx) => {
      for (const m of await ctx.db.query("members").collect()) await ctx.db.patch(m._id, { role: "admin" });
    });
    const r = await appCall(s, lena, "POST", "/v1/app/teams/acme/repo", { url, token: "team-secret" });
    expect(r.status).toBe(200);
    expect(r.json.repo).toMatchObject({ url, branch: "main", status: "ok" });
    const dir = clone(url, "c1");
    expect(existsSync(join(dir, "orgs/bergmann-logistik.md"))).toBe(true);
    expect(existsSync(join(dir, "index.md"))).toBe(true);
    expect(readFileSync(join(s.dataDir, "remote.json"), "utf8")).toContain("team-secret");
    expect(readFileSync(join(s.dataDir, "wiki", ".git", "config"), "utf8")).not.toContain("team-secret");
  });

  it("pushes every team commit and pulls edits made in the repo before the next write", async () => {
    expect((await appCall(s, lena, "POST", "/v1/app/teams/acme/notes", note("01JBTEAMREPONOTE0000000001", "Repo kickoff"))).status).toBe(200);
    const dir = clone(url, "c2");
    expect(sh(["log", "--format=%s"], dir)).toContain("ingest: Repo kickoff");

    // Someone adds a page in the repo...
    writeFileSync(join(dir, "people/jonas-becker.md"), readFileSync(join(dir, "people/jonas-becker.md"), "utf8").replace(/\n*$/, "\n\nAdded in GitHub.\n"));
    sh(["add", "-A"], dir);
    sh(["commit", "-q", "-m", "edit in github"], dir);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], dir);

    // ...and the next team write starts from it, so nothing is lost.
    expect((await appCall(s, lena, "POST", "/v1/app/teams/acme/notes", note("01JBTEAMREPONOTE0000000002", "Repo follow-up"))).status).toBe(200);
    const after = clone(url, "c3");
    const log = sh(["log", "--format=%s"], after);
    expect(log).toContain("edit in github");
    expect(log).toContain("ingest: Repo follow-up");
    expect(readFileSync(join(after, "people/jonas-becker.md"), "utf8")).toContain("Added in GitHub.");
    const page = await appCall(s, lena, "POST", "/v1/app/teams/acme/query", { op: "getByRef", ref: "people/jonas-becker" });
    expect((page.json.result as { body: string }).body).toContain("Added in GitHub.");

    const status = await appCall(s, lena, "GET", "/v1/app/teams/acme/repo");
    expect(status.json.repo).toMatchObject({ status: "ok", lastError: null });
  });

  it("asks before connecting a repo with files of its own, then connects it either way it's told", async () => {
    const other = join(tmp, "other.git");
    sh(["init", "-q", "--bare", "-b", "main", other]);
    const work = clone(`file://${other}`, "other-work");
    writeFileSync(join(work, "README.md"), "unrelated\n");
    writeFileSync(join(work, "AGENTS.md"), "# Our rules\n");
    sh(["add", "-A"], work);
    sh(["commit", "-q", "-m", "x"], work);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], work);
    expect(await appCall(s, lena, "POST", "/v1/app/teams/acme/repo", { url: `file://${other}`, token: "t" })).toMatchObject({
      status: 409,
      json: { error: "has_content", files: 2, sample: ["AGENTS.md", "README.md"] },
    });

    // Read-only would replace the team's notes: refused for a team that has some.
    expect(await appCall(s, lena, "POST", "/v1/app/teams/acme/repo", { url: `file://${other}`, token: "t", mode: "read-only", existing: true })).toMatchObject({ status: 400, json: { error: "not_empty" } });

    // Two-way, once seen: merged and pushed there, with the repo's own AGENTS.md untouched.
    const r = await appCall(s, lena, "POST", "/v1/app/teams/acme/repo", { url: `file://${other}`, token: "t", existing: true });
    expect(r).toMatchObject({ status: 200, json: { repo: { mode: "two-way", keep: ["AGENTS.md"] } } });
    const check = clone(`file://${other}`, "other-check");
    expect(readFileSync(join(check, "AGENTS.md"), "utf8")).toBe("# Our rules\n");
    expect(existsSync(join(check, "README.md"))).toBe(true);
    expect(existsSync(join(check, "index.md"))).toBe(true);

    expect((await appCall(s, lena, "DELETE", "/v1/app/teams/acme/repo")).status).toBe(204);
    expect((await appCall(s, lena, "GET", "/v1/app/teams/acme/repo")).json.repo).toBeNull();
  });
});
