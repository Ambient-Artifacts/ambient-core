// For the apps: a brief before a meeting (the attendees' pages, what's open with them, the last
// decisions and meetings), and what's waiting on someone (open action items they owe, and what
// others owe in notes they recorded or took part in). Read from the user's personal wiki and
// their teams' wikis; deterministic, no model.
import type { ActionItemHit, WikiReader } from "@brain/wiki";
import { nameKey } from "@brain/wiki";
import type { Directory, Team } from "./directory.ts";
import { ME_REF, profileOf } from "./me.ts";
import { brainLabel, openActions, ownerKeys, owns, selfRefs, storeId, userProfile, type ContextStore, type ScopedAction } from "./mcp/context.ts";
import type { PersonalStore } from "./personal.ts";
import type { TeamLink } from "./teams.ts";

/** The wikis an app user reads: their own, and each active team's that has a server. */
export async function appStores(uid: string, d: { personal: PersonalStore; teams: TeamLink; directory: Directory }): Promise<ContextStore[]> {
  const out: ContextStore[] = [];
  const personal = await d.personal.reader(uid).catch(() => undefined);
  if (personal) out.push({ scope: "personal", reader: personal });
  for (const team of (await d.directory.teamsOf(uid)) as Team[]) {
    if (team.status !== "active" || !team.serverUrl) continue;
    out.push({ scope: "team", team, reader: d.teams.reader(team, uid) as WikiReader });
  }
  return out;
}

/** "Nikolai" and "Nikolai Madlener" are one person; "Anna" isn't "Annabelle". */
export function sameName(a: string, b: string): boolean {
  const [x, y] = [nameKey(a), nameKey(b)];
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.split(" ").length <= y.split(" ").length ? [x, y] : [y, x];
  return short.split(" ").length === 1 && long.split(" ")[0] === short;
}

export interface BriefPerson {
  name: string;
  found: boolean;
  id?: string;
  title?: string;
  type?: string;
  summary?: string;
  /** What the wiki says about them now (their page's sections), as markdown. */
  truth?: string;
  where?: string;
}

export interface BriefItem {
  owner: string | null;
  task: string;
  due: string | null;
  note: { id: string; title: string; date: string };
}

export interface MeetingBrief {
  title: string | null;
  people: BriefPerson[];
  openActions: BriefItem[];
  decisions: { text: string; date: string; id: string }[];
  recentNotes: { id: string; title: string; date: string }[];
}

const item = (s: ContextStore, a: ActionItemHit): BriefItem => ({
  owner: a.owner,
  task: a.task,
  due: a.due,
  note: { id: storeId(s, a.note.ref), title: a.note.title, date: a.note.sortDate.slice(0, 10) },
});

/**
 * The brief before a meeting with these attendees (names as the calendar has them): who each
 * one is, what's open with them, the last decisions about them, and the last notes they're in.
 */
export async function meetingBrief(stores: ContextStore[], attendees: string[], title: string | null = null): Promise<MeetingBrief> {
  const names = [...new Set(attendees.map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 20);
  const people: BriefPerson[] = [];
  const actions = new Map<string, BriefItem>();
  const decisions = new Map<string, { text: string; date: string; id: string }>();
  const notes = new Map<string, { id: string; title: string; date: string }>();
  for (const name of names) {
    let person: BriefPerson = { name, found: false };
    for (const s of stores) {
      const page = await s.reader.resolveEntity(name, "person").catch(() => undefined);
      if (!page || page.ref === ME_REF || ![page.title, ...(Array.isArray(page.frontmatter.aliases) ? page.frontmatter.aliases.map(String) : [])].some((n) => sameName(n, name))) continue;
      const brief = await s.reader.brief(page.ref).catch(() => undefined);
      if (!person.found) {
        const profile = profileOf(page, "team");
        person = { name, found: true, id: storeId(s, page.ref), title: page.title, type: page.type, summary: page.summary, truth: profile?.truth ?? "", where: brainLabel(s) };
      }
      for (const a of brief?.openActions ?? []) actions.set(`${s.scope}:${s.team?.slug}:${a.note.ref}:${a.task}`, item(s, a));
      for (const dec of brief?.decisions ?? []) decisions.set(`${dec.date.slice(0, 10)}:${dec.text}`, { text: dec.text, date: dec.date.slice(0, 10), id: storeId(s, dec.source.ref) });
      for (const n of brief?.recentNotes ?? []) notes.set(storeId(s, n.ref), { id: storeId(s, n.ref), title: n.title, date: n.sortDate.slice(0, 10) });
    }
    people.push(person);
  }
  // Items an attendee owns in notes that don't link their page (they had none yet).
  for (const s of stores) {
    const open = await s.reader.actionItems({ status: "open" }).catch(() => [] as ActionItemHit[]);
    for (const a of open) {
      if (a.owner && names.some((n) => owns(a.owner, ownerKeys(n)))) actions.set(`${s.scope}:${s.team?.slug}:${a.note.ref}:${a.task}`, item(s, a));
    }
  }
  return {
    title,
    people,
    openActions: [...actions.values()].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999")).slice(0, 15),
    decisions: [...decisions.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
    recentNotes: [...notes.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
  };
}

export interface WaitingOn {
  name: string;
  /** Open items the user owns, soonest due first. */
  mine: BriefItem[];
  /** Open items others own, from notes the user recorded or took part in. */
  theirs: BriefItem[];
  dueToday: number;
  overdue: number;
}

/** What's waiting on the user, and on others for them. `today` is their local date. */
export async function waitingOn(stores: ContextStore[], fallbackName: string | undefined, today: string): Promise<WaitingOn> {
  const profile = await userProfile(stores, fallbackName);
  const me = stores.find((s) => s.scope === "personal") ? await stores.find((s) => s.scope === "personal")!.reader.getByRef(ME_REF).catch(() => undefined) : undefined;
  const aliases = Array.isArray(me?.frontmatter.aliases) ? me!.frontmatter.aliases.map(String) : [];
  const name = profile.name || fallbackName || "";
  const keys = ownerKeys(name, [...aliases, ...(fallbackName && fallbackName !== name ? [fallbackName] : [])]);
  const { mine, theirs } = name ? await openActions(stores, keys, selfRefs(stores)) : { mine: [] as ScopedAction[], theirs: [] as ScopedAction[] };
  const out = (list: ScopedAction[]) => list.slice(0, 30).map((a) => item(a.store, a));
  return {
    name,
    mine: out(mine),
    theirs: out(theirs),
    dueToday: mine.filter((a) => a.due === today).length,
    overdue: mine.filter((a) => a.due !== null && a.due < today).length,
  };
}

/** The morning push: counts only, never the tasks (a lock screen and Apple's servers see it). */
export function digestMessage(w: WaitingOn): { title: string; body: string } | null {
  if (w.mine.length === 0 && w.theirs.length === 0) return null;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (w.mine.length) {
    const when = [w.overdue ? `${w.overdue} overdue` : "", w.dueToday ? `${w.dueToday} due today` : ""].filter(Boolean).join(", ");
    parts.push(`${n(w.mine.length, "open action item", "open action items")}${when ? ` (${when})` : ""}`);
  }
  if (w.theirs.length) parts.push(`${n(w.theirs.length, "thing", "things")} others owe you`);
  return { title: "Waiting on you", body: `${parts.join(" · ")}.` };
}
