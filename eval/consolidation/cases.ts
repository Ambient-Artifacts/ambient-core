// What the nightly team consolidation should make of the batch in batch/: five new notes on top
// of the placement eval's fixture wiki (a fictional 12-person tool maker in Graz). Each case is
// one outcome a teammate would expect the morning after, checked with plain patterns over the
// pages the run wrote. Two cases are known to fail today (README, "Known gaps").

export type Category = "entity recall" | "fact recall" | "decision recall" | "decision precision" | "supersession" | "untouched" | "link validity";

export const CATEGORIES: Category[] = ["entity recall", "fact recall", "decision recall", "decision precision", "supersession", "untouched", "link validity"];

/** A living page by ref, or (for a page whose slug isn't known in advance) by folder and name. */
export type PageRef = string | { folder: "people" | "orgs" | "projects" | "topics"; name: RegExp };

export type Case =
  /** The page exists afterwards and its timeline links the note: the note was folded in. */
  | { id: string; kind: "entity"; page: PageRef; note: string; why: string }
  /** Every pattern is in the page's summary or current truth. */
  | { id: string; kind: "fact"; page: PageRef; expect: RegExp[]; why: string }
  /**
   * A new decision page sourced from the note and matching the pattern exists (`exists: true`,
   * recall) or doesn't (`exists: false`, precision).
   */
  | { id: string; kind: "decision"; note: string; match: RegExp; exists: boolean; why: string }
  /**
   * The page's current truth no longer states `was` (and states `now`, when given); with
   * `inTimeline`, `was` is kept in the timeline, so the change stays on record.
   */
  | { id: string; kind: "supersession"; page: string; now?: RegExp; was: RegExp; inTimeline: boolean; why: string }
  /**
   * `identical`: every page listed is byte for byte as before. Otherwise the page may be
   * rewritten but gains no timeline line, keeps `keep` and states nothing in `forbid`.
   */
  | { id: string; kind: "untouched"; pages: string[]; identical: true; why: string }
  | { id: string; kind: "untouched"; pages: [string]; identical: false; keep: RegExp[]; forbid: RegExp[]; why: string };

/** The batch, by note ref. */
export const NOTES = {
  datacore: "notes/2026-10/2026-10-14-datacore-status-call-m1n2o3",
  competitor: "sessions/2026-10/2026-10-14-competitor-research-tellwerk-akkutechnik-p4q5r6",
  offer: "notes/2026-10/2026-10-15-offer-review-steiner-bau-s7t8u9",
  checkout: "sessions/2026-10/2026-10-16-checkout-scope-for-the-shop-launch-v1w2x3",
  fair: "notes/2026-10/2026-10-16-trade-fair-planning-y4z5a6",
} as const;

const TELLWERK = { folder: "orgs", name: /tellwerk/i } as const;
const GO_LIVE_NEW = /(2027-02-01|1\.? ?(feb|februar|february) 2027|february 1,? 2027|01\.02\.2027)/i;
const GO_LIVE_OLD = /(2027-01-11|11\.? ?(jan|jän|januar|january) 2027|january 11,? 2027|11\.01\.2027)/i;

