// Per-team settings on the team server (product/sources.md): where meeting transcripts and
// copies of work logs go, and the Microsoft 365 connection that writes to a OneDrive or
// SharePoint folder. One JSON file next to remote.json, mode 0600, readable only by the service
// user; the client secret is sealed with BRAIN_TEAM_SECRET when it's set, and never leaves this
// server: the API returns public().
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TeamSettings, withKind, type TranscriptDestination } from "@brain/spec";
import { sealer, type Sealer } from "./seal.ts";

export interface PublicTeamSettings {
  transcripts: TeamSettings["transcripts"];
  work: TeamSettings["work"];
  microsoft: { kind: "own"; tenant_id: string; client_id: string } | { kind: "ambient"; tenant_id: string; tenant_name: string } | null;
  ignore: string[];
  notes: TeamSettings["notes"];
}

/** On disk: the own app's secret sealed; older files have no `kind` (withKind). */
type Stored = Omit<TeamSettings, "microsoft"> & {
  microsoft: { kind?: string; tenant_id: string; client_id?: string; client_secret?: string; client_secret_sealed?: string; tenant_name?: string } | null;
};

export class TeamSettingsStore {
  private current: TeamSettings = TeamSettings.parse({});
  private key: Sealer | null;

  constructor(
    readonly file: string,
    secret?: string | null,
  ) {
    this.key = sealer(secret, "ambient team settings secret");
  }

  async load(): Promise<TeamSettings> {
    let stored: Stored;
    try {
      stored = JSON.parse(await readFile(this.file, "utf8")) as Stored;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[team] can't read ${this.file}: ${(err as Error).message}`);
      return this.current;
    }
    let microsoft: Stored["microsoft"] = stored.microsoft ? (withKind(stored.microsoft) as Stored["microsoft"]) : null;
    if (microsoft?.client_secret_sealed) {
      const { client_secret_sealed, ...rest } = microsoft;
      try {
        if (!this.key) throw new Error("BRAIN_TEAM_SECRET isn't set");
        microsoft = { ...rest, client_secret: this.key.open(client_secret_sealed) };
      } catch (err) {
        // The server still starts; deliveries to the drive wait until the secret is right or
        // Microsoft 365 is connected again.
        console.error(`[team] the Microsoft 365 secret doesn't open (${(err as Error).message}): drive delivery is off until it's fixed`);
        microsoft = null;
      }
    }
    const parsed = TeamSettings.safeParse({ ...stored, microsoft });
    if (!parsed.success) {
      console.error(`[team] ${this.file} is invalid (${parsed.error.issues[0]?.path.join(".")}); using defaults`);
      return this.current;
    }
    this.current = parsed.data;
    // Written before the secret was set: seal it now.
    if (this.key && stored.microsoft?.client_secret && this.current.microsoft?.kind === "own") await this.save(this.current);
    return this.current;
  }

  get(): TeamSettings {
    return this.current;
  }

  async save(next: TeamSettings): Promise<void> {
    const valid = TeamSettings.parse(next);
    const { microsoft, ...rest } = valid;
    const stored: Stored = {
      ...rest,
      microsoft: microsoft?.kind === "own" && this.key
        ? { kind: "own", tenant_id: microsoft.tenant_id, client_id: microsoft.client_id, client_secret_sealed: this.key.seal(microsoft.client_secret) }
        : microsoft,
    };
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    this.current = valid;
  }

  /**
   * What applies now. A repo connected read-only takes nothing from Ambient, so transcripts meant
   * for it go nowhere (the team picks a drive folder instead).
   */
  effective(readOnly: boolean): TeamSettings {
    const t: TranscriptDestination = readOnly && this.current.transcripts.kind === "repo" ? { kind: "none" } : this.current.transcripts;
    return { ...this.current, transcripts: t };
  }

  public(readOnly: boolean): PublicTeamSettings {
    const { transcripts, work, microsoft, ignore, notes } = this.effective(readOnly);
    const m: PublicTeamSettings["microsoft"] = !microsoft
      ? null
      : microsoft.kind === "own"
        ? { kind: "own", tenant_id: microsoft.tenant_id, client_id: microsoft.client_id }
        : { kind: "ambient", tenant_id: microsoft.tenant_id, tenant_name: microsoft.tenant_name };
    return { transcripts, work, microsoft: m, ignore, notes };
  }
}
