// The relay between a run and the MCP servers its owner connected (bots/mcp-connections.ts): a
// bot's run, or Amb's session on a computer, speaks MCP to the gateway at /v1/bot/mcp/<id> with its
// own token; the gateway checks on every request that the bot (or Amb) has that connection now,
// and calls the service with the connection's key. The run never sees the key.
//
// Stateless, as the gateway's own /mcp: one MCP server per request, tools only.
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { sha256Hex } from "../crypto.ts";
import { api, type Control } from "../control.ts";
import { addressKey, strikes } from "../limiter.ts";
import type { Owner } from "../routines/keys.ts";
import { RUN_TOKEN_PREFIX } from "../routines/service.ts";
import { McpConnectionError, type McpConnections } from "./mcp-connections.ts";

type Who = { owner: Owner; who: { routineId: string } | { amb: true } };

export function mcpRelayPath(id: string): string {
  return `/v1/bot/mcp/${id}`;
}

export function mcpRelayRouter(d: {
  connections: () => McpConnections | undefined;
  control: Control;
  /** Whose token it is, when it's the one Amb's session on a computer holds (bots/computer.ts). */
  ambUid?: (token: string) => string | null;
  version: string;
}): Router {
  const r = express.Router();
  // Made-up tokens cost a database lookup each: an address that keeps failing waits a minute.
  const failures = strikes(60, 60_000);

  r.use("/v1/bot/mcp/:id", (req, _res, next) => {
    if (!req.headers.accept?.includes("text/event-stream")) {
      req.headers.accept = "application/json, text/event-stream";
      req.rawHeaders.push("Accept", "application/json, text/event-stream");
    }
    next();
  });

  /** Whose run this is: a bot's (its run token, while it runs) or Amb's session for a person. */
  const identify = async (authorization: string | undefined): Promise<Who | null> => {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) return null;
    if (token.startsWith(RUN_TOKEN_PREFIX)) {
      const run = await d.control.q(api.bots.runOwner, { runTokenHash: sha256Hex(token) });
      if (!run) return null;
      const owner: Owner = run.teamId ? { kind: "team", teamId: String(run.teamId) } : { kind: "user", uid: String(run.createdBy) };
      return { owner, who: { routineId: String(run.routineId) } };
    }
    const uid = d.ambUid?.(token);
    return uid ? { owner: { kind: "user", uid }, who: { amb: true } } : null;
  };

  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const connections = d.connections();
    if (!connections) return res.status(404).json({ error: "not_found" });
    const address = addressKey(req.ip);
    if (failures.blocked(address)) return res.status(429).json({ error: "slow_down" });
    try {
      const me = await identify(req.headers.authorization);
      if (!me) {
        failures.add(address);
        return res.status(401).json({ error: "invalid_token", error_description: "This run is over." });
      }
      const granted = await connections.granted(me.owner, String(req.params.id), me.who);
      // Not theirs, taken away or removed: the same answer, so a run can't probe for ids.
      if (!granted) return res.status(404).json({ error: "not_found", error_description: "This connection isn't given to you." });
      res.locals.me = me;
      res.locals.granted = granted;
      next();
    } catch (err) {
      next(err);
    }
  };

  const handle = async (req: Request, res: Response) => {
    const connections = d.connections()!;
    const me = res.locals.me as Who;
    const granted = res.locals.granted as { name: string; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
    const id = String(req.params.id);
    const server = new Server({ name: granted.name, version: d.version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: granted.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object" as const, ...t.inputSchema } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const out = await connections.call(me.owner, id, me.who, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
        return out as never;
      } catch (err) {
        // The model reads why, and can say so; nothing of the key or the address is in it.
        const text = err instanceof McpConnectionError ? err.message : `${granted.name} didn't answer: ${(err as Error).message.slice(0, 300)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  r.post("/v1/bot/mcp/:id", authenticate, express.json({ limit: "4mb" }), handle);
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });
  };
  r.get("/v1/bot/mcp/:id", notAllowed);
  r.delete("/v1/bot/mcp/:id", notAllowed);
  return r;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function page(title: string, body: string, ok: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${ok ? '<meta http-equiv="refresh" content="1;url=ambient://connections">' : ""}<title>${esc(title)}</title><style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.25rem;color:#1d1d1f;background:#fbfaf7}a{color:inherit}@media(prefers-color-scheme:dark){body{color:#f5f5f7;background:#141414}}</style></head><body><h1>${esc(title)}</h1>${body}${ok ? '<p><a href="ambient://connections">Back to Ambient</a></p>' : ""}</body></html>`;
}

/**
 * Where a service sends the person back after its sign-in page (bots/mcp-connections.ts): the
 * code and the state it was started with. The state says whose sign-in it is; nothing else does.
 */
export function mcpSignInRouter(connections: () => McpConnections | undefined): Router {
  const r = express.Router();
  r.get("/v1/mcp/connected", async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "text/html; charset=utf-8");
    const mcp = connections();
    if (!mcp) return res.status(404).send(page("Not set up", "<p>Connections aren't set up on this Ambient server.</p>", false));
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (typeof req.query.error === "string" || !code) {
      return res.status(400).send(page("Not connected", "<p>The sign-in wasn't allowed. Start it again in Ambient whenever you like.</p>", false));
    }
    try {
      const out = await mcp.finishSignIn(state, code);
      res.send(page(`${out.name} is connected`, "<p>Give it to a bot or to Ambient under Connections.</p>", true));
    } catch (err) {
      const message = err instanceof McpConnectionError ? err.message : "That didn't work. Start the sign-in again in Ambient.";
      res.status(err instanceof McpConnectionError ? err.status : 500).send(page("Not connected", `<p>${esc(message)}</p>`, false));
    }
  });
  return r;
}
