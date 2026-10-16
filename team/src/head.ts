// The part of a living page above its timeline: title, current truth (one list, or sections
// by kind of page) and open questions. Written by consolidation and the dedup pass alike.
import { splitCompiled } from "@brain/spec";

/** What a living page holds above its timeline. */
export interface Head {
  currentTruth: string[];
  sections: { heading: string; bullets: string[] }[];
  openQuestions: string[];
}

/** The head of a living page as markdown: title, current truth (in sections), open questions. */
export function renderHead(title: string, h: Head): string {
  const bullet = (b: string) => `- ${b.replace(/^\s*-\s*/, "")}`;
  const out = [`# ${title}`, ""];
  if (h.currentTruth.length) out.push(...h.currentTruth.map(bullet), "");
  for (const s of h.sections) out.push(`### ${s.heading}`, ...s.bullets.map(bullet), "");
  out.push("## Open questions", ...(h.openQuestions.length ? h.openQuestions.map((q) => `- ${q}`) : ["- (none)"]));
  return out.join("\n");
}

/** Read a living page's head back: bullets above any section, the sections, the open questions. */
export function headParts(body: string): Head {
  const out: Head = { currentTruth: [], sections: [], openQuestions: [] };
  let where: "flat" | "section" | "open" | "other" = "flat";
  for (const line of splitCompiled(body).currentTruth.split(/\r?\n/)) {
    if (/^# /.test(line)) continue;
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      out.sections.push({ heading: h3[1]!, bullets: [] });
      where = "section";
      continue;
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      where = h2[1]!.toLowerCase() === "open questions" ? "open" : "other";
      continue;
    }
    const b = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!b) continue;
    const text = b[1]!.trim();
    if (where === "flat") out.currentTruth.push(text);
    else if (where === "section") out.sections[out.sections.length - 1]!.bullets.push(text);
    else if (where === "open" && text !== "(none)") out.openQuestions.push(text);
  }
  out.sections = out.sections.filter((s) => s.bullets.length > 0);
  return out;
}

