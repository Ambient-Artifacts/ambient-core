// The consolidation eval: what does the nightly team job write from a day's notes? The real
// `consolidate()`, with its decision and overview steps, runs over a batch of new notes on top
// of the placement eval's fixture wiki, with the model the job uses; plain code checks the
// pages it wrote against cases.ts.
//
//   npm run eval:consolidation                        compared with eval/consolidation/baseline.json
//   npm run eval:consolidation -- --update-baseline   this run becomes the baseline
//   npm run eval:consolidation -- --judge [n]         also has a model check n current-truth lines (20) against their notes
//   EVAL_MODEL=claude-haiku-5-5 npm run eval:consolidation
//
// It fails (exit 1) when the total falls more than 0.1 below the baseline (one case in a small
// category, since answers vary from run to run). Without ANTHROPIC_API_KEY it says so and exits 0.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "../../team/src/consolidate.ts";
import { AnthropicDecisionFiler, AnthropicEntityFinder, AnthropicOverviewWriter, AnthropicUpdater, DEFAULT_MODEL } from "../../team/src/anthropic.ts";
import { runNight, score, summarize, written, type Summary } from "./harness.ts";
import { judge, type Judged } from "./judge.ts";

const HERE = import.meta.dirname;
/** The nightly job's own model (team/src/anthropic.ts), unless EVAL_MODEL says otherwise. */
const MODEL = process.env.EVAL_MODEL ?? DEFAULT_MODEL;
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "claude-sonnet-5-5";
const TOLERANCE = 0.1;
const args = process.argv.slice(2);
const at = args.indexOf("--judge");
const judgeLines = at < 0 ? 0 : Number(args[at + 1]) > 0 ? Number(args[at + 1]) : 20;

/** USD per million tokens, 2026-10. A model not listed gets its tokens reported without a price. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
};
const usd = (model: string, u: Usage) => {
  const p = PRICES[model];
  return p ? (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_tokens * p.cacheRead) / 1_000_000 : null;
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log("eval:consolidation: ANTHROPIC_API_KEY is not set; nothing run.");
    return 0;
  }
  const night = await runNight({
    pages: new AnthropicUpdater(key, MODEL),
    decisions: new AnthropicDecisionFiler(key, MODEL),
    finder: new AnthropicEntityFinder(key, MODEL),
    overview: new AnthropicOverviewWriter(key, MODEL),
  });
  try {
    const results = score(night.before, night.after);
    for (const r of results) console.log(`${r.category.padEnd(18)} ${r.id.padEnd(4)} ${r.pass ? "pass" : "FAIL"}  ${r.detail}`);
    for (const c of night.result.checks.filter((c) => !c.ok)) console.log(`job check ${c.name}: ${c.detail}`);
    for (const d of night.dropped) console.log(`dropped timeline   ${d.page}: note "${d.note}" (${d.date}): ${d.fact.slice(0, 100)}`);
    const summary = summarize(results);

    let judged: Judged | null = null;
    if (judgeLines) {
      judged = await judge(new Anthropic({ apiKey: key, maxRetries: 4 }), JUDGE_MODEL, night.before, night.after, judgeLines);
      for (const v of judged.verdicts.filter((v) => !v.supported)) console.log(`unsupported        ${v.page}: "${v.line}" (${v.reason})`);
    }

    const spend = [
      ...Object.entries(night.tally).map(([step, t]) => ({ step, model: t.model, calls: t.calls, usage: t.usage, usd: usd(t.model, t.usage) })),
      ...(judged ? [{ step: "judge", model: judged.model, calls: judged.calls, usage: judged.usage, usd: usd(judged.model, judged.usage) }] : []),
    ];
    const tokens = spend.reduce((t, s) => ({ input: t.input + s.usage.input_tokens, output: t.output + s.usage.output_tokens }), { input: 0, output: 0 });
    const cost = spend.every((s) => s.usd !== null) ? spend.reduce((t, s) => t + s.usd!, 0) : null;

    console.log("");
    for (const [cat, s] of Object.entries(summary.categories)) console.log(`${cat.padEnd(18)} ${`${s.passed}/${s.of}`.padEnd(6)} ${pct(s.score)}`);
    console.log(`${"total".padEnd(18)} ${"".padEnd(6)} ${pct(summary.total)}`);
    if (judged) console.log(`support (${judged.model}): ${judged.supported} of ${judged.verdicts.length} sampled lines supported, ${judged.unsupported} unsupported`);
    console.log(`model ${MODEL} · ${spend.reduce((t, s) => t + s.calls, 0)} calls · ${tokens.input} input and ${tokens.output} output tokens${cost === null ? "" : ` · $${cost.toFixed(3)}`}`);

    const out = {
      model: MODEL,
      at: new Date().toISOString(),
      summary,
      results,
      checks: night.result.checks,
      dropped: night.dropped,
      spend,
      cost,
      judge: judged,
      pages: written(night.before, night.after),
    };
    mkdirSync(join(HERE, "..", "out"), { recursive: true });
    writeFileSync(join(HERE, "..", "out", "consolidation-latest.json"), JSON.stringify(out, null, 2));

    const baselineFile = join(HERE, "baseline.json");
    if (args.includes("--update-baseline")) {
      writeFileSync(baselineFile, `${JSON.stringify({ model: MODEL, at: out.at, summary }, null, 2)}\n`);
      console.log("baseline updated");
      return 0;
    }
    if (!existsSync(baselineFile)) return 0;
    const base = JSON.parse(readFileSync(baselineFile, "utf8")) as { model: string; summary: Summary };
    const fixed = base.summary.failed.filter((id) => !summary.failed.includes(id));
    const broke = summary.failed.filter((id) => !base.summary.failed.includes(id));
    if (fixed.length) console.log(`passing now, failing in the baseline: ${fixed.join(", ")}`);
    if (broke.length) console.log(`failing now, passing in the baseline: ${broke.join(", ")}`);
    if (base.model !== MODEL) console.log(`the baseline is for ${base.model}`);
    if (summary.total < base.summary.total - TOLERANCE) {
      console.error(`eval failed: the total is ${pct(summary.total)}, the baseline ${pct(base.summary.total)}`);
      return 1;
    }
    return 0;
  } finally {
    rmSync(night.root, { recursive: true, force: true });
  }
}

process.exit(await main());
