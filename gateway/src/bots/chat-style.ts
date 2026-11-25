// How a bot talks in Slack and Teams, and what keeps a run's answer from landing twice.
//
// A run that answers mid-run (its reply, /v1/bot/reply) usually ends with the same words as its
// result, and the result goes to the thread too: without this, every answer showed up twice.

/** Told to the bot with every Slack or Teams message: people read these on their phones. */
export const CHAT_STYLE =
  "Write like a colleague in chat: short, a few lines at most, one message. No headings, no apologies or explanations of your setup unless asked; ask one question if you need something.";

/** Runs forgotten after this long without a result (a run that never finished). */
const POSTED_FOR_MS = 6 * 3600_000;

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/** A run posted this mid-run. */
export function remember(posted: Map<string, { texts: string[]; at: number }>, runId: string, text: string, now: number): void {
  for (const [k, v] of posted) if (now - v.at > POSTED_FOR_MS) posted.delete(k);
  const cur = posted.get(runId) ?? { texts: [], at: now };
  posted.set(runId, { texts: [...cur.texts, norm(text)].slice(-20), at: now });
}

/** A run's result says nothing new: it's one of the things it posted already, or all of them in a row. */
export function alreadyPosted(posted: Map<string, { texts: string[]; at: number }>, runId: string, text: string): boolean {
  const said = posted.get(runId)?.texts;
  if (!said?.length) return false;
  const t = norm(text);
  if (!t) return true;
  if (said.some((s) => s === t || s.includes(t))) return true;
  return norm(said.join(" ")).includes(t);
}
