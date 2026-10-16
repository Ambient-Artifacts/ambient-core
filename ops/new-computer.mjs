#!/usr/bin/env node
// Creates a one-time setup code for a routine computer, the way the app's "Connect a computer"
// does: for a user (found by email), or for a team's server (by the team's slug; replaces any
// earlier one, since a team has one server).
//   node ops/new-computer.mjs nikolai@example.com "Build server"
//   node ops/new-computer.mjs --team ambient
// Run from the repo root with CONVEX_DEPLOY_KEY (or a logged-in convex CLI) for the target deployment.
import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const team = args[0] === "--team" ? args[1] : undefined;
const email = team ? undefined : args[0];
const name = (team ? args[2] : args[1]) ?? (team ? "Team server" : "Server");
if (!email && !team) {
  console.error('usage: node ops/new-computer.mjs <email> ["<computer name>"]  |  node ops/new-computer.mjs --team <slug> ["<name>"]');
  process.exit(2);
}
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
const code = `${part()}-${part()}`;
const codeHash = createHash("sha256").update(`host-setup:${code}`).digest("hex");
const target = team ? { team } : { email };
execFileSync("npx", ["convex", "run", "routines:staffAddHost", JSON.stringify({ ...target, name, codeHash, expiresAt: Date.now() + 30 * 60_000 })], {
  cwd: new URL("../control/", import.meta.url).pathname,
  stdio: ["ignore", "ignore", "inherit"],
});
// The last line is the code alone, for scripts (ops/routines-team-server.sh).
console.error(`Setup code for ${team ? `team ${team}'s server` : `"${name}" (${email})`}, valid 30 minutes. On the computer: sudo node ambient-runner.mjs setup <code>`);
console.log(code);
