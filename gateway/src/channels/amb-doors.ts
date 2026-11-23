// Amb in Slack and Microsoft Teams (docs/bots.md, "Amb in Slack and Teams"): its own app in a
// company's workspace, made like a bot's ("Ambient", or the name the company gives it). Who it
// serves depends on where it's written to, never on the model:
//
//   a direct message ──▶ the writer's Ambient account (by their email, among the people the
//                        workspace's owner covers) ──▶ their own Amb chat: one more door to it,
//                        like iMessage; the answer goes back there
//   a channel        ──▶ the team's Amb: the team's brain only, never anyone's personal notes
//
// The app's records live with its owner (the person or the team that connected the workspace),
// under the key "amb"; which DM is a person's door lives with that person.
import type { IncomingFile } from "../bots/attachments.ts";
import { checkAttachments } from "../bots/ambient.ts";
import type { Owner } from "../routines/keys.ts";
import type { AmbInbox } from "./imessage.ts";
import type { ThreadMessage } from "./channel-files.ts";

/** The key Amb's app is kept under, where a bot's would be under its id. */
export const AMB = "amb";

/** What Amb's doors in Slack and Teams need from the rest of the gateway. */
export interface AmbDoorDeps {
  /** Amb's chat (bots/ambient.ts): takes a message in and answers through the same door. */
  inbox: AmbInbox;
  /** The Ambient account behind an email, among the people `owner` covers (the person, or the team's members). */
  accountByEmail(owner: Owner, email: string): Promise<{ uid: string; name: string } | null>;
  /** Files a decision's answer (a click on a card). */
  answer?(uid: string, decisionId: string, answer: string, via: string): Promise<void>;
  /** A team's Amb in a channel (null: not available there yet; the reason is said). */
  teamTurn?(teamId: string, asker: { uid: string; name: string }, conversation: string, text: string, files: IncomingFile[], thread?: ThreadMessage[]): Promise<{ text: string } | null>;
  /** Turns in flight: a channel turn is written down until its answer is posted (bots/turn-queue.ts). */
  turns?: import("../bots/turn-queue.ts").TurnQueue;
}

/** A team's channel turn as written down: enough to answer it again after a restart and post it where it was asked. */
export interface TeamTurnPayload {
  teamId: string;
  asker: { uid: string; name: string };
  conversation: string;
  text: string;
  thread: ThreadMessage[];
  /** Where the answer goes: Slack (channel and thread), or Teams (its service and conversation). */
  to: { slack: { channel: string; thread: string } } | { teams: { serviceUrl: string; conv: string } };
}

/** Amb's chat takes images, PDFs and text: the rest is named in the message. */
export function forAmb(files: IncomingFile[]): { files: IncomingFile[]; left: string[] } {
  const ok: IncomingFile[] = [];
  const left: string[] = [];
  for (const f of files) {
    try {
      checkAttachments([...ok, f]);
      ok.push(f);
    } catch (err) {
      left.push(`${f.name} (${(err as Error).message.replace(/^.*?: /, "")})`);
    }
  }
  return { files: ok, left };
}
