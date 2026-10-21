// Work-session notes filed under notes/ before they had their own folder move to sessions/,
// in one commit. Runs when the team server starts; does nothing once they've moved.
import type { TeamWiki } from "./wiki.ts";

export async function moveSessionNotes(wiki: TeamWiki): Promise<number> {
  if (wiki.remote?.readOnly || wiki.fence) return 0;  // the repo is another tool's: nothing to move here
  const legacy = wiki.store.ofType("note").filter((p) => p.path.startsWith("notes/") && p.frontmatter.kind === "session");
  if (!legacy.length) return 0;
  await wiki.write(async (put, remove) => {
    for (const p of legacy) {
      await put(p.path.replace(/^notes\//, "sessions/"), wiki.read(p.path));
      await remove(p.path);
    }
    return { message: `move: ${legacy.length} work session(s) to sessions/`, result: {} };
  });
  return legacy.length;
}
