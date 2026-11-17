// Root commands Ambient asks to run on a computer (docs/bots.md, "Access"). On a computer with
// access "admin" each one waits for an approval card the person answers in the app (once, for
// this session, always, or deny), as OpenClaw's exec approvals do; "full" runs them without
// asking; "standard" never runs them. The computer's runner, which is root, runs them; Ambient's
// own session there stays an ordinary user.
import { api, type Control } from "../control.ts";
import type { Notifier } from "../push.ts";
import type { Owner, RoutineKeys } from "../routines/keys.ts";
import { RoutineError, type Actor, type RoutineService } from "../routines/service.ts";
import type { AmbientComputers } from "./computer.ts";

export interface Approval {
  id: string;
  computer: { id: string; name: string; team: string | null };
  command: string;
  reason: string;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: number;
  expiresAt: number;
}

export interface CommandResult {
  status: "done" | "waiting" | "denied" | "expired";
  approval?: string;
  code?: number;
  output?: string;
  message: string;
}

const PURPOSE = "host:approval";
const WAIT_MS = 90_000;
const OUTPUT_MAX = 20_000;

function refused(code: string, message: string, status = 400) {
  return new RoutineError(code, message, status);
}

export class AdminService {
  /** Commands allowed "for this session", per computer and person (until the gateway restarts). */
  private session = new Map<string, Set<string>>();

