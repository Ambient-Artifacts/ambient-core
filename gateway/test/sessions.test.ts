// Work sessions end to end: the plugin's real hook script sends a Claude Code session to the
// gateway, the worker summarizes it (with a stand-in model) into a note in the personal wiki,
// and a session in a team's folder reaches the team server only after the 30-minute hold,
// unless the user keeps it personal. Plus `log_work` for AI apps over MCP.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { SessionSummarizer, SessionSummaryInput } from "@brain/team";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePage } from "@brain/spec";
import { appCall, INVITE, mcpClient, signIn, startStack, text, type Stack } from "./helpers.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "integrations", "claude-code", "scripts", "capture.sh");
const HOLD = 30 * 60_000;

let s: Stack;
let app: string;
let token: string;
let home: string;
let project: string;

class StandIn implements SessionSummarizer {
  calls: SessionSummaryInput[] = [];
  async summarize(input: SessionSummaryInput) {
    this.calls.push(input);
    return {
      summary: {
        substantial: !input.transcript.includes("just saying hi"),
        title: "Upload retries",
        summary: "Added retries with backoff to the session upload.",
        workedOn: ["Retry with backoff in the uploader"],
        decisions: ["Three retries, then give up"],
        nextSteps: ["Lena Vogel: watch the error rate"],
        openQuestions: [],
        people: ["Petra Schäfer"],
        projects: ["Platform"],
        language: "en",
      },
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0 },
    };
  }
}
const model = new StandIn();

