/**
 * Streamable HTTP transport for the MCP server (public, unauthenticated PoC host).
 *
 * Stateless: the SDK transport refuses to be reused when `sessionIdGenerator` is
 * undefined ("Stateless transport cannot be reused across requests"), so every POST
 * gets a fresh McpServer + transport pair that is torn down when the response closes.
 * No session table, nothing to leak across clients, nothing to lose on a cold start.
 *
 * The transport writes the MCP response itself but sets no CORS headers, so this
 * module owns CORS, the OPTIONS preflight, routing, /health and rate limiting.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { clientIp, RateLimiter } from './rate-limit.js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  // Browser MCP clients read these off the response; without exposing them they are invisible.
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version, www-authenticate',
  'Access-Control-Max-Age': '86400',
};

export interface HttpServerOptions {
  port: number;
  /** Factory, not an instance: stateless mode needs one server per request. */
  createMcpServer: () => McpServer;
  /** Requests per minute per IP against /mcp. */
  rateLimitPerMin?: number;
}

/** Starts the HTTP listener and resolves once it is accepting connections. */
export function startHttpServer(options: HttpServerOptions): Promise<Server> {
  const limiter = new RateLimiter(options.rateLimitPerMin ?? 60);

  const server = createServer((req, res) => {
    void handle(req, res, options.createMcpServer, limiter).catch((err: unknown) => {
      console.error('request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error');
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  createMcpServer: () => McpServer,
  limiter: RateLimiter,
): Promise<void> {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (path === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (path !== '/mcp') {
    sendJson(res, 404, { error: 'Not found. The MCP endpoint is POST /mcp.' });
    return;
  }

  const ip = clientIp(req);
  const verdict = limiter.check(ip);
  if (!verdict.allowed) {
    console.error(`rate limit hit for ${ip}`);
    res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    sendJsonRpcError(
      res,
      429,
      -32000,
      `Rate limit exceeded. Retry in ${verdict.retryAfterSeconds}s.`,
    );
    return;
  }

  // GET (server-initiated SSE) and DELETE (session teardown) only mean something with
  // sessions. Stateless, both would open or discard a transport nothing can ever write
  // to, so refuse them the way the SDK's own stateless example does.
  if (req.method !== 'POST') {
    sendJsonRpcError(res, 405, -32000, 'Method not allowed. This endpoint is stateless: use POST.');
    return;
  }

  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void mcpServer.close();
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}
