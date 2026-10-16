// The Claude Code plugin's context hook, run the way Claude Code runs it: at the start of a
// session it prints what Ambient knows; when a prompt names someone the wikis have a page for,
// it prints that page once per session. The prompt itself never leaves the computer.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appCall, fixturePersonalOps, INVITE, signIn, startStack, type Stack } from "./helpers.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "integrations", "claude-code", "scripts", "context.sh");

let s: Stack;
let token: string;
let home: string;

function hook(mode: string, input: Record<string, unknown>, env: Record<string, string> = {}, server?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("bash", [SCRIPT, mode], {
      env: { PATH: process.env.PATH ?? "", HOME: home, LC_ALL: "C.UTF-8", AMBIENT_TOKEN: token, AMBIENT_SERVER: server ?? s.origin, AMBIENT_DATA: join(home, ".ambient"), ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
}

const prompt = (session: string, text: string, cwd = "/home/lena/git/platform") =>
  hook("prompt", { session_id: session, transcript_path: `/home/lena/.claude/projects/x/${session}.jsonl`, cwd, permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: text });

beforeAll(async () => {
  s = await startStack();
  const app = (await signIn(s, "apple-context-hook", "Lena Vogel")).access_token;
  await appCall(s, app, "POST", "/v1/app/personal/sync", { device_id: "iphone", ops: fixturePersonalOps() });
  await appCall(s, app, "POST", "/v1/app/teams/join", { code: INVITE });
  token = String((await appCall(s, app, "POST", "/v1/app/pats", { label: "Claude Code", purpose: "claude-code" })).json.token);
  home = mkdtempSync(join(tmpdir(), "brain-context-home-"));
});
afterAll(() => s.close());

describe("at the start of a session", () => {
  it("prints who the user is, what's new and when to look, and keeps the names for prompts", async () => {
    const r = await hook("start", { session_id: "s1", source: "startup", hook_event_name: "SessionStart" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("# What Ambient knows at the start of this session");
    expect(r.out).toContain("Name: Lena Vogel.");
    expect(r.out).toMatch(/## New since \d{4}-\d{2}-\d{2}/);
    expect(r.out).toContain("## When to look in Ambient");
    expect(readFileSync(join(home, ".ambient", "last-start"), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}\n$/);
    const names = readFileSync(join(home, ".ambient", "names.tsv"), "utf8");
    expect(names).toContain("team:acme:people/jonas-becker\tJonas Becker\n");
    expect(names).toContain("personal:people/anna-mueller\tAnna Müller\n");
    expect(names).not.toContain("topics/");
  });

  it("prints nothing on a resumed session, or with the option off", async () => {
    expect((await hook("start", { session_id: "s1", source: "resume" })).out).toBe("");
    expect((await hook("start", { session_id: "s2", source: "startup" }, { AMBIENT_CONTEXT: "off" })).out).toBe("");
  });
});

describe("with a prompt", () => {
  it("adds the page of each entity named, once per session", async () => {
    const r = await prompt("s1", "Draft a short reply to jonas becker about the Bergmann Logistik offer");
    expect(r.code).toBe(0);
    expect(r.out).toContain("## From Ambient: Jonas Becker (person, Acme team wiki)");
    expect(r.out).toContain("## From Ambient: Bergmann Logistik (org, Acme team wiki)");
    expect(r.out).toContain("Full page with its timeline: `fetch` id team:acme:people/jonas-becker.");
    expect(readFileSync(join(home, ".ambient", "context.log"), "utf8")).toContain("prompt: added team:acme:people/jonas-becker,team:acme:orgs/bergmann-logistik");

    // Already in this session's context: nothing again. Another session gets them.
    expect((await prompt("s1", "And what did Jonas Becker promise?")).out).toBe("");
    expect((await prompt("s3", "What did Jonas Becker promise?")).out).toContain("## From Ambient: Jonas Becker");
  });

  it("adds them again after /compact, when they're gone from context", async () => {
    await hook("start", { session_id: "s1", source: "compact" });
    expect((await prompt("s1", "Jonas Becker again")).out).toContain("## From Ambient: Jonas Becker");
  });

  it("adds nothing for names outside the prompt or parts of other words", async () => {
    expect((await prompt("s4", "hello there", "/home/lena/Bergmann Logistik")).out).toBe("");
    expect((await prompt("s4", "the Jonasbecker library")).out).toBe("");
  });
});

describe("privacy", () => {
  it("never sends the prompt: only the names list and the ids of pages it matched", async () => {
    const seen: string[] = [];
    const fake = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        if (req.url?.startsWith("/v1/context/names")) res.end("team:acme:people/jonas-becker\tJonas Becker\n");
        else if (req.url?.startsWith("/v1/context/pages")) {
          res.setHeader("Ambient-Found", "team:acme:people/jonas-becker");
          res.end("## From Ambient: Jonas Becker\n");
        } else res.end("");
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const data = mkdtempSync(join(tmpdir(), "brain-context-fake-"));
    const r = await hook("prompt", { session_id: "p1", prompt: "Confidential: ask Jonas Becker about the zebra-7731 merger" }, { AMBIENT_DATA: data }, url);
    fake.close();
    expect(r.out).toContain("## From Ambient: Jonas Becker");
    expect(seen.map((x) => x.split(" ")[1]!.split("?")[0])).toEqual(["/v1/context/names", "/v1/context/pages"]);
    expect(seen.join("\n")).not.toMatch(/zebra|merger|Confidential/i);
    expect(existsSync(join(data, "names.tsv"))).toBe(true);
  });
});
