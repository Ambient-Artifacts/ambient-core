// What a bot remembers between runs, one small JSON file per bot: where its team is in Teams,
// the channel for the morning report, who it already told about which correction.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Member } from "./botframework.ts";
import type { Waiting } from "./waiting.ts";

export interface BotState {
  serviceUrl?: string;
  /** The team's conversation id in Teams (19:…@thread.tacv2), from the install or a channel message. */
  teamId?: string;
  teamName?: string;
  /** The channel for the morning report: where someone first talked to the bot. */
  channel?: { id: string; name?: string };
  members?: { at: string; list: Member[] };
  /** Corrections waiting for an owner, as of the last look at the wiki. */
  waiting?: Waiting[];
  /** Owner told, by Waiting.key: when, and the card's message for updating it after a click. */
  told?: Record<string, { at: string; conversation?: string; activity?: string; done?: string }>;
  /** Day (local) and time of the last morning report. */
  reportedOn?: string;
  reportedAt?: string;
}

export interface BotStore {
  load(): Promise<BotState>;
  save(state: BotState): Promise<void>;
}

export class FileBotStore implements BotStore {
  constructor(
    private dir: string,
    private appId: string,
  ) {}

  private get file() {
    return join(this.dir, `${this.appId}.json`);
  }

  async load(): Promise<BotState> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as BotState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async save(state: BotState): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export class MemoryBotStore implements BotStore {
  constructor(public state: BotState = {}) {}
  async load() {
    return structuredClone(this.state);
  }
  async save(state: BotState) {
    this.state = structuredClone(state);
  }
}
