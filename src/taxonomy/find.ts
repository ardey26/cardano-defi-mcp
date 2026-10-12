/**
 * Joins the three record sets into the answer an agent needs: which venues
 * offer a capability, which MCP tools can do it there, and where nothing can.
 */

import {
  TAXONOMY_ROOT,
  getVenue,
  listVenues,
  loadCapabilities,
  loadMcps,
  loadVenues,
  matchesCapability,
} from './index.js';
import type { CapabilityNode, Effect } from './schema.js';

export interface FindQuery {
  capability: string;
  asset?: string;
  venue?: string;
}

export interface AgentPath {
  capability: string;
  /** null for a venue-agnostic tool (a wallet, or an aggregator that names no venues). */
  venue: string | null;
  mcp: string;
  tool: string;
  effect: Effect;
  official: boolean;
  /** Callable on the server the agent is already connected to. */
  here: boolean;
}

export interface Gap {
  venue: string;
  capability: string;
}

export interface FindResult {
  capability: string;
  venues: Array<{ id: string; name: string; capabilities: string[]; assets: string[] }>;
  paths: AgentPath[];
  gaps: Gap[];
}

export interface CapabilitySummary extends CapabilityNode {
  venues: number;
  tools: number;
}

const EFFECT_RANK: Record<Effect, number> = { read: 0, unsigned_tx: 1, signs: 2 };

// Callable now beats needs-install; holding no keys beats signing; the venue's own team beats a third party.
function comparePaths(a: AgentPath, b: AgentPath): number {
  return (
    Number(b.here) - Number(a.here) ||
    EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect] ||
    Number(b.official) - Number(a.official) ||
    a.mcp.localeCompare(b.mcp) ||
    a.tool.localeCompare(b.tool) ||
    (a.venue ?? '').localeCompare(b.venue ?? '')
  );
}

export function findCapability(query: FindQuery, here: readonly string[], root = TAXONOMY_ROOT): FindResult {
  const capability = query.capability.trim().toLowerCase();
  const nodes = loadCapabilities(root);
  if (!nodes.some((n) => matchesCapability(n.id, capability))) {
    const groups = [...new Set(nodes.map((n) => n.id.split('.')[0]))];
    throw new Error(
      `Unknown capability '${query.capability}'. Pass a group (${groups.join(', ')}) ` +
        'or a capability id from list_capabilities.',
    );
  }
  const venueFilter = query.venue?.trim().toLowerCase();
  if (venueFilter && !getVenue(venueFilter, root)) {
    throw new Error(`Unknown venue '${query.venue}'. Call list_venues to see the available ids.`);
  }

  // Tool paths match against every venue in scope, not only venues whose record
  // lists the capability: venues list what they offer (lend.*), while agent-side
  // capabilities like data.position never appear on a venue record.
  const inScope = listVenues({ asset: query.asset }, root).filter((v) => !venueFilter || v.id === venueFilter);
  const scopeIds = new Set(inScope.map((v) => v.id));
  const venues = inScope.filter((v) => v.capabilities.some((c) => matchesCapability(c, capability)));

  const paths: AgentPath[] = [];
  for (const server of loadMcps(root)) {
    for (const tool of server.tools) {
      if (!matchesCapability(tool.capability, capability)) continue;
      const base = {
        capability: tool.capability,
        mcp: server.id,
        tool: tool.name,
        effect: tool.effect,
        official: server.official,
        here: here.includes(server.id),
      };
      if (!tool.venues) {
        // A tool that names no venue cannot claim the one the agent asked about.
        if (!venueFilter) paths.push({ ...base, venue: null });
        continue;
      }
      for (const v of tool.venues) {
        if (scopeIds.has(v)) paths.push({ ...base, venue: v });
      }
    }
  }
  paths.sort(comparePaths);

  const gaps = venues.flatMap((v) =>
    v.capabilities
      .filter((c) => matchesCapability(c, capability))
      .filter((c) => !paths.some((p) => p.venue === v.id && p.capability === c))
      .map((c) => ({ venue: v.id, capability: c })),
  );

  return {
    capability,
    venues: venues.map((v) => ({
      id: v.id,
      name: v.name,
      capabilities: v.capabilities.filter((c) => matchesCapability(c, capability)),
      assets: v.assets,
    })),
    paths,
    gaps,
  };
}

export function listCapabilities(root = TAXONOMY_ROOT): CapabilitySummary[] {
  const venues = loadVenues(root);
  const tools = loadMcps(root).flatMap((m) => m.tools);
  return loadCapabilities(root).map((node) => ({
    ...node,
    venues: venues.filter((v) => v.capabilities.includes(node.id)).length,
    tools: tools.filter((t) => t.capability === node.id).length,
  }));
}
