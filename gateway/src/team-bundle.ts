// The team's brain for a team's own computer (docs/architecture.md, "A team on its own computer"):
// the team server and its nightly upkeep as one file, built from this checkout when it's first
// asked for (esbuild, which the gateway already has through tsx), and served at
// /runner/ambient-team.mjs. Its sha256 goes to team computers with their sync; the runner checks it
// before it runs the file, as an unprivileged user.
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface TeamBundle {
  source: Buffer;
  version: string;
  sha256: string;
}

export function teamBundler(root: string, version: string): () => Promise<TeamBundle> {
  let built: Promise<TeamBundle> | null = null;
  return () => {
    built ??= (async () => {
      const esbuild = await import("esbuild");
      const out = await esbuild.build({
        entryPoints: [join(root, "team", "src", "computer-main.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        // Node's own SQLite stands in for the native better-sqlite3 (team/src/sqlite-node.ts), so
        // the computer needs Node 22.13 or newer; the runner checks before it installs the brain.
        target: "node22",
        alias: { "better-sqlite3": join(root, "team", "src", "sqlite-node.ts") },
        write: false,
        legalComments: "none",
        // The bundle's own require, for the CommonJS parts of its dependencies.
        banner: { js: `// Ambient's team brain ${version}, built from ambient-core (MIT).\nimport { createRequire as __ambientRequire } from "node:module"; const require = __ambientRequire(import.meta.url);` },
        define: { "process.env.BRAIN_BUNDLE_VERSION": JSON.stringify(version) },
      });
      const source = Buffer.from(out.outputFiles[0]!.contents);
      return { source, version, sha256: createHash("sha256").update(source).digest("hex") };
    })().catch((err) => {
      built = null;
      throw err;
    });
    return built;
  };
}
