// Ten questions a member of a small company asks their AI, over the fixture team wiki (a
// fictional 12-person tool maker in Graz). None mentions Ambient: whether the model looks there
// on its own is part of what's measured. Graded on the final answer, with plain patterns.

export interface Question {
  id: string;
  kind: "person" | "decision" | "project" | "action" | "me" | "negative";
  ask: string;
  /** Every pattern must be in the answer. */
  expect?: RegExp[];
  /** None of these may be: placeholders, invented facts. */
  forbid?: RegExp[];
  /** The wiki has nothing on it: the right answer says so. */
  abstain?: boolean;
}

/** Saying the wiki has nothing on it, in English or German. */
export const ABSTAINS =
  /(no (information|record|notes?|mention|data|details|entries)|nothing (about|on|in|for)|not (find|found|in (the|your|ambient))|couldn'?t find|can'?t find|could not find|don'?t (have|see|know)|do not (have|see)|(doesn'?t|does not) (say|mention|include|contain|have)|not (mentioned|recorded|listed|stated|documented)|isn'?t (mentioned|recorded|in)|keine (Informationen|Einträge|Notizen|Angaben)|nichts (zu|über|gefunden)|nicht (gefunden|vermerkt|erwähnt|dokumentiert)|kein(e|en|er)? [\p{L}-]+ (gefunden|vermerkt|erwähnt)|steht\b[^.]{0,40}\bnichts|(dazu|darüber) (steht|gibt es|habe ich) (nichts|keine))/iu;

export const QUESTIONS: Question[] = [
  { id: "q1", kind: "person", ask: "Who is Tobias Brandl and what is he working on at the moment?", expect: [/sales|vertrieb/i, /steiner/i] },
  { id: "q2", kind: "person", ask: "Who's our contact person at Steiner Bau?", expect: [/ines steiner/i] },
  { id: "q3", kind: "decision", ask: "Which ERP system did we choose, and why?", expect: [/datacore/i, /(cheap|price|licen[cs]|günstig|30 ?%|support)/i] },
  { id: "q4", kind: "project", ask: "Wann geht der neue Shop jetzt live?", expect: [/(2027-03-15|15\.? ?(märz|march|mar\.?) 2027|march 15,? 2027|15\.0?3\.2027)/i] },
  {
    id: "q5",
    kind: "project",
    ask: "What's the status of our ERP switch?",
    expect: [/datacore/i, /(2027-01-11|11\.? ?(jan|jän)\w* 2027|january 11|jan(uary)?\.? 11|11 jan(uary)?|2026-11-02|november 2|2\.? ?nov|2 nov)/i],
  },
  { id: "q6", kind: "action", ask: "What did Tobias promise Steiner Bau, and by when?", expect: [/(offer|angebot|quote|quotation)/i, /(2026-10-17|17\.? ?(okt|oct)\w*|october 17|oct\.? 17|17 oct|17\.\s?10\.|17th of october)/i] },
  {
    id: "q7",
    kind: "decision",
    ask: "What did we decide on the call with Steiner Bau on 8 October?",
    expect: [/(annual minimum|minimum (annual )?(volume|quantity|purchase)|jahresabnahme|fixed annual|mindestabnahme|per year commitment|annual (purchase|volume|commitment)|committed (annual|yearly)|yearly minimum)/i],
  },
  {
    id: "q8",
    kind: "me",
    ask: "Write two sentences introducing me to the team at Steiner Bau.",
    expect: [/mara/i, /(operations|betrieb|kessler)/i],
    forbid: [/\[[^\]]*(name|role|title|company|your|ihr|position)[^\]]*\]/i],
  },
  // Forbidden: facts invented about what the wiki doesn't hold (facts about other things it does hold are fine).
  { id: "q9", kind: "negative", ask: "What's the latest on our deal with Hofmann Logistik?", abstain: true, forbid: [/hofmann[^.\n]{0,80}\d+ (units|stück|drills|bohrer)/i] },
  { id: "q10", kind: "negative", ask: "When did Lea Novak join the company?", abstain: true, forbid: [/\b(lea|she|sie)\b[^.\n]{0,30}(joined|started|began|eingetreten|angefangen)[^.\n]{0,30}(19|20)\d\d/i] },
];

export interface Grade {
  correct: boolean;
  /** Said it doesn't know (right for negatives, a miss for the rest). */
  abstained: boolean;
}

export function grade(q: Question, answer: string): Grade {
  const abstained = ABSTAINS.test(answer);
  const forbidden = (q.forbid ?? []).some((p) => p.test(answer));
  if (q.abstain) return { correct: abstained && !forbidden, abstained };
  const found = (q.expect ?? []).every((p) => p.test(answer));
  return { correct: found && !forbidden, abstained: abstained && !found };
}
