// A bot's files for people and for Amb (docs/bots.md, "A bot's folder"): who may read and write
// is who may see and change the bot. AGENTS.md is the bot's prompt, so a change to it goes through
// the loop (and is a version of it there). When Amb changes a bot's instructions or skills, the
// bot's thread says so, where its owner talks to it.
import { api } from "../control.ts";
import type { Actor, RoutineService } from "../routines/service.ts";
import { AGENTS, FolderError, MEMORY, checkPath, type Author, type BotFolder, type FileInfo, type FileView, type Handoff } from "./folder.ts";
import { sealMessage } from "./messages.ts";
import type { BotMirror, MirrorStatus } from "./mirror.ts";

export class BotFiles {
  constructor(
    private d: {
      routines: RoutineService;
      folder: BotFolder;
      /** Bots' folders in git; absent: not mirrored. */
      mirror?: BotMirror;
      now?: () => number;
    },
  ) {}

  /**
   * Refuses a change before it's made (the reviewer may not rewrite a bot's AGENTS.md: it
   * proposes it instead; docs/bots.md, "Automations"). Returns why, or null to allow it.
   */
  guard?: (actor: Actor, id: string, path: string, by: Author) => string | null;

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  async list(actor: Actor, id: string): Promise<{ files: FileInfo[]; handoffs: Handoff[] }> {
    const f = await this.d.routines.folderOf(actor, id, false);
    const [files, handoffs] = await Promise.all([this.d.folder.files(f.owner, f.routineId, f.agents), this.d.folder.handoffs(f.owner, f.routineId, 3)]);
    return { files, handoffs };
  }

  /** Where the bot's folder is in git, and how the last mirror went. */
  async mirrorStatus(actor: Actor, id: string): Promise<MirrorStatus | null> {
    if (!this.d.mirror) return null;
    const f = await this.d.routines.folderOf(actor, id, false);
    return this.d.mirror.status(f.owner, f.routineId);
  }

  /** Mirror the bot's owner's bots now (who may change the bot). */
  async mirrorNow(actor: Actor, id: string): Promise<MirrorStatus | null> {
    if (!this.d.mirror) return null;
    const f = await this.d.routines.folderOf(actor, id, true);
    await this.d.mirror.mirror(f.owner);
    return this.d.mirror.status(f.owner, f.routineId);
  }

  async read(actor: Actor, id: string, path: string, version?: number): Promise<FileView> {
    const f = await this.d.routines.folderOf(actor, id, false);
    return this.d.folder.read(f.owner, f.routineId, path, f.agents, version);
  }

  async history(actor: Actor, id: string, path: string) {
    const f = await this.d.routines.folderOf(actor, id, false);
    return this.d.folder.history(f.owner, f.routineId, path);
  }

  async handoffs(actor: Actor, id: string, limit: number): Promise<Handoff[]> {
    const f = await this.d.routines.folderOf(actor, id, false);
    return this.d.folder.handoffs(f.owner, f.routineId, limit);
  }

  /** A new version of a file; `by` says who (the person in the app, Amb through its tools). */
  async write(actor: Actor, id: string, path: string, content: string, by: Author, why: string | null, source: string): Promise<FileView> {
    const p = checkPath(path);
    const refusal = this.guard?.(actor, id, p, by);
    if (refusal) throw new FolderError("propose_instead", refusal, 409);
    const f = await this.d.routines.folderOf(actor, id, true);
    let view: FileView;
    if (p === AGENTS) {
      await this.d.routines.update(actor, id, { prompt: content }, source, { by, why });
      view = await this.d.folder.read(f.owner, f.routineId, AGENTS, content);
    } else view = await this.d.folder.write(f.owner, f.routineId, p, content, by, why);
    if (by.kind === "amb" && p !== MEMORY) await this.note(actor, id, `I changed ${p}${why ? `: ${why}` : "."} (version ${view.version}; you can undo it under Files.)`);
    return view;
  }

  async remove(actor: Actor, id: string, path: string, by: Author, why: string | null): Promise<void> {
    const f = await this.d.routines.folderOf(actor, id, true);
    await this.d.folder.remove(f.owner, f.routineId, path, by, why);
    if (by.kind === "amb") await this.note(actor, id, `I deleted ${checkPath(path)}${why ? `: ${why}` : "."} (you can bring it back under Files.)`);
  }

  /** An earlier version back, as a new version. */
  async revert(actor: Actor, id: string, path: string, version: number, by: Author, source: string): Promise<FileView> {
    const f = await this.d.routines.folderOf(actor, id, true);
    const text = await this.d.folder.versionText(f.owner, f.routineId, path, version);
    return this.write(actor, id, path, text, by, `restored version ${version}`, source);
  }

  /** A note from Amb in a bot's thread (doesn't start a run). */
  async note(actor: Actor, id: string, text: string): Promise<void> {
    const f = await this.d.routines.folderOf(actor, id, false);
    const sealed = await sealMessage(this.d.routines.keys, f.owner, { text });
    const access = { uid: actor.uid as never, teamIds: actor.teams.filter((t) => t.status === "active").map((t) => t.id) as never };
    await this.d.routines.control.m(api.bots.note, { ...access, id, iv: sealed.iv, ct: sealed.ct, now: this.now() }).catch((err: Error) => console.warn(`[files] the thread note didn't go out: ${err.message}`));
  }
}

/** What MCP tools and app routes need for bots' folders, Amb's memory and history, together. */
export interface Folders {
  files: BotFiles;
  folder: BotFolder;
  /** Bots' folders in git (docs/bots.md, "A bot's folder in git"). */
  mirror?: import("./mirror.ts").BotMirror;
  history: import("./history.ts").HistorySearch;
  /** Amb's automations (set once Amb is up; docs/bots.md, "Automations"). */
  automations?: import("./automations.ts").Automations;
  /** GitHub's events for bots and the PR gate (docs/bots.md, "GitHub events and the PR gate"). */
  github?: import("./github.ts").GitHubEvents;
  /** Ambient's GitHub App, when it's set up (docs/bots.md, "Connect GitHub"). */
  githubApp?: import("./github-apps.ts").GitHubApps;
  /** Who can ask each bot in Slack and Teams (docs/bots.md, "Who can ask it"). */
  askers?: import("./askers.ts").BotAskers;
  /** Bots' own Slack apps (docs/bots.md, "Slack"). */
  slack?: import("./slack-apps.ts").SlackApps;
  /** Bots' own Microsoft Teams apps (docs/bots.md, "Microsoft Teams"). */
  teams?: import("./teams-apps.ts").TeamsApps;
  /** How bots learn: signals, scorecards, lessons (docs/bots.md, "How bots learn"). */
  learning?: import("./learning.ts").BotLearning;
  /** Amb's settings per person (docs/bots.md, "Amb's settings"). */
  ambSettings?: import("./amb-settings.ts").AmbSettings;
  /** MCP servers people connect and give to bots (docs/bots.md, "MCP connections"). */
  mcp?: import("./mcp-connections.ts").McpConnections;
  /** Amb on iMessage, when a line is set up (docs/bots.md, "iMessage"). */
  imessage?: import("../channels/imessage.ts").IMessageChannel;
  /** Where Amb's own words go besides the app's chat (docs/bots.md, "Channels"). */
  reach?: import("../channels/reach.ts").AmbReach;
  /** Wake-ups bots book for themselves (docs/bots.md, "Wake-ups"). */
  wakes?: import("./wakes.ts").Wakes;
}
