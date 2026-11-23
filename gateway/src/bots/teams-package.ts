// A bot's Teams app package (docs/bots.md, "Microsoft Teams"): manifest.json and its two icons in
// a zip, the shape Teams' app catalog takes. Small on purpose: a stored (uncompressed) zip and a
// PNG writer, so no library is needed for three files.
import { crc32, deflateSync } from "node:zlib";

/** Teams' limits for an app's names and descriptions. */
const SHORT_NAME = 30;
const FULL_NAME = 100;
const SHORT_DESC = 80;

export interface TeamsManifestInput {
  /** The app's id in the manifest (a GUID Ambient keeps for the bot). */
  manifestId: string;
  /** "1.0.N": a new version each time the package is published again (a new icon, a new name). */
  version: string;
  /** The bot's Microsoft app (its Entra app registration's Application ID). */
  botAppId: string;
  name: string;
  website: string;
}

/** The manifest Teams gets: the bot's name, where it can be used, and that it may read channel threads. */
export function teamsManifest(m: TeamsManifestInput): Record<string, unknown> {
  const name = m.name.trim() || "Bot";
  const site = m.website.replace(/\/+$/, "");
  return {
    $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    manifestVersion: "1.17",
    version: m.version,
    id: m.manifestId,
    developer: { name: "Ambient", websiteUrl: site, privacyUrl: `${site}/privacy`, termsOfUseUrl: `${site}/terms` },
    name: { short: name.slice(0, SHORT_NAME), full: `${name}, a bot in Ambient`.slice(0, FULL_NAME) },
    description: {
      short: `${name}, a bot in Ambient.`.slice(0, SHORT_DESC),
      full: `${name} is a bot in Ambient. Mention it in a channel or send it a message: it answers in the thread. It takes instructions only from the person who added it.`,
    },
    icons: { outline: "outline.png", color: "color.png" },
    accentColor: "#2F2F31",
    bots: [{ botId: m.botAppId, scopes: ["personal", "team", "groupChat"], isNotificationOnly: false, supportsFiles: false, supportsCalling: false, supportsVideo: false }],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [],
    // Resource-specific consent: replies in the thread under a post of its own reach it without an @mention.
    webApplicationInfo: { id: m.botAppId, resource: `api://botid-${m.botAppId}` },
    authorization: { permissions: { resourceSpecific: [{ name: "ChannelMessage.Read.Group", type: "Application" }] } },
  };
}

/** The package: manifest.json, color.png (192 px) and outline.png (32 px, white on transparent). */
export function teamsPackage(m: TeamsManifestInput, color?: Buffer): Buffer {
  return zip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(teamsManifest(m), null, 2)) },
    { name: "color.png", data: color ?? defaultColorIcon() },
    { name: "outline.png", data: outlineIcon() },
  ]);
}

/** Width and height of a PNG, or null when it isn't one. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// ---- icons ----

/** A circle on a square: Ambient's dark tile with a light dot, until the app sends the bot's face. */
export function defaultColorIcon(): Buffer {
  return circlePng(192, [0x2f, 0x2f, 0x31, 0xff], [0xf2, 0xf2, 0xf4, 0xff], 0.3);
}

/** Teams' outline icon: white on transparent, 32 px. */
export function outlineIcon(): Buffer {
  return circlePng(32, [0, 0, 0, 0], [0xff, 0xff, 0xff, 0xff], 0.38);
}

function circlePng(size: number, bg: number[], fg: number[], radius: number): Buffer {
  const rows: Buffer[] = [];
  const c = (size - 1) / 2;
  const r = size * radius;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const px = Math.hypot(x - c, y - c) <= r ? fg : bg;
      row.set(px, 1 + x * 4);
    }
    rows.push(row);
  }
  return png(size, size, Buffer.concat(rows));
}

/** An RGBA PNG from its filtered rows (each row starts with filter byte 0). */
function png(width: number, height: number, raw: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- zip (stored) ----

/** A zip with its files stored as they are: what Teams reads, without a compression library. */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** The files in a stored zip (tests; reading back what was published). */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const start = i + 30 + nameLen + extra;
    out.set(name, buf.subarray(start, start + size));
    i = start + size;
  }
  return out;
}
