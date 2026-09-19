/**
 * Reference agent integration — the smallest useful MCP *client* for this server.
 *
 * Spawns `npx tsx src/server.ts` over stdio, lists the tools, then calls three
 * read-only tools and prints what comes back. This is what an agent framework does
 * under the hood; it is deliberately framework-free so the wiring stays visible.
 *
 * This example hits live networks (Liqwid GraphQL, Indigo analytics). It is an
 * example, not a test — `npm test` stays fully mocked and offline.
 *
 *   npm run demo
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A mainnet address for a real, currently open Indigo CDP owner.
 *
 * Indigo publishes no "well-known" demo address. This one is derived from a payment
 * key hash that appears in Indigo's public analytics feed (GET /api/cdps), rendered
 * as an enterprise address. `get_position` matches CDPs by payment credential, so it
 * resolves the same public positions the feed shows. Nobody advertised this address,
 * and CDPs get closed — if the call returns zero positions, pick another `owner`
 * from https://analytics.indigoprotocol.io/api/cdps and re-derive.
 */
const INDIGO_CDP_ADDRESS = 'addr1v87vyz5y8ggz7qa45elzm9t8l36vwrpv9s55hp06svyxvygk3lza2';

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}

function print(label: string, result: CallToolResult, maxChars = 900): void {
  const body = textOf(result);
  const shown = body.length > maxChars ? `${body.slice(0, maxChars)}\n… (${body.length} chars total)` : body;
  console.log(`\n── ${label}${result.isError ? ' [error]' : ''} ──\n${shown}`);
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/server.ts'],
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });

  const client = new Client({ name: 'bazaarswap-reference-agent', version: '0.1.0' });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    console.log(`connected — ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

    print(
      'list_venues { category: "cdp" }',
      (await client.callTool({ name: 'list_venues', arguments: { category: 'cdp' } })) as CallToolResult,
    );

    print(
      'get_market_data {}',
      (await client.callTool({ name: 'get_market_data', arguments: {} })) as CallToolResult,
    );

    print(
      `get_position { protocol: "indigo", address: "${INDIGO_CDP_ADDRESS.slice(0, 12)}…" }`,
      (await client.callTool({
        name: 'get_position',
        arguments: { protocol: 'indigo', address: INDIGO_CDP_ADDRESS },
      })) as CallToolResult,
    );
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error('reference agent failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
