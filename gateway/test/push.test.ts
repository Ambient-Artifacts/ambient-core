// Push notifications: the APNs sender against a stand-in Apple (HTTP/2, cleartext), and the
// whole path from an app registering its device to a failed routine run reaching it.
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { exportPKCS8, generateKeyPair, jwtVerify, decodeProtectedHeader } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apnsSender, type PushDevice, type PushMessage, type PushOutcome } from "../src/push.ts";
import { appCall, signIn, startStack, type Stack } from "./helpers.ts";

const TOKEN = "a1".repeat(32);
const message: PushMessage = { title: "Loop failed", body: "“Blog draft” didn't finish.", url: "ambient://routine/r1?run=x1", thread: "routines", collapseId: "routine-failed-r1" };

describe("the APNs sender", () => {
  let apple: Http2Server;
  let origin: string;
  let publicKey: CryptoKey;
  let privateKey: string;
  const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
  /** What the stand-in Apple answers next (then 200). */
  const answers: { status: number; reason?: string }[] = [];

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    publicKey = pair.publicKey as CryptoKey;
    privateKey = await exportPKCS8(pair.privateKey);
    apple = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        seen.push({ headers: req.headers, body });
        const a = answers.shift() ?? { status: 200 };
        res.writeHead(a.status, { "apns-id": "x" });
        res.end(a.reason ? JSON.stringify({ reason: a.reason }) : "");
      });
    });
    await new Promise<void>((r) => apple.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(apple.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => apple.close(() => r())));

  const sender = () => apnsSender({ teamId: "TEAM123456", keyId: "KEY1234567", privateKey, topic: "com.example.brain" }, { production: origin, sandbox: origin })!;

  it("sends an alert to the device, signed with the team's key", async () => {
    expect(await sender()({ token: TOKEN, sandbox: false }, message)).toBe("sent");
    const { headers, body } = seen.at(-1)!;
    expect(headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(headers).toMatchObject({ "apns-topic": "com.example.brain", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "routine-failed-r1" });
    const jwt = String(headers.authorization).replace(/^bearer /, "");
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect((await jwtVerify(jwt, publicKey, { issuer: "TEAM123456" })).payload.iat).toBeTypeOf("number");
    expect(JSON.parse(body)).toEqual({ aps: { alert: { title: "Loop failed", body: "“Blog draft” didn't finish." }, sound: "default", "thread-id": "routines" }, url: "ambient://routine/r1?run=x1" });
  });

  it("keeps its provider token, and renews it when Apple says it expired", async () => {
    const send = sender();
    await send({ token: TOKEN, sandbox: false }, message);
    await send({ token: TOKEN, sandbox: false }, message);
    const [a, b] = seen.slice(-2).map((s) => s.headers.authorization);
    expect(a).toBe(b);
    answers.push({ status: 403, reason: "ExpiredProviderToken" });
    expect(await send({ token: TOKEN, sandbox: false }, message)).toBe("sent");
    const [expired, renewed] = seen.slice(-2).map((s) => s.headers.authorization);
    expect(expired).toBe(a);
    expect(renewed).not.toBe(a);
  });

  it("says when a token is gone, and when sending just failed", async () => {
    const send = sender();
    answers.push({ status: 410, reason: "Unregistered" });
    expect(await send({ token: TOKEN, sandbox: false }, message)).toBe("gone");
    answers.push({ status: 400, reason: "BadDeviceToken" });
    expect(await send({ token: TOKEN, sandbox: true }, message)).toBe("gone");
    answers.push({ status: 503, reason: "ServiceUnavailable" });
    expect(await send({ token: TOKEN, sandbox: false }, message)).toBe("failed");
    expect(await apnsSender({ teamId: "T", keyId: "K", privateKey, topic: "x" }, { production: "http://127.0.0.1:1", sandbox: "http://127.0.0.1:1" })!({ token: TOKEN, sandbox: false }, message)).toBe("failed");
  });

  it("is off without a key", () => {
    expect(apnsSender(undefined)).toBeUndefined();
  });
});

