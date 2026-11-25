// Who can ask a bot to do something in Slack and Teams (docs/bots.md, "Who can ask it").
//
// A bot's owner chooses: everyone in the workspace (the default), or only the people they pick.
// Whoever added the bot to Slack or Teams can always ask it. "Everyone" means the company's own
// people: Slack guests and people from other companies in a shared channel, and Teams users of
// another tenant, are left out unless they're picked. A bot's runs hold its owner's secrets, so
// the people it takes instructions from can use them; that's why the choice is the owner's.
//
// Kept in the sealed records under `bot:askers`, one per bot, next to its Slack and Teams apps.
// The people seen writing to it are kept too, so the app has someone to pick from in Teams
// (Slack's members come from Slack itself).
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";

const ASKERS = "bot:askers";
/** At most this many people picked, and this many remembered from writing to it. */
export const PEOPLE_MAX = 200;
const SEEN_MAX = 100;

export type AskersMode = "everyone" | "selected";
export type Via = "slack" | "teams";

/** A person in Slack (a user id) or Teams (an Entra object id), with their name. */
export interface Asker {
  via: Via;
  id: string;
  name: string;
}

export interface AskersRecord {
  mode: AskersMode;
  people: Asker[];
  /** People who wrote to it lately, newest last (what Teams offers to pick from). */
  seen?: (Asker & { at: number })[];
}

/** What the app shows. */
export interface AskersView {
  mode: AskersMode;
  people: Asker[];
}

const ownerArgs = (owner: Owner) => ({ ownerKind: owner.kind, ownerId: owner.kind === "user" ? owner.uid : owner.teamId });

export class BotAskers {
  private locks = new Map<string, Promise<void>>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  async get(owner: Owner, routineId: string): Promise<AskersRecord> {
    const r = (await this.d.control.q(api.records.get, { ...ownerArgs(owner), kind: ASKERS, key: routineId })) as { iv: string; ct: string; deleted: boolean } | null;
    const empty: AskersRecord = { mode: "everyone", people: [] };
    if (!r || r.deleted) return empty;
    const raw = await this.d.keys.open(owner, `record:${ASKERS}`, r.iv, r.ct).catch(() => null);
    if (raw === null) return empty;
    try {
      const v = JSON.parse(raw) as Partial<AskersRecord>;
      return { mode: v.mode === "selected" ? "selected" : "everyone", people: Array.isArray(v.people) ? v.people : [], ...(Array.isArray(v.seen) ? { seen: v.seen } : {}) };
    } catch {
      return empty;
    }
  }

  private async put(owner: Owner, routineId: string, value: AskersRecord): Promise<void> {
    const sealed = await this.d.keys.seal(owner, `record:${ASKERS}`, JSON.stringify(value));
    await this.d.control.m(api.records.put, { ...ownerArgs(owner), kind: ASKERS, key: routineId, iv: sealed.iv, ct: sealed.ciphertext, size: sealed.ciphertext.length, byKind: "user", keep: 1, now: this.now() });
  }

