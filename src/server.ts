import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuditLog } from "./audit.js";
import type { Ops } from "./ops.js";
import { bearer, tokenMatches } from "./token.js";
import { buildMcpServer } from "./tools.js";

export interface HttpOptions {
  ops: Ops;
  audit: AuditLog;
  /** Returns the current token; read per request so a rotated token takes effect without restart. */
  getToken: () => Promise<string | null>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * HTTP front: GET /healthz (no auth), POST/GET/DELETE /mcp (bearer auth, stateless Streamable HTTP).
 * Paths are matched by suffix (a proxy in front may add a path prefix).
 * Every `/.well-known/*` path is a plain 404: the bridge has no OAuth, and MCP clients that get our 401 probe
 * `/.well-known/oauth-protected-resource[/mcp]` and `/.well-known/oauth-authorization-server` to find one.
 */
export function createBridgeHttpServer(opts: HttpOptions): Server {
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, opts);
    } catch (e) {
      console.error(`request failed: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  });
  // wait_for_status may legitimately hold a request for up to 600s.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: HttpOptions) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");

  // Before the suffix matches: /.well-known/oauth-protected-resource/mcp ends with /mcp.
  if (isWellKnown(path)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (path.endsWith("/healthz") && req.method === "GET") {
    const [rex_reachable, watcher_heartbeat_age_s] = await Promise.all([
      opts.ops.rexReachable(),
      opts.ops.heartbeatAgeS(),
    ]);
    sendJson(res, 200, { ok: true, rex_reachable, watcher_heartbeat_age_s });
    return;
  }

  if (!path.endsWith("/mcp")) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  const expected = await opts.getToken();
  const presented = bearer(req.headers.authorization);
  if (!expected || !presented || !tokenMatches(presented, expected)) {
    // RFC 7235 wants a challenge on 401. No resource_metadata: there is no OAuth here, only a static token.
    sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="rex-grokbot-bridge"' });
    return;
  }

  if (req.method !== "POST") {
    // Stateless mode: no standalone SSE stream and no sessions to delete.
    sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { allow: "POST" });
    return;
  }

  const mcp = buildMcpServer(opts.ops, opts.audit);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

/** True for any path with a `.well-known` segment (`/.well-known/…`, or `/prefix/.well-known/…`). */
export function isWellKnown(path: string): boolean {
  return path.split("/").includes(".well-known");
}
