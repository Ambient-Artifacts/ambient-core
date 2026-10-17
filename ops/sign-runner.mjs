#!/usr/bin/env node
// Signs runner/ambient-runner.mjs for the runners' self-update (they install only a release signed
// with a key in their RUNNER_KEYS). Run it after every change to the runner and commit the .sig;
// a test fails while the signature doesn't match. The private key stays on the machine that
// releases (never in the repo, never on the gateway):
//   node ops/sign-runner.mjs                                  # key: ~/.brain-secrets/runner-signing-key.pem
//   AMBIENT_RUNNER_SIGNING_KEY=/path/to/key.pem node ops/sign-runner.mjs
// A new key: generate an Ed25519 pair, add its public key (SPKI, base64) to RUNNER_KEYS, and sign
// that runner with the old key once, so computers on the old runner accept the change.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "runner", "ambient-runner.mjs");
const keyPath = process.env.AMBIENT_RUNNER_SIGNING_KEY ?? join(homedir(), ".brain-secrets", "runner-signing-key.pem");
// As the runner checks it: the server line blanked, since each gateway writes its own address there.
const canonical = readFileSync(runner, "utf8").replace(/const DEFAULT_SERVER = "[^"]*";/, 'const DEFAULT_SERVER = "";');
const signature = sign(null, Buffer.from(canonical, "utf8"), createPrivateKey(readFileSync(keyPath))).toString("base64");
writeFileSync(`${runner}.sig`, `${signature}\n`);
console.log(`Signed ${runner} → ambient-runner.mjs.sig`);
