import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { findCapability, listCapabilities } from '../taxonomy/find.js';
import { CategorySchema, getMcp, getVenue, listVenues, searchVenues } from '../taxonomy/index.js';
import { toolResult } from './result.js';

/** `here` lists the taxonomy/mcps/ ids whose tools this server registers, so find_capability can mark them callable. */
export function registerTaxonomyTools(server: McpServer, here: readonly string[]): void {
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
        capability: z
          .string()
          .optional()
          .describe('Capability id or group the venue must offer, e.g. "lend.borrow" or "lend"'),
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
        'assets, capability ids and caveats. To see which MCP tools can act at the venue, call find_capability. Read-only.',
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

  server.registerTool(
    'list_capabilities',
    {
      title: 'List what agents can do on Cardano',
      description:
        'List the capability tree (e.g. lend.borrow, trade.swap, mint.cdp) with how many venues offer each ' +
        'capability and how many MCP tools can perform it. Use an id or a group ("lend") with find_capability. ' +
        'Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      toolResult(async () => {
        const capabilities = listCapabilities();
        return { count: capabilities.length, capabilities };
      }),
  );

  server.registerTool(
    'find_capability',
    {
      title: 'Find venues and MCP tools for a capability',
      description:
        'Answer "how can an agent do X on Cardano?". Returns the venues offering the capability, the MCP tools ' +
        'that can perform it ranked best first, and gaps (venues where no MCP tool can act). A path with ' +
        '`here: true` is a tool on this server: call it directly. Otherwise call get_mcp for its connect ' +
        'config and ask the user to add that server; never claim you can use a tool that is not here. ' +
        'Ranking prefers tools that hold no keys (effect read < unsigned_tx < signs) and official servers. Read-only.',
      inputSchema: {
        capability: z.string().min(1).describe('Capability id or group, e.g. "lend.borrow" or "lend"'),
        asset: z.string().optional().describe('Only venues listing this asset ticker, e.g. "iUSD"'),
        venue: z.string().optional().describe('Only this venue id, e.g. "liqwid"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ capability, asset, venue }) =>
      toolResult(async () => findCapability({ capability, asset, venue }, here)),
  );

  server.registerTool(
    'get_mcp',
    {
      title: 'Get one MCP server record',
      description:
        'Get the taxonomy record for one MCP server by id (ids come from find_capability paths): publisher, ' +
        'whether it is official, auth, its classified tools, and `connect` — the ready-to-paste client config ' +
        'to hand the user so they can add it. Read-only.',
      inputSchema: {
        id: z.string().min(1).describe('MCP id, e.g. "cardano-defi-mcp"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      toolResult(async () => {
        const record = getMcp(id);
        if (!record) {
          throw new Error(`Unknown MCP '${id}'. MCP ids appear in find_capability results.`);
        }
        return record;
      }),
  );
}
