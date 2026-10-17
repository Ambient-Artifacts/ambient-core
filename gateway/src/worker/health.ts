// Health check for the whole beta, run on the core VM every 30 minutes (and once a day as
// a heartbeat). It checks invariants, not exit codes: a job that "succeeds" without doing
// its work is a problem too. New problems and recoveries go to the alert webhook; a
// problem that persists is repeated once a day; the daily heartbeat posts even when all
// is green, so silence never means "fine".
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { api, type Control } from "../control.ts";
import { Revisions } from "../revisions.ts";

export interface Problem {
  key: string;
  text: string;
}

export interface HealthDeps {
  control: Control;
  gatewayUrl: string;
  fetchImpl?: typeof fetch;
  now?: number;
  /** systemd state of a unit, or null where there is no systemd (tests). */
  unit?: (name: string) => Promise<{ result: string; lastRunAt: number | null } | null>;
  /** A team server's health token (TeamLink, purpose "health"): only with it does /health say more than "ok". */
  teamToken?: (team: { id: string; slug: string }) => Promise<string>;
}

const HOUR = 3_600_000;

export async function checkHealth(d: HealthDeps): Promise<{ problems: Problem[]; summary: string[] }> {
  const now = d.now ?? Date.now();
  const get = d.fetchImpl ?? fetch;
  const problems: Problem[] = [];
  const summary: string[] = [];

  try {
    const r = await get(`${d.gatewayUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    summary.push("gateway ok");
  } catch (err) {
    problems.push({ key: "gateway", text: `Gateway health check failed: ${(err as Error).message}` });
  }

  const revisions = new Revisions(d.control);
  for (const team of await d.control.q(api.teams.active, {})) {
    try {
      const headers: Record<string, string> = d.teamToken ? { authorization: `Bearer ${await d.teamToken({ id: String(team.id), slug: team.slug })}` } : {};
      const r = await get(`${team.serverUrl}/health`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const h = (await r.json()) as {
        pages: number;
        consolidate: null | { lastStatus: string | null; lastRunAt: string | null; pendingNotes: number; oldestPending: string | null };
        repo?: null | { status: string; lastError: string | null };
        /** The wiki's git head (team servers from 2026-10-13 on). */
        head?: string | null;
      };
      // Changes made on the server itself (the nightly run, edits pulled from the team's repo)
      // move its head: tell the apps. Delivered notes already did.
      if (h.head && (await revisions.teamHead(team.id, h.head))) summary.push(`${team.slug}: wiki changed on the server`);
      if (h.repo?.status === "error") problems.push({ key: `team:${team.slug}:repo`, text: `Team ${team.name}: repo sync failing: ${h.repo.lastError ?? "unknown error"}` });
      const c = h.consolidate;
      if (c?.lastStatus === "failed" || c?.lastStatus === "partial") {
        problems.push({ key: `team:${team.slug}:run`, text: `Team ${team.name}: last nightly run was ${c.lastStatus} (${c.lastRunAt}).` });
      }
      const lastRun = c?.lastRunAt ? Date.parse(c.lastRunAt) : 0;
      if (c && c.pendingNotes > 0 && now - lastRun > 26 * HOUR) {
        problems.push({ key: `team:${team.slug}:pending`, text: `Team ${team.name}: ${c.pendingNotes} notes waiting since ${c.oldestPending?.slice(0, 10)}; no run in 26h.` });
      }
      summary.push(`${team.slug}: ${h.pages} pages, last run ${c?.lastStatus ?? "never"}${c?.lastRunAt ? ` ${c.lastRunAt.slice(0, 16)}` : ""}, ${c?.pendingNotes ?? 0} pending`);
    } catch (err) {
      problems.push({ key: `team:${team.slug}:down`, text: `Team ${team.name} server unreachable: ${(err as Error).message}` });
    }
  }

  // Work sessions: summaries that keep failing, uploads nobody picked up, team copies not delivered.
  const sessions = await d.control.q(api.sessions.backlog, { now });
  if (sessions.failed) problems.push({ key: "sessions:failed", text: `${sessions.failed} work session(s) couldn't be summarized: ${sessions.lastError ?? "unknown error"}` });
  if (sessions.stuck) problems.push({ key: "sessions:stuck", text: `${sessions.stuck} work session(s) waiting more than 30 minutes for a summary. Is brain-sessions.timer running?` });
  if (sessions.overdueShares) problems.push({ key: "sessions:shares", text: `${sessions.overdueShares} work session(s) held for a team aren't getting through.` });

  // The pool of unclaimed team servers: creating a team in the app needs one.
  const pool = await d.control.q(api.teams.freeServers, {});
  if (!pool.length) problems.push({ key: "pool:empty", text: "No free team servers left: creating a team in the app fails until one is registered." });
  for (const server of pool) {
    try {
      const r = await get(`${server.url}/health`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const h = (await r.json()) as { claimed?: boolean; serverId?: string };
      if (h.claimed !== false || h.serverId !== server.serverId) throw new Error("answers as something else than this unclaimed server");
    } catch (err) {
      problems.push({ key: `pool:${server.serverId}`, text: `Pool server ${server.serverId} isn't ready: ${(err as Error).message}` });
    }
  }
  summary.push(`pool: ${pool.length} free server(s)`);

  const runs = await d.control.q(api.work.recent, { limit: 200 });
  const failed = runs.filter((r) => r.lastStatus === "failed" && now - r.lastRunAt < 24 * HOUR);
  if (failed.length) problems.push({ key: "personal:failed", text: `Personal upkeep failed for ${failed.length} user(s) in the last 24h.` });
  const waiting = await d.control.q(api.work.due, { now, quietMs: 2 * HOUR, limit: 200 });
  if (waiting.length) problems.push({ key: "personal:backlog", text: `${waiting.length} user(s) have notes waiting more than 2h for upkeep.` });
  summary.push(`personal: ${runs.filter((r) => now - r.lastRunAt < 24 * HOUR).length} users kept up in 24h`);

  const repos = await d.control.q(api.repos.connected, {});
  const broken = repos.filter((r) => r.status === "error");
  const stale = repos.filter((r) => r.status === "ok" && (r.lastSyncAt === null || now - r.lastSyncAt > 2 * HOUR));
  if (broken.length) problems.push({ key: "repos:error", text: `Repo sync failing for ${broken.length} user(s): ${broken[0]!.lastError ?? "unknown error"}` });
  if (stale.length) problems.push({ key: "repos:stale", text: `${stale.length} connected repo(s) not synced for 2h.` });
  if (repos.length) summary.push(`repos: ${repos.length} connected, ${broken.length} failing`);

  const unit = d.unit ? await d.unit("brain-personal.service") : null;
  if (unit) {
    if (unit.result !== "success") problems.push({ key: "personal:unit", text: `brain-personal.service last result: ${unit.result}.` });
    if (unit.lastRunAt === null || now - unit.lastRunAt > 0.75 * HOUR) {
      problems.push({ key: "personal:stalled", text: `The personal worker hasn't run since ${unit.lastRunAt ? new Date(unit.lastRunAt).toISOString().slice(0, 16) : "it was installed"}.` });
    }
  }
  return { problems, summary };
}

/** systemd's view of a unit: last result and when it last ran. */
export async function systemdUnit(name: string): Promise<{ result: string; lastRunAt: number | null } | null> {
  try {
    const { stdout } = await promisify(execFile)("systemctl", ["show", name, "-p", "Result", "-p", "ExecMainStartTimestamp"]);
    const props = Object.fromEntries(stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const started = props.ExecMainStartTimestamp ? Date.parse(props.ExecMainStartTimestamp.replace(/ [A-Z]{2,5}$/, "")) : NaN;
    return { result: props.Result ?? "unknown", lastRunAt: Number.isFinite(started) ? started : null };
  } catch {
    return null;
  }
}

interface AlertState {
  open: Record<string, { since: number; lastAlert: number; text: string }>;
}

/**
 * Decide what to post: new problems, recoveries, a daily reminder for open ones, and the
 * daily heartbeat. Pure apart from the state file, so it can be tested.
 */
export function alerts(state: AlertState, problems: Problem[], now: number, daily: boolean, summary: string[]): { messages: string[]; state: AlertState } {
  const next: AlertState = { open: {} };
  const messages: string[] = [];
  for (const p of problems) {
    const prev = state.open[p.key];
    if (!prev) messages.push(`🔴 ${p.text}`);
    else if (now - prev.lastAlert > 24 * HOUR) messages.push(`🔴 Still: ${p.text}`);
    next.open[p.key] = { since: prev?.since ?? now, lastAlert: !prev || now - prev.lastAlert > 24 * HOUR ? now : prev.lastAlert, text: p.text };
  }
  for (const [key, prev] of Object.entries(state.open)) {
    if (!next.open[key]) messages.push(`🟢 Recovered: ${prev.text}`);
  }
  if (daily) {
    messages.push(problems.length ? `Ambient daily: ${problems.length} open problem(s).\n${summary.join("\n")}` : `Ambient daily: all green.\n${summary.join("\n")}`);
  }
  return { messages, state: next };
}

export async function loadState(file: string): Promise<AlertState> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as AlertState;
  } catch {
    return { open: {} };
  }
}

export async function saveState(file: string, state: AlertState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2));
}

/** Slack-compatible incoming webhook. Without one, messages only reach the journal. */
export async function post(webhook: string | undefined, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  console.log(text);
  if (!webhook) return;
  await fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) });
}
