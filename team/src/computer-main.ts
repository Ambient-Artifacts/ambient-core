// The team's brain on the team's own computer (docs/architecture.md, "A team on its own computer"):
// one file, built by the gateway (gateway/src/team-bundle.ts), installed and kept current by the
// runner there.
//   node ambient-team.mjs serve        the team server, on 127.0.0.1 only (ambient-team.service)
//   node ambient-team.mjs consolidate  the nightly upkeep, with the computer's Claude (ambient-team-upkeep.timer)
//   node ambient-team.mjs version
const cmd = process.argv[2];
if (cmd === "serve") await import("./server.ts");
else if (cmd === "consolidate") await import("./cli.ts");
else if (cmd === "version") console.log(process.env.BRAIN_VERSION ?? "unknown");
else {
  console.error("usage: ambient-team.mjs serve | consolidate | version");
  process.exit(2);
}
