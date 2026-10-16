// The placement eval: do AI apps answer from Ambient, and does putting who the user is and what
// their wikis hold into the MCP instructions (gateway/src/mcp/context.ts) help or hurt?
//
//   npm run eval                       both conditions, compared with eval/baseline.json
//   npm run eval -- --update-baseline  this run becomes the baseline
//   EVAL_MODEL=claude-haiku-5-5 npm run eval
//
// Each question goes to a model with Ambient's real MCP tools over the fixture wiki, as an app
// would connect them: once with the general instructions only ("general"), once with the
// user's profile and the wiki map as well ("personal"). It fails (exit 1) when the personal
// instructions score below the general ones (keep them off until they win), or below the
// baseline by more than one question. Without ANTHROPIC_API_KEY it says so and exits 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ask, summarize, type Condition, type Result, type Summary } from "./harness.ts";
import { QUESTIONS } from "./questions.ts";

const HERE = import.meta.dirname;
const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-5-5";
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const pick = args.includes("--questions") ? new Set(args[args.indexOf("--questions") + 1]!.split(",")) : undefined;

const pct = (x: number) => `${Math.round(x * 100)}%`;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("eval: ANTHROPIC_API_KEY is not set; nothing run.");
    return 0;
  }
  const anthropic = new Anthropic({ maxRetries: 4 });
  const conditions: Condition[] = only ? [only as Condition] : ["general", "personal"];
  const questions = QUESTIONS.filter((q) => !pick || pick.has(q.id));
  const results: Result[] = [];
  for (const condition of conditions) {
    for (const q of questions) {
      const r = await ask(anthropic, MODEL, condition, q);
      results.push(r);
      console.log(`${condition.padEnd(8)} ${q.id.padEnd(4)} ${r.correct ? "right" : r.abstained ? "abstained" : "WRONG"} · tools: ${r.tools.join(", ") || "none"}`);
    }
  }
  const summary = Object.fromEntries(conditions.map((c) => [c, summarize(results.filter((r) => r.condition === c))])) as Record<Condition, Summary>;
  const tokens = results.reduce((t, r) => ({ input: t.input + r.inputTokens, output: t.output + r.outputTokens }), { input: 0, output: 0 });
  console.log("");
  for (const c of conditions) {
    const s = summary[c];
    console.log(`${c.padEnd(8)} score ${s.score}/${s.of} · recall ${pct(s.recall)} · precision ${pct(s.precision)} · looked in Ambient ${s.looked}/${s.of} · negatives right ${s.abstainedRight}`);
  }
  console.log(`model ${MODEL} · ${tokens.input} input and ${tokens.output} output tokens`);

  const out = { model: MODEL, at: new Date().toISOString(), summary, results };
  mkdirSync(join(HERE, "out"), { recursive: true });
  writeFileSync(join(HERE, "out", "latest.json"), JSON.stringify(out, null, 2));

  const baselineFile = join(HERE, "baseline.json");
  if (args.includes("--update-baseline")) {
    writeFileSync(baselineFile, `${JSON.stringify({ model: MODEL, at: out.at, summary }, null, 2)}\n`);
    console.log("baseline updated");
    return 0;
  }
  const failures: string[] = [];
  if (summary.general && summary.personal && summary.personal.score < summary.general.score) {
    failures.push(`the personal instructions score below the general ones (${summary.personal.score} < ${summary.general.score}): keep them off until they win`);
  }
  if (existsSync(baselineFile) && !pick) {
    const base = JSON.parse(readFileSync(baselineFile, "utf8")) as { summary: Partial<Record<Condition, Summary>> };
    for (const c of conditions) {
      const was = base.summary[c]?.score;
      if (was !== undefined && summary[c].score < was - 1) failures.push(`${c} scores ${summary[c].score}, the baseline ${was}`);
    }
  }
  for (const f of failures) console.error(`eval failed: ${f}`);
  return failures.length ? 1 : 0;
}

process.exit(await main());
