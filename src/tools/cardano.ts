import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getBalance } from '../adapters/blockfrost.js';
import { getMarkets, getPositions as getLiqwidPositions } from '../adapters/liqwid.js';
import { getPositions as getIndigoPositions } from '../adapters/indigo.js';
import { toolResult } from './result.js';

export function registerCardanoTools(server: McpServer): void {
  server.registerTool(
    'get_balance',
    {
      title: 'Get a Cardano address balance',
      description:
        'Read the ADA and native-asset balance of a Cardano address from Blockfrost. Read-only. ' +
        'Requires BLOCKFROST_PROJECT_ID; an address never seen on-chain reports a zero balance.',
      inputSchema: {
        address: z.string().min(1).describe('Bech32 Cardano address (addr1... / addr_test1...)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address }) => toolResult(() => getBalance(address)),
  );

  server.registerTool(
    'get_position',
    {
      title: 'Get DeFi positions for an address',
      description:
        'Read open positions for a Cardano address: Indigo CDPs (collateral, minted iAsset debt, frozen flag, ' +
        'and the CDP out-ref that close_cdp needs) or Liqwid loans (debt, collateral value, health factor, LTV). ' +
        'Read-only.',
      inputSchema: {
        protocol: z.enum(['indigo', 'liqwid']).describe('Which protocol to read positions from'),
        address: z.string().min(1).describe('Bech32 Cardano address that owns the positions'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ protocol, address }) =>
      toolResult(async () => {
        const positions =
          protocol === 'indigo' ? await getIndigoPositions(address) : await getLiqwidPositions(address);
        return { protocol, address, count: positions.length, positions };
      }),
  );

  server.registerTool(
    'get_market_data',
    {
      title: 'Get Liqwid market rates',
      description:
        'Read live Liqwid v2 money-market data: supply APY, borrow APR and utilization per market. Read-only, ' +
        'no API key needed. Pass `asset` to filter to one market by its display name (e.g. "ADA", "iUSD").',
      inputSchema: {
        asset: z.string().optional().describe('Filter to one market by display name, case-insensitive'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ asset }) =>
      toolResult(async () => {
        const markets = await getMarkets();
        const filtered = asset
          ? markets.filter((m) => m.asset.toLowerCase() === asset.toLowerCase())
          : markets;
        return { venue: 'liqwid', count: filtered.length, markets: filtered };
      }),
  );
}
