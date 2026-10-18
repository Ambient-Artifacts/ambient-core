// A team repo that already has files of its own: connected only once someone has seen them, and
// then either kept by Ambient (two-way, its own AGENTS.md and index.md untouched) or followed
// read-only (another tool keeps it: Ambient never writes, commits or pushes there).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HasContent } from "@brain/wiki";
import { TeamRemote } from "../src/remote.ts";
import { ReadOnlyWiki, TeamWiki } from "../src/wiki.ts";

const tmp = mkdtempSync(join(tmpdir(), "brain-existing-repo-"));
const sh = (args: string[], cwd?: string) =>
  execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Jonas Berg", GIT_AUTHOR_EMAIL: "jonas@example.com", GIT_COMMITTER_NAME: "Jonas Berg", GIT_COMMITTER_EMAIL: "jonas@example.com", GIT_CONFIG_NOSYSTEM: "1" },
  });

let n = 0;
/** A bare repo (file://) holding `files`, committed by someone else. */
function theirRepo(files: Record<string, string>): { url: string; work: string; push: (more: Record<string, string>, message?: string) => void } {
  const name = `their-${n++}`;
  const bare = join(tmp, `${name}.git`);
  sh(["init", "-q", "--bare", "-b", "main", bare]);
  const work = join(tmp, `${name}-work`);
  sh(["-c", "protocol.file.allow=always", "clone", "-q", bare, work]);
  const push = (more: Record<string, string>, message = "theirs") => {
    for (const [p, t] of Object.entries(more)) {
      mkdirSync(join(work, p, ".."), { recursive: true });
      writeFileSync(join(work, p), t);
    }
    sh(["add", "-A"], work);
    sh(["commit", "-q", "-m", message], work);
    sh(["-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], work);
  };
  if (Object.keys(files).length) push(files);
  return { url: `file://${bare}`, work, push };
}

const commits = (url: string) => Number(sh(["rev-list", "--count", "main"], url.replace("file://", "")).trim());
const opts = { allowFile: true };

async function freshWiki(): Promise<{ wiki: TeamWiki; remote: TeamRemote; dir: string }> {
  const data = mkdtempSync(join(tmp, "data-"));
  const dir = join(data, "wiki");
  const remote = new TeamRemote(join(data, "remote.json"), dir, opts);
  const wiki = await TeamWiki.open(dir, "team-acme", "Acme", remote);
  return { wiki, remote, dir };
}

const page = (title: string, type: string, body: string) => `---\ntitle: ${title}\ntype: ${type}\n---\n# ${title}\n\n${body}\n`;

describe("a team repo with files of its own", () => {
  it("is connected only once someone has seen what's in it", async () => {
    const theirs = theirRepo({ "AGENTS.md": "# Our rules\n", "clients/acme.md": page("Acme", "client", "A client.") });
    const { remote } = await freshWiki();
    const asked = await remote.connect(theirs.url, "t", { mode: "read-only" }).catch((e: unknown) => e);
    expect(asked).toBeInstanceOf(HasContent);
    expect(asked).toMatchObject({ files: 2, sample: ["clients/acme.md", "AGENTS.md"] });
    expect(remote.connected).toBe(false);
    expect(commits(theirs.url)).toBe(1);
  });

  it("read-only: becomes the repo's content, follows it, and never writes, commits or pushes", async () => {
    const theirs = theirRepo({ "AGENTS.md": "# Our rules\n", "index.md": "# Our wiki\n", "clients/acme.md": page("Acme", "client", "A client.") });
    const { wiki, remote, dir } = await freshWiki();
    const status = await remote.connect(theirs.url, "t", { mode: "read-only", existing: true });
    wiki.reload();
    expect(status).toMatchObject({ mode: "read-only", status: "ok", lastPushAt: null });
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Our rules\n");
    expect(readFileSync(join(dir, "index.md"), "utf8")).toBe("# Our wiki\n");
    expect(wiki.store.entries().some((e) => e.ref === "clients/acme")).toBe(true);

    await expect(wiki.write(async (put) => {
      await put("topics/x.md", page("X", "topic", "x"));
      return { message: "test: x", result: {} };
    })).rejects.toBeInstanceOf(ReadOnlyWiki);
    expect(existsSync(join(dir, "topics/x.md"))).toBe(false);

    // Their next commit comes in; a stray local change gives way to the repo.
    theirs.push({ "clients/beta.md": page("Beta", "client", "Another client.") });
    writeFileSync(join(dir, "index.md"), "changed here\n");
    expect(await remote.pull()).toBe(true);
    expect(existsSync(join(dir, "clients/beta.md"))).toBe(true);
    expect(readFileSync(join(dir, "index.md"), "utf8")).toBe("# Our wiki\n");
    // Still only their two commits: nothing of Ambient's ever went there.
    expect(commits(theirs.url)).toBe(2);

    // A server restart doesn't rebuild indexes into it either.
    const again = await TeamWiki.open(dir, "team-acme", "Acme", new TeamRemote(join(dir, "..", "remote.json"), dir, opts));
    expect(again.remote?.readOnly).toBe(true);
    expect(readFileSync(join(dir, "index.md"), "utf8")).toBe("# Our wiki\n");
  });

  it("read-only: refuses an empty repo, and a wiki that already has notes", async () => {
    const empty = theirRepo({});
    const { remote } = await freshWiki();
    await expect(remote.connect(empty.url, "t", { mode: "read-only", existing: true })).rejects.toMatchObject({ code: "bad_url" });

    const theirs = theirRepo({ "clients/acme.md": page("Acme", "client", "A client.") });
    const used = await freshWiki();
    await used.wiki.write(async (put) => {
      await put("notes/2026-10/2026-10-18-call-aaaaaa.md", page("Call", "note", "We talked."));
      return { message: "ingest: call", result: {} };
    });
    await expect(used.remote.connect(theirs.url, "t", { mode: "read-only", existing: true })).rejects.toMatchObject({ code: "not_empty" });
    expect(used.remote.connected).toBe(false);
  });

  it("two-way: merges with it, and never writes its own AGENTS.md or index.md", async () => {
    const theirs = theirRepo({ "AGENTS.md": "# Our rules\n", "index.md": "# Our wiki\n", "topics/pricing.md": page("Pricing", "topic", "Prices.") });
    const { wiki, remote, dir } = await freshWiki();
    const status = await remote.connect(theirs.url, "t", { mode: "two-way", existing: true });
    wiki.reload();
    expect(status).toMatchObject({ mode: "two-way", keep: ["AGENTS.md", "index.md"] });
    await wiki.write(async (put) => {
      await put("topics/onboarding.md", page("Onboarding", "topic", "How people start."));
      return { message: "test: onboarding", result: {} };
    });
    const pushed = mkdtempSync(join(tmp, "check-"));
    sh(["-c", "protocol.file.allow=always", "clone", "-q", theirs.url, pushed]);
    expect(readFileSync(join(pushed, "AGENTS.md"), "utf8")).toBe("# Our rules\n");
    expect(readFileSync(join(pushed, "index.md"), "utf8")).toBe("# Our wiki\n");
    expect(existsSync(join(pushed, "topics/onboarding.md"))).toBe(true);
    expect(existsSync(join(pushed, "topics/pricing.md"))).toBe(true);
    // The folder catalogs are Ambient's to keep.
    expect(existsSync(join(pushed, "topics/_index.md"))).toBe(true);
    expect(readFileSync(join(dir, "index.md"), "utf8")).toBe("# Our wiki\n");
  });
});
