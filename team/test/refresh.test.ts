import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TeamRemote } from "../src/remote.ts";
import { TeamWiki } from "../src/wiki.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A connected repo whose pull takes `ms` and brings in one page committed elsewhere. */
function slowRemote(dir: string, ms: number): { remote: TeamRemote; pulls: () => number } {
  let pulls = 0;
  const remote = {
    connected: true,
    readOnly: true,
    fence: null,
    async pull() {
      pulls++;
      await new Promise((r) => setTimeout(r, ms));
      writeFileSync(join(dir, "elsewhere.md"), "---\ntitle: Elsewhere\ntype: topic\n---\n\nWritten in the team's repo.\n");
      execFileSync("git", ["add", "elsewhere.md"], { cwd: dir });
      execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "elsewhere"], { cwd: dir });
      return true;
    },
  } as unknown as TeamRemote;
  return { remote, pulls: () => pulls };
}

describe("a query while the connected repo is pulled", () => {
  it("answers without waiting for the pull, and reads the repo once after it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "team-refresh-"));
    dirs.push(dir);
    const wiki = await TeamWiki.open(dir, "team-1", "Team");
    const { remote, pulls } = slowRemote(dir, 1500);
    wiki.remote = remote;
    let reloads = 0;
    const reload = wiki.reload.bind(wiki);
    wiki.reload = () => {
      reloads++;
      reload();
    };

    const started = Date.now();
    await wiki.refresh();
    // The gateway gives a query 8 s; the pull and the reads after it used to happen inside it.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(pulls()).toBe(1);
    expect(wiki.store.getByRef("elsewhere")).toBeUndefined();

    await new Promise((r) => setTimeout(r, 2000));
    expect(reloads).toBe(1);
    expect(wiki.store.getByRef("elsewhere")).toBeTruthy();

    // The next check finds the head it already read: no second read of the whole repo.
    await wiki.refresh(0);
    expect(reloads).toBe(1);
  });
});
