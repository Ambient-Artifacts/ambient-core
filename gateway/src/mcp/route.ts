import express, { type Request, type Response, type Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuthError, type ResourceTarget, type createBearerVerifier } from "../auth/bearer.ts";
import type { RoutineService } from "../routines/service.ts";
import { personalInstructions } from "./context.ts";
import { buildMcpServer, type ReaderSource } from "./tools.ts";

export const MCP_SCOPES = ["personal:read", "personal:write", "team:read", "team:write"];
export const TEAM_MCP_SCOPES = ["team:read", "team:write"];

export function resourceMetadataUrl(origin: string, resourcePath: string): string {
  return `${origin}/.well-known/oauth-protected-resource${resourcePath}`;
}

/** RFC 9728 protected-resource metadata for /mcp and /t/<slug>/mcp. */
export function protectedResourceRouter(origin: string): Router {
  const router = express.Router();
  const doc = (resourcePath: string, scopes: string[], name: string) => ({
    resource: `${origin}${resourcePath}`,
    authorization_servers: [origin],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    resource_name: name,
  });
  router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.json(doc("/mcp", MCP_SCOPES, "Ambient"));
  });
  router.get("/.well-known/oauth-protected-resource/t/:slug/mcp", (req, res) => {
    res.json(doc(`/t/${req.params.slug}/mcp`, TEAM_MCP_SCOPES, `Ambient team ${req.params.slug}`));
  });
  return router;
}

export function mcpRouter(deps: {
  origin: string;
  verify: ReturnType<typeof createBearerVerifier>;
  readers: ReaderSource;
  routines?: RoutineService;
  version: string;
  /** The user's name, for the instructions an app gets when it connects. */
  userName?: (uid: string) => Promise<string | undefined>;
}): Router {
  const router = express.Router();

  // OpenAI's connector may omit "text/event-stream" from Accept; the SDK
  // rejects that with 406. The SDK reads rawHeaders, so patch both.
  router.use(["/mcp", "/t/:slug/mcp"], (req, _res, next) => {
    if (!req.headers.accept?.includes("text/event-stream")) {
      req.headers.accept = "application/json, text/event-stream";
      req.rawHeaders.push("Accept", "application/json, text/event-stream");
    }
    next();
  });

  const handle = async (req: Request, res: Response, target: ResourceTarget, resourcePath: string) => {
    let principal;
    try {
      const proof = req.headers.dpop;
      principal = await deps.verify(req.headers.authorization, target, { method: req.method, proof: typeof proof === "string" ? proof : undefined });
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      const params = [`resource_metadata="${resourceMetadataUrl(deps.origin, resourcePath)}"`];
      if (err.code !== "invalid_request") params.push(`error="${err.code}"`, `error_description="${err.message}"`);
      if (err.code === "insufficient_scope") params.push(`scope="${target.teamSlug ? TEAM_MCP_SCOPES.join(" ") : MCP_SCOPES.join(" ")}"`);
      res.status(err.status).set("WWW-Authenticate", `Bearer ${params.join(", ")}`).json({ error: err.code, error_description: err.message });
      return;
    }

    // Instructions reach the model only through `initialize`: only then are they made for this user.
    const body = req.body as unknown;
    const connecting = (Array.isArray(body) ? body : [body]).some((m) => (m as { method?: unknown } | null)?.method === "initialize");
    const personal = connecting
      ? await personalInstructions(principal, deps.readers, { name: await deps.userName?.(principal.uid).catch(() => undefined) })
      : null;
    const server = buildMcpServer({ principal, readers: deps.readers, routines: deps.routines, version: deps.version, personal });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  router.post("/mcp", express.json({ limit: "1mb" }), (req, res) =>
    handle(req, res, { url: `${deps.origin}/mcp`, teamSlug: null }, "/mcp"),
  );
  router.post("/t/:slug/mcp", express.json({ limit: "1mb" }), (req, res) => {
    const slug = String(req.params.slug);
    return handle(req, res, { url: `${deps.origin}/t/${slug}/mcp`, teamSlug: slug }, `/t/${slug}/mcp`);
  });

  // Stateless server: no server→client stream and no sessions to delete.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });
  };
  router.get(["/mcp", "/t/:slug/mcp"], notAllowed);
  router.delete(["/mcp", "/t/:slug/mcp"], notAllowed);
  return router;
}
