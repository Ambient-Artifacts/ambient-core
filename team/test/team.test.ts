import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobResult, parsePage, splitCompiled, type TeamNoteV1 } from "@brain/spec";
import { createTeamApp } from "../src/app.ts";
import { consolidate, type PageUpdateInput, type PageUpdater } from "../src/consolidate.ts";
import { TeamRemote } from "../src/remote.ts";
import { TeamWiki } from "../src/wiki.ts";
import { moveSessionNotes } from "../src/sessions-folder.ts";
import type { OverviewInput, OverviewWriter } from "../src/overview.ts";

const ISSUER = "https://mcp.example.test";
let privateKey: CryptoKey;
let jwk: JWK;
let base: string;
let dataDir: string;
let wiki: TeamWiki;
let close: () => void;

async function token(purpose: string, opts: { aud?: string; typ?: string; extra?: Record<string, unknown> } = {}) {
  return new SignJWT({ purpose, ...opts.extra })
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ: opts.typ ?? "brain-team+jwt" })
    .setIssuer(ISSUER)
    .setAudience(opts.aud ?? "team:t_acme")
    .setSubject("u_lena")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

function note(id: string, overrides: Partial<TeamNoteV1> = {}): TeamNoteV1 {
  return {
    schema: "brain.team-note/v1",
    note_id: id,
    team_id: "t_acme",
    recorded_by: "u_lena",
    recorded_by_name: "Lena Vogel",
    recorded_at: "2026-10-06T10:00:00+02:00",
    duration_s: 1200,
    language: "de-DE",
    kind: "call",
    consent: { mode: "all-agreed", confirmed_at: "2026-10-06T10:21:00+02:00" },
    entry_page: {
      frontmatter: {
        title: "Kundencall Bergmann",
        summary: "Bergmann will 40 Lizenzen mit SSO.",
        people: ["people/petra-schaefer", "../../etc/passwd"],
        orgs: ["orgs/bergmann-logistik"],
        evil: "<script>",
      },
      body_md: "# Kundencall Bergmann\n\n<b>Bergmann</b> will 40 Lizenzen.\n\n## Action items\n- [ ] Lena Vogel: Angebot schicken (due 2026-10-09)\n",
    },
    transcript: { segments: [{ t0: 0, t1: 3, text: "Hallo zusammen", speaker: "Lena Vogel" }] },
    participants_hint: [],
    client: { app: "1.0 (1)", transcriber: "SpeechTranscriber de-DE", compiler: "fm-ondevice" },
    ...overrides,
  };
}

async function post(path: string, body: unknown, bearer: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  dataDir = mkdtempSync(join(tmpdir(), "brain-team-"));
  wiki = await TeamWiki.open(join(dataDir, "wiki"), "t_acme", "Acme");
  const app = createTeamApp(wiki, { teamId: "t_acme", gatewayIssuer: ISSUER, gatewayJwks: { keys: [jwk] }, rawDir: join(dataDir, "raw"), version: "test" });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe("auth", () => {
  it("says only that it's up, unless the gateway's health token asks for the details", async () => {
    const open = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(open).toEqual({ status: "ok", service: "brain-team", version: "test" });
    const withToken = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${await token("health")}` } });
    expect(await withToken.json()).toHaveProperty("head");
    const wrongPurpose = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${await token("query")}` } });
    expect(await wrongPurpose.json()).not.toHaveProperty("head");
  });

  it("accepts only gateway tokens for this team and purpose", async () => {
    const q = { op: "recent" };
    expect((await post("/v1/query", q, "nope")).status).toBe(401);
    expect((await post("/v1/query", q, await token("query", { aud: "team:t_other" }))).status).toBe(401);
    expect((await post("/v1/query", q, await token("inbox"))).status).toBe(401);
    expect((await post("/v1/query", q, await token("query", { typ: "at+jwt" }))).status).toBe(401);
    expect((await post("/v1/query", q, await token("query"))).status).toBe(200);
  });
});

