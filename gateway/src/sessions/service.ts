// Work sessions with AI agents → notes in the wiki.
//
//   Claude Code hook ──upload──▶ receive(): cut down, scrub, seal ──▶ Convex inbox
//   worker, every minute ──▶ process(): summarize ──▶ personal note (+ team copy on hold)
//                        ──▶ deliverDue(): held copies whose 30 minutes are over ──▶ team server
//   MCP log_work ──▶ logWork(): the app's model already summarized ──▶ same note path
//
// The transcript itself is never stored: the inbox holds the cut-down text until the note
// exists. Which sessions go to a team is the user's rules (folders and repos → team).
import { createHash, randomBytes } from "node:crypto";
import { entityName, foldText, personName, renderPage, slugify, TeamNoteV1 } from "@brain/spec";
import { normalizeSessionSummary, type SessionSummarizer, type SessionSummary } from "@brain/team";
import type { WikiReader } from "@brain/wiki";
import { api, type Control } from "../control.ts";
import type { Directory, Team } from "../directory.ts";
import type { PersonalStore } from "../personal.ts";
import type { TeamLink } from "../teams.ts";
import { condense, homeRelative, normalizeRemote, parseClaudeCode, pickTeam, splitBlocks, type SessionPlace, type SessionRule } from "./condense.ts";

/** How long a team copy waits, so the user can keep a session personal. */
export const SHARE_HOLD_MS = 30 * 60_000;

/** The Claude Code hook's input (its stdin JSON) plus what the hook adds under `ambient`. */
export interface UploadMeta {
  session_id?: string;
  cwd?: string;
  reason?: string;
  ambient?: { home?: string; repo?: string; tool?: string };
}

/** What waits in the inbox (sealed) between upload and summary. */
interface Queued {
  v: 1;
  /** The block's id: `<session id>-b<start, epoch seconds>`. */
  sessionId: string;
  /** Hash of `transcript`, stored with the note. */
  hash: string;
  tool: string;
  transcript: string;
  place: SessionPlace;
  branch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  prs: string[];
  commits: { sha: string; message: string }[];
}

export class BadUpload extends Error {}

export interface NoteSpec {
  sessionId: string;
  contentHash?: string;
  tool: string;
  /** `source` in the note's front matter: `claude-code`, `ai:<client>`. */
  source: string;
  summary: SessionSummary;
  startedAt: string | null;
  endedAt: string | null;
  place: SessionPlace;
  branch: string | null;
  prs: string[];
  commits: { sha: string; message: string }[];
  /** Write the note into the personal wiki (false on a team-only connection). */
  personal: boolean;
  team: Team | null;
}

export interface SessionDeps {
  control: Control;
  personal: PersonalStore;
  directory: Directory;
  teams: TeamLink;
  holdMs?: number;
}

const TOOL_NAMES: Record<string, string> = { "claude-code": "Claude Code" };

export class SessionService {
  constructor(private d: SessionDeps) {}

