// Entry point of the admin CLI (see admin.ts): node --import tsx gateway/src/admin-cli.ts <command>
import { ConvexHttpClient } from "convex/browser";
import { AdminError, runAdmin } from "./admin.ts";
import { loadConfig } from "./config.ts";
import { Control } from "./control.ts";

const config = loadConfig();
const convex = new ConvexHttpClient(config.convexUrl);
const control = new Control({ query: (fn, args) => convex.query(fn, args), mutation: (fn, args) => convex.mutation(fn, args) }, config.serviceSecret);

// A repo's access token comes on stdin (never as an argument).
const readSecret = async () => {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

try {
  console.log(await runAdmin(process.argv.slice(2), { config, control, readSecret }));
} catch (err) {
  console.error(err instanceof AdminError ? err.message : err);
  process.exit(err instanceof AdminError ? 2 : 1);
}