export const CASES: Case[] = [
  // Pages the batch should create or update.
  { id: "e1", kind: "entity", page: "people/stefan-koller", note: NOTES.datacore, why: "a new person named in a meeting note's front matter gets a page" },
  { id: "e2", kind: "entity", page: TELLWERK, note: NOTES.competitor, why: "a competitor an AI-app work note is about gets an org page (the note's orgs are empty)" },
  { id: "e3", kind: "entity", page: "topics/werkzeugtage-2027", note: NOTES.fair, why: "a new topic named in front matter gets a page" },
  { id: "e4", kind: "entity", page: "projects/erp-umstieg", note: NOTES.datacore, why: "the ERP project takes in the status call" },
  { id: "e5", kind: "entity", page: "orgs/datacore", note: NOTES.datacore, why: "the vendor takes in the status call" },
  { id: "e6", kind: "entity", page: "orgs/steiner-bau", note: NOTES.offer, why: "the customer takes in the offer review" },
  { id: "e7", kind: "entity", page: "projects/shop-2027", note: NOTES.checkout, why: "the shop project takes in the work note on its checkout" },

  // Facts that must be on a page afterwards.
  { id: "f1", kind: "fact", page: "people/stefan-koller", expect: [/datacore/i, /(project lead|project manager|projektleit)/i], why: "who Stefan Koller is" },
  { id: "f2", kind: "fact", page: "orgs/datacore", expect: [/stefan koller/i], why: "the vendor's contact person" },
  { id: "f3", kind: "fact", page: "orgs/steiner-bau", expect: [/((three|3)[- ]year|drei ?jahr|3 jahre)/i, /(6 ?%|tier|staffel|discount|rabatt)/i], why: "the framework contract's term and tiered prices" },
  { id: "f4", kind: "fact", page: "projects/shop-2027", expect: [/paypal/i, /(invoice|rechnung)/i], why: "the launch's payment scope" },
  { id: "f5", kind: "fact", page: TELLWERK, expect: [/(munich|münchen)/i, /(competitor|competes|rival|wettbewerb|konkurrent)/i], why: "who the competitor is" },
  { id: "f6", kind: "fact", page: "topics/werkzeugtage-2027", expect: [/24[- ]?(m²|m2|sq|square|qm|quadrat)/i, /(2027-03-09|9\.? ?(mar|märz|march)\w* 2027|march 9)/i], why: "booth size and dates" },

  // Decision pages: from a "## Decisions" section, from prose, and a trivial choice that isn't one.
  { id: "d1", kind: "decision", note: NOTES.offer, match: /(tier|staffel|6 ?%|10 ?%|discount|rabatt)/i, exists: true, why: "the tiered-price decision in the offer review's Decisions section" },
  { id: "d2", kind: "decision", note: NOTES.checkout, match: /paypal/i, exists: true, why: "dropping PayPal from the launch, decided in a work note's prose (no Decisions section)" },
  { id: "d3", kind: "decision", note: NOTES.offer, match: /(cover|deckblatt|blue|blau|pdf)/i, exists: false, why: "the offer PDF's cover page is a trivial choice, not a team decision" },

  // A corrected fact: the new value is current truth, the old one is only history.
  { id: "s1", kind: "supersession", page: "projects/erp-umstieg", now: GO_LIVE_NEW, was: GO_LIVE_OLD, inTimeline: true, why: "the ERP go-live moved from 2027-01-11 to 2027-02-01" },
  { id: "s2", kind: "supersession", page: "people/mara-huber", was: GO_LIVE_OLD, inTimeline: false, why: "Mara's page no longer gives the old go-live" },

  // What the batch has nothing to say about.
  { id: "u1", kind: "untouched", pages: ["people/jonas-wirth"], identical: false, keep: [/freelance/i, /checkout/i], forbid: [/(werkzeugtage|trade fair|messe|booth)/i], why: "Jonas only sat in on the trade fair meeting" },
  {
    id: "u2",
    kind: "untouched",
    pages: ["decisions/0001-datacore-as-erp", "decisions/0002-shop-launch-march-2027", "decisions/0003-framework-contract-annual-minimum"],
    identical: true,
    why: "no new decision replaces an old one (tiered prices come on top of the annual minimum)",
  },
  {
    id: "u3",
    kind: "untouched",
    pages: [
      "notes/2026-09/2026-09-22-erp-auswahl-a1b2c3",
      "notes/2026-10/2026-10-06-shop-review-g7h8i9",
      "notes/2026-10/2026-10-08-call-steiner-bau-d4e5f6",
      "notes/2026-10/2026-10-13-weekly-j1k2l3",
      ...Object.values(NOTES),
    ],
    identical: true,
    why: "consolidation never edits a note",
  },
];

/**
 * Link validity has no list: it applies to every living page the run wrote. Each bullet of
 * the page's current truth must link the note it came from, and that note must exist; no link
 * on the page may point at a page that doesn't exist.
 */
/**
 * Where a living page cites its notes: each timeline line links the note it came from (current
 * truth carries no links by design; its evidence is the timeline below it).
 */
export const LINK_RULE = "every timeline line links an existing note, and no link on the page is broken";
