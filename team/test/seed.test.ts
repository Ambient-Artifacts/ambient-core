// Day-one seeding: a new team's wiki starts with what its company's website says. Only public
// websites are read, only the people the site names as staff get pages, and real pages are
// never overwritten by a guess from the website.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoteFrontmatter, parsePage, renderPage } from "@brain/spec";
import { consolidate, type PageUpdater } from "../src/consolidate.ts";
import { headParts } from "../src/head.ts";
import { htmlText, isPublicAddress, normalizeResearch, readSite, seedTeam, siteHost, siteLinks, type SiteResearcher } from "../src/seed.ts";
import { TeamWiki } from "../src/wiki.ts";

const HOME = `<html><head><title>Bergmann</title><style>.x{}</style><script>alert("x")</script></head><body>
<nav><a href="/ueber-uns">Über uns</a> <a href="/team">Team</a> <a href="https://other.example/about">Partner</a>
<a href="/impressum">Impressum</a> <a href="/produkte/flotte">Flotte</a> <a href="/brochure.pdf">PDF</a> <a href="/blog/post-1">Blog</a></nav>
<h1>Bergmann Logistik</h1><p>Wir bewegen Paletten &amp; Pakete &ndash; seit 1990.</p></body></html>`;

const SITE: Record<string, string> = {
  "https://www.bergmann.example/": HOME,
  "https://www.bergmann.example/ueber-uns": `<p>${"Bergmann Logistik ist ein Familienunternehmen aus Linz. ".repeat(6)}</p>`,
  "https://www.bergmann.example/team": `<p>${"Petra Schäfer, Geschäftsführerin. Jonas Becker, Vertrieb. ".repeat(5)}</p>`,
  "https://www.bergmann.example/produkte/flotte": `<p>${"Flotte: Software für Fuhrparks. ".repeat(10)}</p>`,
  "https://www.bergmann.example/impressum": `<p>${"Impressum Bergmann Logistik GmbH, Linz. ".repeat(8)}</p>`,
};

const fakeFetch = async (url: string) => (SITE[url] ? { url, html: SITE[url]! } : null);

class FakeResearcher implements SiteResearcher {
  model = "claude-haiku-4-5";
  inputs: { domain: string; pages: { url: string; text: string }[] }[] = [];
  async research(input: { domain: string; pages: { url: string; text: string }[] }) {
    this.inputs.push(input);
    return {
      research: {
        org: { name: "Bergmann Logistik", aliases: ["Bergmann"], summary: "Familienunternehmen für Logistik aus Linz.", what: ["Bewegt Paletten und Pakete."] },
        people: [
          { name: "Petra Schäfer", role: "Geschäftsführerin" },
          { name: "Jonas Becker", role: "Vertrieb" },
          { name: "Petra Schäfer", role: "duplicate" },
          { name: "Max (unser Fahrer des Monats)", role: "Fahrer" },
          { name: "Klaus", role: "Lager" },
        ],
        products: [{ name: "Flotte", summary: "Software für Fuhrparks.", what: ["Plant Touren."] }],
        language: "de",
      },
      usage: { input_tokens: 5000, output_tokens: 400, cache_read_tokens: 0 },
    };
  }
}