function transcript(id: string, prompt: string, opts: { cron?: boolean } = {}) {
  const base = { sessionId: id, cwd: join(home, "git", "platform"), gitBranch: "main", entrypoint: opts.cron ? "sdk-cli" : "cli" };
  const lines = [
    { ...base, type: "user", timestamp: "2026-10-08T09:12:00Z", ...(opts.cron ? {} : { origin: { kind: "human" } }), message: { role: "user", content: prompt } },
    { ...base, type: "assistant", timestamp: "2026-10-08T09:12:30Z", message: { role: "assistant", content: [{ type: "text", text: "Adding a retry with backoff." }] } },
    { ...base, type: "assistant", timestamp: "2026-10-08T09:13:00Z", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: join(home, "git", "platform", "src", "upload.ts") } }] } },
    { ...base, type: "user", timestamp: "2026-10-08T09:14:20Z", message: { role: "user", content: [{ type: "tool_result", content: "[main 3f2a9c1] Retry uploads\nhttps://github.com/acme/platform/pull/42" }] } },
  ];
  const path = join(project, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

/** Run the plugin's hook script the way Claude Code does: hook input on stdin. */
function hook(args: string[], input: unknown, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("bash", [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home, AMBIENT_TOKEN: token, AMBIENT_SERVER: s.origin, AMBIENT_DATA: join(home, ".ambient"), ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
}

const end = (path: string, id: string) => hook(["end"], { session_id: id, transcript_path: path, cwd: join(home, "git", "platform"), reason: "prompt_input_exit", hook_event_name: "SessionEnd" });
const log = () => readFileSync(join(home, ".ambient", "capture.log"), "utf8");
const personalNote = async (title: string) => {
  const pages = (await appCall(s, app, "GET", "/v1/app/personal/pages")).json.pages as { path: string; content: string }[];
  return pages.map((p) => ({ path: p.path, page: parsePage(p.content) })).filter((p) => p.page.frontmatter.title === title);
};

beforeAll(async () => {
  s = await startStack();
  app = (await signIn(s, "apple-sessions", "Lena Vogel")).access_token;
  await appCall(s, app, "POST", "/v1/app/teams/join", { code: INVITE });
  token = String((await appCall(s, app, "POST", "/v1/app/pats", { label: "Claude Code", purpose: "claude-code" })).json.token);
  home = mkdtempSync(join(tmpdir(), "brain-sessions-home-"));
  project = join(home, ".claude", "projects", "-git-platform");
  mkdirSync(project, { recursive: true });
});
afterAll(() => s.close());

describe("Claude Code sessions", () => {
  it("the hook sends a finished session; the worker writes a note to the personal wiki", async () => {
    const path = transcript("5f0c2a9e-aaaa-4c4c-8888-000000000001", "Add a retry to the upload. The key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
    const run = await end(path, "5f0c2a9e-aaaa-4c4c-8888-000000000001");
    expect(run).toEqual({ code: 0, out: "" });
    expect(log()).toContain("sent 5f0c2a9e-aaaa-4c4c-8888-000000000001 (202)");

    const done = await s.sessions.process(model);
    expect(done).toMatchObject([{ status: "written", team: null }]);
    const input = model.calls.at(-1)!;
    expect(input).toMatchObject({ tool: "Claude Code", person: "Lena Vogel", team: null, branch: "main" });
    expect(input.transcript).toContain("User: Add a retry to the upload");
    expect(input.transcript).toContain("→ edited ~/git/platform/src/upload.ts");
    expect(input.transcript).not.toContain("sk-ant-api03");

    const [note] = await personalNote("Upload retries");
    expect(note!.path).toMatch(/^wiki\/sessions\/2026\/10\/2026-10-08-upload-retries-[a-z0-9]{6}\.md$/);
    expect(note!.page.frontmatter).toMatchObject({ type: "note", kind: "session", scope: "personal", source: "claude-code", work: { tool: "Claude Code", branch: "main" } });
    expect(note!.page.body).toContain("## Decisions\n- Three retries, then give up");
    expect(note!.page.body).toContain("## Action items\n- [ ] Lena Vogel: watch the error rate");
    expect(note!.page.body).toContain("- Pull request: https://github.com/acme/platform/pull/42");
    expect(note!.page.body).toContain("- Commit `3f2a9c1`: Retry uploads");

    // Sending the same session again (unchanged) does nothing.
    await end(path, "5f0c2a9e-aaaa-4c4c-8888-000000000001");
    expect(log().match(/sent 5f0c2a9e-aaaa-4c4c-8888-000000000001/g)).toHaveLength(1);
  });

  it("never sends a session on the hold list", async () => {
    const path = transcript("5f0c2a9e-aaaa-4c4c-8888-000000000099", "Something private");
    writeFileSync(join(home, ".ambient", "hold"), "5f0c2a9e-aaaa-4c4c-8888-000000000099\n");
    await end(path, "5f0c2a9e-aaaa-4c4c-8888-000000000099");
    expect(log()).toContain("held 5f0c2a9e-aaaa-4c4c-8888-000000000099");
    expect(log()).not.toContain("sent 5f0c2a9e-aaaa-4c4c-8888-000000000099");
  });

  it("leaves scheduled runs alone, in the hook and on the server", async () => {
    const path = transcript("cccccccc-0000-4000-8000-000000000001", "Run the nightly audit", { cron: true });
    await end(path, "cccccccc-0000-4000-8000-000000000001");
    expect(log()).toContain("skip cccccccc-0000-4000-8000-000000000001: nobody typed in it");
    const direct = await fetch(`${s.origin}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-encoding": "gzip" },
      body: gzipSync(`{"session_id":"cccccccc-0000-4000-8000-000000000001"}\n${readFileSync(path, "utf8")}`),
    });
    expect(direct.status).toBe(200);
    expect(await direct.json()).toMatchObject({ status: "skipped" });
    expect(await s.sessions.process(model)).toEqual([]);
  });

  it("refuses uploads without a session token", async () => {
    expect((await fetch(`${s.origin}/v1/sessions`, { method: "POST", body: "{}" })).status).toBe(401);
    const plain = String((await appCall(s, app, "POST", "/v1/app/pats", { label: "Codex" })).json.token);
    expect((await fetch(`${s.origin}/v1/sessions`, { method: "POST", headers: { authorization: `Bearer ${plain}` }, body: "{}" })).status).toBe(403);
  });

  it("a session in a team's folder goes to the team after the hold; Keep personal stops it", async () => {
    expect((await appCall(s, app, "PUT", "/v1/app/sessions/rules", { rules: [{ match: "~/git/platform", team: "nope" }] })).status).toBe(400);
    expect((await appCall(s, app, "PUT", "/v1/app/sessions/rules", { rules: [{ match: "~/git/platform", team: "acme" }] })).status).toBe(200);

    const shared = transcript("5f0c2a9e-aaaa-4c4c-8888-000000000002", "Add a retry to the upload, round two");
    const kept = transcript("5f0c2a9e-aaaa-4c4c-8888-000000000003", "Add a retry to the upload, round three");
    await end(shared, "5f0c2a9e-aaaa-4c4c-8888-000000000002");
    await end(kept, "5f0c2a9e-aaaa-4c4c-8888-000000000003");
    const now = Date.now();
    expect(await s.sessions.process(model, { now })).toMatchObject([
      { status: "written", team: "acme" },
      { status: "written", team: "acme" },
    ]);
    expect(model.calls.at(-1)!.team).toBe("Acme");

    const list = (await appCall(s, app, "GET", "/v1/app/sessions")).json;
    expect(list.rules).toEqual([{ match: "~/git/platform", team: "acme" }]);
    const pending = [...(list.pending as { sessionId: string }[])].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(pending).toMatchObject([
      { sessionId: expect.stringMatching(/^5f0c2a9e-aaaa-4c4c-8888-000000000002-b\d+$/), title: "Upload retries", team: { slug: "acme", name: "Acme" } },
      { sessionId: expect.stringMatching(/^5f0c2a9e-aaaa-4c4c-8888-000000000003-b\d+$/) },
    ]);
    const [sharedBlock, keptBlock] = pending.map((p) => p.sessionId);
    expect((await appCall(s, app, "POST", `/v1/app/sessions/${keptBlock}/keep`)).status).toBe(204);

    expect(await s.sessions.deliverDue(now + 60_000)).toEqual([]);
    expect(await s.sessions.deliverDue(now + HOLD + 60_000)).toEqual([{ sessionId: sharedBlock, status: "delivered" }]);
    const recent = await appCall(s, app, "POST", "/v1/app/teams/acme/query", { op: "recent", limit: 10, kind: "session" });
    const pages = recent.json.result as { title: string; frontmatter: Record<string, unknown> }[];
    expect(pages.map((p) => p.title)).toEqual(["Upload retries"]);
    expect(pages[0]!.frontmatter).toMatchObject({ kind: "session", scope: "team", recorded_by: "people/lena-vogel", work: { tool: "Claude Code" } });
    expect((await appCall(s, app, "GET", "/v1/app/sessions")).json.pending).toEqual([]);
  });

  it("a long session becomes one note per working block, each routed by its own edits", async () => {
    const id = "5f0c2a9e-bbbb-4c4c-8888-000000000020";
    const base = { sessionId: id, cwd: "/opt/workspace", gitBranch: "main", entrypoint: "sdk-cli" };
    const prompt = (text: string, at: string) => ({ ...base, type: "user", timestamp: at, origin: { kind: "human" }, message: { role: "user", content: text } });
    const edit = (file: string, at: string) => ({ ...base, type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: `Editing ${file}.` }, { type: "tool_use", name: "Edit", input: { file_path: file } }] } });
    const morning = [
      prompt("Build the team page in the app", "2026-10-08T08:00:00Z"),
      edit(join(home, "git", "platform", "src", "teams.ts"), "2026-10-08T08:05:00Z"),
      edit(join(home, "git", "platform", "src", "app.ts"), "2026-10-08T08:20:00Z"),
    ];
    const afternoon = [
      prompt("Now something for the other company", "2026-10-08T13:00:00Z"),
      edit(join(home, "other", "notes.md"), "2026-10-08T13:10:00Z"),
    ];
    const path = join(project, `${id}.jsonl`);
    writeFileSync(path, [...morning, ...afternoon].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const upload = async () => {
      const res = await fetch(`${s.origin}/v1/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-encoding": "gzip" },
        body: gzipSync(`${JSON.stringify({ session_id: id, cwd: "/opt/workspace", ambient: { home } })}\n${readFileSync(path, "utf8")}`),
      });
      return (await res.json()) as { status: string; blocks: number; queued: number };
    };
    expect(await upload()).toMatchObject({ status: "queued", blocks: 2, queued: 2 });
    const done = await s.sessions.process(model);
    expect(done.map((d) => [d.sessionId.replace(id, "S"), d.team])).toEqual([
      [`S-b${Date.parse("2026-10-08T08:00:00Z") / 1000}`, "acme"],
      [`S-b${Date.parse("2026-10-08T13:00:00Z") / 1000}`, null],
    ]);
    // The morning block is done; only the afternoon, which grew, is summarized again.
    writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(prompt("And one more thing", "2026-10-08T13:30:00Z")) + "\n");
    expect(await upload()).toMatchObject({ status: "queued", blocks: 2, queued: 1 });
    await s.sessions.process(model);
    expect(await upload()).toMatchObject({ status: "skipped", queued: 0 });
  });

  it("a rule written as an absolute path matches, and a rule added later re-routes unchanged blocks when the session is sent again", async () => {
    await appCall(s, app, "PUT", "/v1/app/sessions/rules", { rules: [] });
    const id = "5f0c2a9e-cccc-4c4c-8888-000000000030";
    const path = transcript(id, "Work on the platform before any rule existed");
    const upload = async () => {
      const res = await fetch(`${s.origin}/v1/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-encoding": "gzip" },
        body: gzipSync(`${JSON.stringify({ session_id: id, cwd: "/opt/workspace", ambient: { home } })}\n${readFileSync(path, "utf8")}`),
      });
      return (await res.json()) as { status: string; queued: number };
    };
    expect(await upload()).toMatchObject({ queued: 1 });
    expect(await s.sessions.process(model)).toMatchObject([{ status: "written", team: null }]);
    // The rule names the folder by its absolute path; the session's files are stored as ~/git/platform/….
    await appCall(s, app, "PUT", "/v1/app/sessions/rules", { rules: [{ match: `${home}/git/*`, team: "acme" }] });
    expect(await upload()).toMatchObject({ queued: 1 });
    expect(await s.sessions.process(model)).toMatchObject([{ status: "written", team: "acme" }]);
    expect(await upload()).toMatchObject({ queued: 0 });
    await appCall(s, app, "PUT", "/v1/app/sessions/rules", { rules: [{ match: "~/git/platform", team: "acme" }] });
  });

  it("the next session start picks up a session that never ended", async () => {
    const data = join(home, ".ambient-catch-up");
    const current = transcript("5f0c2a9e-aaaa-4c4c-8888-000000000010", "Start of a new session");
    // First run: everything already there is left alone.
    await hook(["catch-up-run", current], {}, { AMBIENT_DATA: data });
    expect(readFileSync(join(data, "capture.log"), "utf8")).toMatch(/first run: \d+ earlier sessions left alone/);
    const orphan = transcript("5f0c2a9e-aaaa-4c4c-8888-000000000011", "Work in a terminal that was closed");
    const old = new Date(Date.now() - 40 * 60_000);
    utimesSync(orphan, old, old);
    await hook(["catch-up-run", current], {}, { AMBIENT_DATA: data });
    const catchUpLog = readFileSync(join(data, "capture.log"), "utf8");
    expect(catchUpLog).toContain("sent 5f0c2a9e-aaaa-4c4c-8888-000000000011 (202)");
    expect(catchUpLog).not.toContain("sent 5f0c2a9e-aaaa-4c4c-8888-000000000010");
  });
});

describe("log_work for AI apps over MCP", () => {
  it("logs to the personal wiki, and only with team:write to a team", async () => {
    const codex = String((await appCall(s, app, "POST", "/v1/app/pats", { label: "ChatGPT" })).json.token);
    const client = await mcpClient(`${s.origin}/mcp`, codex);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("log_work");
    const res = await client.callTool({ name: "log_work", arguments: { title: "Pricing page draft", summary: "Drafted the team pricing page.", decisions: ["$19 per seat"], app: "ChatGPT" } });
    expect(text(res)).toContain('Logged "Pricing page draft"');
    const [note] = await personalNote("Pricing page draft");
    expect(note!.page.frontmatter).toMatchObject({ kind: "session", work: { tool: "ChatGPT" } });
    const toTeam = await client.callTool({ name: "log_work", arguments: { title: "Shared draft", summary: "x", share_with_team: "acme" } });
    expect(text(toTeam)).toContain("can't send work to the team");
    await client.close();
  });

  it("the Claude Code plugin's connection doesn't get log_work (its sessions arrive whole)", async () => {
    const client = await mcpClient(`${s.origin}/mcp`, token);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("log_work");
    await client.close();
  });

  it("a team-only connection (Copilot) logs to the team, after the hold", async () => {
    const copilot = String((await appCall(s, app, "POST", "/v1/app/pats", { label: "Copilot", team: "acme" })).json.token);
    const client = await mcpClient(`${s.origin}/t/acme/mcp`, copilot);
    const res = await client.callTool({ name: "log_work", arguments: { title: "Quarterly plan", summary: "Outlined the Q4 plan.", app: "Copilot" } });
    expect(text(res)).toContain("Acme team wiki in 30 minutes");
    const pending = (await appCall(s, app, "GET", "/v1/app/sessions")).json.pending as { title: string; path: string | null; team: { slug: string } }[];
    expect(pending.filter((p) => p.title === "Quarterly plan")).toMatchObject([{ path: null, team: { slug: "acme" } }]);
    await client.close();
  });

  it("moves work-session notes filed under notes/ (before they had their own folder) and tells devices", async () => {
    const uid = ((await appCall(s, app, "GET", "/v1/app/me")).json.user as { uid: string }).uid;
    const old = "wiki/notes/2026/10/2026-10-07-old-session-abcdef.md";
    const text = "---\ntype: note\nkind: session\ntitle: Old session\nsummary: Filed before sessions/ existed.\n---\n\n# Old session\n";
    await s.personal.serverWrite(uid, [{ path: old, content: text }]);
    await s.control.m(s.api.sessions.saveNote, { uid: uid as never, sessionId: "legacy-session-0001", noteId: "LEGACYNOTE0001", path: old, title: "Old session", tool: "Claude Code", now: Date.now() });
    const before = (await appCall(s, app, "POST", "/v1/app/personal/sync", { device_id: "iphone-test-1", ops: [], since_seq: 0 })).json as { seq: number };
    expect(await s.sessions.moveLegacyNotes()).toBe(1);
    const after = (await appCall(s, app, "POST", "/v1/app/personal/sync", { device_id: "iphone-test-1", ops: [], since_seq: before.seq })).json as { changes: { path: string; deleted?: boolean }[] };
    expect(after.changes.map((c) => [c.path, Boolean(c.deleted)]).sort()).toEqual([
      [old, true],
      ["wiki/sessions/2026/10/2026-10-07-old-session-abcdef.md", false],
    ]);
    expect(await s.sessions.moveLegacyNotes()).toBe(0);
  });
});
