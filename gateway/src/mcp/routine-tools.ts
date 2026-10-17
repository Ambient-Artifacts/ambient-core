// MCP tools for routines: an AI app lists, creates, changes, runs and deletes routines (prompts
// Claude Code runs on a schedule) and sets their secrets. Personal routines run on one of the
// user's computers and need the personal connection; a team's run on the team's server, and
// only its owners and admins change them (with `team:write`). Secret values go in, never out.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WEEKDAYS } from "@brain/spec";
import type { Principal } from "../auth/bearer.ts";
import { RoutineError, RoutineInput, RoutinePatch, SecretName, SecretValue, type Actor, type Computer, type Routine, type RoutineService, type Run } from "../routines/service.ts";

const Schedule = z
  .object({
    every: z.enum(["hour", "day", "weekday", "week"]).describe('"hour" (every hour at the minute of time), "day", "weekday" (Monday to Friday) or "week" (on days).'),
    days: z.array(z.enum(WEEKDAYS)).max(7).optional().describe('For "week": the days, e.g. ["wed"].'),
    time: z.string().describe('"HH:MM", 24-hour, in timezone.'),
    timezone: z.string().describe("The user's IANA time zone, e.g. Europe/Vienna."),
  })
  .describe("When it runs.");

function when(ts: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);
  } catch {
    return new Date(ts).toISOString();
  }
}

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 1 ? `${Math.round(ms / 1000)} s` : min < 120 ? `${min} min` : `${Math.round(min / 60)} h`;
}

