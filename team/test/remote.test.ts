// The team repo's token at rest: sealed with BRAIN_TEAM_SECRET, so the data directory alone
// (a backup, a copied volume) holds no token that pushes to the team's repo.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TeamRemote } from "../src/remote.ts";

const config = { url: "https://github.com/acme/wiki.git", token: "ghp_secret-token-123", branch: "main", status: "ok", lastPushAt: null, lastPullAt: null, lastError: null };

describe("the team repo's token", () => {
  it("is sealed on disk once BRAIN_TEAM_SECRET is set, and still read back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-remote-"));
    const file = join(dir, "remote.json");
    writeFileSync(file, JSON.stringify(config));

    const remote = new TeamRemote(file, dir, {}, "team-secret");
    await remote.load();
    expect(remote.connected).toBe(true);
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain("ghp_secret-token-123");
    expect(JSON.parse(onDisk).tokenSealed).toMatch(/^v1\./);

    const again = new TeamRemote(file, dir, {}, "team-secret");
    await again.load();
    expect(again.connected).toBe(true);
    expect(again.status()).toMatchObject({ url: config.url, branch: "main" });

    // Without the secret it can't be used (and isn't guessed at).
    const without = new TeamRemote(file, dir, {});
    await without.load();
    expect(without.connected).toBe(false);

    // With another secret (changed, or mistyped): sync is off, and the server still starts.
    const wrong = new TeamRemote(file, dir, {}, "another-secret");
    await wrong.load();
    expect(wrong.connected).toBe(false);
  });

  it("stays as it was on a server without the secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-remote-"));
    const file = join(dir, "remote.json");
    writeFileSync(file, JSON.stringify(config));
    const remote = new TeamRemote(file, dir, {});
    await remote.load();
    expect(remote.connected).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("ghp_secret-token-123");
  });
});
