// Cutting a Claude Code transcript down to what a summary needs, scrubbing secrets, and
// deciding which team a session belongs to.
import { describe, expect, it } from "vitest";
import { condense, normalizeRemote, parseClaudeCode, pickTeam, redactSecrets, ruleMatches, splitBlocks } from "../src/sessions/condense.ts";

const HOME = "/Users/lena";
const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: "5f0c2a9e-1111-4c4c-8888-0123456789ab", cwd: `${HOME}/git/platform`, gitBranch: "main", entrypoint: "cli", ...o });
const human = (text: string, at: string) => line({ type: "user", timestamp: at, origin: { kind: "human" }, message: { role: "user", content: text } });
const agent = (content: unknown[], at: string) => line({ type: "assistant", timestamp: at, message: { role: "assistant", content } });
const toolResult = (text: string, at: string) => line({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "tool_result", content: text }] } });

export const INTERACTIVE = [
  human("Add a retry to the upload, the hook times out on big sessions", "2026-10-08T09:12:00Z"),
  agent([{ type: "thinking", thinking: "SECRET PLAN in my head" }, { type: "text", text: "I'll add a retry with backoff in the uploader." }], "2026-10-08T09:12:30Z"),
  agent([{ type: "tool_use", name: "Read", input: { file_path: `${HOME}/git/platform/src/upload.ts` } }], "2026-10-08T09:12:40Z"),
  toolResult("export const KEY = 'whatever'\nconst body = readFileSync(...)", "2026-10-08T09:12:41Z"),
  agent([{ type: "tool_use", name: "Edit", input: { file_path: `${HOME}/git/platform/src/upload.ts`, old_string: "a", new_string: "b" } }], "2026-10-08T09:13:00Z"),
  agent([{ type: "tool_use", name: "Bash", input: { command: "npm test && git commit -m 'Retry uploads'", description: "Run tests and commit" } }], "2026-10-08T09:14:00Z"),
  toolResult("[main 3f2a9c1] Retry uploads with backoff\n 1 file changed\nhttps://github.com/acme/platform/pull/42", "2026-10-08T09:14:20Z"),
  line({ type: "user", timestamp: "2026-10-08T09:14:30Z", isMeta: true, message: { role: "user", content: "<system-reminder>ignore</system-reminder>" } }),
  line({ type: "user", timestamp: "2026-10-08T09:14:31Z", origin: { kind: "task-notification" }, message: { role: "user", content: "Background task finished" } }),
  human("Perfect. Also the token is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 if you need it", "2026-10-08T09:15:00Z"),
  agent([{ type: "text", text: "Done: uploads retry 3 times. Don't paste keys here; rotate that one." }], "2026-10-08T09:15:30Z"),
].join("\n");