  /** One change at a time per bot (a write in between isn't lost). */
  private async change(owner: Owner, routineId: string, f: (r: AskersRecord) => AskersRecord | null): Promise<AskersRecord> {
    const key = `${owner.kind}:${owner.kind === "user" ? owner.uid : owner.teamId}:${routineId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let out!: AskersRecord;
    const next = prev.then(async () => {
      const cur = await this.get(owner, routineId);
      const v = f(cur);
      out = v ?? cur;
      if (v) await this.put(owner, routineId, v);
    });
    const done = next.catch(() => undefined);
    this.locks.set(key, done);
    void done.finally(() => {
      if (this.locks.get(key) === done) this.locks.delete(key);
    });
    await next;
    return out;
  }

  view(r: AskersRecord): AskersView {
    return { mode: r.mode, people: r.people };
  }

  /** The owner's choice: everyone, or only these people (the list is kept when switching back, for next time). */
  async set(owner: Owner, routineId: string, mode: AskersMode, people?: Asker[]): Promise<AskersView> {
    const clean = people?.map((p) => ({ via: p.via, id: p.id.trim(), name: p.name.trim().slice(0, 100) || "Someone" })).filter((p, i, all) => p.id && all.findIndex((q) => q.via === p.via && q.id === p.id) === i).slice(0, PEOPLE_MAX);
    return this.view(await this.change(owner, routineId, (r) => ({ ...r, mode, people: clean ?? r.people })));
  }

  /**
   * Whether this person may ask it. `installer`: they added it to Slack or Teams (always yes).
   * `company`: they're one of the company's own people (not a guest, not another company's).
   */
  allows(r: AskersRecord, via: Via, id: string, p: { installer: boolean; company: boolean }): boolean {
    if (p.installer) return true;
    if (r.people.some((x) => x.via === via && x.id === id)) return true;
    return r.mode === "everyone" && p.company;
  }

  /** Someone wrote to it: remembered, so the app can offer them in the picker. */
  async saw(owner: Owner, routineId: string, who: Asker): Promise<void> {
    await this.change(owner, routineId, (r) => {
      const known = r.seen?.find((s) => s.via === who.via && s.id === who.id);
      // Written lately and the name hasn't changed: nothing to write.
      if (known && known.name === who.name && this.now() - known.at < 24 * 3600_000) return null;
      const seen = [...(r.seen ?? []).filter((s) => !(s.via === who.via && s.id === who.id)), { ...who, at: this.now() }].slice(-SEEN_MAX);
      return { ...r, seen };
    });
  }
}

/** Words for a refusal: who can ask it instead. */
export function onlyLine(r: AskersRecord, via: Via, installer: string): string {
  const others = r.people.filter((p) => p.via === via).map((p) => (via === "slack" ? `<@${p.id}>` : p.name));
  const all = [installer, ...others.filter((o) => o !== installer)];
  const list = all.length <= 1 ? all[0]! : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
  return `I only take instructions from ${list} for now. My owner can change who can ask me in Ambient.`;
}

/** Someone the app can pick: from Slack's member list, or seen writing to the bot in Teams. */
export interface Candidate extends Asker {
  /** A Slack guest or another company's account: "everyone" leaves them out, picking takes them. */
  guest?: boolean;
}

/** All the app needs for its picker: the choice, who added it (always in), and who can be picked. */
export interface AskersPage extends AskersView {
  owners: Asker[];
  candidates: Candidate[];
}

/** The picker's page for a bot (its Slack and Teams apps, whichever it has). */
export async function askersPage(
  askers: BotAskers,
  slack: { installerOf(o: Owner, r: string): Promise<{ id: string; name: string } | null>; members(o: Owner, r: string): Promise<{ id: string; name: string; guest: boolean }[]> } | undefined,
  teams: { installerOf(o: Owner, r: string): Promise<{ id: string; name: string } | null> } | undefined,
  owner: Owner,
  routineId: string,
): Promise<AskersPage> {
  const [r, sOwner, tOwner, members] = await Promise.all([
    askers.get(owner, routineId),
    slack?.installerOf(owner, routineId).catch(() => null) ?? null,
    teams?.installerOf(owner, routineId).catch(() => null) ?? null,
    slack?.members(owner, routineId).catch(() => []) ?? [],
  ]);
  const owners: Asker[] = [...(sOwner ? [{ via: "slack" as const, ...sOwner }] : []), ...(tOwner ? [{ via: "teams" as const, ...tOwner }] : [])];
  const isOwner = (c: Asker) => owners.some((o) => o.via === c.via && o.id === c.id);
  const slackPeople: Candidate[] = (members ?? []).map((m) => ({ via: "slack", id: m.id, name: m.name, ...(m.guest ? { guest: true } : {}) }));
  const teamsPeople: Candidate[] = [...(r.seen ?? [])].filter((s) => s.via === "teams").reverse().map((s) => ({ via: "teams", id: s.id, name: s.name }));
  // Picked people stay offered even when Slack's list doesn't have them (yet).
  const all = [...slackPeople, ...teamsPeople, ...r.people];
  const candidates = all.filter((c, i) => !isOwner(c) && all.findIndex((x) => x.via === c.via && x.id === c.id) === i);
  return { ...askers.view(r), owners, candidates };
}