describe("a failed routine run", () => {
  let s: Stack;
  let lena: string;
  let ben: string;
  let host: string;
  let id: string;
  const sent: { device: PushDevice; message: PushMessage }[] = [];
  /** Tokens the stand-in Apple refuses, per environment. */
  const refused = new Set<string>();
  const push = async (device: PushDevice, msg: PushMessage): Promise<PushOutcome> => {
    if (refused.has(`${device.token}:${device.sandbox}`)) return "gone";
    sent.push({ device, message: msg });
    return "sent";
  };
  const hostCall = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${s.origin}${path}`, { method, headers: { authorization: `Bearer ${host}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const run = async (status: "succeeded" | "failed") => {
    const start = await hostCall("POST", `/v1/host/routines/${id}/runs`);
    const runId = (start.run as { id: string }).id;
    await hostCall("POST", `/v1/host/runs/${runId}`, { status, summary: status === "failed" ? "claude: command not found" : "Done." });
    return runId;
  };
  /** Waits for `n` pushes in all (sending doesn't hold up the computer's report). */
  const pushes = (n: number) => vi.waitFor(() => expect(sent).toHaveLength(n));
  const devices = () => s.t.run(async (ctx) => ctx.db.query("pushDevices").collect());

  beforeAll(async () => {
    s = await startStack({ push });
    lena = (await signIn(s, "apple-lena", "Lena Vogel")).access_token;
    ben = (await signIn(s, "apple-ben", "Ben Weiss")).access_token;
    const code = String((await appCall(s, lena, "POST", "/v1/app/computers", { name: "Build server" })).json.code);
    const setup = await fetch(`${s.origin}/v1/host/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, info: { hostname: "srv", os: "Linux", runner: "0.1.0", claude: "2" } }),
    });
    host = String(((await setup.json()) as { token: string }).token);
    const schedule = { every: "day", time: "08:00", timezone: "Europe/Vienna" };
    id = ((await appCall(s, lena, "POST", "/v1/app/routines", { name: "Blog draft", prompt: "Draft it.", schedule })).json.routine as { id: string }).id;
  });
  afterAll(() => s.close());

  it("apps register their device; a bad token is refused", async () => {
    expect((await appCall(s, lena, "PUT", "/v1/app/push-device", { token: TOKEN.toUpperCase(), sandbox: true, platform: "ios" })).status).toBe(204);
    expect((await appCall(s, lena, "PUT", "/v1/app/push-device", { token: "nope", sandbox: true, platform: "ios" })).status).toBe(400);
    expect((await appCall(s, lena, "PUT", "/v1/app/push-device", { token: TOKEN, sandbox: true, platform: "watchos" })).status).toBe(400);
    expect(await devices()).toMatchObject([{ token: TOKEN, sandbox: true, platform: "ios" }]);
  });

  it("pushes to the owner's devices, opening the run", async () => {
    const runId = await run("failed");
    await pushes(1);
    expect(sent[0]).toEqual({
      device: { token: TOKEN, sandbox: true, platform: "ios" },
      message: {
        title: "Loop failed",
        body: "“Blog draft” didn't finish. Open it to see what went wrong.",
        url: `ambient://routine/${id}?run=${runId}`,
        thread: "routines",
        collapseId: `routine-failed-${id}`,
      },
    });
  });

  it("only when it's news: not again while it keeps failing, again after Run Now, a success or a day", async () => {
    await run("failed");  // still broken: no push
    await appCall(s, lena, "POST", `/v1/app/routines/${id}/run`);
    const manual = await run("failed");
    await pushes(2);
    expect(sent[1]!.message.url).toContain(manual);

    await run("succeeded");
    await run("succeeded");  // no push for a success
    const afterSuccess = await run("failed");
    await pushes(3);
    expect(sent[2]!.message.url).toContain(afterSuccess);

    await s.t.run(async (ctx) => {
      const r = (await ctx.db.query("routines").collect())[0]!;
      await ctx.db.patch(r._id, { failureNoticeAt: Date.now() - 25 * 3600_000 });
    });
    const dayLater = await run("failed");
    await pushes(4);
    expect(sent[3]!.message.url).toContain(dayLater);
  });

  it("a token from the other environment is moved there; one Apple refuses in both goes", async () => {
    refused.add(`${TOKEN}:true`);
    await appCall(s, lena, "POST", `/v1/app/routines/${id}/run`);
    await run("failed");
    await pushes(5);
    expect(sent[4]!.device.sandbox).toBe(false);
    await vi.waitFor(async () => expect(await devices()).toMatchObject([{ token: TOKEN, sandbox: false }]));

    refused.add(`${TOKEN}:false`);
    await appCall(s, lena, "POST", `/v1/app/routines/${id}/run`);
    await run("failed");
    await vi.waitFor(async () => expect(await devices()).toEqual([]));
    expect(sent).toHaveLength(5);
    refused.clear();
  });

  it("signing out takes the device back; only its own account can", async () => {
    await appCall(s, lena, "PUT", "/v1/app/push-device", { token: TOKEN, sandbox: false, platform: "macos" });
    expect((await appCall(s, ben, "DELETE", `/v1/app/push-device/${TOKEN}`)).status).toBe(204);
    expect(await devices()).toHaveLength(1);
    expect((await appCall(s, lena, "DELETE", `/v1/app/push-device/${TOKEN}`)).status).toBe(204);
    expect(await devices()).toEqual([]);
  });

  it("a device signed in to another account moves there, and goes with that account", async () => {
    await appCall(s, lena, "PUT", "/v1/app/push-device", { token: TOKEN, sandbox: true, platform: "ios" });
    await appCall(s, ben, "PUT", "/v1/app/push-device", { token: TOKEN, sandbox: true, platform: "ios" });
    const [row] = await devices();
    const benUid = (await appCall(s, ben, "GET", "/v1/app/me")).json.user as { uid: string };
    expect(String(row!.userId)).toBe(benUid.uid);
    expect((await appCall(s, ben, "DELETE", "/v1/app/me", {})).status).toBe(200);
    expect(await devices()).toEqual([]);
  });
});
