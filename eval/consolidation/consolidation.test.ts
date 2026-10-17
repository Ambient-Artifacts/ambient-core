// The consolidation eval's own checks, without a model: the scorer on pages written by hand,
// and a whole night through the real consolidate() with stub steps.
import { rmSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import type { PageUpdater } from "../../team/src/consolidate.ts";
import { sectionsFor } from "../../team/src/consolidate.ts";
import type { DecisionFiler } from "../../team/src/decisions.ts";
import type { OverviewWriter } from "../../team/src/overview.ts";
import { NOTES } from "./cases.ts";
import { pages, runNight, score, summarize, type CaseResult } from "./harness.ts";

const HERE = import.meta.dirname;
const start = () => new Map([...pages(join(HERE, "..", "fixture")), ...pages(join(HERE, "batch"))]);
const byId = (rs: CaseResult[], id: string) => rs.find((r) => r.id === id)!;
const cite = (from: string, note: string) => `([note](${posix.relative(posix.dirname(from), note)}.md))`;

/** A living page as the nightly job writes it. */
function living(ref: string, type: string, lines: string[], timeline: string[]): string {
  const title = ref.split("/")[1]!;
  return `---\ntitle: ${title}\ntype: ${type}\nsummary: About ${title}.\nupdate_mode: compiled\nstatus: active\nupdated: 2026-10-17\n---\n# ${title}\n\n### Status\n${lines.map((l) => `- ${l}`).join("\n")}\n\n## Open questions\n- (none)\n\n## Timeline\n${timeline.join("\n")}\n`;
}

describe("the scorer", () => {
  const erp = "projects/erp-umstieg";
  const moved = `- 2026-10-14: Go-live moved from 2027-01-11 to 2027-02-01. ${cite(erp, NOTES.datacore)}`;

  it("wants a corrected fact replaced in the current truth and kept in the timeline", () => {
    const before = start();
    const right = new Map(before).set(erp, living(erp, "project", [`Go-live on 2027-02-01. ${cite(erp, NOTES.datacore)}`], [moved]));
    expect(byId(score(before, right), "s1").pass).toBe(true);
    const stale = new Map(before).set(erp, living(erp, "project", ["Go-live on 2027-02-01, after 2027-01-11 was dropped."], [moved]));
    expect(byId(score(before, stale), "s1").detail).toContain("still states the old value");
    const forgotten = new Map(before).set(erp, living(erp, "project", ["Go-live on 2027-02-01."], [`- 2026-10-14: New go-live date. ${cite(erp, NOTES.datacore)}`]));
    expect(byId(score(before, forgotten), "s1").detail).toContain("doesn't keep the old value");
  });

  it("wants every current-truth bullet of a written page to cite a note that exists", () => {
    const before = start();
    const cited = score(before, new Map(before).set(erp, living(erp, "project", [`Go-live on 2027-02-01. ${cite(erp, NOTES.datacore)}`], [moved])));
    expect(byId(cited, `l:${erp}`)).toMatchObject({ pass: true, detail: `${erp}: 1 of 1 bullets cite a note` });
    const bare = score(before, new Map(before).set(erp, living(erp, "project", ["Go-live on 2027-02-01.", `Owned by Mara. ${cite(erp, NOTES.datacore)}`], [moved])));
    expect(byId(bare, `l:${erp}`)).toMatchObject({ pass: false, detail: `${erp}: 1 of 2 bullets cite a note` });
    const invented = score(before, new Map(before).set(erp, living(erp, "project", [`Go-live on 2027-02-01. ${cite(erp, "notes/2026-10/2026-10-15-invented")}`], [moved])));
    expect(byId(invented, `l:${erp}`).detail).toContain("broken links to notes/2026-10/2026-10-15-invented");
    // Pages the run didn't write aren't judged.
    expect(cited.filter((r) => r.category === "link validity")).toHaveLength(1);
  });

  it("finds a new page by name, and counts a trivial or unexpected decision against precision", () => {
    const before = start();
    const org = "orgs/tellwerk";
    const decision = (title: string, source: string) =>
      `---\ntitle: ${title}\ntype: decision\nsummary: ${title}.\nstatus: accepted\ndate: 2026-10-15\ndeciders: []\naffects: []\nsource: ${source}\nupdated: 2026-10-17\n---\n# ${title}\n`;
    const after = new Map(before)
      .set(org, living(org, "org", [`Competitor from Munich. ${cite(org, NOTES.competitor)}`], [`- 2026-10-14: Researched as a competitor. ${cite(org, NOTES.competitor)}`]))
      .set("decisions/0004-tiered-prices", decision("Tiered prices for Steiner Bau", NOTES.offer))
      .set("decisions/0005-blue-cover-page", decision("Blue cover page for offers", NOTES.offer))
      .set("decisions/0006-new-coffee-machine", decision("New coffee machine", NOTES.fair));
    const rs = score(before, after);
    expect([byId(rs, "e2").pass, byId(rs, "f5").pass, byId(rs, "d1").pass]).toEqual([true, true, true]);
    expect(byId(rs, "d3")).toMatchObject({ pass: false, detail: "filed anyway as decisions/0005-blue-cover-page" });
    expect(byId(rs, "d0")).toMatchObject({ pass: false, detail: "unexpected: decisions/0006-new-coffee-machine" });
  });
});

describe("a night with stub steps", () => {
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 };
  /** Writes each note's summary as a bullet citing the note, and a timeline line per note. */
  const pagesStub: PageUpdater = {
    model: "stub",
    async update(input) {
      const lines = input.evidence.map((e) => `${e.summary} ${cite(input.ref, e.note)}`);
      const first = sectionsFor(input.type)[0];
      return {
        update: {
          title: input.existing?.title ?? input.ref.split("/")[1]!,
          summary: input.evidence[0]!.summary,
          aliases: [],
          ...(first ? { sections: { [first.key]: lines } } : { currentTruth: lines }),
          openQuestions: [],
          timeline: input.evidence.map((e) => ({ note: e.note, date: e.date, fact: e.title })),
        },
        usage,
      };
    },
  };
  /** Files every decision bullet, trivial or not. */
  const decisionsStub: DecisionFiler = {
    model: "stub",
    async file(input) {
      return { decisions: { decisions: input.note.decisions.map((d) => ({ significant: true, title: d.slice(0, 60), statement: d, affects: [], supersedes: null })) }, usage };
    },
  };
  const overviewStub: OverviewWriter = {
    model: "stub",
    async write() {
      return { overview: { headline: "Stub.", now: [], activeProjects: [], keyPeople: [], openLoops: [], recentDecisions: [] }, usage };
    },
  };

  it("runs the real job over the batch and scores what it wrote", async () => {
    const night = await runNight({ pages: pagesStub, decisions: decisionsStub, overview: overviewStub });
    try {
      expect(night.result.status).toBe("ok");
      // Ten pages are named in the batch's front matter; one note has a Decisions section.
      expect([night.tally.pages.calls, night.tally.decisions.calls, night.tally.overview.calls]).toEqual([10, 1, 1]);
      const results = score(night.before, night.after);
      const summary = summarize(results);
      expect(Object.fromEntries(Object.entries(summary.categories).map(([c, s]) => [c, s.of]))).toEqual({
        "entity recall": 7,
        "fact recall": 6,
        "decision recall": 2,
        "decision precision": 2,
        supersession: 2,
        untouched: 3,
        "link validity": 10,
      });
      expect(summary.failed.sort()).toEqual([
        // Known gap 1: the competitor note has no orgs, so no org page is asked for.
        "d2", // Known gap 2: the PayPal decision is in prose, so the filer never sees it.
        "d3", // The stub files the trivial cover-page choice.
        "e2",
        "f5",
        "s1", // The stub repeats the note's summary, which names the old go-live too.
        "s2",
        "u1", // The stub gives Jonas a timeline line for a meeting he only sat in on.
      ]);
      expect(results.filter((r) => r.category === "link validity").every((r) => r.pass)).toBe(true);
      expect(night.dropped).toEqual([]);
    } finally {
      rmSync(night.root, { recursive: true, force: true });
    }
  });

  it("reports timeline entries that name a note by its file name, which the job drops", async () => {
    // What Haiku 4.5 did on 2026-10-17 on pages that already had a timeline: it named the notes
    // the way the page's timeline links them, and repeated the existing lines.
    const byFileName: PageUpdater = {
      model: "stub",
      async update(input) {
        const r = await pagesStub.update(input);
        const u = r.update as { timeline: { note: string; date: string; fact: string }[] };
        const repeated = (input.existing?.timelineTail ?? []).map((l) => ({ note: /([^/]+)\.md\)\)$/.exec(l)![1]!, date: l.slice(2, 12), fact: "Repeated." }));
        return { ...r, update: { ...u, timeline: [...repeated, ...u.timeline.map((t) => ({ ...t, note: t.note.split("/").pop()! }))] } };
      },
    };
    const night = await runNight({ pages: byFileName, decisions: decisionsStub, overview: overviewStub });
    try {
      expect(night.dropped.filter((d) => d.page === "projects/erp-umstieg")).toEqual([
        { page: "projects/erp-umstieg", note: "2026-10-14-datacore-status-call-m1n2o3", date: "2026-10-14", fact: "Datacore status call" },
      ]);
      expect(byId(score(night.before, night.after), "e4")).toMatchObject({ pass: false, detail: `projects/erp-umstieg updated, but no timeline line links ${NOTES.datacore}` });
    } finally {
      rmSync(night.root, { recursive: true, force: true });
    }
  });
});
