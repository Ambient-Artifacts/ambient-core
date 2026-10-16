// Push notifications to the iPhone and Mac apps, through Apple's push service (APNs). The apps
// register their device tokens (PUT /v1/app/push-device, kept in Convex `pushDevices`); what's
// worth a push is decided next to the event (a routine run failed: routines.finishRun) and sent
// from here. Needs an APNs key (.p8) from the Apple Developer account; without one nothing is
// sent and nothing else changes.
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import { api, type Control } from "./control.ts";

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** The .p8 key's PEM text. */
  privateKey: string;
  /** The apps' bundle id (the iPhone and Mac apps share one). */
  topic: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** An ambient:// link the app opens when the notification is tapped. */
  url?: string;
  /** Groups the app's notifications in Notification Center. */
  thread?: string;
  /** A newer notification with the same id replaces the one still showing (at most 64 bytes). */
  collapseId?: string;
}

export interface PushDevice {
  token: string;
  sandbox: boolean;
}

/** "gone": Apple won't take this token (the app was deleted, or the wrong environment). */
export type PushOutcome = "sent" | "gone" | "failed";
export type PushSender = (device: PushDevice, message: PushMessage) => Promise<PushOutcome>;

export const APNS_ORIGINS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };
/** Apple wants a new provider token at most every 20 minutes and at least every 60. */
const TOKEN_TTL_MS = 50 * 60_000;
const TIMEOUT_MS = 10_000;
/** Kept by Apple while the device is offline, then dropped. */
const EXPIRES_S = 24 * 3600;
const GONE = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

export function apnsSender(config: ApnsConfig | undefined, origins = APNS_ORIGINS): PushSender | undefined {
  if (!config) return undefined;
  const key = importPKCS8(config.privateKey, "ES256");
  let jwt: { value: string; at: number } | undefined;
  const providerToken = async (renew: boolean) => {
    if (!renew && jwt && Date.now() - jwt.at < TOKEN_TTL_MS) return jwt.value;
    const value = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: config.keyId }).setIssuer(config.teamId).setIssuedAt().sign(await key);
    jwt = { value, at: Date.now() };
    return value;
  };

  // One HTTP/2 connection per environment, kept open as Apple asks, opened again once it closes.
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (origin: string) => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(origin);
    const forget = () => {
      if (sessions.get(origin) === s) sessions.delete(origin);
    };
    s.on("error", (err) => {
      forget();
      console.warn(`[push] apns connection: ${err.message}`);
    });
    s.on("goaway", forget);
    s.on("close", forget);
    s.unref();  // never what keeps the process running
    sessions.set(origin, s);
    return s;
  };

  const post = (origin: string, token: string, headers: Record<string, string>, body: string) =>
    new Promise<{ status: number; reason?: string }>((resolve, reject) => {
      const req = session(origin).request({ ":method": "POST", ":path": `/3/device/${token}`, "content-type": "application/json", ...headers });
      let status = 0;
      let data = "";
      req.setTimeout(TIMEOUT_MS, () => {
        req.close(constants.NGHTTP2_CANCEL);
        reject(new Error("timed out"));
      });
      req.on("response", (h) => (status = Number(h[":status"])));
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (data += chunk));
      req.on("end", () => {
        let reason: string | undefined;
        try {
          reason = (JSON.parse(data) as { reason?: string }).reason;
        } catch {
          // 200 has no body
        }
        resolve({ status, reason });
      });
      req.on("error", reject);
      req.end(body);
    });

  return async (device, message) => {
    const payload = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: "default", ...(message.thread ? { "thread-id": message.thread } : {}) },
      ...(message.url ? { url: message.url } : {}),
    });
    const headers: Record<string, string> = {
      "apns-topic": config.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + EXPIRES_S),
      ...(message.collapseId ? { "apns-collapse-id": message.collapseId } : {}),
    };
    const origin = device.sandbox ? origins.sandbox : origins.production;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await post(origin, device.token, { ...headers, authorization: `bearer ${await providerToken(attempt > 0)}` }, payload);
        if (out.status === 200) return "sent";
        if (out.status === 410 || (out.reason && GONE.has(out.reason))) return "gone";
        if (out.status === 403 && out.reason === "ExpiredProviderToken" && attempt === 0) continue;
        console.warn(`[push] apns refused: ${out.status} ${out.reason ?? ""}`);
        return "failed";
      }
      return "failed";
    } catch (err) {
      console.warn(`[push] apns unreachable: ${(err as Error).message}`);
      return "failed";
    }
  };
}

/** Sends a user's notifications to each app install they're signed in on. Never throws. */
export class Notifier {
  constructor(private d: { control: Control; send?: PushSender }) {}

  async notify(uid: string, message: PushMessage): Promise<void> {
    const send = this.d.send;
    if (!send) return;
    try {
      const devices = await this.d.control.q(api.push.devices, { uid: uid as never });
      await Promise.all(devices.map((device) => this.deliver(send, device, message)));
    } catch (err) {
      console.warn(`[push] couldn't notify: ${(err as Error).message}`);
    }
  }

  private async deliver(send: PushSender, device: PushDevice, message: PushMessage): Promise<void> {
    if ((await send(device, message)) !== "gone") return;
    // A token from the other environment (a Release build run from Xcode, say) is refused as a
    // bad token: try that environment once before giving the device up.
    const other = { token: device.token, sandbox: !device.sandbox };
    if ((await send(other, message)) === "sent") {
      await this.d.control.m(api.push.setSandbox, other);
      return;
    }
    await this.d.control.m(api.push.removeDevice, { token: device.token });
  }
}