describe("ingest", () => {
  it("writes one sanitized note page, commits it, and keeps the transcript out of git", async () => {
    const res = await post("/v1/inbox", note("01JBTEAMNOTE00000000000001"), await token("inbox", { extra: { recorded_by_slug: "people/lena-vogel" } }));
    expect(res.status).toBe(201);
    const path = String(res.json.path);
    expect(path).toBe("notes/2026-10/2026-10-06-kundencall-bergmann-000001.md");

    const page = parsePage(readFileSync(join(dataDir, "wiki", path), "utf8"));
    expect(page.frontmatter).toMatchObject({ scope: "team", team_id: "t_acme", recorded_by: "people/lena-vogel" });
    expect(page.frontmatter.people).toEqual(["people/lena-vogel", "people/petra-schaefer"]);
    expect(page.frontmatter).not.toHaveProperty("evil");
    expect(page.body).not.toContain("<b>");
    expect(page.body).toContain("## Related\n- [Lena Vogel](../../people/lena-vogel.md)");

    expect(readdirSync(join(dataDir, "raw"))).toEqual(["01JBTEAMNOTE00000000000001.json"]);
    expect(JSON.parse(readFileSync(join(dataDir, "raw", "01JBTEAMNOTE00000000000001.json"), "utf8")).segments[0].speaker).toBe("Lena Vogel");
    const log = execFileSync("git", ["-C", join(dataDir, "wiki"), "log", "--format=%s %an"], { encoding: "utf8" });
    expect(log).toContain("ingest: Kundencall Bergmann (000001) Ambient Bot");
    const tracked = execFileSync("git", ["-C", join(dataDir, "wiki"), "ls-files"], { encoding: "utf8" });
    expect(tracked).not.toContain("raw");
    // The same commit carries the regenerated index pages.
    const inCommit = execFileSync("git", ["-C", join(dataDir, "wiki"), "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
    expect(inCommit).toContain(path);
    expect(inCommit).toContain("index.md");
    expect(inCommit).toContain("notes/2026-10/_index.md");
    expect(readFileSync(join(dataDir, "wiki", "notes", "2026-10", "_index.md"), "utf8")).toContain("(2026-10-06-kundencall-bergmann-000001.md)");
    expect(readFileSync(join(dataDir, "wiki", "AGENTS.md"), "utf8")).toContain("Start with `index.md`");

    const again = await post("/v1/inbox", note("01JBTEAMNOTE00000000000001"), await token("inbox"));
    expect(again).toMatchObject({ status: 200, json: { status: "duplicate", path } });
  });

  it("rejects notes for another team or without consent", async () => {
    expect((await post("/v1/inbox", note("01JBTEAMNOTE00000000000002", { team_id: "t_other" }), await token("inbox"))).status).toBe(400);
    const noConsent = note("01JBTEAMNOTE00000000000003", { consent: { mode: "unknown" as never, confirmed_at: "2026-10-06T10:21:00+02:00" } });
    expect((await post("/v1/inbox", noConsent, await token("inbox"))).status).toBe(400);
  });

  it("serves a shared note's transcript from the raw store", async () => {
    const res = await post("/v1/query", { op: "transcript", ref: "notes/2026-10/2026-10-06-kundencall-bergmann-000001" }, await token("query"));
    expect(String(res.json.result)).toMatch(/^Transcript of "Kundencall Bergmann" \(2026-10-06\)/);
    expect(String(res.json.result)).toContain("] Lena Vogel: ");
    expect((await post("/v1/query", { op: "transcript", ref: "orgs/nothing" }, await token("query"))).json.result).toBeNull();
  });

  it("serves the new note through the query API", async () => {
    const res = await post("/v1/query", { op: "search", query: "Lizenzen" }, await token("query"));
    const hits = res.json.result as { page: { ref: string } }[];
    expect(hits.map((h) => h.page.ref)).toContain("notes/2026-10/2026-10-06-kundencall-bergmann-000001");
    const actions = await post("/v1/query", { op: "actionItems", owner: "Lena" }, await token("query"));
    expect(actions.json.result).toEqual([
      expect.objectContaining({ task: "Angebot schicken", due: "2026-10-09", owner: "Lena Vogel" }),
    ]);
  });
});

describe("consolidate", () => {
  class FakeUpdater implements PageUpdater {
    model = "claude-haiku-4-5";
    seen: PageUpdateInput[] = [];
    async update(input: PageUpdateInput) {
      this.seen.push(input);
      if (input.ref === "people/petra-schaefer") throw new Error("model hiccup");
      const n = input.evidence[0]!;
      return {
        update: {
          // A name per page: two pages with one name are one person to the dedup pass.
          title: input.ref === "orgs/bergmann-logistik" ? "Bergmann Logistik" : input.ref === "people/lena-vogel" ? "Lena Vogel" : "Petra Schäfer",
          summary: `Summary of ${input.ref}`,
          aliases: ["Bergmann"],
          currentTruth: ["- Wants 40 seats with SSO.", "x".repeat(500)],
          openQuestions: [],
          timeline: [
            { note: n.note, date: n.date, fact: "Asked for 40 seats." },
            { note: "notes/invented", date: "2026-10-06", fact: "Hallucinated note" },
          ],
        },
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0 },
      };
    }
  }

  it("updates living pages, records partial failures, and is a no-op the second time", async () => {
    const updater = new FakeUpdater();
    const outDir = join(dataDir, "out");
    const r1 = await consolidate(wiki, updater, { outDir, version: "test" });
    expect(JobResult.safeParse(r1).success).toBe(true);
    expect(r1.status).toBe("partial");
    expect(r1.output.pages_updated).toBe(2);
    expect(r1.checks.map((c) => c.name)).toEqual(["page:people/petra-schaefer", "lint"]);
    expect(readdirSync(join(outDir, "lint")).length).toBe(1);
    expect(readFileSync(join(dataDir, "wiki", "log.md"), "utf8")).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] consolidate \| 2 pages from 1 notes$/m);
    expect(r1.llm).toMatchObject({ requests: 3, input_tokens: 2000, cost_usd: 0.004 });
    expect(updater.seen[0]!.evidence[0]!.body).toContain("Angebot schicken");

    const org = parsePage(readFileSync(join(dataDir, "wiki", "orgs/bergmann-logistik.md"), "utf8"));
    expect(org.frontmatter).toMatchObject({ title: "Bergmann Logistik", type: "org", update_mode: "compiled" });
    const { currentTruth, timeline } = splitCompiled(org.body);
    expect(currentTruth).toContain("- Wants 40 seats with SSO.");
    expect(timeline).toEqual(["- 2026-10-06: Asked for 40 seats. ([note](../notes/2026-10/2026-10-06-kundencall-bergmann-000001.md))"]);

    // The failed page's note stays pending, so the next run retries only that page.
    const r2 = await consolidate(wiki, new FakeUpdater(), { outDir, version: "test" });
    expect(r2.input.notes).toBe(1);

    const quiet = new (class extends FakeUpdater {
      override async update(input: PageUpdateInput) {
        return super.update({ ...input, ref: input.ref === "people/petra-schaefer" ? "people/ok" : input.ref });
      }
    })();
    await consolidate(wiki, quiet, { outDir, version: "test" });
    const r4 = await consolidate(wiki, quiet, { outDir, version: "test" });
    expect(r4.status).toBe("noop");
    expect(r4.llm).toBeNull();
    expect(readdirSync(join(outDir, "consolidate")).length).toBe(4);
  });

  it("writes the overview page with links to existing pages only", async () => {
    const seen: OverviewInput[] = [];
    const writer: OverviewWriter = {
      model: "claude-haiku-4-5",
      async write(input) {
        seen.push(input);
        return {
          overview: {
            headline: "Bergmann wants 40 seats with SSO.",
            now: ["Pricing offer for Bergmann is due."],
            activeProjects: [{ ref: "projects/invented", status: "should be dropped" }],
            keyPeople: [{ ref: "orgs/bergmann-logistik", why: "Biggest open deal." }],
            openLoops: ["Send the annual-price offer (Jonas, 2026-10-10)."],
            recentDecisions: [],
          },
          usage: { input_tokens: 500, output_tokens: 100, cache_read_tokens: 0 },
        };
      },
    };
    const r = await consolidate(wiki, new FakeUpdater(), { outDir: join(dataDir, "out-overview"), version: "test", overview: writer });
    expect(seen[0]!.living.map((l) => l.ref)).toContain("orgs/bergmann-logistik");
    expect(seen[0]!.actions.length).toBeGreaterThan(0);
    const page = readFileSync(join(dataDir, "wiki", "overview.md"), "utf8");
    expect(page).toContain("type: overview");
    expect(page).toContain("- [Bergmann Logistik](orgs/bergmann-logistik.md): Biggest open deal.");
    expect(page).not.toContain("invented");
    expect(page).not.toContain("## Recent decisions");
    expect(r.output.commits.length).toBe(1);
    expect(readFileSync(join(dataDir, "wiki", "log.md"), "utf8")).toContain("] overview | rewritten");
  });

  it("the running server picks up pages committed by the nightly job", async () => {
    const res = await post("/v1/query", { op: "resolveEntity", name: "Bergmann" }, await token("query"));
    expect(res.json.result).toMatchObject({ ref: "orgs/bergmann-logistik", title: "Bergmann Logistik" });
  });
});

