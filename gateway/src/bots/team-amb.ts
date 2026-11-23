// A team's Amb in a Slack or Teams channel (docs/bots.md, "Amb in Slack and Teams"; the team
// wiki's product/conversations.md): the same Amb, with the team's brain only. Each thread is a
// lane: one Claude Code session on the team's own computer, resumed every time the thread writes
// to it, with a token for that team alone (the asker's, so what it may change follows their role),
// so nothing personal can reach a channel.
//
//   a mention in a thread ──▶ turn(): the thread's lane on the team's computer; the new message and
//                             what people said in the thread since it last answered
//   a new thread, or a session that isn't there ──▶ the lane starts cold from its turns so far
//                             and the whole thread
//   no computer for the team ──▶ the server's key, where the operator pays (upkeep.ts), with the
//                             team's tools in-process; else it says how to connect one
//
// The lane's record (sealed, with the team: `store`) keeps its session, how far it has read, and
// its turns (no end date, like any chat). They never reach anyone's own chat with Amb.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolLoop, type Turn } from "../ai/loop.ts";
import type { Team } from "../directory.ts";
import type { IncomingFile } from "./attachments.ts";
import { threadSoFar, type ThreadMessage } from "../channels/channel-files.ts";
import { sha256Hex } from "../crypto.ts";
import type { AmbientComputers } from "./computer.ts";

/** How many of a thread's last turns go with a turn (the thread itself is kept whole). */
const HISTORY_TURNS = 20;

/** A thread's lane as kept: its turns, its session, and the newest thread message it has read (ms). */
export interface LaneRecord {
  turns: Turn[];
  at: number;
  session?: string;
  seen?: number;
}

/** Where a thread's lane is kept (the team's sealed records; tests: in memory). */
export interface ThreadStore {
  get(teamId: string, conversation: string): Promise<LaneRecord | null>;
  put(teamId: string, conversation: string, value: LaneRecord): Promise<void>;
}

/** A thread's lane id: the same on every computer (its folder there is named after it). */
export function laneOf(teamId: string, conversation: string): string {
  return `team-${sha256Hex(`${teamId}\n${conversation}`).slice(0, 24)}`;
}

/** What a team's Amb may use where it runs without a computer: reading the team's brain, suggesting corrections. */
const TEAM_TOOLS = new Set(["index", "search", "fetch", "brief", "get_entity", "list_recent", "list_decisions", "list_action_items", "transcript", "suggest_correction"]);

export function teamAmbInstructions(o: { team: string; asker: string; where: string }): string {
  return [
    `You are Ambient, ${o.team}'s assistant, answering in a ${o.where} channel where several people of ${o.team} read along. ${o.asker} asked you.`,
    `Use ${o.team}'s brain only (the team wiki and the team's bots). You have nothing personal here, and say so if asked for someone's own notes, chats or bots: they ask you that in a direct message instead.`,
    "Answer for the whole channel: short, plain, the most important first, with the page you found it on. Markdown works. When the brain doesn't say, say that instead of guessing.",
    "Change something (a team bot's settings, a correction) only when they asked for it here, and only what their role in the team allows.",
  ].join("\n\n");
}

export class TeamAmb {
  private history = new Map<string, LaneRecord>();

  constructor(
    private d: {
      computers: AmbientComputers;
      /** The asker's computers, their teams' servers among them. */
      computersOf: (uid: string) => Promise<{ id: string; uid: string; name: string; team: string | null; teamId?: string | null }[]>;
      teamsOf: (uid: string) => Promise<Team[]>;
      /** The team's tools for the asker, in-process (no computer: the server's key answers). */
      teamMcp: (uid: string, team: Team) => Promise<McpServer>;
      apiKey?: string;
      model: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
      store?: ThreadStore;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private async load(teamId: string, conversation: string): Promise<LaneRecord> {
    const v = this.d.store ? await this.d.store.get(teamId, conversation).catch(() => null) : (this.history.get(`${teamId}:${conversation}`) ?? null);
    return v ?? { turns: [], at: 0 };
  }

  private async save(teamId: string, conversation: string, value: LaneRecord): Promise<void> {
    // Kept whole, like a chat; a very long thread keeps its last 500 turns.
    const kept = { ...value, turns: value.turns.slice(-500), at: this.now() };
    if (this.d.store) await this.d.store.put(teamId, conversation, kept).catch((err: Error) => console.warn(`[team-amb] a thread wasn't kept: ${err.message}`));
    else this.history.set(`${teamId}:${conversation}`, kept);
  }

  /**
   * One turn in a thread. `conversation` names the thread; `thread` is what was said in it before
   * this message (with when), of which the lane takes only what it hasn't read.
   */
  async turn(teamId: string, asker: { uid: string; name: string }, conversation: string, text: string, files: IncomingFile[] = [], thread: ThreadMessage[] = []): Promise<{ text: string }> {
    const team = (await this.d.teamsOf(asker.uid)).find((t) => t.id === teamId && t.status === "active");
    if (!team) return { text: `${asker.name}, you're not in this team in Ambient, so I can't answer from its brain for you.` };
    const where = conversation.startsWith("slack:") ? "Slack" : "Microsoft Teams";
    const instructions = teamAmbInstructions({ team: team.name, asker: asker.name, where });
    const rec = await this.load(teamId, conversation);
    const asked = `${asker.name}: ${text}`;
    const newest = thread.reduce((m, x) => Math.max(m, x.at), rec.seen ?? 0);
    let answer: string;
    let session = rec.session;
    const host = (await this.d.computersOf(asker.uid).catch(() => [])).find((h) => h.teamId === teamId && this.d.computers.connected(h.id));
    if (host) {
      // Warm: only what people said in the thread since it last answered. Cold (no session yet):
      // the whole thread; the runner adds the turns so far when it has no session to resume.
      const since = rec.session ? threadSoFar(thread.filter((m) => m.at > (rec.seen ?? 0) && m.who !== "you"), "Said in the thread since you last answered:") : threadSoFar(thread);
      const out = await this.d.computers.askWithFiles(
        { id: host.id, uid: asker.uid, name: host.name },
        { text: `${asked}${since}`, name: asker.name, instructions, mode: "chat", fresh: false, history: rec.turns.slice(-HISTORY_TURNS), lane: laneOf(teamId, conversation), ...(rec.session ? { session: rec.session } : {}), ...(files.length ? { attachments: files } : {}) },
        { teamId },
      );
      answer = out.text;
      session = out.session ?? session;
    } else if (this.d.apiKey) {
      const names = files.length ? `\n\n[Files with this message: ${files.map((f) => f.name).join(", ")}]` : "";
      answer = await toolLoop({ server: await this.d.teamMcp(asker.uid, team), apiKey: this.d.apiKey, model: this.d.model, instructions, allowed: TEAM_TOOLS, history: rec.turns.slice(-HISTORY_TURNS), question: `${asked}${names}${threadSoFar(thread)}`, maxSteps: 8, maxTokens: 1500, clientName: "ambient-team", fetchImpl: this.d.fetchImpl });
    } else {
      return { text: `No computer runs ${team.name}'s Ambient yet. An owner or admin connects one on the team's page in the Ambient app (Computers); then I answer here.` };
    }
    answer = answer.trim() || "I don't have an answer to that.";
    await this.save(teamId, conversation, { turns: [...rec.turns, { role: "user" as const, text: asked }, { role: "assistant" as const, text: answer }], at: this.now(), ...(session ? { session } : {}), seen: Math.max(newest, this.now()) });
    return { text: answer };
  }
}