  /**
   * An upload from the Claude Code hook: the first line is the hook's JSON input, the rest is
   * the session's transcript (JSONL). Sessions nobody typed in (scheduled jobs) are skipped.
   * A long session becomes one note per working block; a block that hasn't changed since the
   * last upload isn't queued again.
   */
  async receive(uid: string, body: string, now = Date.now()): Promise<{ status: "queued" | "skipped"; reason?: string; sessionId: string; blocks?: number; queued?: number }> {
    const nl = body.indexOf("\n");
    let meta: UploadMeta;
    try {
      meta = JSON.parse(nl < 0 ? body : body.slice(0, nl)) as UploadMeta;
    } catch {
      throw new BadUpload("the first line must be the hook's JSON input");
    }
    const parsed = parseClaudeCode(nl < 0 ? "" : body.slice(nl + 1));
    const sessionId = String(meta.session_id ?? parsed.sessionId ?? "");
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(sessionId)) throw new BadUpload("missing or malformed session id");
    if (!parsed.interactive) return { status: "skipped", reason: "nobody typed in this session (a scheduled or scripted run)", sessionId };
    const home = typeof meta.ambient?.home === "string" ? meta.ambient.home : null;
    const cwd = typeof meta.cwd === "string" ? meta.cwd : parsed.cwd;
    const tool = TOOL_NAMES[meta.ambient?.tool ?? "claude-code"] ?? "Claude Code";
    const blocks = splitBlocks(parsed);
    let route: { rules: SessionRule[]; teams: Team[] } | null = null;
    let queued = 0;
    for (const block of blocks) {
      if (!block.interactive) continue;
      const transcript = condense(block, { home });
      if (transcript.length < 40) continue;
      const start = block.startedAt ? Math.floor(Date.parse(block.startedAt) / 1000) : Number.NaN;
      const blockId = Number.isNaN(start) ? sessionId : `${sessionId}-b${start}`;
      const hash = createHash("sha256").update(transcript).digest("hex").slice(0, 32);
      const place: SessionPlace = {
        cwd: cwd ? homeRelative(cwd, home) : null,
        repo: normalizeRemote(meta.ambient?.repo),
        files: block.edited.map((f) => homeRelative(f, home)).slice(0, 500),
        home,
      };
      const known = await this.d.control.q(api.sessions.noteFor, { uid: uid as never, sessionId: blockId });
      if (known?.contentHash === hash) {
        // Unchanged. Only a note that never went anywhere but now matches a team's rule
        // (a rule added since) is written again, for the team.
        if (known.share || !known.path) continue;
        route ??= await this.routing(uid);
        if (!pickTeam(route.rules, place, route.teams)) continue;
      }
      const item: Queued = {
        v: 1,
        sessionId: blockId,
        hash,
        tool,
        transcript,
        place,
        branch: block.branch,
        startedAt: block.startedAt,
        endedAt: block.endedAt,
        prs: block.prs.slice(0, 10),
        commits: block.commits.slice(-20),
      };
      const sealed = await this.d.personal.seal(uid, `session:${blockId}`, JSON.stringify(item));
      await this.d.control.m(api.sessions.enqueue, { uid: uid as never, sessionId: blockId, iv: sealed.iv, ciphertext: sealed.ciphertext, now });
      queued++;
    }
    if (!queued) return { status: "skipped", reason: "nothing new to summarize", sessionId, blocks: blocks.length, queued };
    return { status: "queued", sessionId, blocks: blocks.length, queued };
  }

  /** Summarize waiting sessions into notes. Failures are retried a few times, then flagged by the health check. */
  async process(summarizer: SessionSummarizer, opts: { limit?: number; now?: number } = {}) {
    const now = opts.now ?? Date.now();
    const items = await this.d.control.m(api.sessions.claim, { now, limit: opts.limit ?? 20, leaseMs: 10 * 60_000 });
    const results: { sessionId: string; status: "written" | "skipped" | "failed"; path?: string; team?: string | null; error?: string; tokens?: number }[] = [];
    for (const item of items) {
      const uid = String(item.uid);
      try {
        const q = JSON.parse(await this.d.personal.open(uid, `session:${item.sessionId}`, item.iv, item.ciphertext)) as Queued;
        const user = await this.d.directory.user(uid);
        const team = await this.teamFor(uid, q.place);
        const out = await summarizer.summarize({
          transcript: q.transcript,
          tool: q.tool,
          person: user?.name ?? "the user",
          team: team?.name ?? null,
          repo: q.place.repo,
          branch: q.branch,
          startedAt: q.startedAt,
          endedAt: q.endedAt,
        });
        const summary = normalizeSessionSummary(out.summary);
        if (!summary) throw new Error("the summary didn't have the expected shape");
        const tokens = out.usage.input_tokens + out.usage.output_tokens;
        const existing = await this.d.control.q(api.sessions.noteFor, { uid: uid as never, sessionId: item.sessionId });
        if (!summary.substantial && !existing?.path) {
          // Nothing worth a note. Remember the text's hash so an unchanged block isn't summarized again.
          await this.d.control.m(api.sessions.saveNote, {
            uid: uid as never,
            sessionId: item.sessionId,
            noteId: existing?.noteId ?? newNoteId(now),
            path: "",
            title: "",
            tool: q.tool,
            contentHash: q.hash,
            now,
          });
          await this.d.control.m(api.sessions.done, { id: item.id });
          results.push({ sessionId: item.sessionId, status: "skipped", tokens });
          continue;
        }
        const written = await this.writeNote(uid, {
          sessionId: q.sessionId,
          contentHash: q.hash,
          tool: q.tool,
          source: "claude-code",
          summary,
          startedAt: q.startedAt,
          endedAt: q.endedAt,
          place: q.place,
          branch: q.branch,
          prs: q.prs,
          commits: q.commits,
          personal: true,
          team,
        }, now);
        await this.d.control.m(api.sessions.done, { id: item.id });
        results.push({ sessionId: item.sessionId, status: "written", path: written.path, team: team?.slug ?? null, tokens });
      } catch (err) {
        const error = (err as Error).message;
        await this.d.control.m(api.sessions.failed, { id: item.id, error, now });
        results.push({ sessionId: item.sessionId, status: "failed", error });
      }
    }
    return results;
  }

  /** The team a session goes to under the user's rules, if they're still in it. */
  async teamFor(uid: string, place: SessionPlace): Promise<Team | null> {
    const { rules, teams } = await this.routing(uid);
    return rules.length ? pickTeam(rules, place, teams) : null;
  }

  private async routing(uid: string): Promise<{ rules: SessionRule[]; teams: Team[] }> {
    const rules = (await this.d.control.q(api.sessions.rules, { uid: uid as never })) as SessionRule[];
    const teams = rules.length ? (await this.d.directory.teamsOf(uid)).filter((t) => t.status === "active") : [];
    return { rules, teams };
  }

  /** Write (or rewrite) a session's note, and hold a copy for the team when there is one. */
  async writeNote(uid: string, spec: NoteSpec, now = Date.now()): Promise<{ path: string; noteId: string; share: string | null }> {
    const existing = await this.d.control.q(api.sessions.noteFor, { uid: uid as never, sessionId: spec.sessionId });
    const noteId = existing?.noteId ?? newNoteId(now);
    const s = spec.summary;
    const recordedAt = validIso(spec.startedAt) ?? new Date(now).toISOString();
    const endedAt = validIso(spec.endedAt);
    const day = recordedAt.slice(0, 10);
    const durationS = endedAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(recordedAt)) / 1000)) : 0;
    const work = {
      tool: spec.tool,
      ...(spec.place.repo ? { repo: spec.place.repo } : {}),
      ...(spec.branch ? { branch: spec.branch.slice(0, 120) } : {}),
      ...(endedAt ? { ended_at: endedAt } : {}),
    };
    const body = renderBody(s, spec, recordedAt, endedAt);
    let path = existing?.path ?? "";
    const user = await this.d.directory.user(uid);
    // Full names of others only: never the person working, never a description in a name's place.
    const fullNames = noteNames(s.people, user?.name ?? null);
    const projectNames = s.projects.map((n) => entityName("projects", n)).filter((n): n is string => n !== null);
    if (spec.personal) {
      const reader = await this.d.personal.reader(uid);
      const people = await resolve(reader, fullNames, "person");
      const projects = await resolve(reader, projectNames, "project");
      path ||= `wiki/sessions/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}-${slugify(s.title).slice(0, 50) || "session"}-${noteId.slice(-6).toLowerCase()}.md`;
      const legacy = path.startsWith("wiki/notes/") ? path : null;
      if (legacy) path = legacy.replace(/^wiki\/notes\//, "wiki/sessions/");
      const page = renderPage({
        frontmatter: {
          id: noteId,
          type: "note",
          title: s.title,
          summary: s.summary,
          kind: "session",
          recorded_at: recordedAt,
          duration_s: durationS,
          language: s.language,
          scope: "personal",
          consent: { mode: "solo" },
          people,
          projects,
          work,
          source: spec.source,
          compile: { engine: "server", status: "compiled", fallback: "none" },
          updated: new Date(now).toISOString().slice(0, 10),
        },
        body: `\n${body}\n`,
      });
      await this.d.personal.serverWrite(uid, [{ path, content: page }]);
      if (legacy) await this.d.personal.serverDelete(uid, [legacy]);
    }

    let share: { teamId: never; iv: string; ciphertext: string; dueAt: number } | undefined;
    if (spec.team) {
      const note: TeamNoteV1 = TeamNoteV1.parse({
        schema: "brain.team-note/v1",
        note_id: noteId,
        team_id: spec.team.id,
        recorded_by: uid,
        recorded_by_name: user?.name,
        recorded_at: recordedAt,
        duration_s: durationS,
        language: s.language,
        kind: "session",
        consent: { mode: "solo", confirmed_at: new Date(now).toISOString() },
        entry_page: {
          frontmatter: {
            title: s.title,
            summary: s.summary,
            people: fullNames.map((n) => `people/${slugify(n)}`).filter((r) => r.length > 7),
            projects: projectNames.map((n) => `projects/${slugify(n)}`).filter((r) => r.length > 9),
            work,
          },
          body_md: body,
        },
        transcript: null,
        participants_hint: fullNames,
        client: { app: spec.source, transcriber: "none", compiler: "session-summary" },
      });
      const sealed = await this.d.personal.seal(uid, `share:${spec.sessionId}`, JSON.stringify(note));
      share = { teamId: spec.team.id as never, iv: sealed.iv, ciphertext: sealed.ciphertext, dueAt: now + (this.d.holdMs ?? SHARE_HOLD_MS) };
    }
    const saved = await this.d.control.m(api.sessions.saveNote, {
      uid: uid as never,
      sessionId: spec.sessionId,
      noteId,
      path,
      title: s.title,
      tool: spec.tool,
      contentHash: spec.contentHash,
      share,
      now,
    });
    return { path, noteId, share: saved.share };
  }

  /**
   * Work-session notes written before they had their own folder move from wiki/notes/ to
   * wiki/sessions/ (same file name). Devices pick up the new page and the deletion of the old.
   */
  async moveLegacyNotes(now = Date.now()): Promise<number> {
    const rows = await this.d.control.q(api.sessions.legacyNotes, { limit: 100 });
    for (const row of rows) {
      const uid = String(row.uid);
      const to = row.path.replace(/^wiki\/notes\//, "wiki/sessions/");
      const text = await this.d.personal.readPage(uid, row.path);
      if (text !== undefined) {
        await this.d.personal.serverWrite(uid, [{ path: to, content: text }]);
        await this.d.personal.serverDelete(uid, [row.path]);
      }
      await this.d.control.m(api.sessions.setPath, { id: row.id, path: to, now });
    }
    return rows.length;
  }

  /** Team copies whose hold is over go to the team server; a refused one is retried. */
  async deliverDue(now = Date.now()) {
    const due = await this.d.control.q(api.sessions.dueShares, { now, limit: 50 });
    const results: { sessionId: string; status: "delivered" | "dropped" | "failed"; error?: string }[] = [];
    for (const s of due) {
      const uid = String(s.uid);
      const team = (await this.d.directory.teamsOf(uid)).find((t) => t.id === s.teamId && t.status === "active");
      if (!team) {
        // They left the team (or it was closed) during the hold: the note stays personal.
        await this.d.control.m(api.sessions.keepPersonal, { uid: uid as never, sessionId: s.sessionId, now });
        results.push({ sessionId: s.sessionId, status: "dropped" });
        continue;
      }
      try {
        const note = TeamNoteV1.parse(JSON.parse(await this.d.personal.open(uid, `share:${s.sessionId}`, s.iv, s.ciphertext)));
        await this.d.teams.deliver(team, note, uid, team.peopleSlug ?? null);
        await this.d.control.m(api.sessions.shareDelivered, { id: s.id, now });
        results.push({ sessionId: s.sessionId, status: "delivered" });
      } catch (err) {
        await this.d.control.m(api.sessions.shareFailed, { id: s.id, now });
        results.push({ sessionId: s.sessionId, status: "failed", error: (err as Error).message });
      }
    }
    return results;
  }
}

