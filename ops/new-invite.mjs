#!/usr/bin/env node
// Creates an invite code for a team and stores only its hash in Convex.
//   node ops/new-invite.mjs acme [uses] [days]
// Run from the repo root with CONVEX_DEPLOY_KEY (or a logged-in convex CLI) for the target deployment.
import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";

const [slug, uses = "20", days = "14"] = process.argv.slice(2);
if (!slug) {
  console.error("usage: node ops/new-invite.mjs <team-slug> [uses] [days]");
  process.exit(2);
}
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
const code = `${slug.slice(0, 4).toUpperCase()}-${part()}-${part()}`;
const codeHash = createHash("sha256").update(`invite:${code}`).digest("hex");
execFileSync("npx", ["convex", "run", "teams:createInvite", JSON.stringify({ slug, codeHash, uses: Number(uses), days: Number(days) })], {
  cwd: new URL("../control/", import.meta.url).pathname,
  stdio: ["ignore", "inherit", "inherit"],
});
console.log(`Invite code for ${slug}: ${code}  (${uses} uses, ${days} days)`);
