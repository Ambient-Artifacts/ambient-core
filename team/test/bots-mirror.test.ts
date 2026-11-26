// Bots' folders mirrored into a team's wiki repo (docs/bots.md, "A bot's folder in git"): one
// commit replacing what Ambient mirrored before, only Ambient's files removed, kept out of the
// brain's pages, inside the fence when another tool keeps the repo, and never into a read-only one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotsMirror as BotsMirrorSchema, mirrorBots, mirrorRefusal, type BotsMirror } from "../src/bots.ts";
import { TeamRemote } from "../src/remote.ts";
import { ReadOnlyWiki, TeamWiki } from "../src/wiki.ts";

const tmp = mkdtempSync(join(tmpdir(), "brain-bots-mirror-"));
const sh = (args: string[], cwd?: string) =>
  execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Jonas Berg", GIT_AUTHOR_EMAIL: "jonas@example.com", GIT_COMMITTER_NAME: "Jonas Berg", GIT_COMMITTER_EMAIL: "jonas@example.com", GIT_CONFIG_NOSYSTEM: "1" },
  });
const opts = { allowFile: true };
let n = 0;

function theirRepo(files: Record<string, string>): string {
  const bare = join(tmp, `their-${n}.git`);
  const work = join(tmp, `their-${n++}-work`);
  sh(["init", "-q", "--bare", "-b", "main", bare]);
  sh(["-c", "protocol.file.allow=always", "clone", "-q", bare, work]);
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(work, p, ".."), { recursive: true });
    writeFileSync(join(work, p), t);
  }
  sh(["add", "-A"], work);
  sh(["commit", "-q", "-m", "theirs"], work);
  sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], work);
  return `file://${bare}`;
}

async function freshWiki() {
  const data = mkdtempSync(join(tmp, "data-"));
  const dir = join(data, "wiki");
  const remote = new TeamRemote(join(data, "remote.json"), dir, opts);
  const wiki = await TeamWiki.open(dir, "team-acme", "Acme", remote);
  return { wiki, remote, dir };
}

const body = (bots: BotsMirror["bots"], message = "Dev memory.md (the bot: learned in a run)", author?: string): BotsMirror => ({ bots, readme: "# Bots\n\nMirrored from Ambient.\n", message, ...(author ? { author } : {}) });
const dev = (memory: string) => ({ slug: "dev", files: [{ path: "AGENTS.md", content: "Fix the flaky test.\n" }, { path: "memory.md", content: memory }, { path: "skills/ci/SKILL.md", content: "Run npm test." }] });

describe("bots in a team's wiki repo", () => {
  it("are written in one commit, kept out of the brain's pages, and replaced as a whole", async () => {
    const { wiki, dir } = await freshWiki();
    // A bots/ file of the team's own (it was there before Ambient mirrored anything).
    mkdirSync(join(dir, "bots", "ours"), { recursive: true });
    writeFileSync(join(dir, "bots", "ours", "plan.md"), "---\ntitle: Plan\ntype: topic\n---\n# Plan\n");
    const out = await mirrorBots(wiki, body([dev("- npm ci with Node 24.")], "Dev created (Lena Vogel: created)", "Lena Vogel"));
    expect(out).toMatchObject({ folder: "bots", files: 4 });
    expect(readFileSync(join(dir, "bots/dev/skills/ci/SKILL.md"), "utf8")).toBe("Run npm test.");
    expect(sh(["log", "-1", "--format=%s|%an"], dir).trim()).toBe("bots: Dev created (Lena Vogel: created)|Lena Vogel");
    wiki.reload();
    expect(wiki.store.entries().some((e) => e.ref.startsWith("bots/"))).toBe(false);
    expect(existsSync(join(dir, "bots", "_index.md"))).toBe(false);

    // Nothing changed: no commit.
    const head = sh(["rev-parse", "HEAD"], dir).trim();
    expect((await mirrorBots(wiki, body([dev("- npm ci with Node 24.")]))).commit).toBeNull();
    expect(sh(["rev-parse", "HEAD"], dir).trim()).toBe(head);

    // The bot is renamed: its old folder goes, the team's own file stays.
    await mirrorBots(wiki, body([{ ...dev("- npm ci with Node 24."), slug: "builder" }]));
    expect(existsSync(join(dir, "bots/dev"))).toBe(false);
    expect(readFileSync(join(dir, "bots/builder/AGENTS.md"), "utf8")).toBe("Fix the flaky test.\n");
    expect(existsSync(join(dir, "bots/ours/plan.md"))).toBe(true);
  });

  it("take a bot's GOAL.md and SOUL.md (2026-11-26: refused with a bare 400 before)", async () => {
    const loopie = { slug: "loopie", files: [{ path: "AGENTS.md", content: "Build follow-ups.\n" }, { path: "GOAL.md", content: "Useful follow-ups.\n" }, { path: "SOUL.md", content: "Short and warm.\n" }, { path: "memory.md", content: "" }] };
    const sent = body([loopie]);
    expect(BotsMirrorSchema.safeParse(sent).success).toBe(true);
    const { wiki, dir } = await freshWiki();
    await mirrorBots(wiki, sent);
    expect(readFileSync(join(dir, "bots/loopie/GOAL.md"), "utf8")).toBe("Useful follow-ups.\n");
    expect(readFileSync(join(dir, "bots/loopie/SOUL.md"), "utf8")).toBe("Short and warm.\n");
    // A file it doesn't know yet is named, not a bare 400.
    const odd = body([{ slug: "loopie", files: [{ path: "TOOLS.md", content: "x" }] }]);
    const parsed = BotsMirrorSchema.safeParse(odd);
    expect(parsed.success).toBe(false);
    const issues = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
    expect(mirrorRefusal(odd, issues)).toContain("TOOLS.md for loopie");
  });

  it("refuse bad paths and twin folders", async () => {
    const { wiki } = await freshWiki();
    await expect(mirrorBots(wiki, body([dev("x"), dev("y")]))).rejects.toThrow("Two bots are named dev");
  });

  it("go inside the fence when another tool keeps the repo, and stay out of its brain", async () => {
    const url = theirRepo({ "AGENTS.md": "# Our rules\n", "clients/acme.md": "---\ntitle: Acme\ntype: client\n---\n# Acme\n" });
    const { wiki, remote } = await freshWiki();
    await remote.connect(url, "t", { mode: "folder", existing: true });
    wiki.reload();
    const out = await mirrorBots(wiki, body([dev("- learned")]));
    expect(out.folder).toBe("ambient/bots");
    const work = join(tmp, `check-${n++}`);
    sh(["-c", "protocol.file.allow=always", "clone", "-q", url, work]);
    expect(readFileSync(join(work, "ambient/bots/dev/memory.md"), "utf8")).toBe("- learned");
    expect(existsSync(join(work, "bots"))).toBe(false);
    wiki.reload();
    expect(wiki.store.entries().some((e) => e.ref.includes("bots/"))).toBe(false);
  });

  it("are never written into a repo another tool keeps read-only", async () => {
    const url = theirRepo({ "AGENTS.md": "# Our rules\n" });
    const { wiki, remote } = await freshWiki();
    await remote.connect(url, "t", { mode: "read-only", existing: true });
    await expect(mirrorBots(wiki, body([dev("x")]))).rejects.toBeInstanceOf(ReadOnlyWiki);
  });
});
