// The repo address people paste into the app: https only, to a public host, no credentials in
// it; pasted without a scheme, it's https. (203.0.113.0/24 is a documentation range: no DNS here.)
import { describe, expect, it } from "vitest";
import { checkRepoUrl } from "../src/index.ts";

describe("checkRepoUrl", () => {
  it("takes an address without a scheme as https", async () => {
    expect(await checkRepoUrl("203.0.113.5/acme/wiki/_git/wiki")).toBe("https://203.0.113.5/acme/wiki/_git/wiki");
    expect(await checkRepoUrl("  https://203.0.113.5/acme/wiki.git ")).toBe("https://203.0.113.5/acme/wiki.git");
    // Still a private address once it's https.
    await expect(checkRepoUrl("10.0.0.5/acme/wiki.git")).rejects.toMatchObject({ code: "bad_url", message: "That address isn't reachable from Ambient." });
  });

  it("refuses other schemes and credentials in the URL", async () => {
    for (const bad of ["http://203.0.113.5/acme/wiki.git", "ssh://203.0.113.5/acme/wiki.git", "file:///tmp/wiki.git"]) {
      await expect(checkRepoUrl(bad), bad).rejects.toMatchObject({ code: "bad_url", message: "Use the repo's https:// address." });
    }
    for (const bad of ["user:secret@203.0.113.5/acme/wiki.git", "https://user:secret@203.0.113.5/acme/wiki.git"]) {
      await expect(checkRepoUrl(bad), bad).rejects.toMatchObject({ code: "bad_url", message: "Put the token in the token field, not in the URL." });
    }
    await expect(checkRepoUrl("")).rejects.toMatchObject({ code: "bad_url", message: "That isn't a valid URL." });
  });
});
