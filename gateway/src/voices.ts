// Voice fingerprints: the speaker embedding the apps compute on the device from a person's own
// recorded voice (numbers, never audio), so recordings can name who spoke. A person's fingerprint
// reaches their other devices and, while they're in a team, every member's app there: speakers are
// matched on the device; the server only keeps the fingerprints and hands them out. At rest they're
// sealed with the owner's data key, like their pages (crypto.ts). The app's routes and the MCP tools
// both go through this class.
import { z } from "zod";
import { api, type Control } from "./control.ts";
import type { Directory } from "./directory.ts";
import type { PersonalStore } from "./personal.ts";

/** What a device sends: 256 numbers from today's model, with room for others. */
export const VoiceBody = z.object({
  embedding: z.array(z.number().finite()).min(64).max(1024),
  model: z.string().min(1).max(80),
});
export type VoiceInput = z.infer<typeof VoiceBody>;

export interface Voice {
  embedding: number[];
  model: string;
  /** When it was last replaced (ms). */
  updatedAt: number;
}

export interface TeamVoice extends Voice {
  uid: string;
  /** Their Ambient name, as the team's member list shows it. */
  name: string;
}

/** The AAD label the embedding is sealed under (the user's id is bound in too). */
const LABEL = "voice";

export class Voices {
  constructor(private d: { control: Control; personal: PersonalStore; directory: Directory }) {}

  /** Replace the user's fingerprint. False when their account is going away. */
  async put(uid: string, voice: VoiceInput): Promise<boolean> {
    const { iv, ciphertext } = await this.d.personal.seal(uid, LABEL, JSON.stringify(voice.embedding));
    return (await this.d.control.m(api.voices.put, { uid: uid as never, model: voice.model, iv, ciphertext, now: Date.now() })).ok;
  }

  async get(uid: string): Promise<Voice | null> {
    const row = await this.d.control.q(api.voices.get, { uid: uid as never });
    if (!row) return null;
    const embedding = JSON.parse(await this.d.personal.open(uid, LABEL, row.iv, row.ciphertext)) as number[];
    return { embedding, model: row.model, updatedAt: row.updatedAt };
  }

  /** Delete the user's fingerprint; true when there was one. */
  async remove(uid: string): Promise<boolean> {
    return (await this.d.control.m(api.voices.remove, { uid: uid as never })).removed > 0;
  }

  /**
   * Everyone's fingerprint in a team, the requester's own included, for an active member of it;
   * null for anyone else. Any member may read them, not only admins: every member's app names the
   * people in its recordings.
   */
  async ofTeam(uid: string, slug: string): Promise<TeamVoice[] | null> {
    const team = await this.d.directory.membership(uid, slug);
    if (!team || team.status !== "active") return null;
    const rows = await this.d.control.q(api.voices.ofTeam, { uid: uid as never, slug: team.slug });
    if (!rows) return null;
    const out: TeamVoice[] = [];
    for (const r of rows) {
      try {
        const embedding = JSON.parse(this.d.personal.openWithKey(r.uid, r.key, LABEL, r.iv, r.ciphertext)) as number[];
        out.push({ uid: r.uid, name: r.name, embedding, model: r.model, updatedAt: r.updatedAt });
      } catch (err) {
        // One fingerprint that won't open (a key from another master key) mustn't keep the rest
        // of the team's from the apps.
        console.warn(`[gateway] a team voice didn't open: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** Whether the user has a fingerprint stored, and which teams' apps get it (get_settings). */
  async status(uid: string): Promise<{ stored: boolean; model: string | null; updatedAt: number | null; teams: { slug: string; name: string }[] }> {
    const [row, teams] = await Promise.all([this.d.control.q(api.voices.get, { uid: uid as never }), this.d.directory.teamsOf(uid)]);
    return {
      stored: !!row,
      model: row?.model ?? null,
      updatedAt: row?.updatedAt ?? null,
      teams: row ? teams.filter((t) => t.status === "active").map((t) => ({ slug: t.slug, name: t.name })) : [],
    };
  }
}
