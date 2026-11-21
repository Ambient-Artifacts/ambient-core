// Files sent with a message, kept so the message shows them again (docs/bots.md, "Files in the
// chat"): in Ambient's chat and in a bot's thread, on every device, like Claude shows them. Each is
// sealed with its owner's key (the person's; a team bot's thread: the team's) before it goes to
// Convex file storage, its name and type sealed beside it. The message's sealed body names them
// (`MessageBody.files`); the app fetches each through the gateway, which checks who may read it.
import { api, type Control } from "../control.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { RoutineError } from "../routines/service.ts";

/** What a message keeps of a file: enough to show it, the bytes are fetched by id. */
export interface FileRef {
  id: string;
  name: string;
  type: string;
  size: number;
}

/** A file as it arrives with a message: base64, checked (`checkAttachments`). */
export interface IncomingFile {
  name: string;
  type: string;
  data: string;
}

const META = "attachment:meta";
const BYTES = "attachment:bytes";

export class Attachments {
  constructor(private d: { control: Control; keys: RoutineKeys; now?: () => number }) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private ownerArgs(owner: Owner) {
    return owner.kind === "user" ? { userId: owner.uid as never } : { teamId: owner.teamId as never };
  }

  /** Stores the files of one message (`routineId`: a bot's thread; none: Ambient's chat). */
  async save(owner: Owner, place: { routineId?: string }, files: IncomingFile[]): Promise<FileRef[]> {
    const out: FileRef[] = [];
    for (const f of files) {
      const bytes = Buffer.from(f.data, "base64");
      const sealed = await this.d.keys.sealBytes(owner, BYTES, bytes);
      const meta = await this.d.keys.seal(owner, META, JSON.stringify({ name: f.name, type: f.type }));
      const stored = await this.d.control.a(api.attachments.store, {
        ...this.ownerArgs(owner),
        ...(place.routineId ? { routineId: place.routineId as never } : {}),
        iv: sealed.iv,
        data: sealed.ciphertext,
        metaIv: meta.iv,
        metaCt: meta.ciphertext,
        size: bytes.length,
        now: this.now(),
      });
      out.push({ id: stored.id, name: f.name, type: f.type, size: bytes.length });
    }
    return out;
  }

  /**
   * One file's bytes, when it belongs to `owner` and to `place` (that chat, or that bot's thread):
   * an id from somewhere else is "not found", never someone else's file.
   */
  async read(owner: Owner, place: { routineId?: string }, id: string): Promise<{ name: string; type: string; bytes: Buffer }> {
    const notFound = new RoutineError("no_such_file", "There's no such file.", 404);
    if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw notFound;
    const row = await this.d.control.q(api.attachments.get, { id });
    if (!row) throw notFound;
    const mine = owner.kind === "user" ? row.userId === owner.uid && !row.teamId : row.teamId === owner.teamId;
    if (!mine || (row.routineId ?? null) !== (place.routineId ?? null)) throw notFound;
    const data = await this.d.control.a(api.attachments.read, { id });
    if (!data) throw notFound;
    const meta = JSON.parse(await this.d.keys.open(owner, META, row.metaIv, row.metaCt)) as { name?: string; type?: string };
    return { name: meta.name ?? "file", type: meta.type ?? "application/octet-stream", bytes: await this.d.keys.openBytes(owner, BYTES, row.iv, data.data) };
  }

  /** A person's chat files, for good (with Forget chat). */
  async forgetChat(uid: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const out = await this.d.control.m(api.attachments.forgetChat, { uid: uid as never });
      if (!out.removed) break;
    }
  }
}

/** File references as a message body keeps them (`f` in the sealed JSON). */
export function fileRefs(raw: unknown): FileRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .filter((x) => typeof x.id === "string" && typeof x.name === "string")
    .map((x) => ({ id: String(x.id), name: String(x.name), type: typeof x.type === "string" ? x.type : "application/octet-stream", size: typeof x.size === "number" ? x.size : 0 }));
}

/** For a model's history: which files came with a message, by name. */
export function filesLine(files: FileRef[]): string {
  return files.length ? `[Files with this message: ${files.map((f) => f.name).join(", ")}]` : "";
}
