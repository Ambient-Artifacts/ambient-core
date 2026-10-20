// The admin CLI of a self-hosted server: accounts, AI-app sign-in codes, tokens, teams and team
// servers, without the iPhone or Mac app. Runs next to the gateway with the gateway's env:
//   node --import tsx gateway/src/admin-cli.ts user add you@example.com --name "You"
// (in Docker: `docker compose exec gateway admin …`). Everything goes through the same
// services the app API uses, so the rules (scopes, team servers, encryption) are the same.
import { slugify } from "@brain/spec";
import { HasContent } from "@brain/wiki";
import { Pairing } from "./auth/pairing.ts";
import { PatService } from "./auth/pats.ts";
import type { GatewayConfig } from "./config.ts";
import { api, type Control } from "./control.ts";
import { Directory } from "./directory.ts";
import { PersonalStore } from "./personal.ts";
import { PersonalRepos } from "./repos/personal.ts";
import { Revisions } from "./revisions.ts";
import { RoutineKeys } from "./routines/keys.ts";
import { RoutineService } from "./routines/service.ts";
import { TeamLink } from "./teams.ts";
import { CodeHasher } from "./auth/codes.ts";

export const ADMIN_USAGE = `Usage: admin <command>

Accounts
  user add <email> [--name <name>] [--upkeep]
      Create an account (or rename it). --upkeep lets Claude keep the personal wiki current.
  list
      Accounts, teams and team servers.

Connecting AI apps and tools
  connect-code <email>
      A code to type on the sign-in page when an AI app connects to <origin>/mcp (5 minutes).
  token <email> [--team <slug>] [--claude-code] [--label <label>]
      A personal access token, shown once. --claude-code adds sending work sessions (the plugin).
      --team makes a team-only token (it never reads personal notes).
  token list <email>
      The user's tokens: id, label, what they reach, when they were made.
  token revoke <email> <token-id>
      Revoke one of them (it stops working at once).
  computer-code <email> [--name <name>]
      Connect a computer that runs the user's routines (30 minutes).

Teams
  team create <name> --owner <email>
      A team, on a free team server from the pool.
  team add <slug> <email> [--role member|admin|owner]
      Put someone in a team, or change their role.
  team remove <slug> <email>
      Take someone out of a team (their access ends within a minute).
  share <email> <folder-or-repo> <team-slug>
      Send the user's work sessions from that folder or repo (e.g. ~/git/acme-*) to the team.
  server add <server-id> <url>
      Put a team server in the pool (the Docker setup does this for its own).

Wikis in your own git repo (https; the access token comes on stdin, e.g. < token.txt)
  repo <email> <url> [--existing]
      Keep the user's personal wiki in step with their repo (synced every 15 minutes).
  team repo <slug> <url> [--existing] [--read-only]
      Keep the team wiki in step with the team's repo (pushed after every change), or with
      --read-only follow a repo another tool keeps (never written).
      A repo with files of its own needs --existing: run without it first to see what's there.
  team ignore <slug> [<path>...] [--clear]
      Folders and files of the team's repo that aren't knowledge (templates, scripts, a README):
      they stay out of the brain. Without paths: what's left out now. --clear: nothing is.
`;

export class AdminError extends Error {}

