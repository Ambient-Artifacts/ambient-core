// Destinations and team settings (product/sources.md): transcripts to raw/ in the repo by default
// or to a OneDrive/SharePoint folder through Microsoft Graph, copies of work logs to a folder,
// retries, a repo kept by another tool (read-only), where only the files go out, and meeting notes
// written by the team's own pipeline, found again by the recording's id.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePage, type MicrosoftConnection, type TeamNoteV1 } from "@brain/spec";
import { createTeamApp } from "../src/app.ts";
import { Deliverer, TranscriptOutbox } from "../src/destination.ts";
import { graphFor as realGraphFor, GraphTokens, type MicrosoftGraph } from "../src/graph.ts";
import { TeamRemote } from "../src/remote.ts";
import { TeamSettingsStore } from "../src/settings.ts";
import { TeamWiki } from "../src/wiki.ts";

const ISSUER = "https://mcp.example.test";
const TENANT = "00000000-0000-4000-8000-0000000000aa";
const CLIENT = "00000000-0000-4000-8000-0000000000bb";
const SECRET = "good-secret-value-123";
const TEAM_SECRET = "a-long-random-team-secret-for-tests";
const tmp = mkdtempSync(join(tmpdir(), "brain-dest-"));
let privateKey: CryptoKey;
let jwk: JWK;

// A fake Microsoft: token endpoint, folder lookups, uploads. Records every call.
const calls: { method: string; url: string; body?: string; auth?: string }[] = [];
let uploadStatus = 201;
const FOLDERS: Record<string, { name: string; path: string }> = {
  "01FOLDER0001": { name: "Meetings", path: "/drives/b!drive-0001/root:/Company/Unternehmen" },
  "01FOLDER0002": { name: "Work logs", path: "/drives/b!drive-0001/root:/Company/AI" },
};
const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined;
  calls.push({ method, url, body, auth: (init.headers as Record<string, string> | undefined)?.authorization });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const folder = (id: string) => json(200, { id, name: FOLDERS[id]!.name, folder: {}, parentReference: { driveId: "b!drive-0001", path: FOLDERS[id]!.path } });
  if (url.startsWith(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)) {
    return new URLSearchParams(body).get("client_secret") === SECRET
      ? json(200, { access_token: "graph-token", expires_in: 3600 })
      : json(400, { error_description: "AADSTS7000215: Invalid client secret provided.\nTrace ID: x" });
  }
  if (url.startsWith("https://graph.microsoft.com/v1.0/shares/")) return folder("01FOLDER0001");
  const item = /^https:\/\/graph\.microsoft\.com\/v1\.0\/drives\/b!drive-0001\/items\/(01FOLDER000[12])\?/.exec(url);
  if (method === "GET" && item) return folder(item[1]!);
  if (method === "PUT" && /^https:\/\/graph\.microsoft\.com\/v1\.0\/drives\/b!drive-0001\/items\/01FOLDER000[12]:\//.test(url)) {
    return uploadStatus < 300 ? json(uploadStatus, { id: "X1", webUrl: "https://x/file.md" }) : json(uploadStatus, { error: { message: "Access denied" } });
  }
  return json(404, { error: { message: "not found" } });
}) as typeof fetch;
const graphTokensFor = new Map<string, GraphTokens>();
/** Each test server has its own pushed-token store, as on a real team server. */
const graphForTeam = (teamId: string) => (conn: MicrosoftConnection): MicrosoftGraph => realGraphFor(conn, graphTokensFor.get(teamId)!, fakeFetch);