  constructor(
    private d: {
      control: Control;
      keys: RoutineKeys;
      routines: RoutineService;
      computers: AmbientComputers;
      notifier?: Notifier;
      now?: () => number;
      /** Tests: how long run_on_computer waits for a decision before it says "waiting". */
      waitMs?: number;
    },
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private owner(teamId: string | null, uid: string): Owner {
    return teamId ? { kind: "team", teamId } : { kind: "user", uid };
  }

  private async open(teamId: string | null, uid: string, iv: string, ct: string): Promise<{ command: string; reason: string }> {
    const raw = await this.d.keys.open(this.owner(teamId, uid), PURPOSE, iv, ct).catch(() => "{}");
    try {
      const j = JSON.parse(raw) as { c?: string; r?: string };
      return { command: j.c ?? "", reason: j.r ?? "" };
    } catch {
      return { command: "", reason: "" };
    }
  }

  private async run(hostId: string, command: string): Promise<CommandResult> {
    if (!this.d.computers.connected(hostId)) return { status: "waiting", message: "The computer isn't connected right now, so nothing ran. Try again once it's back online." };
    const out = await this.d.computers.exec(hostId, command).catch((err: Error) => ({ code: -1, output: err.message }));
    const output = out.output.length > OUTPUT_MAX ? `…${out.output.slice(-OUTPUT_MAX)}` : out.output;
    return { status: "done", code: out.code, output, message: `Ran as root (exit ${out.code}).` };
  }

  /** Ambient asks to run `command` as root on a computer the person may change. */
  async request(actor: Actor, ref: string, command: string, reason: string): Promise<CommandResult> {
    const cmd = command.trim();
    if (!cmd || cmd.length > 4000) throw refused("bad_request", "Give one command line, up to 4,000 characters.");
    const c = await this.d.routines.adminComputer(actor, ref);
    if (c.access === "standard") {
      throw refused("standard_access", `Ambient can't run root commands on ${c.name}: its access is Standard. The person can switch it to Admin in the Ambient app (the computer, then Ambient's access).`, 403);
    }
    const key = `${c.id}:${actor.uid}`;
    if (c.access === "full" || c.allowed.includes(cmd) || this.session.get(key)?.has(cmd)) return this.run(c.id, cmd);
    const sealed = await this.d.keys.seal(this.owner(c.hostTeamId, actor.uid), PURPOSE, JSON.stringify({ c: cmd, r: reason.trim().slice(0, 500) }));
    const made = await this.d.control.m(api.routines.requestApproval, { uid: actor.uid as never, hostId: c.id as never, iv: sealed.iv, ct: sealed.ciphertext, now: this.now() });
    const id = String(made.id);
    void this.d.notifier
      ?.notify(actor.uid, {
        title: "Ambient wants to run a command",
        body: `${c.team ? `${c.team.name}'s server` : c.name}: ${cmd.length > 140 ? `${cmd.slice(0, 139)}…` : cmd}`,
        url: `ambient://approval/${id}`,
        thread: "approvals",
        collapseId: `approval-${id}`,
      })
      .catch(() => undefined);
    return this.wait(actor, id, cmd, c.id, this.d.waitMs ?? WAIT_MS);
  }

  /** Waits for the decision (polling Convex), then runs it when allowed. */
  private async wait(actor: Actor, id: string, cmd: string, hostId: string, waitMs: number): Promise<CommandResult> {
    const until = this.now() + waitMs;
    for (;;) {
      const a = await this.d.control.q(api.routines.approval, { uid: actor.uid as never, id, now: this.now() });
      if (!a) throw refused("no_such_approval", "There's no such request.", 404);
      if (a.status === "approved") {
        if (a.decision === "session") this.session.set(`${hostId}:${actor.uid}`, new Set([...(this.session.get(`${hostId}:${actor.uid}`) ?? []), cmd]));
        return this.run(hostId, cmd);
      }
      if (a.status === "denied") return { status: "denied", approval: id, message: "They said no. Don't run it another way; ask what they'd like instead." };
      if (a.status === "expired") return { status: "expired", approval: id, message: "Nobody answered within 10 minutes, so it didn't run." };
      if (this.now() >= until) {
        return { status: "waiting", approval: id, message: `Waiting for them to allow it in the Ambient app. Check again with command_status and id ${id}.` };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /** A request's outcome: runs it now if it was allowed while nobody was waiting. */
  async status(actor: Actor, id: string): Promise<CommandResult> {
    const a = await this.d.control.q(api.routines.approval, { uid: actor.uid as never, id, now: this.now() });
    if (!a) throw refused("no_such_approval", "There's no such request.", 404);
    const host = (await this.d.routines.list(actor)).computers.find((x) => x.id === String(a.hostId));
    if (!host) throw refused("no_such_computer", "There's no such computer.", 404);
    const { command } = await this.open(host.team ? (await this.d.routines.adminComputer(actor, host.id)).hostTeamId : null, actor.uid, a.iv, a.ct);
    return this.wait(actor, id, command, host.id, 0);
  }

  /** The person's pending approvals, for the app's cards. */
  async list(actor: Actor): Promise<Approval[]> {
    const rows = await this.d.control.q(api.routines.approvals, { uid: actor.uid as never, now: this.now() });
    const computers = (await this.d.routines.list(actor)).computers;
    const out: Approval[] = [];
    for (const a of rows) {
      const c = computers.find((x) => x.id === String(a.hostId));
      if (!c) continue;
      const teamId = c.team ? (await this.d.routines.adminComputer(actor, c.id).catch(() => null))?.hostTeamId ?? null : null;
      if (c.team && !teamId) continue;
      const { command, reason } = await this.open(teamId, actor.uid, a.iv, a.ct);
      out.push({ id: String(a.id), computer: { id: c.id, name: c.team ? `${c.team.name}'s server` : c.name, team: c.team?.name ?? null }, command, reason, status: a.status, requestedAt: a.createdAt, expiresAt: a.expiresAt });
    }
    return out;
  }

  async decide(actor: Actor, id: string, decision: "once" | "session" | "always" | "deny"): Promise<Approval> {
    const pending = (await this.list(actor)).find((a) => a.id === id);
    if (!pending) throw refused("no_such_approval", "That request isn't waiting anymore.", 404);
    const out = await this.d.control.m(api.routines.decide, { uid: actor.uid as never, id, decision, command: decision === "always" ? pending.command : undefined, now: this.now() });
    if (!out.ok) throw refused(out.error, out.error === "already_decided" ? "It was already answered, or it expired." : "That request isn't waiting anymore.", 409);
    if (decision === "session") this.session.set(`${pending.computer.id}:${actor.uid}`, new Set([...(this.session.get(`${pending.computer.id}:${actor.uid}`) ?? []), pending.command]));
    return { ...pending, status: decision === "deny" ? "denied" : "approved" };
  }
}
