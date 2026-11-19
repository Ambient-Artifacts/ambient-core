// A bot's thread messages and Ambient's chat are sealed with the owner's data key (RoutineKeys), as
// a loop's prompt is: Convex only ever holds ciphertext. A message is its text and, for a question,
// the answers to choose from.
import { createHash } from "node:crypto";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { fileRefs, type FileRef } from "./attachments.ts";

export const MESSAGE_PURPOSE = "bot:message";
export const CHAT_PURPOSE = "ambient:chat";

export interface MessageBody {
  text: string;
  choices?: string[];
  /** A question's work to decide on (docs/bots.md, "Questions show the work"): the draft, the link. */
  details?: string;
  /** Files sent with it (bots/attachments.ts): shown with the message, fetched by id. */
  files?: FileRef[];
}

export async function sealMessage(keys: RoutineKeys, owner: Owner, body: MessageBody, purpose = MESSAGE_PURPOSE) {
  const sealed = await keys.seal(owner, purpose, JSON.stringify({ t: body.text, ...(body.choices?.length ? { c: body.choices } : {}), ...(body.details ? { d: body.details } : {}), ...(body.files?.length ? { f: body.files } : {}) }));
  return { iv: sealed.iv, ct: sealed.ciphertext };
}

export async function openMessage(keys: RoutineKeys, owner: Owner, iv: string, ct: string, purpose = MESSAGE_PURPOSE): Promise<MessageBody> {
  const raw = await keys.open(owner, purpose, iv, ct);
  try {
    const j = JSON.parse(raw) as { t?: unknown; c?: unknown; d?: unknown; f?: unknown };
    if (typeof j.t === "string") {
      const files = fileRefs(j.f);
      return { text: j.t, ...(Array.isArray(j.c) ? { choices: j.c.filter((x): x is string => typeof x === "string") } : {}), ...(typeof j.d === "string" && j.d ? { details: j.d } : {}), ...(files.length ? { files } : {}) };
    }
  } catch {
    // Not ours: shown as it is.
  }
  return { text: raw };
}

/** Whether two results say the same thing (report "news" leaves a repeat out of the thread). */
export function resultHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 32);
}

/** Why a run failed, when it's the computer's Claude account and not the bot: out of credit, or signed out. */
export function claudeProblem(text: string): "credit" | "signin" | null {
  if (/credit balance is too low|insufficient (credit|balance)|exceeded your current quota|billing/i.test(text)) return "credit";
  if (/invalid (x-)?api[ -]key|authentication_error|not logged in|please run \/login|oauth token (has )?expired|invalid bearer token|401 unauthorized/i.test(text)) return "signin";
  return null;
}


/**
 * Why a Codex run failed, when it's the computer's OpenAI sign-in and not the bot: out of credit or
 * over the plan's limit, or not signed in. Only for a failure the runner says is Codex's.
 */
export function openaiProblem(text: string): "credit" | "signin" | null {
  if (!/\bCodex\b|codex login|api\.openai\.com|chatgpt\.com/.test(text)) return null;
  if (/insufficient_quota|exceeded your current quota|usage limit|rate limit reached for|billing/i.test(text)) return "credit";
  if (/invalid_api_key|incorrect api key|no codex credentials|not logged in|run codex login|401 unauthorized|refresh token|token (has )?expired|sign in again/i.test(text)) return "signin";
  return null;
}

/** A failure that is the computer's Claude account (or its OpenAI sign-in for Codex): what the app offers to fix. */
export interface ClaudeFix {
  kind: "claude" | "openai";
  computer: string;
  reason: "credit" | "signin";
}

export function claudeFix(kind: string, text: string, computer: string | null | undefined): ClaudeFix | null {
  if (kind !== "failure" || !computer) return null;
  const openai = openaiProblem(text);
  if (openai) return { kind: "openai", computer, reason: openai };
  const reason = claudeProblem(text);
  return reason ? { kind: "claude", computer, reason } : null;
}
