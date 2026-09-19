#!/usr/bin/env node
/**
 * BazaarSwap Cardano MCP server (stdio).
 *
 * stdout is the JSON-RPC transport: never `console.log`. Diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools/index.js';

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'bazaarswap-cardano', version: '0.1.0' },
    {
      instructions:
        'Cardano DeFi rails: browse a taxonomy of Cardano venues, quote cross-chain swaps into ADA through ' +
        'the BazaarSwap routing backend, read balances and Indigo/Liqwid positions, and build UNSIGNED ' +
        'transactions. This server holds no keys and no funds; every fund-touching tool returns a transaction ' +
        'for you to sign and submit yourself.',
    },
  );

  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('bazaarswap-cardano MCP server ready on stdio');
}

main().catch((err: unknown) => {
  console.error('bazaarswap-cardano MCP server failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
