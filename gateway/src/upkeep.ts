// Upkeep on your computer (docs/architecture.md, "Upkeep on your computer"). Keeping a person's
// brain current (their people and project pages, the overview, their own page) and writing the
// notes of their work sessions takes a model; that model is Claude Code on their own computer,
// signed in with their Claude plan, never a key of Ambient's. The gateway keeps the prompts, the
// merging and the writing; only the answer comes from the computer, through the connection the
// chat already uses (bots/computer.ts). Without a connected computer, notes wait.
//
// The worker runs in a process of its own, so it reaches the computers through the gateway's
// internal routes (internalRouter below), with the service secret.
import { timingSafeEqual } from "node:crypto";
import express, { type Router } from "express";
import { z } from "zod";
import { toWire, type Llm, type LlmAnswer, type WireRequest } from "@brain/team";
import { ComputerUnavailable, type AmbientComputers } from "./bots/computer.ts";
import type { RoutineService } from "./routines/service.ts";
import type { Relay, RelayRequest } from "./relay.ts";

/**
 * Whether the server's own ANTHROPIC_API_KEY may pay for the brain's upkeep, work-session notes and
 * Ambient's chat without a computer: only when the operator says so (self-hosting). Ambient's own
 * servers don't: every person's AI runs on their computer and their Claude plan.
 */
export function useServerKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRAIN_USE_SERVER_KEY === "true";
}

export interface UpkeepComputer {
  id: string;
  name: string;
  connected: boolean;
}

/** Where a person's upkeep runs, and running one answer there. */
export interface UpkeepComputers {
  computerFor(uid: string): Promise<UpkeepComputer | null>;
  complete(uid: string, req: WireRequest): Promise<LlmAnswer>;
}

/** In the gateway: the person's own computers (never a team's), a connected one first. */
export class Upkeep implements UpkeepComputers {
  constructor(private d: { routines: Pick<RoutineService, "computersOf">; computers: Pick<AmbientComputers, "connected" | "complete"> }) {}

  async computerFor(uid: string): Promise<UpkeepComputer | null> {
    // A team's server runs Ambient for its people too, but a person's own notes never go there.
    const own = (await this.d.routines.computersOf(uid)).filter((c) => c.team === null);
    if (!own.length) return null;
    const pick = own.find((c) => this.d.computers.connected(c.id)) ?? own[0]!;
    return { id: pick.id, name: pick.name, connected: this.d.computers.connected(pick.id) };
  }

  async complete(uid: string, req: WireRequest): Promise<LlmAnswer> {
    const c = await this.computerFor(uid);
    if (!c) throw new ComputerUnavailable("no_computer");
    if (!c.connected) throw new ComputerUnavailable("offline");
    return this.d.computers.complete(c.id, req);
  }
}

/** A person's upkeep as an Llm (team/src/llm.ts): every answer from their computer. */
export function computerLlm(computers: UpkeepComputers, uid: string): Llm {
  return { parse: (req) => computers.complete(uid, toWire(req)) };
}

/** In the worker: the same, through the gateway's internal routes. */
export class GatewayUpkeep implements UpkeepComputers {
  constructor(
    private url: string,
    private secret: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.url.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 409 && ["no_computer", "offline", "timeout"].includes(String(json.error))) throw new ComputerUnavailable(json.error as "no_computer");
    if (!res.ok) throw new Error(String(json.message ?? `the gateway answered ${res.status}`));
    return json;
  }

  async computerFor(uid: string): Promise<UpkeepComputer | null> {
    return ((await this.post("/v1/internal/upkeep/computer", { uid }, 15_000)).computer as UpkeepComputer | null) ?? null;
  }

  async complete(uid: string, req: WireRequest): Promise<LlmAnswer> {
    return (await this.post("/v1/internal/upkeep/complete", { uid, request: req }, 6 * 60_000)) as unknown as LlmAnswer;
  }
}

const Wire = z.object({
  model: z.string().regex(/^[A-Za-z0-9._\[\]-]{1,80}$/),
  maxTokens: z.number().int().min(1).max(64_000),
  system: z.string().max(200_000),
  user: z.string().max(4_000_000),
  schema: z.record(z.string(), z.unknown()),
  what: z.string().max(80),
});