async function token(teamId: string, purpose: string, claims: Record<string, string> = {}) {
  return new SignJWT({ purpose, ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "brain-team+jwt" })
    .setIssuer(ISSUER)
    .setAudience(`team:${teamId}`)
    .setSubject("u_lena")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

interface Server {
  base: string;
  dataDir: string;
  wiki: TeamWiki;
  settings: TeamSettingsStore;
  deliverer: Deliverer;
  teamId: string;
  call: (method: string, path: string, purpose: string, body?: unknown, claims?: Record<string, string>) => Promise<{ status: number; text: string; json: Record<string, any> }>;
  health: () => Promise<Record<string, any>>;
  close: () => void;
}

async function start(teamId: string, remote?: (dataDir: string) => TeamRemote, prepare?: (wiki: TeamWiki) => Promise<void>): Promise<Server> {
  const dataDir = mkdtempSync(join(tmp, "data-"));
  const wiki = await TeamWiki.open(join(dataDir, "wiki"), teamId, "Acme", remote?.(dataDir));
  await prepare?.(wiki);
  const settings = new TeamSettingsStore(join(dataDir, "settings.json"), TEAM_SECRET);
  await settings.load();
  const graphTokens = new GraphTokens();
  graphTokensFor.set(teamId, graphTokens);
  const graphFor = graphForTeam(teamId);
  const deliverer = new Deliverer(new TranscriptOutbox(join(dataDir, "outbox")), settings, wiki, graphFor);
  const app = createTeamApp(wiki, {
    teamId, gatewayIssuer: ISSUER, gatewayJwks: { keys: [jwk] }, rawDir: join(dataDir, "raw"), version: "test",
    outDir: join(dataDir, "out"), settings, deliverer, graphTokens, graphFor,
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, purpose: string, body?: unknown, claims?: Record<string, string>) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${await token(teamId, purpose, claims)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };
  const health = async () => (await fetch(`${base}/health`, { headers: { authorization: `Bearer ${await token(teamId, "health")}` } })).json() as Promise<Record<string, any>>;
  return { base, dataDir, wiki, settings, deliverer, teamId, call, health, close: () => server.close() };
}

function note(teamId: string, id: string, overrides: Partial<TeamNoteV1> = {}): TeamNoteV1 {
  return {
    schema: "brain.team-note/v1",
    note_id: id,
    team_id: teamId,
    recorded_by: "u_lena",
    recorded_by_name: "Lena Vogel",
    recorded_at: "2026-10-12T09:30:00+02:00",
    ended_at: "2026-10-12T10:05:00+02:00",
    duration_s: 2100,
    language: "de-DE",
    kind: "call",
    consent: { mode: "all-agreed", confirmed_at: "2026-10-12T10:06:00+02:00" },
    entry_page: { frontmatter: { title: "Kickoff", summary: "Acme startet im November." }, body_md: "# Kickoff\n\nAcme startet." },
    transcript: { segments: [{ t0: 0, t1: 3, text: "Hallo  zusammen.", speaker: "Lena Vogel" }, { t0: 65, t1: 70, text: "Wir starten im November.", speaker: "Speaker 1" }] },
    participants_hint: [],
    client: { app: "1.9 (1)", transcriber: "Parakeet", compiler: "fm-ondevice" },
    meeting: { title: "Kickoff mit Acme", start: "2026-10-12T09:30:00+02:00", end: "2026-10-12T10:00:00+02:00", attendees: ["Anna Muster"] },
    speakers: ["Lena Vogel", "Speaker 1"],
    ...overrides,
  };
}

function session(teamId: string, id: string): TeamNoteV1 {
  return note(teamId, id, {
    kind: "session",
    transcript: null,
    meeting: undefined,
    speakers: undefined,
    entry_page: {
      frontmatter: { title: "Pricing page rewrite", summary: "Rewrote the pricing page.", work: { tool: "Claude Code", repo: "acme/web", branch: "pricing" } },
      body_md: "# Pricing page rewrite\n\nRewrote the pricing page.\n\n## Decisions\n- Monthly plans only\n\n## Related\n- [Anna](../people/anna.md)\n",
    },
    client: { app: "gateway", transcriber: "none", compiler: "session-summary" },
  });
}

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const connect = { microsoft: { tenant_id: TENANT, client_id: CLIENT, client_secret: SECRET } };
const meetingsLink = "https://example-my.sharepoint.com/personal/office_example_com/Documents/Company/Unternehmen/Meetings";

let two: Server;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  two = await start("t_acme");
});
afterAll(() => two.close());

