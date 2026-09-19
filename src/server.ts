#!/usr/bin/env node
/**
 * BazaarSwap Cardano MCP server.
 *
 * Two transports, same tools:
 *   - stdio (default, local): stdout IS the JSON-RPC transport — never `console.log`.
 *   - Streamable HTTP (MCP_TRANSPORT=http, or any PORT, which is how Render starts it).
 */

import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startHttpServer } from './http.js';
import { registerTools } from './tools/index.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'cardano-defi-mcp', version: '0.1.0' },
    {
      instructions:
        'Cardano DeFi rails: browse a taxonomy of Cardano venues, quote cross-chain swaps into ADA through ' +
        'the BazaarSwap routing backend, read balances and Indigo/Liqwid positions, and build UNSIGNED ' +
        'transactions. This server holds no keys and no funds; every fund-touching tool returns a transaction ' +
        'for you to sign and submit yourself. ' +
        "Conventions: amounts are in the token's smallest unit (USDC and ADA both use 6 decimals); " +
        'Cardano\'s chain id is the string "CARDANO" and native ADA is the zero address. ' +
        'Reliability: the quote backend sleeps when idle — if get_quote returns zero routes, that is ' +
        'usually a cold start, not a missing route; wait ~30 seconds and retry once before concluding ' +
        'no route exists. Quotes expire in ~60 seconds and open_cdp transactions embed a price valid ' +
        '~280 seconds, so surface anything that needs signing immediately.',
    },
  );

  registerTools(server);
  return server;
}

export async function main(): Promise<void> {
  const transport = process.env.MCP_TRANSPORT ?? (process.env.PORT ? 'http' : 'stdio');

  if (transport === 'http') {
    const port = Number(process.env.PORT ?? 3000);
    const rateLimitPerMin = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);
    await startHttpServer({ port, createMcpServer, rateLimitPerMin });
    console.error(
      `cardano-defi-mcp MCP server ready on http://0.0.0.0:${port}/mcp ` +
        `(${rateLimitPerMin} req/min per IP, health at /health)`,
    );
    return;
  }

  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error('cardano-defi-mcp MCP server ready on stdio');
}

// Only run when executed directly, so tests can import createMcpServer without
// this file grabbing stdio.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error('cardano-defi-mcp MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