/** The worker's way to the computers: only with the service secret (the worker has it, nobody else). */
export function internalRouter(d: { secret: string; upkeep: UpkeepComputers; relay?: Relay }): Router {
  const r = express.Router();
  const want = Buffer.from(`Bearer ${d.secret}`);
  r.use("/v1/internal", (req, res, next) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  const json = express.json({ limit: "8mb" });
  r.post("/v1/internal/upkeep/computer", json, async (req, res) => {
    const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
    if (!uid) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    res.json({ computer: await d.upkeep.computerFor(uid) });
  });
  r.post("/v1/internal/upkeep/complete", json, async (req, res) => {
    const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
    const wire = Wire.safeParse(req.body?.request);
    if (!uid || !wire.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    try {
      res.json(await d.upkeep.complete(uid, wire.data));
    } catch (err) {
      if (err instanceof ComputerUnavailable) res.status(409).json({ error: err.reason, message: err.message });
      else res.status(502).json({ error: "failed", message: (err as Error).message.slice(0, 500) });
    }
  });
  // The worker's requests for a team's brain on its computer (relay.ts), answered as is.
  r.post("/v1/internal/relay", json, async (req, res) => {
    const hostId = typeof req.body?.hostId === "string" ? req.body.hostId : "";
    const rq = req.body?.request as RelayRequest | undefined;
    if (!d.relay || !hostId || !rq || typeof rq.path !== "string" || !rq.path.startsWith("/") || typeof rq.method !== "string") {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs) || 60_000, 1000), 300_000);
    try {
      const out = await d.relay(hostId, { method: rq.method, path: rq.path, headers: rq.headers ?? {}, body: rq.body ?? null }, timeoutMs);
      res.setHeader("x-ambient-status", String(out.status));
      res.setHeader("x-ambient-headers", Buffer.from(JSON.stringify(out.headers)).toString("base64"));
      res.status(200).end(out.body);
    } catch (err) {
      res.status(err instanceof ComputerUnavailable ? 409 : 502).json({ error: err instanceof ComputerUnavailable ? err.reason : "failed", message: (err as Error).message.slice(0, 300) });
    }
  });
  return r;
}

/** What the worker records while a person's notes wait for their computer (personalWork.lastResult). */
export interface WaitingResult {
  waiting: "no_computer" | "offline";
  computer: string | null;
  /** Notes not yet in their pages. */
  pending: number;
  /** personalSeq when this was recorded: the same seq and reason aren't looked at again. */
  seq: number;
  /** When the pages were last brought up to date, if ever. */
  lastOkAt: number | null;
}

export interface UpkeepState {
  state: "off" | "current" | "pending" | "no_computer" | "offline" | "failed";
  pending: number;
  lastRunAt: number | null;
  computer: string | null;
  message: string | null;
}

const OK = new Set(["ok", "noop", "partial"]);

function parsed(json: string | null | undefined): Record<string, unknown> {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** When the pages were last brought up to date, from the last run (a waiting record carries it on). */
export function lastOk(work: { lastRunAt: number; lastStatus: string; lastResult?: string | null } | null): number | null {
  if (!work) return null;
  if (OK.has(work.lastStatus)) return work.lastRunAt;
  const at = parsed(work.lastResult).lastOkAt;
  return typeof at === "number" ? at : null;
}

/** The app's view of a person's upkeep (GET /v1/app/me/upkeep). */
export function upkeepState(o: {
  on: boolean;
  work: { lastSeq: number; lastRunAt: number; lastStatus: string; lastResult?: string | null } | null;
  seq: number;
  computer: UpkeepComputer | null;
}): UpkeepState {
  const last = parsed(o.work?.lastResult);
  const due = o.seq > (o.work?.lastSeq ?? 0);
  const pending = o.work?.lastStatus === "waiting" && typeof last.pending === "number" ? last.pending : 0;
  const base = { pending, lastRunAt: lastOk(o.work), computer: o.computer?.name ?? null, message: null };
  if (!o.on) return { ...base, state: "off" };
  if (!o.computer) return { ...base, state: "no_computer" };
  if (!o.computer.connected) return { ...base, state: "offline" };
  if (o.work?.lastStatus === "failed") {
    const error = typeof last.error === "string" ? last.error : null;
    return { ...base, state: "failed", message: error ? `Updating your pages failed: ${error.slice(0, 200)}` : "Updating your pages failed. It's tried again soon." };
  }
  if (due || o.work?.lastStatus === "waiting") return { ...base, state: "pending" };
  return { ...base, state: "current" };
}