describe("which websites", () => {
  it("reads public websites only", () => {
    expect(siteHost("bergmann.example")).toBe("bergmann.example");
    expect(siteHost("https://www.Bergmann.example/ueber-uns")).toBe("www.bergmann.example");
    for (const bad of ["localhost", "10.0.0.1", "[::1]", "intranet.local", "bergmann.example:8080", "ftp://bergmann.example", "server"]) {
      expect(() => siteHost(bad), bad).toThrow();
    }
  });

  it("tells public addresses from private ones", () => {
    for (const ip of ["8.8.8.8", "2a00:1450:4001:81a::200e", "193.170.0.1"]) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe("reading the site", () => {
  it("keeps the text, not the markup", () => {
    const text = htmlText(HOME);
    expect(text).toContain("Bergmann Logistik");
    expect(text).toContain("Wir bewegen Paletten & Pakete – seit 1990.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".x{}");
  });

  it("follows the about, team and product links on the same site, the legal pages last", () => {
    const links = siteLinks(HOME, "https://www.bergmann.example/");
    expect(links).toEqual([
      "https://www.bergmann.example/ueber-uns",
      "https://www.bergmann.example/team",
      "https://www.bergmann.example/produkte/flotte",
      "https://www.bergmann.example/impressum",
    ]);
  });

  it("reads the home page and the pages worth reading", async () => {
    const pages = await readSite("www.bergmann.example", { fetch: fakeFetch, maxPages: 4 });
    expect(pages.map((p) => p.url)).toEqual([
      "https://www.bergmann.example/",
      "https://www.bergmann.example/ueber-uns",
      "https://www.bergmann.example/team",
      "https://www.bergmann.example/produkte/flotte",
    ]);
    await expect(readSite("nothing.example", { fetch: fakeFetch })).rejects.toThrow("didn't return a web page");
  });
});

describe("what the model found", () => {
  it("keeps people with full names, once, and drops descriptions", async () => {
    const r = normalizeResearch((await new FakeResearcher().research({ domain: "x", pages: [] })).research);
    expect(r.people.map((p) => p.name)).toEqual(["Petra Schäfer", "Jonas Becker"]);
    expect(r.language).toBe("de");
  });
});

describe("seeding a team", () => {
  it("writes the website note and the pages in their sections, and leaves real pages alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-seed-"));
    const wiki = await TeamWiki.open(join(dir, "wiki"), "t_berg", "Bergmann");
    const real = renderPage({
      frontmatter: { title: "Jonas Becker", type: "person", summary: "Runs sales.", aliases: [], update_mode: "compiled", status: "active", updated: "2026-10-01" },
      body: "\n# Jonas Becker\n\n### Who they are\n- Runs sales since 2019.\n\n## Timeline\n",
    });
    await wiki.write(async (put) => {
      await put("people/jonas-becker.md", real);
      return { message: "test: a real page", result: {} };
    });
    const researcher = new FakeResearcher();
    const out = await seedTeam(wiki, researcher, { domain: "https://www.bergmann.example", outDir: join(dir, "out"), fetch: fakeFetch, today: "2026-10-15", now: new Date("2026-10-15T09:00:00Z") });

    expect(researcher.inputs[0]!.domain).toBe("www.bergmann.example");
    expect(out.created.sort()).toEqual(["orgs/bergmann-logistik", "people/petra-schaefer", "projects/flotte"]);
    expect(out.skipped).toEqual(["people/jonas-becker"]);
    expect(out.commit).toBeTruthy();

    const note = parsePage(readFileSync(join(wiki.dir, out.note), "utf8"));
    expect(NoteFrontmatter.safeParse(note.frontmatter).success).toBe(true);
    expect(note.frontmatter).toMatchObject({ source: "web-research", orgs: ["orgs/bergmann-logistik"], people: ["people/petra-schaefer", "people/jonas-becker"], projects: ["projects/flotte"] });
    expect(note.frontmatter.sources).toContain("https://www.bergmann.example/team");
    expect(note.body).toContain("## Leute\n- Petra Schäfer: Geschäftsführerin");

    const petra = parsePage(readFileSync(join(wiki.dir, "people/petra-schaefer.md"), "utf8"));
    expect(petra.frontmatter).toMatchObject({ type: "person", source: "web-research", summary: "Geschäftsführerin bei Bergmann Logistik." });
    expect(headParts(petra.body).sections.map((s) => s.heading)).toEqual(["Who they are", "Relationship"]);
    expect(petra.body).toMatch(/- 2026-10-15: Auf der Website von Bergmann Logistik genannt als Geschäftsführerin\. \(\[note\]\(\.\.\/notes\/2026-10\/2026-10-15-bergmann-logistik-website-[a-z0-9]{6}\.md\)\)/);
    const org = readFileSync(join(wiki.dir, "orgs/bergmann-logistik.md"), "utf8");
    expect(org).toContain("### Key people\n- [Petra Schäfer](../people/petra-schaefer.md), Geschäftsführerin");
    expect(readFileSync(join(wiki.dir, "people/jonas-becker.md"), "utf8")).toBe(real);
    expect(wiki.store.lint().counts.broken_link).toBe(0);

    // The nightly job doesn't redo the note, and the first overview gets written.
    const updater: PageUpdater = { model: "claude-haiku-4-5", update: async () => { throw new Error("no page should be updated"); } };
    let overviews = 0;
    const r = await consolidate(wiki, updater, {
      outDir: join(dir, "out"),
      version: "test",
      forceOverview: true,
      overview: { model: "claude-haiku-4-5", write: async () => (overviews++, { overview: { headline: "Bergmann.", now: [], activeProjects: [], keyPeople: [], openLoops: [], recentDecisions: [] }, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 } }) },
    });
    expect(r.input.notes).toBe(0);
    expect(overviews).toBe(1);
    expect(existsSync(join(wiki.dir, "overview.md"))).toBe(true);
  });
});