describe("reading a Claude Code transcript", () => {
  it("keeps prompts, answers and one line per action; drops tool output and thinking", () => {
    const s = parseClaudeCode(INTERACTIVE);
    expect(s).toMatchObject({ sessionId: "5f0c2a9e-1111-4c4c-8888-0123456789ab", interactive: true, humanPrompts: 2, branch: "main", startedAt: "2026-10-08T09:12:00Z", endedAt: "2026-10-08T09:15:30Z" });
    expect(s.edited).toEqual([`${HOME}/git/platform/src/upload.ts`]);
    expect(s.commits).toEqual([{ sha: "3f2a9c1", message: "Retry uploads with backoff" }]);
    expect(s.prs).toEqual(["https://github.com/acme/platform/pull/42"]);

    const text = condense(s, { home: HOME });
    expect(text).toContain("[09:12] User: Add a retry to the upload");
    expect(text).toContain("[09:12] Agent: I'll add a retry with backoff");
    expect(text).toContain("→ edited ~/git/platform/src/upload.ts");
    expect(text).toContain("→ ran: Run tests and commit");
    expect(text).not.toContain("SECRET PLAN");
    expect(text).not.toContain("readFileSync");
    expect(text).not.toContain("system-reminder");
    expect(text).not.toContain("Background task finished");
    expect(text).not.toContain("→ read"); // file reads are noise
    expect(text).not.toContain("sk-ant-");
    expect(text).toContain("[secret]");
    expect(text).not.toContain(HOME);
  });

  it("tells scheduled runs from sessions a person worked in", () => {
    const cron = [
      JSON.stringify({ type: "user", sessionId: "aaaaaaaa-0000", entrypoint: "sdk-cli", timestamp: "2026-10-08T03:00:00Z", message: { role: "user", content: "Run the nightly wiki audit" } }),
      JSON.stringify({ type: "assistant", sessionId: "aaaaaaaa-0000", timestamp: "2026-10-08T03:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    ].join("\n");
    expect(parseClaudeCode(cron).interactive).toBe(false);
    // Older Claude Code (no origin field) started in a terminal counts as a person.
    expect(parseClaudeCode(cron.replace('"sdk-cli"', '"cli"')).interactive).toBe(true);
  });

  it("keeps the start and most of the end of a very long session", () => {
    const many = Array.from({ length: 400 }, (_, i) => human(`step ${i} ${"x".repeat(400)}`, `2026-10-08T09:${String(i % 60).padStart(2, "0")}:00Z`)).join("\n");
    const text = condense(parseClaudeCode(many), { home: HOME, maxChars: 20_000 });
    expect(text.length).toBeLessThan(21_000);
    expect(text).toContain("step 0 ");
    expect(text).toContain("step 399 ");
    expect(text).toMatch(/\[… \d+ lines from the middle of the session left out …\]/);
  });
});

describe("working blocks", () => {
  it("starts a new block when the person comes back after an hour, and gives each block its own edits and commits", () => {
    const later = [
      agent([{ type: "text", text: "Still running the long test suite." }], "2026-10-08T11:00:00Z"), // the agent alone: no new block
      human("Next: the docs", "2026-10-08T12:30:00Z"),
      agent([{ type: "tool_use", name: "Write", input: { file_path: `${HOME}/git/platform/README.md` } }], "2026-10-08T12:31:00Z"),
      toolResult("[main 9b8c7d6] Docs for retries", "2026-10-08T12:32:00Z"),
    ].join("\n");
    const blocks = splitBlocks(parseClaudeCode(`${INTERACTIVE}\n${later}`));
    expect(blocks.map((b) => [b.startedAt, b.endedAt, b.humanPrompts])).toEqual([
      ["2026-10-08T09:12:00Z", "2026-10-08T11:00:00Z", 2],
      ["2026-10-08T12:30:00Z", "2026-10-08T12:31:00Z", 1],
    ]);
    expect(blocks.map((b) => b.edited)).toEqual([[`${HOME}/git/platform/src/upload.ts`], [`${HOME}/git/platform/README.md`]]);
    expect(blocks.map((b) => b.commits.map((c) => c.sha))).toEqual([["3f2a9c1"], ["9b8c7d6"]]);
    expect(blocks.map((b) => b.prs)).toEqual([["https://github.com/acme/platform/pull/42"], []]);
    expect(blocks.every((b) => b.interactive)).toBe(true);
  });
});

describe("scrubbing secrets", () => {
  it("removes keys, tokens, passwords and credentials in URLs", () => {
    const text = [
      "ANTHROPIC_API_KEY=sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      // Made up, and split so secret scanners don't take it for a real key.
      `export STRIPE_SECRET=${"sk_" + "live_"}abcdefghijklmnopqrstuvwx`,
      'config = {"password": "hunter2hunter2"}',
      "git clone https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/repo",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----",
      `jwt ${["eyJhbGciOiJFUzI1NiJ9", "eyJzdWIiOiJsZW5hIn0", "c2lnbmF0dXJlc2lnbmF0dXJl"].join(".")}`,
      "ambient_pat_abcdefghijklmnopqrstuvwxyz",
    ].join("\n");
    const out = redactSecrets(text);
    for (const leaked of ["sk-ant-api03", "sk_live_", "hunter2", "ghs_", "abcdefghijklmnopqrstuvwxyz.123", "AAAAB3NzaC1yc2E", "eyJzdWIi", "ambient_pat_"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("github.com/acme/repo");
  });
});

describe("which team a session goes to", () => {
  const teams = [{ slug: "ambient-artifacts" }, { slug: "acme" }];

  it("normalizes git remotes", () => {
    expect(normalizeRemote("git@github.com:Ambient-Artifacts/brain-platform.git")).toBe("github.com/ambient-artifacts/brain-platform");
    expect(normalizeRemote("https://ghp_secret@github.com/Acme/Repo.git")).toBe("github.com/acme/repo");
    expect(normalizeRemote("ssh://git@gitlab.example.com:2222/team/app.git")).toBe("gitlab.example.com/team/app");
    expect(normalizeRemote("")).toBeNull();
  });

  it("matches a folder by where the session started or where most edits were", () => {
    const rule = { match: "~/git/brain-*", team: "ambient-artifacts" };
    expect(ruleMatches(rule, { cwd: "~/git/brain-platform", repo: null, files: [] })).toBe(true);
    expect(ruleMatches(rule, { cwd: "~/git/brain-platform/gateway", repo: null, files: [] })).toBe(true);
    expect(ruleMatches(rule, { cwd: "~/git/other", repo: null, files: [] })).toBe(false);
    // Started elsewhere (a workspace folder), but the work happened in the team's repos.
    expect(ruleMatches(rule, { cwd: "/opt/workspace", repo: null, files: ["~/git/brain-ios/A.swift", "~/git/brain-platform/b.ts", "~/notes.md"] })).toBe(true);
    expect(ruleMatches(rule, { cwd: "/opt/workspace", repo: null, files: ["~/git/brain-ios/A.swift", "~/x.md", "~/y.md"] })).toBe(false);
    expect(ruleMatches({ match: "/srv/acme/**", team: "acme" }, { cwd: "/srv/acme/a/b/c", repo: null, files: [] })).toBe(true);
  });

  it("matches absolute rules against home-relative paths and back, when the home folder is known", () => {
    const files = ["~/git/brain-platform/a.ts", "~/git/brain-ios/B.swift"];
    expect(ruleMatches({ match: "/root/git/brain-*", team: "t" }, { cwd: "/opt/workspace", repo: null, files, home: "/root" })).toBe(true);
    expect(ruleMatches({ match: "~/git/brain-*", team: "t" }, { cwd: "/opt/workspace", repo: null, files: ["/root/git/brain-ios/B.swift"], home: "/root" })).toBe(true);
    expect(ruleMatches({ match: "/root/git/brain-*", team: "t" }, { cwd: "~/git/brain-platform", repo: null, files: [], home: "/root/" })).toBe(true);
    expect(ruleMatches({ match: "/home/other/git/brain-*", team: "t" }, { cwd: null, repo: null, files, home: "/root" })).toBe(false);
  });

  it("matches a repo pattern against the remote", () => {
    const rule = { match: "github.com/Ambient-Artifacts/*", team: "ambient-artifacts" };
    expect(ruleMatches(rule, { cwd: "~/x", repo: "github.com/ambient-artifacts/brain-ios", files: [] })).toBe(true);
    expect(ruleMatches(rule, { cwd: "~/x", repo: "github.com/someone/brain-ios", files: [] })).toBe(false);
    expect(ruleMatches({ match: "https://github.com/acme/app.git", team: "acme" }, { cwd: null, repo: "github.com/acme/app", files: [] })).toBe(true);
  });

  it("takes the first rule whose team the user is still in", () => {
    const rules = [
      { match: "~/git/old-*", team: "left-team" },
      { match: "~/git/*", team: "acme" },
    ];
    expect(pickTeam(rules, { cwd: "~/git/old-thing", repo: null, files: [] }, teams)?.slug).toBe("acme");
    expect(pickTeam(rules, { cwd: "~/Documents", repo: null, files: [] }, teams)).toBeNull();
  });
});
