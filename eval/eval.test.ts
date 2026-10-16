// The eval's own checks, without a model: the graders, and that an app connecting to the
// fixture gets Ambient's read tools and (in the personal condition) who the user is.
import { describe, expect, it } from "vitest";
import { connect, summarize, type Result } from "./harness.ts";
import { grade, QUESTIONS } from "./questions.ts";

const q = (id: string) => QUESTIONS.find((x) => x.id === id)!;

describe("graders", () => {
  it("score answers that have the facts, and only those", () => {
    expect(grade(q("q3"), "We chose Datacore ERP because the licences were about 30% cheaper.").correct).toBe(true);
    expect(grade(q("q3"), "We chose SAP Business One.").correct).toBe(false);
    expect(grade(q("q4"), "Der Shop geht am 15. März 2027 live.").correct).toBe(true);
    expect(grade(q("q6"), "He promised an offer with tiered prices by 2026-10-17.").correct).toBe(true);
    expect(grade(q("q6"), "Tobias versprach ein Angebot mit Staffelpreisen. Er muss es bis 17.10.2026 senden.").correct).toBe(true);
  });

  it("fail an intro with placeholders, pass one with the facts", () => {
    expect(grade(q("q8"), "Hi, I'm [Your Name], [your role] at [Company].").correct).toBe(false);
    expect(grade(q("q8"), "Hi, I'm Mara Huber, Head of Operations at Kessler Werkzeuge in Graz.").correct).toBe(true);
  });

  it("want an honest 'nothing found' for what the wiki doesn't hold", () => {
    expect(grade(q("q9"), "I couldn't find anything about Hofmann Logistik in your notes.").correct).toBe(true);
    expect(grade(q("q9"), "The Hofmann Logistik deal is for 200 units.").correct).toBe(false);
    expect(grade(q("q10"), "Your wiki doesn't mention when Lea joined.").correct).toBe(true);
    expect(grade(q("q10"), "Lea joined in 2021.").correct).toBe(false);
    // German abstentions count too (a real Sonnet 5.5 answer).
    expect(grade(q("q10"), "Ich habe kein Eintrittsdatum für Lea Novak gefunden. In Ambient, Gmail und Google Drive steht dazu nichts.").correct).toBe(true);
    expect(grade(q("q9"), "Zu Hofmann Logistik steht in deinen Notizen nichts.").correct).toBe(true);
    // Abstaining and naming a real deal next to it is right; inventing Hofmann numbers isn't.
    expect(grade(q("q9"), "I couldn't find anything on Hofmann Logistik. The wiki has Steiner Bau: about 300 units a year.").correct).toBe(true);
    expect(grade(q("q9"), "I couldn't find much, but Hofmann Logistik wants 120 units.").correct).toBe(false);
    expect(grade(q("q10"), "The wiki doesn't say when Lea joined; she has led the shop since the review on 2026-10-06.").correct).toBe(true);
  });

  it("count a wrong answer against precision and an abstention against recall only", () => {
    const r = (id: string, correct: boolean, abstained: boolean, tools: string[] = []): Result => ({ id, kind: q(id).kind, condition: "general", correct, abstained, tools, answer: "", inputTokens: 0, outputTokens: 0 });
    const s = summarize([r("q1", true, false, ["brief"]), r("q2", false, true, ["web_search"]), r("q3", false, false, ["search"]), r("q9", true, true, ["gmail_search", "search"])]);
    expect(s).toEqual({ score: 2, of: 4, recall: 1 / 3, precision: 1 / 2, looked: 3, abstainedRight: 1 });
  });
});

describe("the connection an app gets", () => {
  it("has the read tools, and the personal condition says who the user is and what the wikis hold", async () => {
    const general = await connect("general");
    expect(general.tools.map((t) => t.name).sort()).toEqual(["brief", "fetch", "get_entity", "index", "list_action_items", "list_decisions", "list_recent", "search", "transcript"]);
    expect(general.instructions).not.toContain("## About the user");
    const personal = await connect("personal");
    expect(personal.instructions).toContain("Name: Mara Huber.");
    expect(personal.instructions).toContain('The Kessler Werkzeuge team wiki (scope "team", team "kessler")');
    expect(personal.instructions).toContain("People: ");
    expect(personal.instructions).not.toMatch(/People: [^.]*Mara Huber/);
    await general.client.close();
    await personal.client.close();
  });
});
