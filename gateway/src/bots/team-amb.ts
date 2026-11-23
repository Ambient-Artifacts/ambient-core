// A team's Amb in a Slack or Teams channel (docs/bots.md, "Amb in Slack and Teams"): the same Amb,
// with the team's brain only. It runs on the team's own computer (the one that runs its bots),
// with a token for that team alone, so nothing personal can reach a channel: not the asker's
// notes, not their bots, not their chat with Amb. What it may change, it may as the asker (their
// role in the team decides).
//
//   a mention in a channel ──▶ turn(): the team's computer, a short session (mode "internal"),
//                              the asker's token for the team, the channel's last turns
//   no computer for the team ──▶ the server's key, where the operator pays (upkeep.ts), with the
//                              team's tools in-process; else it says how to connect one
//
// A channel's last turns are kept in memory for a few hours (a restart forgets them), so a
// follow-up in the thread is understood; they never reach anyone's own chat with Amb.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolLoop, type Turn } from "../ai/loop.ts";
import type { Team } from "../directory.ts";
import type { IncomingFile } from "./attachments.ts";
import type { AmbientComputers } from "./computer.ts";

const HISTORY_TURNS = 12;
const HISTORY_MS = 6 * 3600_000;

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
  private history = new Map<string, { turns: Turn[]; at: number }>();

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
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** One turn in a channel: `conversation` names the thread, so a follow-up there is understood. */
  async turn(teamId: string, asker: { uid: string; name: string }, conversation: string, text: string, files: IncomingFile[] = []): Promise<{ text: string }> {
    const team = (await this.d.teamsOf(asker.uid)).find((t) => t.id === teamId && t.status === "active");
    if (!team) return { text: `${asker.name}, you're not in this team in Ambient, so I can't answer from its brain for you.` };
    const where = conversation.startsWith("slack:") ? "Slack" : "Microsoft Teams";
    const instructions = teamAmbInstructions({ team: team.name, asker: asker.name, where });
    const now = this.now();
    for (const [k, v] of this.history) if (now - v.at > HISTORY_MS) this.history.delete(k);
    const history = this.history.get(conversation)?.turns ?? [];
    const asked = `${asker.name}: ${text}`;
    let answer: string;
    const host = (await this.d.computersOf(asker.uid).catch(() => [])).find((h) => h.teamId === teamId && this.d.computers.connected(h.id));
    if (host) {
      const out = await this.d.computers.askWithFiles({ id: host.id, uid: asker.uid, name: host.name }, { text: asked, name: asker.name, instructions, mode: "internal", fresh: true, history, ...(files.length ? { attachments: files } : {}) }, { teamId });
      answer = out.text;
    } else if (this.d.apiKey) {
      const names = files.length ? `\n\n[Files with this message: ${files.map((f) => f.name).join(", ")}]` : "";
      answer = await toolLoop({ server: await this.d.teamMcp(asker.uid, team), apiKey: this.d.apiKey, model: this.d.model, instructions, allowed: TEAM_TOOLS, history, question: `${asked}${names}`, maxSteps: 8, maxTokens: 1500, clientName: "ambient-team", fetchImpl: this.d.fetchImpl });
    } else {
      return { text: `No computer runs ${team.name}'s Ambient yet. An owner or admin connects one on the team's page in the Ambient app (Computers); then I answer here.` };
    }
    answer = answer.trim() || "I don't have an answer to that.";
    this.history.set(conversation, { turns: [...history, { role: "user" as const, text: asked }, { role: "assistant" as const, text: answer }].slice(-HISTORY_TURNS), at: now });
    return { text: answer };
  }
}