export interface AdminDeps {
  config: GatewayConfig;
  control: Control;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** A secret piped in (a repo's access token), so it stays out of argv and shell history. */
  readSecret?: () => Promise<string>;
}

type Flags = Record<string, string | true>;
/** Flags that stand alone; every other flag takes a value. */
const SWITCHES = ["upkeep", "claude-code", "help", "existing", "read-only", "clear"];

function parse(args: string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const key = a.slice(2);
    if (SWITCHES.includes(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[i + 1];
    // A forgotten value must not quietly change what's made (`token x --team` is no personal token).
    if (next === undefined || next.startsWith("--")) throw new AdminError(`--${key} needs a value.\n\n${ADMIN_USAGE}`);
    flags[key] = next;
    i++;
  }
  return { words, flags };
}

const text = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);

function need(value: string | undefined, what: string): string {
  if (!value) throw new AdminError(`${what} is missing.\n\n${ADMIN_USAGE}`);
  return value;
}

/** Runs one admin command and returns what to print. Throws AdminError for the user's mistakes. */
export async function runAdmin(args: string[], d: AdminDeps): Promise<string> {
  const { words, flags } = parse(args);
  const [cmd, sub] = words;
  const now = d.now ?? Date.now;
  const origin = d.config.origin;

  const findUser = async (ref: string | undefined) => {
    const out = await d.control.q(api.admin.findUser, { ref: need(ref, "The user's email") });
    if (out.matches > 1) throw new AdminError(`${out.matches} accounts have the email ${ref}. Use the user id from \`admin list\`.`);
    if (!out.user) throw new AdminError(`No account for ${ref}. Make one with: admin user add ${ref}`);
    return out.user;
  };

  if (cmd === "user" && sub === "add") {
    const email = need(words[2], "The email");
    const out = await d.control.m(api.admin.upsertLocalUser, { email, name: text(flags, "name"), now: now() });
    if (!out.ok) throw new AdminError(`"${email}" isn't an email address.`);
    if (flags.upkeep) await d.control.m(api.users.setPrefs, { uid: out.user.uid, consolidate: true });
    return `${out.created ? "Created" : "Updated"} ${out.user.name} <${out.user.email}> (${out.user.uid})${flags.upkeep ? ", Claude upkeep on" : ""}.`;
  }

  if (cmd === "list" || (cmd === "user" && sub === "list")) {
    const o = await d.control.q(api.admin.overview, {});
    const lines = [`Accounts (${o.users.length})`];
    for (const u of o.users) lines.push(`  ${u.uid}  ${u.name} <${u.email ?? "no email"}>  ${u.signIn}${u.upkeep ? ", upkeep" : ""}${u.disabled ? ", disabled" : ""}`);
    lines.push(`Teams (${o.teams.length})`);
    for (const t of o.teams) lines.push(`  ${t.slug}  ${t.name}  ${t.status}, ${t.members} member(s), ${t.serverUrl ?? "no server"}`);
    lines.push(`Team servers (${o.servers.length})`);
    for (const s of o.servers) lines.push(`  ${s.serverId}  ${s.url}  ${s.status}`);
    return lines.join("\n");
  }

  if (cmd === "connect-code") {
    const u = await findUser(sub);
    const { code, expiresAt } = await new Pairing(d.control, new CodeHasher(d.config.masterKey)).create(u.uid);
    return [
      `Sign-in code for ${u.name}: ${code.slice(0, 4)}-${code.slice(4)}  (until ${new Date(expiresAt).toISOString()}, works once)`,
      `Add ${origin}/mcp as a connector in the AI app (Claude: Settings → Connectors → Add custom connector) and type the code when it asks.`,
    ].join("\n");
  }

  if (cmd === "token" && sub === "list") {
    const u = await findUser(words[2]);
    const tokens = await new PatService(d.control).list(u.uid);
    if (!tokens.length) return `${u.name} has no tokens.`;
    return tokens
      .map((t) => `${t.id}  ${t.label}  ${t.resourceKind === "team" ? `team ${t.teamId}` : "personal"} (${t.scopes.join(" ")})  made ${new Date(t.createdAt).toISOString().slice(0, 10)}`)
      .join("\n");
  }

  if (cmd === "token" && sub === "revoke") {
    const u = await findUser(words[2]);
    const id = need(words[3], "The token's id (from `admin token list`)");
    if (!(await new PatService(d.control).revoke(u.uid, id))) throw new AdminError(`${u.name} has no live token ${id}.`);
    return `Revoked ${id}. It stops working at once.`;
  }

  if (cmd === "token") {
    const u = await findUser(sub);
    const pats = new PatService(d.control);
    const label = text(flags, "label") ?? (flags["claude-code"] ? "Claude Code" : "Admin CLI");
    const slug = text(flags, "team");
    let made: { token: string };
    if (slug) {
      const team = (await new Directory(d.control, 0).teamsOf(u.uid)).find((t) => t.slug === slug);
      if (!team) throw new AdminError(`${u.name} isn't in a team "${slug}". Add them with: admin team add ${slug} ${u.email ?? u.uid}`);
      made = await pats.create({ uid: u.uid, scopes: ["team:read", "team:write"], resource: { kind: "team", teamId: team.id }, label });
    } else {
      const scopes = ["personal:read", "personal:write", "team:read", ...(flags["claude-code"] ? ["sessions:write"] : [])];
      made = await pats.create({ uid: u.uid, scopes, resource: { kind: "personal" }, label });
    }
    await d.control.m(api.users.markAppConnected, { uid: u.uid, now: now() });
    return [
      made.token,
      `Shown once. Send it as "Authorization: Bearer <token>" to ${origin}${slug ? `/t/${slug}` : ""}/mcp.`,
    ].join("\n");
  }

  if (cmd === "computer-code") {
    const u = await findUser(sub);
    const personal = new PersonalStore(d.control, d.config.masterKey);
    const routines = new RoutineService({
      control: d.control,
      keys: new RoutineKeys({ control: d.control, personal, master: d.config.masterKey }),
      codes: new CodeHasher(d.config.masterKey),
      origin,
    });
    const teams = await new Directory(d.control, 0).teamsOf(u.uid);
    const out = await routines.addComputer({ uid: u.uid, teams, personal: true, canWritePersonal: true, canWriteTeams: true }, text(flags, "name") ?? "Server");
    return [`Setup code for ${u.name}'s computer "${out.computer.name}", valid 30 minutes. On that computer (Linux, systemd, Claude Code signed in):`, out.commands].join("\n");
  }

  if (cmd === "team" && sub === "create") {
    const name = need(words[2], "The team's name");
    const owner = await findUser(need(text(flags, "owner"), "--owner <email>"));
    const made = await d.control.m(api.teams.createOwned, {
      uid: owner.uid,
      name,
      peopleSlug: `people/${slugify(owner.name) || "member"}`,
      now: now(),
    });
    if (!made.ok) {
      if (made.error === "no_server") throw new AdminError("No free team server. Start one and add it with: admin server add <server-id> <url>");
      throw new AdminError("Give the team a name.");
    }
    const link = new TeamLink(origin, d.config.signingKeys[0]!, d.fetchImpl, (team) => new Revisions(d.control).teamChanged(team.id));
    try {
      await link.claim(made.server, { id: made.team.id, name: made.team.name });
    } catch (err) {
      await d.control.m(api.teams.abandonCreate, { teamId: made.team.id as never });
      throw new AdminError(`The team server ${made.server.serverId} (${made.server.url}) didn't take the team: ${(err as Error).message}`);
    }
    const ready = await link.ready(made.server.url);
    return [
      `Created team "${made.team.name}" (slug ${made.team.slug}) on ${made.server.serverId}, owned by ${owner.name}.`,
      ready ? `Its server is up.` : `Its server is restarting as the team's; give it a few seconds.`,
      `Team MCP URL: ${origin}/t/${made.team.slug}/mcp`,
    ].join("\n");
  }

  if (cmd === "team" && sub === "add") {
    const slug = need(words[2], "The team's slug");
    const u = await findUser(words[3]);
    const role = text(flags, "role") ?? "member";
    if (!["member", "admin", "owner"].includes(role)) throw new AdminError("--role is member, admin or owner.");
    const out = await d.control.m(api.admin.setMember, {
      slug,
      uid: u.uid,
      role: role as "member" | "admin" | "owner",
      peopleSlug: `people/${slugify(u.name) || "member"}`,
      now: now(),
    });
    if (!out.ok) throw new AdminError(`No team "${slug}".`);
    return `${u.name} is ${out.created ? "now" : "still"} in ${slug}, as ${role}.`;
  }

  if (cmd === "team" && sub === "remove") {
    const slug = need(words[2], "The team's slug");
    const u = await findUser(words[3]);
    const out = await d.control.m(api.admin.removeMember, { slug, uid: u.uid });
    if (!out.ok) throw new AdminError(out.error === "no_team" ? `No team "${slug}".` : `${u.name} is the team's only owner. Make someone else owner first: admin team add ${slug} <email> --role owner`);
    return out.removed ? `${u.name} is out of ${slug}.` : `${u.name} wasn't in ${slug}.`;
  }

  if (cmd === "repo" || (cmd === "team" && sub === "repo")) {
    const isTeam = cmd === "team";
    const url = need(words[isTeam ? 3 : 2], "The repo's https URL");
    const token = ((await d.readSecret?.()) ?? "").trim();
    if (!token) throw new AdminError("Pipe the repo's access token in on stdin, e.g. `admin repo you@example.com https://github.com/you/wiki.git < token.txt`.");
    if (!isTeam) {
      const u = await findUser(sub);
      const personal = new PersonalStore(d.control, d.config.masterKey);
      const status = await new PersonalRepos(d.control, personal, { allowFile: d.config.allowFileRepos }).connect(u.uid, url, token, { existing: flags.existing === true }).catch((err: Error) => {
        const there = err instanceof HasContent ? ` (e.g. ${err.sample.join(", ")}). Add --existing to connect it anyway` : "";
        throw new AdminError(`The repo didn't connect: ${err.message}${there}`);
      });
      return `${u.name}'s personal wiki is connected to ${status.url} (${status.branch}). It syncs every 15 minutes.`;
    }
    const slug = need(sub === "repo" ? words[2] : undefined, "The team's slug");
    const team = (await d.control.q(api.admin.overview, {})).teams.find((t) => t.slug === slug && t.status === "active");
    if (!team) throw new AdminError(`No active team "${slug}".`);
    const link = new TeamLink(origin, d.config.signingKeys[0]!, d.fetchImpl);
    const mode = flags["read-only"] === true ? "read-only" : "two-way";
    const out = await link.repo({ id: team.id, slug, name: team.name, status: "active", serverUrl: team.serverUrl }, "admin", "POST", { url, token, mode, existing: flags.existing === true });
    if (out.status === 409) {
      const j = out.json as { message?: string; sample?: string[] };
      throw new AdminError(`${j.message ?? "The repo has files of its own."} (e.g. ${(j.sample ?? []).join(", ")}). Add --existing to connect it anyway${mode === "two-way" ? ", or --read-only if another tool keeps it" : ""}.`);
    }
    if (out.status !== 200) throw new AdminError(`The team server refused: ${JSON.stringify(out.json)}`);
    return mode === "read-only"
      ? `The ${slug} team wiki follows ${url} now, read-only: Ambient reads it and never writes there.`
      : `The ${slug} team wiki is connected to ${url}. Every change is pushed there.`;
  }

  if (cmd === "team" && sub === "ignore") {
    const slug = need(words[2], "The team's slug");
    const team = (await d.control.q(api.admin.overview, {})).teams.find((t) => t.slug === slug && t.status === "active");
    if (!team) throw new AdminError(`No active team "${slug}".`);
    const link = new TeamLink(origin, d.config.signingKeys[0]!, d.fetchImpl);
    const asTeam = { id: team.id, slug, name: team.name, status: "active" as const, serverUrl: team.serverUrl };
    const paths = words.slice(3);
    const change = flags.clear === true ? [] : paths.length ? paths : null;
    const out = await link.settings(asTeam, "admin", change ? "PUT" : "GET", change ? { ignore: change } : undefined);
    if (out.status !== 200) throw new AdminError(`The team server refused: ${JSON.stringify(out.json)}`);
    const now = ((out.json as { settings?: { ignore?: string[] } }).settings?.ignore ?? []);
    return now.length ? `The ${slug} brain leaves out: ${now.join(", ")}.` : `The ${slug} brain leaves nothing out.`;
  }

  if (cmd === "share") {
    const u = await findUser(sub);
    const match = need(words[2], "The folder or repo");
    const slug = need(words[3], "The team's slug");
    if (!(await new Directory(d.control, 0).teamsOf(u.uid)).some((t) => t.slug === slug)) throw new AdminError(`${u.name} isn't in a team "${slug}".`);
    const rules = (await d.control.q(api.sessions.rules, { uid: u.uid })) as { match: string; team: string }[];
    const next = [...rules.filter((r) => r.match !== match), { match, team: slug }];
    await d.control.m(api.sessions.setRules, { uid: u.uid, rules: next });
    return `${u.name}'s work sessions in ${match} now go to ${slug} (after the 30-minute hold). Rules: ${next.map((r) => `${r.match} → ${r.team}`).join(", ")}`;
  }

  if (cmd === "server" && sub === "add") {
    const serverId = need(words[2], "The server id");
    const url = need(words[3], "The server's URL");
    if (!/^https?:\/\/[^\s/]+/.test(url)) throw new AdminError(`"${url}" isn't a URL.`);
    const out = await d.control.m(api.admin.registerServer, { serverId, url, now: now() });
    return `${out.created ? "Added" : "Updated"} team server ${serverId} at ${url.replace(/\/+$/, "")} (${out.status}).`;
  }

  if (!cmd || cmd === "help" || flags.help) return ADMIN_USAGE;
  throw new AdminError(`Unknown command "${words.join(" ")}".\n\n${ADMIN_USAGE}`);
}