function computerLine(c: Computer): string {
  const whose = c.team ? `${c.team.name}'s server` : c.name;
  if (!c.ready) return `- ${whose}: waiting to be set up (id: ${c.id})`;
  const seen = c.online ? "online" : c.lastSeenAt ? `offline since ${new Date(c.lastSeenAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "offline";
  return `- ${whose}${c.hostname && c.hostname !== c.name ? ` (${c.hostname})` : ""}: ${seen}, Claude Code ${c.claude ?? "?"} (id: ${c.id})`;
}

function routineText(r: Routine, full = false): string {
  const tz = r.schedule.timezone;
  const state = !r.computer
    ? r.team
      ? "the team's server isn't set up for routines yet"
      : "no computer, doesn't run"
    : !r.enabled
      ? "paused"
      : r.nextRunAt
        ? `next ${when(r.nextRunAt, tz)}`
        : "waiting for its computer";
  const lines = [
    `${r.name} (id: ${r.id}${r.team ? `, team ${r.team.slug}` : ", personal"}${r.canEdit ? "" : ", read-only for you"})`,
    `  ${r.scheduleText} (${tz}) · ${state}${r.runRequested ? " · run requested" : ""}`,
    `  On ${r.team ? `${r.team.name}'s server` : (r.computer?.name ?? "no computer")}${r.folder ? `, in ${r.folder}` : ""}`,
  ];
  if (r.lastRun) {
    const took = r.lastRun.finishedAt ? `, ${duration(r.lastRun.finishedAt - r.lastRun.startedAt)}` : "";
    lines.push(`  Last run: ${r.lastRun.status} ${when(r.lastRun.startedAt, tz)}${took}`);
  }
  if (full) lines.push("", "Prompt:", r.prompt);
  else lines.push(`  Prompt: ${r.prompt.length > 160 ? `${r.prompt.slice(0, 160).replace(/\s+/g, " ")}…` : r.prompt.replace(/\s+/g, " ")}`);
  return lines.join("\n");
}

function runText(run: Run, tz: string): string {
  const head = `- ${when(run.startedAt, tz)} · ${run.status}${run.trigger === "manual" ? " (run now)" : ""}${run.durationMs !== null ? ` · ${duration(run.durationMs)}` : ""}${run.costUsd !== null ? ` · $${run.costUsd.toFixed(2)}` : ""}`;
  return run.summary ? `${head}\n  ${run.summary.replace(/\n/g, "\n  ")}` : head;
}

function result(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], ...(structured ? { structuredContent: structured } : {}) };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** zod issues as one sentence for the calling model. */
function invalid(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ");
}

const PAUSED = "It's paused until the user turns it on in the Ambient app (Routines, then the routine, then Resume); an AI app can't turn it on.";

export function registerRoutineTools(server: McpServer, principal: Principal, routines: RoutineService) {
  const actor: Actor = {
    uid: principal.uid,
    teams: principal.teams,
    personal: principal.personal,
    canWritePersonal: principal.personal && principal.scopes.has("personal:write"),
    canWriteTeams: principal.scopes.has("team:write"),
  };
  // A team-only connection (a company's Copilot) works on that one team's routines.
  const onlyTeam = !principal.personal ? principal.teams[0] : undefined;
  const source = `mcp${principal.clientId ? `:${principal.clientId}` : ""}`;
  const guard = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RoutineError) return error(err.message);
      throw err;
    }
  };
  const teamArg: Record<string, z.ZodTypeAny> =
    !onlyTeam && principal.teams.length
      ? { team: z.string().max(80).optional().describe(`A team's slug (${principal.teams.map((t) => t.slug).join(", ")}): the routine belongs to the team and runs on its server. Leave out for the user's own.`) }
      : {};

  server.registerTool(
    "list_routines",
    {
      title: "List routines",
      description:
        "Routines: prompts Claude Code runs on a schedule, the user's own on their computers and their teams' on each team's server. Shows when each runs next and how the last run went, the computers, and the names of the secrets runs get. Pass an id for one routine's full prompt and its recent runs with what each did.",
      inputSchema: { id: z.string().max(64).optional().describe("A routine's id, for its full prompt and recent runs.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(async () => {
        if (id) {
          const r = await routines.get(actor, id);
          const runs = await routines.runs(actor, id, 5);
          return result(`${routineText(r, true)}\n\nRecent runs:\n${runs.map((x) => runText(x, r.schedule.timezone)).join("\n") || "(none yet)"}`, { routine: r, runs });
        }
        const all = await routines.list(actor);
        const owners = [...(actor.personal ? [null] : []), ...principal.teams.map((t) => t.slug)];
        const secretLines: string[] = [];
        for (const slug of owners) {
          const names = (await routines.secrets(actor, slug).catch(() => [])).map((s) => s.name);
          secretLines.push(`- ${slug ? `team ${slug}` : "personal"}: ${names.join(", ") || "(none)"}`);
        }
        const text = [
          all.routines.length ? all.routines.map((r) => routineText(r)).join("\n\n") : "No routines yet.",
          `Computers:\n${all.computers.map(computerLine).join("\n") || "(none: the user connects one in the Ambient app, under Routines)"}`,
          `Secrets (environment variables runs get):\n${secretLines.join("\n")}`,
        ].join("\n\n");
        return result(text, all);
      }),
  );

  server.registerTool(
    "create_routine",
    {
      title: "Create a routine",
      description:
        "Create a routine: a prompt Claude Code runs on a schedule, unattended, with the tools and files of the computer it runs on and the owner's secrets as environment variables. Only when the user asks for one. Write the prompt as complete instructions for a run nobody watches: where to work, what to do, and what to finish with. Its last message is shown as the run's result. It's created paused: it runs once the user turns it on in the Ambient app.",
      inputSchema: {
        name: z.string().min(1).max(80),
        prompt: z.string().min(1).max(20_000),
        schedule: Schedule,
        ...teamArg,
        computer: z.string().max(80).optional().describe("For the user's own routines: the computer's name or id (see list_routines); defaults to the only one."),
        folder: z.string().max(500).optional().describe("Working folder on that computer, e.g. ~/blog."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: Record<string, unknown>) =>
      guard(async () => {
        const input = RoutineInput.safeParse({ ...args, ...(onlyTeam ? { team: onlyTeam.slug } : {}) });
        if (!input.success) return error(`Check the routine: ${invalid(input.error)}.`);
        // An AI app drafts a routine; only the person starts it. A routine runs Claude Code unattended
        // on their computer or the team's server, with their secrets: whatever an AI was told (by a
        // page it read, say), turning one on stays the user's call, in the app.
        const r = await routines.create(actor, { ...input.data, enabled: false }, source);
        const note = r.computer
          ? `\n\n${PAUSED}`
          : r.team
            ? `\n\nThe team's server isn't set up for routines yet, so it won't run until it is. ${PAUSED}`
            : `\n\nIt has no computer yet, so it won't run: the user connects one in the Ambient app under Routines, then picks it. ${PAUSED}`;
        return result(`Created:\n${routineText(r)}${note}`, { routine: r });
      }),
  );

  server.registerTool(
    "update_routine",
    {
      title: "Change a routine",
      description: "Change a routine's name, prompt, schedule, computer or folder, or pause it (enabled: false). Only what's passed changes. A new prompt, computer or folder pauses it until the user turns it on again in the Ambient app; only the user can turn a routine on.",
      inputSchema: {
        id: z.string().max(64),
        name: z.string().min(1).max(80).optional(),
        prompt: z.string().min(1).max(20_000).optional(),
        schedule: Schedule.optional(),
        computer: z.string().max(80).optional(),
        folder: z.string().max(500).optional().describe('"" for the runner\'s own folder.'),
        enabled: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, folder, ...rest }) =>
      guard(async () => {
        const patch = RoutinePatch.safeParse({ ...rest, ...(folder !== undefined ? { folder: folder.trim() === "" ? null : folder } : {}) });
        if (!patch.success) return error(`Check the change: ${invalid(patch.error)}.`);
        if (patch.data.enabled === true) return error(`Only the user can turn a routine on, in the Ambient app (Routines, then the routine). ${PAUSED}`);
        // What runs, or where, changed: the user approves it again.
        const rewrites = patch.data.prompt !== undefined || patch.data.computer !== undefined || patch.data.folder !== undefined;
        const r = await routines.update(actor, id, rewrites ? { ...patch.data, enabled: false } : patch.data, source);
        return result(`Changed:\n${routineText(r)}${rewrites ? `\n\n${PAUSED}` : ""}`, { routine: r });
      }),
  );

  server.registerTool(
    "run_routine",
    {
      title: "Run a routine now",
      description: "Start a routine now, outside its schedule. Its computer starts it within a minute; see the result later with list_routines and its id. Only routines the user has turned on.",
      inputSchema: { id: z.string().max(64) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) =>
      guard(async () => {
        if (!(await routines.get(actor, id)).enabled) return error(`It's paused, so it can't run. ${PAUSED}`);
        const r = await routines.runNow(actor, id);
        return result(`"${r.name}" starts on ${r.team ? `${r.team.name}'s server` : (r.computer?.name ?? "its computer")} within a minute.`, { routine: r });
      }),
  );

  server.registerTool(
    "delete_routine",
    {
      title: "Delete a routine",
      description: "Delete a routine and its run history. Only when the user asks; to stop it for a while, pause it with update_routine (enabled: false) instead.",
      inputSchema: { id: z.string().max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(async () => {
        const out = await routines.remove(actor, id);
        return result(`Deleted "${out.name}". Its computer removes the schedule within a minute.`);
      }),
  );

  server.registerTool(
    "set_routine_secret",
    {
      title: "Set a routine secret",
      description:
        "Store a secret (a token or key) that runs get as an environment variable, e.g. GITHUB_TOKEN, for the user's own routines or a team's. Only with a value the user gave you and asked to store. Values can't be read back, not even here; remove: true deletes one. Storing one pauses that owner's routines that are on, until the user turns them on again in the Ambient app: every run gets every secret.",
      inputSchema: {
        name: z.string().max(64).describe("Capital letters, digits and _, e.g. GITHUB_TOKEN."),
        value: z.string().max(10_000).optional(),
        ...teamArg,
        remove: z.boolean().optional().describe("Delete the secret instead."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: Record<string, unknown>) =>
      guard(async () => {
        const a = args as { name: string; value?: string; team?: string; remove?: boolean };
        const team = onlyTeam?.slug ?? a.team ?? null;
        const whose = team ? `team ${team}'s routines` : "the user's own routines";
        const name = SecretName.safeParse(a.name);
        if (!name.success) return error(`Check the name: ${invalid(name.error)}.`);
        if (a.remove) {
          await routines.removeSecret(actor, team, name.data);
          return result(`Removed ${name.data} from ${whose}.`);
        }
        const value = SecretValue.safeParse(a.value);
        if (!value.success) return error("Pass the secret's value, or remove: true to delete it.");
        const { paused } = await routines.setSecret(actor, team, name.data, value.data, { pauseLoops: true, source });
        const stored = `Stored ${name.data} for ${whose}. Their runs get it as an environment variable.`;
        if (paused.length === 0) return result(stored);
        return result(`${stored} Because an AI app changed a secret, ${paused.length === 1 ? "this routine is" : "these routines are"} paused: ${paused.map((n) => `"${n}"`).join(", ")}. ${PAUSED}`);
      }),
  );
}
