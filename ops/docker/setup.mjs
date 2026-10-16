#!/usr/bin/env node
// The one-shot `setup` service of docker-compose.yml, run on every `docker compose up` (safe to
// repeat): deploy the Convex functions to the self-hosted Convex backend, give them the gateway's
// service secret, and put this server's team servers in the pool.
//   CONVEX_SELF_HOSTED_URL, CONVEX_SELF_HOSTED_ADMIN_KEY   the backend and its admin key
//   BRAIN_SERVICE_SECRET                                   shared by the gateway and the functions
//   BRAIN_TEAM_SERVERS                                     e.g. "team-1=http://team:8090", comma-separated
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../control/convex/_generated/api.js";

const need = (key) => {
  const v = process.env[key];
  if (!v) {
    console.error(`[setup] ${key} is missing: run ops/docker/init.sh first, or see docs/self-hosting.md`);
    process.exit(1);
  }
  return v;
};
const url = need("CONVEX_SELF_HOSTED_URL").replace(/\/+$/, "");
need("CONVEX_SELF_HOSTED_ADMIN_KEY");
const secret = need("BRAIN_SERVICE_SECRET");
const control = fileURLToPath(new URL("../../control/", import.meta.url));

// 1. The backend is up.
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${url}/version`)).ok) break;
  } catch {}
  if (i === 60) {
    console.error(`[setup] Convex isn't answering at ${url}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

// 2. Functions and the secret. The CLI picks a cloud deployment over the self-hosted one when
//    these are set, so they go.
const env = { ...process.env };
delete env.CONVEX_DEPLOY_KEY;
delete env.CONVEX_DEPLOYMENT;
const convex = (args, input) => {
  const r = spawnSync("npx", ["convex", ...args], { cwd: control, env, input, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"] });
  if (r.status !== 0) {
    console.error(`[setup] npx convex ${args[0]} ${args[1] ?? ""} failed`);
    process.exit(1);
  }
};
console.log(`[setup] deploying the Convex functions to ${url}`);
convex(["deploy", "--yes", "--typecheck", "disable", "--codegen", "disable"]);
convex(["env", "set", "BRAIN_SERVICE_SECRET", "--force"], secret);

// 3. Team servers.
const client = new ConvexHttpClient(url);
for (const entry of (process.env.BRAIN_TEAM_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const [serverId, serverUrl] = entry.split("=");
  if (!serverId || !serverUrl) {
    console.error(`[setup] BRAIN_TEAM_SERVERS: "${entry}" isn't <id>=<url>`);
    process.exit(1);
  }
  const out = await client.mutation(api.admin.registerServer, { secret, serverId, url: serverUrl, now: Date.now() });
  console.log(`[setup] team server ${serverId} at ${serverUrl}: ${out.created ? "added to the pool" : out.status}`);
}
console.log("[setup] done");
