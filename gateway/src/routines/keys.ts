// Sealing routine data for its owner: a person's with their data key (PersonalStore), a team's
// with a team data key that's wrapped by the master key like a person's, so Convex holds no
// readable prompt, run result or secret either way.
import { api, type Control } from "../control.ts";
import { decryptPage, encryptPage, newDataKey, unwrapDataKey, wrapDataKey, type MasterKey } from "../crypto.ts";
import type { PersonalStore } from "../personal.ts";

export type Owner = { kind: "user"; uid: string } | { kind: "team"; teamId: string };

export class RoutineKeys {
  private teamKeys = new Map<string, Buffer>();

  constructor(
    private d: { control: Control; personal: PersonalStore; master: MasterKey },
  ) {}

  private async teamKey(teamId: string): Promise<Buffer> {
    const cached = this.teamKeys.get(teamId);
    if (cached) return cached;
    const id = `team:${teamId}`;
    let rec = await this.d.control.q(api.routines.teamKey, { teamId: teamId as never });
    if (!rec) {
      rec = await this.d.control.m(api.routines.putTeamKey, {
        teamId: teamId as never,
        masterKeyId: this.d.master.id,
        wrapped: wrapDataKey(this.d.master, id, newDataKey()),
        now: Date.now(),
      });
    }
    if (rec.masterKeyId !== this.d.master.id) throw new Error(`team key wrapped by unknown master key ${rec.masterKeyId}`);
    const key = unwrapDataKey(this.d.master, id, rec.wrapped);
    this.teamKeys.set(teamId, key);
    return key;
  }

  async seal(owner: Owner, label: string, text: string): Promise<{ iv: string; ciphertext: string }> {
    if (owner.kind === "user") return this.d.personal.seal(owner.uid, label, text);
    return encryptPage(await this.teamKey(owner.teamId), `team:${owner.teamId}`, label, text);
  }

  async open(owner: Owner, label: string, iv: string, ciphertext: string): Promise<string> {
    if (owner.kind === "user") return this.d.personal.open(owner.uid, label, iv, ciphertext);
    return decryptPage(await this.teamKey(owner.teamId), `team:${owner.teamId}`, label, iv, ciphertext);
  }
}