describe("raw/ in the team's repository (the default)", () => {
  it("commits the transcript in the app's format and links it from the note, without indexing it", async () => {
    const res = await two.call("POST", "/v1/inbox", "inbox", note("t_acme", "01JDESTREPO000000000000001"));
    expect(res.status).toBe(201);
    await two.deliverer.run();
    const rawPath = "raw/2026-10/2026-10-12-kickoff-mit-acme-000001.md";
    const text = readFileSync(join(two.dataDir, "wiki", rawPath), "utf8");
    // One key per line, flow values, strings quoted: what the app writes and pipelines parse.
    expect(text).toContain('\nlocale: "de-DE"\n');
    expect(text).toContain('\nmeeting: {title: "Kickoff mit Acme", start: "2026-10-12T09:30:00+02:00", end: "2026-10-12T10:00:00+02:00", attendees: ["Anna Muster"]}\n');
    const raw = parsePage(text);
    expect(raw.frontmatter).toMatchObject({
      id: "01JDESTREPO000000000000001", type: "transcript", title: "Kickoff mit Acme", recorded_by: "Lena Vogel",
      speakers: ["Lena Vogel", "Speaker 1"], ended_at: "2026-10-12T10:05:00+02:00", team: "Acme", scope: "team",
    });
    expect(raw.body).toBe("[00:00:00] Lena Vogel: Hallo zusammen.\n[00:01:05] Speaker 1: Wir starten im November.\n");
    const dir = join(two.dataDir, "wiki");
    expect(git(dir, "ls-files")).toContain(rawPath);
    expect(git(dir, "log", "--format=%s")).toContain("transcript: Kickoff mit Acme (000001)");
    const notePage = parsePage(readFileSync(join(dir, String(res.json.path)), "utf8"));
    expect(notePage.frontmatter.raw).toBe(rawPath);
    expect(two.wiki.store.findById("01JDESTREPO000000000000001")?.path).toBe(res.json.path);
    expect(readFileSync(join(dir, "index.md"), "utf8")).not.toContain("raw/");
    expect(readdirSync(join(two.dataDir, "outbox")).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  it("stops ignoring raw/ in wikis Ambient created earlier, and leaves anyone else's .gitignore alone", async () => {
    const old = (gitignore: string) => {
      const dir = mkdtempSync(join(tmp, "old-"));
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", dir]);
      writeFileSync(join(dir, ".gitignore"), gitignore);
      writeFileSync(join(dir, "AGENTS.md"), "# old\n");
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"]);
      return dir;
    };
    const ours = old("raw/\nout/\n.brain/\n");
    await TeamWiki.open(ours, "t_old", "Old");
    expect(readFileSync(join(ours, ".gitignore"), "utf8")).toBe("out/\n.brain/\n");
    expect(git(ours, "log", "--format=%s")).toContain("chore: track raw/ for meeting transcripts");

    const theirs = old("raw/\nnode_modules/\n");
    const wiki = await TeamWiki.open(theirs, "t_theirs", "Theirs");
    expect(readFileSync(join(theirs, ".gitignore"), "utf8")).toBe("raw/\nnode_modules/\n");
    await wiki.write(async (put) => {
      await put("raw/2026-10/x.md", "---\ntype: \"transcript\"\n---\n[00:00:00] Hi\n", { index: false });
      return { message: "transcript: x", result: {} };
    });
    expect(git(theirs, "ls-files")).toContain("raw/2026-10/x.md");
  });
});

describe("team settings", () => {
  it("needs a settings token and never returns the secret, which is sealed on disk", async () => {
    expect((await two.call("GET", "/v1/settings", "inbox")).status).toBe(401);
    const bad = await two.call("PUT", "/v1/settings", "settings", { microsoft: { tenant_id: TENANT, client_id: CLIENT, client_secret: "wrong-secret-xyz" } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain("Invalid client secret");
    const ok = await two.call("PUT", "/v1/settings", "settings", { ...connect, transcripts: { kind: "drive", url: meetingsLink } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      settings: {
        transcripts: { kind: "drive", drive_id: "b!drive-0001", folder_id: "01FOLDER0001", label: "Company / Unternehmen / Meetings" },
        work: { kind: "none" },
        microsoft: { tenant_id: TENANT, client_id: CLIENT },
      },
      repo_mode: null,
    });
    expect(ok.text).not.toContain(SECRET);
    expect((await two.call("GET", "/v1/settings", "settings")).text).not.toContain(SECRET);
    const file = join(two.dataDir, "settings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    expect(JSON.parse(readFileSync(file, "utf8")).microsoft.client_secret_sealed).toMatch(/^v1\./);
    // Opens again with the same secret; with another one the server starts without the connection.
    const reloaded = (await new TeamSettingsStore(file, TEAM_SECRET).load()).microsoft;
    expect(reloaded?.kind === "own" ? reloaded.client_secret : null).toBe(SECRET);
    expect((await new TeamSettingsStore(file, "another-secret-entirely-xx").load()).microsoft).toBeNull();
  });

  it("answers a pasted non-link with a sentence, not an error", async () => {
    const res = await two.call("PUT", "/v1/settings", "settings", { transcripts: { kind: "drive", url: "Meetings folder" } });
    expect(res).toMatchObject({ status: 400, json: { message: "That doesn't look like a OneDrive or SharePoint folder link." } });
  });

  it("refuses a drive folder without the Microsoft 365 connection", async () => {
    const res = await two.call("PUT", "/v1/settings", "settings", { microsoft: null });
    expect(res.status).toBe(400);
    expect(res.json.message).toContain("needs the Microsoft 365 connection");
  });
});

describe("a OneDrive/SharePoint folder", () => {
  it("uploads the transcript into a month folder, replacing an older version", async () => {
    calls.length = 0;
    expect((await two.call("POST", "/v1/inbox", "inbox", note("t_acme", "01JDESTDRIVE00000000000002"))).status).toBe(201);
    await two.deliverer.run();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(
      "https://graph.microsoft.com/v1.0/drives/b!drive-0001/items/01FOLDER0001:/2026-10/2026-10-12-kickoff-mit-acme-000002.md:/content?@microsoft.graph.conflictBehavior=replace",
    );
    expect(put?.body).toContain('type: "transcript"');
    const status = (await two.call("GET", "/v1/settings", "settings")).json.delivery;
    expect(status).toMatchObject({ destination: "drive:Company / Unternehmen / Meetings", waiting: 0, failing: false });
  });

  it("keeps a file and retries with backoff when Microsoft refuses", async () => {
    uploadStatus = 403;
    const t0 = Date.now();
    expect((await two.call("POST", "/v1/inbox", "inbox", note("t_acme", "01JDESTFAIL000000000000003"))).status).toBe(201);
    await two.deliverer.run(t0 + 1000);
    let [item] = await two.deliverer.outbox.all();
    expect(item).toMatchObject({ note_id: "01JDESTFAIL000000000000003", kind: "transcript", attempts: 1 });
    expect(item!.last_error).toContain("no access to that folder");
    expect((await two.deliverer.run(t0 + 2000)).failed).toBe(0); // not due yet
    await two.deliverer.run(t0 + 2 * 60_000);
    await two.deliverer.run(t0 + 10 * 60_000);
    [item] = await two.deliverer.outbox.all();
    expect(item!.attempts).toBe(3);
    expect((await two.health()).delivery).toMatchObject({ failing: true, waiting: 1 });
    uploadStatus = 201;
    await two.deliverer.run(t0 + 3 * 3600_000);
    expect(await two.deliverer.outbox.all()).toEqual([]);
  });

  it("sends a copy of each shared work log to the work folder (by IDs, as a single-folder grant needs)", async () => {
    const set = await two.call("PUT", "/v1/settings", "settings", { work: { kind: "drive", drive_id: "b!drive-0001", folder_id: "01FOLDER0002" } });
    expect(set.json.settings.work).toEqual({ kind: "drive", drive_id: "b!drive-0001", folder_id: "01FOLDER0002", label: "Company / AI / Work logs" });
    calls.length = 0;
    const res = await two.call("POST", "/v1/inbox", "inbox", session("t_acme", "01JDESTWORK000000000000004"));
    expect(res.status).toBe(201);
    expect(String(res.json.path)).toMatch(/^sessions\//); // Ambient keeps this wiki: the page is written too
    await two.deliverer.run();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/items/01FOLDER0002:/2026-10/2026-10-12-pricing-page-rewrite-000004.md:/content");
    const page = parsePage(put!.body!);
    expect(page.frontmatter).toMatchObject({ type: "work", title: "Pricing page rewrite", tool: "Claude Code", repo: "acme/web", branch: "pricing", recorded_by: "Lena Vogel" });
    expect(page.body).toContain("## Decisions\n- Monthly plans only");
    expect(page.body).not.toContain("## Related");
  });

  it("never cuts a title through an emoji", async () => {
    calls.length = 0;
    const title = `${"a".repeat(59)}🙂 rest`; // the 60-character cut falls inside the emoji
    const n = note("t_acme", "01JDESTEMOJI00000000000009", { meeting: undefined, entry_page: { frontmatter: { title, summary: "x" }, body_md: "# x" } });
    expect((await two.call("POST", "/v1/inbox", "inbox", n)).status).toBe(201);
    await two.deliverer.run();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toContain(`title: "${"a".repeat(59)}"`);
    expect(put?.body).not.toMatch(/\\ud[89ab]/i);
  });

  it("writes nothing when transcripts are switched off", async () => {
    await two.call("PUT", "/v1/settings", "settings", { transcripts: { kind: "none" } });
    await two.call("POST", "/v1/inbox", "inbox", note("t_acme", "01JDESTNONE000000000000005"));
    expect(await two.deliverer.outbox.all()).toEqual([]);
    expect(git(join(two.dataDir, "wiki"), "ls-files").split("\n").filter((f) => f.startsWith("raw/") && f.includes("000005"))).toEqual([]);
  });
});

describe("a repo kept by another tool (connected read-only)", () => {
  let ro: Server;
  let bare: string;
  const commits = () => Number(execFileSync("git", ["-C", bare, "rev-list", "--count", "main"], { encoding: "utf8" }).trim());

  beforeAll(async () => {
    bare = join(tmp, "theirs.git");
    const work = join(tmp, "theirs-work");
    const env = { ...process.env, GIT_AUTHOR_NAME: "Jonas Berg", GIT_AUTHOR_EMAIL: "jonas@example.com", GIT_COMMITTER_NAME: "Jonas Berg", GIT_COMMITTER_EMAIL: "jonas@example.com" };
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "-q", bare, work], { env });
    mkdirSync(join(work, "clients"), { recursive: true });
    writeFileSync(join(work, "clients", "acme.md"), "---\ntitle: Acme\ntype: client\n---\n# Acme\n");
    writeFileSync(join(work, "clients", "_index.md"), "# clients\n\nOne page per client: overview and history.\n\n## Pages\n\n| Page | Description |\n|---|---|\n| [acme.md](acme.md) | Acme |\n");
    mkdirSync(join(work, "templates"), { recursive: true });
    writeFileSync(join(work, "templates", "client.md"), "---\ntitle: <Client name>\ntype: client\n---\n# <Client name>\n");
    writeFileSync(join(work, "README.md"), "# Acme wiki\n\nHow this repo works.\n");
    execFileSync("git", ["-C", work, "add", "-A"], { env });
    execFileSync("git", ["-C", work, "commit", "-qm", "theirs"], { env });
    execFileSync("git", ["-C", work, "-c", "protocol.file.allow=always", "push", "-q", "origin", "HEAD:main"], { env });
    ro = await start(
      "t_ro",
      (dataDir) => new TeamRemote(join(dataDir, "remote.json"), join(dataDir, "wiki"), { allowFile: true }),
      async (wiki) => {
        await wiki.remote!.connect(`file://${bare}`, "t", { mode: "read-only", existing: true });
        wiki.reload();
      },
    );
  });
  afterAll(() => ro.close());

  it("takes no notes while nothing is set, and transcripts can't go to its repo", async () => {
    const got = await ro.call("GET", "/v1/settings", "settings");
    expect(got.json).toMatchObject({ settings: { transcripts: { kind: "none" }, work: { kind: "none" } }, repo_mode: "read-only" });
    expect((await ro.call("POST", "/v1/inbox", "inbox", note("t_ro", "01JDESTRO00000000000000001"))).json.error).toBe("read_only");
    await ro.call("PUT", "/v1/settings", "settings", connect);
    const repo = await ro.call("PUT", "/v1/settings", "settings", { transcripts: { kind: "repo" } });
    expect(repo.status).toBe(400);
    expect(repo.json.message).toContain("kept by another tool");
  });

  it("sends a recording's transcript to the folder, writes no page and never commits", async () => {
    await ro.call("PUT", "/v1/settings", "settings", { transcripts: { kind: "drive", url: meetingsLink } });
    const before = commits();
    const pages = ro.wiki.store.size;
    calls.length = 0;
    const res = await ro.call("POST", "/v1/inbox", "inbox", note("t_ro", "01JDESTRO00000000000000002"));
    expect(res).toMatchObject({ status: 201, json: { status: "stored", path: "drive:2026-10/2026-10-12-kickoff-mit-acme-000002.md" } });
    await ro.deliverer.run();
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/items/01FOLDER0001:/2026-10/2026-10-12-kickoff-mit-acme-000002.md:"))).toBe(true);
    expect(ro.wiki.store.size).toBe(pages);
    expect(commits()).toBe(before);
    expect(existsSync(join(ro.dataDir, "raw", "01JDESTRO00000000000000002.json"))).toBe(false);
    // The phone sending it again (its answer got lost) doesn't write it twice.
    expect((await ro.call("POST", "/v1/inbox", "inbox", note("t_ro", "01JDESTRO00000000000000002"))).json.status).toBe("duplicate");
    expect(await ro.deliverer.outbox.all()).toEqual([]);
  });

  it("leaves out what the team says isn't knowledge, and says what a folder holds in the team's words", async () => {
    expect(ro.wiki.store.getByRef("templates/client")).toBeDefined();
    expect(ro.wiki.store.getByRef("README")).toBeDefined();
    const folder = async () => (await ro.call("POST", "/v1/query", "query", { op: "listing", folder: "clients" })).json.result;
    expect((await folder()).about).toBe("One page per client: overview and history.");

    const bad = await ro.call("PUT", "/v1/settings", "settings", { ignore: ["../outside"] });
    expect(bad).toMatchObject({ status: 400, json: { error: "settings" } });
    expect(ro.settings.get().ignore).toEqual([]);

    const put = await ro.call("PUT", "/v1/settings", "settings", { ignore: ["./templates/", "README.md", "templates"] });
    expect(put.status).toBe(200);
    expect(put.json.settings.ignore).toEqual(["README.md", "templates"]);
    expect(ro.wiki.store.getByRef("templates/client")).toBeUndefined();
    expect(ro.wiki.store.getByRef("README")).toBeUndefined();
    expect(ro.wiki.store.getByRef("clients/acme")).toBeDefined();
    expect((await ro.call("GET", "/v1/settings", "settings")).json.settings.ignore).toEqual(["README.md", "templates"]);
    expect(JSON.parse(readFileSync(join(ro.dataDir, "settings.json"), "utf8")).ignore).toEqual(["README.md", "templates"]);
    // The repo is read-only: nothing was written to it.
    expect(existsSync(join(ro.dataDir, "wiki", "templates", "client.md"))).toBe(true);

    // A reload (the repo changed, the server restarted) keeps them out; putting nothing brings them back.
    ro.wiki.reload();
    expect(ro.wiki.store.getByRef("templates/client")).toBeUndefined();
    expect((await ro.call("PUT", "/v1/settings", "settings", { ignore: [] })).json.settings.ignore).toEqual([]);
    expect(ro.wiki.store.getByRef("templates/client")).toBeDefined();
    expect((await folder()).about).toBe("One page per client: overview and history.");
  });

  it("takes work sessions only when the team set a work log folder", async () => {
    expect((await ro.call("POST", "/v1/inbox", "inbox", session("t_ro", "01JDESTRO00000000000000003"))).status).toBe(409);
    await ro.call("PUT", "/v1/settings", "settings", { work: { kind: "drive", drive_id: "b!drive-0001", folder_id: "01FOLDER0002" } });
    const res = await ro.call("POST", "/v1/inbox", "inbox", session("t_ro", "01JDESTRO00000000000000003"));
    expect(res).toMatchObject({ status: 201, json: { path: "drive:2026-10/2026-10-12-pricing-page-rewrite-000003.md" } });
    expect((await ro.health()).consolidate?.pendingNotes ?? 0).toBe(0);
  });
});

describe("who changed what", () => {
  const lena = { recorded_by_slug: "people/lena-vogel" };
  it("commits a note and its transcript with the person as author and in the message; Ambient stays the committer", async () => {
    const s = await start("t_authors");
    try {
      expect((await s.call("POST", "/v1/inbox", "inbox", note("t_authors", "01JAUTHOR00000000000000001"), lena)).status).toBe(201);
      const ingest = git(join(s.dataDir, "wiki"), "log", "-1", "--format=%an <%ae>|%cn|%s");
      expect(ingest.trim()).toBe("Lena Vogel <lena-vogel@people.ambient.invalid>|Ambient Bot|ingest: Kickoff (000001) by Lena Vogel");
      await s.deliverer.run();
      const transcript = git(join(s.dataDir, "wiki"), "log", "-1", "--format=%an|%cn|%s", "--", "raw");
      expect(transcript.trim()).toBe("Lena Vogel|Ambient Bot|transcript: Kickoff mit Acme (000001) by Lena Vogel");
      expect(readFileSync(join(s.dataDir, "wiki", "log.md"), "utf8")).toContain("ingest | Kickoff (000001) by Lena Vogel");
      // Without a name from the gateway (and for Ambient's own upkeep), the bot is the author.
      await s.call("POST", "/v1/inbox", "inbox", note("t_authors", "01JAUTHOR00000000000000002", { recorded_by_name: undefined }));
      expect(git(join(s.dataDir, "wiki"), "log", "-1", "--format=%an|%s").trim()).toBe("Ambient Bot|ingest: Kickoff (000002)");
    } finally {
      s.close();
    }
  });
});

describe("meeting notes written by the team's own pipeline", () => {
  let s: Server;
  beforeAll(async () => {
    s = await start("t_own");
  });
  afterAll(() => s.close());

  it("can only be chosen when the transcripts reach that pipeline", async () => {
    expect((await s.call("GET", "/v1/settings", "settings")).json.settings.notes).toEqual({ by: "ambient" });
    const nowhere = await s.call("PUT", "/v1/settings", "settings", { transcripts: { kind: "none" }, notes: { by: "own" } });
    expect(nowhere.status).toBe(400);
    expect(nowhere.json.message).toMatch(/choose where transcripts go first/);
    expect((await s.call("PUT", "/v1/settings", "settings", { notes: { by: "someone" } })).status).toBe(400);
    const ok = await s.call("PUT", "/v1/settings", "settings", { notes: { by: "own" } });
    expect(ok.status).toBe(200);
    expect(ok.json.settings).toMatchObject({ transcripts: { kind: "repo" }, notes: { by: "own" } });
    // And transcripts can't be switched off under it.
    expect((await s.call("PUT", "/v1/settings", "settings", { transcripts: { kind: "none" } })).status).toBe(400);
  });

  it("takes a recording as its transcript only: no page from Ambient, the file committed by the person", async () => {
    const res = await s.call("POST", "/v1/inbox", "inbox", note("t_own", "01JOWNNOTES000000000000001"), { recorded_by_slug: "people/lena-vogel" });
    expect(res.status).toBe(201);
    expect(res.json.path).toBe("raw/2026-10/2026-10-12-kickoff-mit-acme-000001.md");
    expect(s.wiki.store.findById("01JOWNNOTES000000000000001")).toBeUndefined();
    expect(existsSync(join(s.dataDir, "wiki", "notes"))).toBe(false);
    await s.deliverer.run();
    expect(existsSync(join(s.dataDir, "wiki", res.json.path))).toBe(true);
    expect(git(join(s.dataDir, "wiki"), "log", "-1", "--format=%an|%s").trim()).toBe("Lena Vogel|transcript: Kickoff mit Acme (000001) by Lena Vogel");
    // Sent twice (the phone retries): still one file, still no page.
    expect((await s.call("POST", "/v1/inbox", "inbox", note("t_own", "01JOWNNOTES000000000000001"))).json.status).toBe("duplicate");
  });

  it("still files work sessions: the setting is about meetings", async () => {
    expect((await s.call("POST", "/v1/inbox", "inbox", session("t_own", "01JOWNNOTES000000000000002"))).status).toBe(201);
    expect(s.wiki.store.findById("01JOWNNOTES000000000000002")?.type).toBe("note");
  });

  it("finds the team's page for a recording: the one the pipeline wrote, by recording_id", async () => {
    // The team's pipeline writes its meeting page into the repo, as another process.
    const dir = join(s.dataDir, "wiki");
    mkdirSync(join(dir, "meetings", "2026-10"), { recursive: true });
    writeFileSync(join(dir, "meetings", "2026-10", "2026-10-12-acme-kickoff.md"),
      '---\ntitle: "Kickoff with Acme"\ntype: meeting\nsummary: "Acme starts in November."\nrecording_id: "01JOWNNOTES000000000000001"\n---\n# Meeting: Kickoff with Acme\n\nAcme starts in November.\n');
    git(dir, "add", "meetings");
    git(dir, "-c", "user.name=Pipeline", "-c", "user.email=pipeline@example.com", "commit", "-q", "-m", "meetings: kickoff with Acme");
    const found = await s.call("POST", "/v1/query", "query", { op: "recording", id: "01JOWNNOTES000000000000001" });
    expect(found.status).toBe(200);
    expect(found.json.result).toMatchObject({ ref: "meetings/2026-10/2026-10-12-acme-kickoff", title: "Kickoff with Acme" });
    expect((await s.call("POST", "/v1/query", "query", { op: "recording", id: "01JNOSUCHRECORDING00000001" })).json.result).toBeNull();
    expect((await s.call("POST", "/v1/query", "query", { op: "recording", id: "../people/x" })).status).toBe(400);
  });

  it("and for a team whose notes Ambient writes, the note filed under the recording's id", async () => {
    await two.call("POST", "/v1/inbox", "inbox", note("t_acme", "01JRECORDNOTE0000000000001"));
    const found = await two.call("POST", "/v1/query", "query", { op: "recording", id: "01JRECORDNOTE0000000000001" });
    expect(found.json.result).toMatchObject({ type: "note", title: "Kickoff" });
  });
});

describe("Ambient's own Microsoft app (Connect Microsoft 365)", () => {
  let amb: Server;
  const TENANT_B = "00000000-0000-4000-8000-0000000000cc";
  beforeAll(async () => {
    amb = await start("t_amb");
  });
  afterAll(() => amb.close());

  it("takes tokens only from the gateway's graph purpose, and checks them", async () => {
    const good = { tenant_id: TENANT_B, access_token: "pushed-token-for-tenant-b-0001", expires_at: Date.now() + 3600_000 };
    expect((await amb.call("PUT", "/v1/graph-token", "settings", good)).status).toBe(401);
    expect((await amb.call("PUT", "/v1/graph-token", "graph", { ...good, tenant_id: "not-a-tenant" })).status).toBe(400);
    expect((await amb.call("PUT", "/v1/graph-token", "graph", { ...good, expires_at: Date.now() - 1 })).status).toBe(400);
  });

  it("connects only once the gateway has sent a token for that company, and writes with it", async () => {
    const conn = { microsoft: { kind: "ambient", tenant_id: TENANT_B, tenant_name: "Example Ltd" } };
    const early = await amb.call("PUT", "/v1/settings", "settings", conn);
    expect(early.status).toBe(400);
    expect(early.json.message).toContain("Waiting for Ambient's Microsoft access");
    expect((await amb.call("PUT", "/v1/graph-token", "graph", { tenant_id: TENANT_B, access_token: "pushed-token-for-tenant-b-0001", expires_at: Date.now() + 3600_000 })).status).toBe(204);
    calls.length = 0;
    const ok = await amb.call("PUT", "/v1/settings", "settings", { ...conn, transcripts: { kind: "drive", drive_id: "b!drive-0001", folder_id: "01FOLDER0001" } });
    expect(ok.status).toBe(200);
    expect(ok.json.settings).toMatchObject({
      microsoft: { kind: "ambient", tenant_id: TENANT_B, tenant_name: "Example Ltd" },
      transcripts: { kind: "drive", folder_id: "01FOLDER0001", label: "Company / Unternehmen / Meetings" },
    });
    expect(calls.every((c) => c.auth === "Bearer pushed-token-for-tenant-b-0001")).toBe(true);
    expect(calls.some((c) => c.url.includes("login.microsoftonline.com"))).toBe(false); // no credential on the team server
    const stored = JSON.parse(readFileSync(join(amb.dataDir, "settings.json"), "utf8"));
    expect(stored.microsoft).toEqual({ kind: "ambient", tenant_id: TENANT_B, tenant_name: "Example Ltd" });

    calls.length = 0;
    expect((await amb.call("POST", "/v1/inbox", "inbox", note("t_amb", "01JDESTAMB0000000000000001"))).status).toBe(201);
    await amb.deliverer.run();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/items/01FOLDER0001:/2026-10/2026-10-12-kickoff-mit-acme-000001.md:");
    expect(put?.auth).toBe("Bearer pushed-token-for-tenant-b-0001");
  });

  it("keeps files waiting while the token is missing or expired, and sends them when it comes", async () => {
    graphTokensFor.get("t_amb")!.set(TENANT_B, "expired-token-xxxxxxxxxxxx", Date.now() + 60_000); // inside the 2-minute margin
    calls.length = 0;
    expect((await amb.call("POST", "/v1/inbox", "inbox", note("t_amb", "01JDESTAMB0000000000000002"))).status).toBe(201);
    await amb.deliverer.run();
    const [waiting] = await amb.deliverer.outbox.all();
    expect(waiting?.last_error).toContain("Waiting for Ambient's Microsoft access");
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect((await amb.call("PUT", "/v1/graph-token", "graph", { tenant_id: TENANT_B, access_token: "pushed-token-for-tenant-b-0002", expires_at: Date.now() + 3600_000 })).status).toBe(204);
    await amb.deliverer.tokenArrived(); // also what the token route starts; resolves once it's done
    expect(await amb.deliverer.outbox.all()).toEqual([]);
  });
});