function validIso(s: string | null | undefined): string | null {
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
}

function newNoteId(now: number): string {
  return `${now.toString(36).toUpperCase()}${randomBytes(5).toString("hex").toUpperCase()}`;
}

/**
 * The people a note names: full names (a first name alone is too ambiguous to link), not the
 * person who worked (summarizers list them anyway), and names, not descriptions.
 */
export function noteNames(names: string[], self: string | null): string[] {
  const me = self ? foldText(self).trim() : null;
  const out: string[] = [];
  for (const raw of names) {
    const n = personName(raw);
    if (!n || n.split(" ").length < 2) continue;
    const f = foldText(n);
    if (me && (f === me || (me.split(" ").length === 1 && f.split(" ")[0] === me))) continue;
    if (!out.some((o) => foldText(o) === f)) out.push(n);
  }
  return out;
}

async function resolve(reader: WikiReader, names: string[], kind: "person" | "project"): Promise<string[]> {
  const refs = new Set<string>();
  for (const name of names) {
    const page = await reader.resolveEntity(name, kind).catch(() => undefined);
    if (page) refs.add(page.ref);
  }
  return [...refs].slice(0, 10);
}

function bullets(heading: string, items: string[]): string {
  return items.length ? `\n\n## ${heading}\n${items.map((i) => `- ${i}`).join("\n")}` : "";
}

function renderBody(s: SessionSummary, spec: NoteSpec, startedAt: string, endedAt: string | null): string {
  const when = `${startedAt.slice(0, 10)} ${startedAt.slice(11, 16)}${endedAt ? `–${endedAt.slice(11, 16)}` : ""} UTC`;
  const session = [
    `- ${spec.tool}, ${when}`,
    ...(spec.place.repo ? [`- Repository: ${spec.place.repo}${spec.branch ? ` (branch ${spec.branch})` : ""}`] : []),
    ...spec.prs.map((u) => `- Pull request: ${u}`),
    ...spec.commits.slice(-8).map((c) => `- Commit \`${c.sha.slice(0, 7)}\`: ${c.message.replace(/[\r\n]+/g, " ").slice(0, 120)}`),
  ];
  return (
    `# ${s.title}\n\n${s.summary}` +
    bullets("Worked on", s.workedOn) +
    bullets("Decisions", s.decisions) +
    (s.nextSteps.length ? `\n\n## Action items\n${s.nextSteps.map((t) => `- [ ] ${t}`).join("\n")}` : "") +
    bullets("Open questions", s.openQuestions) +
    `\n\n## Session\n${session.join("\n")}`
  );
}
