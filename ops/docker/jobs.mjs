#!/usr/bin/env node
// The systemd timers in ops/systemd, for Docker: each job runs as its own process on its
// schedule, never twice at once. One container per role:
//   node ops/docker/jobs.mjs gateway   work sessions every minute, personal upkeep and repo sync
//                                      every 15 minutes, health every 30 minutes plus a daily summary,
//                                      and the hourly "Waiting on you" digest (it does nothing until
//                                      the APNs key is set, like brain-digest.timer)
//   node ops/docker/jobs.mjs team      the team wiki's nightly consolidation
// Times of day are in the container's time zone (TZ, default UTC).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const gateway = (...args) => ["gateway/src/worker/cli.ts", ...args];
const JOBS = {
  gateway: [
    { name: "sessions", everySec: 60, args: gateway("sessions") },
    { name: "personal", everySec: 15 * 60, args: gateway("personal") },
    { name: "health", everySec: 30 * 60, args: gateway("health") },
    { name: "health-daily", at: process.env.BRAIN_HEALTH_DAILY_AT || "08:25", args: gateway("health", "--daily") },
    { name: "digest", everySec: 60 * 60, args: gateway("digest") },
  ],
  team: [{ name: "consolidate", at: process.env.BRAIN_CONSOLIDATE_AT || "02:00", args: ["team/src/cli.ts", "consolidate"] }],
};

const role = process.argv[2];
const jobs = JOBS[role];
if (!jobs) {
  console.error(`usage: node ops/docker/jobs.mjs ${Object.keys(JOBS).join(" | ")}`);
  process.exit(2);
}

const state = new Map(jobs.map((j) => [j.name, { running: false, lastStart: 0, lastDay: "" }]));

function run(job) {
  const s = state.get(job.name);
  s.running = true;
  s.lastStart = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", ...job.args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (stream, out) => {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) out.write(`[${job.name}] ${line}\n`);
    });
    stream.on("end", () => rest && out.write(`[${job.name}] ${rest}\n`));
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on("close", (code) => {
    s.running = false;
    if (code !== 0) console.error(`[${job.name}] exited ${code}`);
  });
}

function tick() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const day = now.toDateString();
  for (const job of jobs) {
    const s = state.get(job.name);
    if (s.running) continue;
    if (job.everySec && Date.now() - s.lastStart >= job.everySec * 1000) run(job);
    if (job.at && hhmm === job.at && s.lastDay !== day) {
      s.lastDay = day;
      run(job);
    }
  }
}

console.log(`[jobs] ${role}: ${jobs.map((j) => `${j.name} ${j.everySec ? `every ${j.everySec}s` : `at ${j.at}`}`).join(", ")} (TZ ${process.env.TZ || "UTC"})`);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
tick();
setInterval(tick, 15_000);
