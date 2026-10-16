#!/usr/bin/env node
// Prints a fresh gateway env block. Store it in your password manager and on
// the core VM at /etc/brain/gateway.env (root:brain 0640). Never commit it.
//   node ops/gen-secrets.mjs > gateway.env
//   node ops/gen-secrets.mjs --env     only the secrets, for Docker's .env (ops/docker/init.sh)
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = { ...(await exportJWK(privateKey)), alg: "ES256", use: "sig", kid: `es256-${Date.now().toString(36)}` };

const secrets = `BRAIN_SIGNING_JWKS='${JSON.stringify({ keys: [jwk] })}'
BRAIN_COOKIE_KEYS=${randomBytes(32).toString("base64url")}
BRAIN_MASTER_KEY_ID=mk1
BRAIN_MASTER_KEY=${randomBytes(32).toString("base64")}
BRAIN_SERVICE_SECRET=${randomBytes(32).toString("hex")}`;

if (process.argv.includes("--env")) {
  console.log(secrets);
} else {
  console.log(`# Brain gateway secrets, generated ${new Date().toISOString()}
${secrets}
# Fill these in:
BRAIN_ORIGIN=https://mcp.example.com
CONVEX_URL=https://<deployment>.eu-west-1.convex.cloud
BRAIN_APPLE_AUDIENCES=com.example.brain
PORT=8080`);
  console.error("Also run: npx convex env set BRAIN_SERVICE_SECRET <the value above>  (in control/, against the prod deployment)");
  console.error("Losing BRAIN_MASTER_KEY makes every stored personal page unreadable. Back it up.");
}
