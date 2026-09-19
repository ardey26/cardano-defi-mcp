import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CapabilitySchema, CategorySchema, getVenue, listVenues, searchVenues } from '../taxonomy/index.js';
import { toolResult } from './result.js';

export function registerTaxonomyTools(server: McpServer): void {
  server.registerTool(
    'list_venues',
    {
      title: 'List Cardano DeFi venues',
      description:
        'List the indexed Cardano DeFi venues (DEXes, lending markets, CDP and stablecoin protocols, perps). ' +
        'Optionally filter by category, asset ticker or capability, or pass `query` for a free-text search over ' +
        'id, name, description and assets. Read-only: returns index data, not live chain state.',
      inputSchema: {
        category: CategorySchema.optional().describe('Venue category filter'),
        asset: z.string().optional().describe('Asset ticker the venue must list, e.g. "ADA" or "iUSD"'),
        capability: CapabilitySchema.optional().describe('Capability the venue must offer, e.g. "borrow"'),
        query: z.string().optional().describe('Free-text search; when set, the other filters are ignored'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ category, asset, capability, query }) =>
      toolResult(async () => {
        const venues = query ? searchVenues(query) : listVenues({ category, asset, capability });
        return { count: venues.length, venues };
      }),
  );

  server.registerTool(
    'get_venue',
    {
      title: 'Get one Cardano DeFi venue',
      description:
        'Get the full taxonomy record for one venue by id (e.g. "minswap", "liqwid", "indigo"): category, url, ' +
        'assets, capabilities, integration level and caveats. Read-only.',
      inputSchema: {
        id: z.string().min(1).describe('Venue id, e.g. "indigo"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      toolResult(async () => {
        const venue = getVenue(id);
        if (!venue) {
          throw new Error(`Unknown venue '${id}'. Call list_venues to see the available ids.`);
        }
        return venue;
      }),
  );
}