// Last, so the extra notes don't change what the tests above count.
describe("ingest: other kinds of notes", () => {
  it("takes a note the phone wrote without Apple Intelligence (extractive)", async () => {
    const res = await post("/v1/inbox", note("01JBTEAMNOTE00000000000004", { client: { app: "1.0 (1)", transcriber: "SpeechTranscriber de-DE", compiler: "extractive" } }), await token("inbox"));
    expect(res.status).toBe(201);
    const page = parsePage(readFileSync(join(dataDir, "wiki", String(res.json.path)), "utf8"));
    expect(page.frontmatter.compile).toEqual({ engine: "fm-ondevice", status: "partial", fallback: "extractive" });
  });

  it("takes a work session note, with where the work happened", async () => {
    const session = note("01JBTEAMNOTE00000000000005", {
      kind: "session",
      consent: { mode: "solo", confirmed_at: "2026-10-06T10:21:00+02:00" },
      transcript: null,
      client: { app: "claude-code", transcriber: "none", compiler: "session-summary" },
      entry_page: {
        frontmatter: { title: "Team space in the app", summary: "Built team creation on pooled servers.", work: { tool: "Claude Code", repo: "github.com/acme/platform", branch: "main", evil: 1 } },
        body_md: "# Team space in the app\n\nBuilt it.\n\n## Decisions\n- Pool servers instead of one per signup.",
      },
    });
    const res = await post("/v1/inbox", session, await token("inbox"));
    expect(res.status).toBe(201);
    const page = parsePage(readFileSync(join(dataDir, "wiki", String(res.json.path)), "utf8"));
    expect(page.frontmatter).toMatchObject({ kind: "session", work: { tool: "Claude Code", repo: "github.com/acme/platform", branch: "main" }, compile: { engine: "server" } });
    expect(page.frontmatter.work).not.toHaveProperty("evil");
    expect(String(res.json.path)).toMatch(/^sessions\/2026-10\//);
  });

  it("moves work sessions filed under notes/ to sessions/ in one commit", async () => {
    const legacy = "notes/2025-01/2025-01-06-old-session-aaaaaa.md";
    await wiki.write(async (put) => {
      await put(legacy, "---\nid: 01JBLEGACYSESSION00000001\ntype: note\nkind: session\ntitle: Old session\nsummary: x\n---\n\n# Old session\n");
      return { message: "test: legacy session", result: {} };
    });
    expect(await moveSessionNotes(wiki)).toBe(1);
    expect(existsSync(join(dataDir, "wiki", legacy))).toBe(false);
    expect(existsSync(join(dataDir, "wiki", "sessions/2025-01/2025-01-06-old-session-aaaaaa.md"))).toBe(true);
    // The emptied folder's index goes with it; the new folder gets one.
    expect(existsSync(join(dataDir, "wiki", "notes/2025-01/_index.md"))).toBe(false);
    expect(existsSync(join(dataDir, "wiki", "sessions/2025-01/_index.md"))).toBe(true);
    const status = execFileSync("git", ["-C", join(dataDir, "wiki"), "status", "--porcelain"], { encoding: "utf8" });
    expect(status).toBe("");
    expect(execFileSync("git", ["-C", join(dataDir, "wiki"), "log", "-1", "--format=%s"], { encoding: "utf8" })).toContain("move: 1 work session(s) to sessions/");
    expect(await moveSessionNotes(wiki)).toBe(0);
  });
});

// Last: it adds notes the tests above don't expect.
describe("summarize again", () => {
  it("replaces a note it has only as quotes when its recorder sends it summarized, and nobody else can", async () => {
    const id = "01JBTEAMNOTE0000000000QUOT";
    const lena = await token("inbox", { extra: { recorded_by_slug: "people/lena-vogel" } });
    const quoted = note(id, {
      entry_page: { frontmatter: { title: "Hallo zusammen", summary: "Hallo zusammen." }, body_md: "# Hallo zusammen\n\nHallo zusammen.\n" },
      client: { app: "1.0 (1)", transcriber: "SpeechTranscriber de-DE", compiler: "extractive" },
    });
    const first = await post("/v1/inbox", quoted, lena);
    expect(first.status).toBe(201);
    const path = String(first.json.path);
    expect(parsePage(readFileSync(join(dataDir, "wiki", path), "utf8")).frontmatter.compile).toMatchObject({ fallback: "extractive" });

    // Someone else can't replace it.
    const ben = await token("inbox", { extra: { recorded_by_slug: "people/ben-koch" } });
    expect((await post("/v1/inbox", note(id), ben)).json).toMatchObject({ status: "duplicate", path });

    // The recorder's device, summarized: replaced at the same address.
    const again = await post("/v1/inbox", note(id), lena);
    expect(again.json).toMatchObject({ status: "replaced", path });
    const page = parsePage(readFileSync(join(dataDir, "wiki", path), "utf8"));
    expect(page.frontmatter).toMatchObject({ title: "Kundencall Bergmann", compile: { fallback: "none" } });
    expect(page.body).toContain("40 Lizenzen");
    const log = execFileSync("git", ["-C", join(dataDir, "wiki"), "log", "-1", "--format=%s"], { encoding: "utf8" });
    expect(log).toContain("summarized again: Kundencall Bergmann");

    // Summarized now: the next copy is a duplicate again.
    expect((await post("/v1/inbox", note(id), lena)).json).toMatchObject({ status: "duplicate", path });
  });
});

describe("paths", () => {
  it("refuses a note id that isn't a plain id: the raw transcript is named after it", async () => {
    const res = await post("/v1/inbox", note("../../escaped-note-000001"), await token("inbox"));
    expect(res.status).toBe(400);
    expect(existsSync(join(dataDir, "escaped-note-000001.json"))).toBe(false);
  });

  it("never overwrites another note whose address a new id would share", async () => {
    // Same day, title and last six characters as the first test's note, different id.
    const original = "notes/2026-10/2026-10-06-kundencall-bergmann-000001.md";
    const before = readFileSync(join(dataDir, "wiki", original), "utf8");
    const res = await post("/v1/inbox", note("01JBOTHERMEMBERNOTE0000001", { entry_page: { frontmatter: { title: "Kundencall Bergmann" }, body_md: "# Kundencall Bergmann\n\nSomething else.\n" } }), await token("inbox"));
    expect(res.status).toBe(201);
    expect(res.json.path).toBe("notes/2026-10/2026-10-06-kundencall-bergmann-01jbothermembernote0000001.md");
    expect(readFileSync(join(dataDir, "wiki", original), "utf8")).toBe(before);
  });

  it("doesn't follow a symlink in the wiki folder, for reading or writing", async () => {
    // A connected repo could have committed one (git now checks links out as plain files).
    const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
    writeFileSync(join(outside, "secret.md"), "---\ntitle: Secret\ntype: topic\n---\nserver secret\n");
    symlinkSync(outside, join(dataDir, "wiki", "linked"));
    symlinkSync(join(outside, "secret.md"), join(dataDir, "wiki", "topics-leak.md"));
    try {
      wiki.reload();
      expect(wiki.store.entries().some((e) => e.ref.startsWith("linked/") || e.ref === "topics-leak")).toBe(false);
      await expect(wiki.write(async (put) => {
        await put("linked/planted.md", "planted");
        return { message: "test: planted", result: {} };
      })).rejects.toThrow(/bad path/);
      expect(existsSync(join(outside, "planted.md"))).toBe(false);
      expect(() => wiki.read("topics-leak.md")).toThrow(/bad path/);
    } finally {
      unlinkSync(join(dataDir, "wiki", "linked"));
      unlinkSync(join(dataDir, "wiki", "topics-leak.md"));
      wiki.reload();
    }
  });

  it("writes in a wiki with a folder whose name has two dots in it", async () => {
    // A folder like this can come from the team's repo; "..", the path part, is what's refused.
    mkdirSync(join(dataDir, "wiki", "projects", "v1..v2"), { recursive: true });
    writeFileSync(join(dataDir, "wiki", "projects", "v1..v2", "plan.md"), "---\ntitle: Plan\ntype: project\n---\nThe plan.\n");
    try {
      wiki.reload();
      const out = await wiki.write(async (put) => {
        await put("topics/dots.md", "---\ntitle: Dots\ntype: topic\n---\nDots.\n");
        return { message: "test: dots", result: {} };
      });
      expect(out.commit).toBeTruthy();
      await expect(wiki.write(async (put) => {
        await put("projects/../../escaped.md", "x");
        return { message: "test: escape", result: {} };
      })).rejects.toThrow(/bad path/);
    } finally {
      rmSync(join(dataDir, "wiki", "projects", "v1..v2"), { recursive: true, force: true });
      wiki.reload();
    }
  });
});

describe("a team whose repo another tool keeps (read-only)", () => {
  it("turns notes away before storing anything, the transcript included", async () => {
    const file = join(dataDir, "remote-read-only.json");
    writeFileSync(file, JSON.stringify({ url: "https://example.com/wiki.git", token: "t", branch: "main", status: "ok", lastPushAt: null, lastPullAt: null, lastError: null, mode: "read-only" }));
    const readOnly = new TeamRemote(file, join(dataDir, "wiki"), {});
    await readOnly.load();
    const before = wiki.remote;
    wiki.remote = readOnly;
    try {
      const res = await post("/v1/inbox", note("01JREADONLYNOTE00000000001"), await token("inbox"));
      expect(res).toMatchObject({ status: 409, json: { error: "read_only" } });
      expect(existsSync(join(dataDir, "raw", "01JREADONLYNOTE00000000001.json"))).toBe(false);
    } finally {
      wiki.remote = before;
    }
  });
});
