import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CapabilityNodeSchema,
  McpSchema,
  VenueSchema,
  type CapabilityNode,
  type Category,
  type Mcp,
  type Venue,
} from './schema.js';

export * from './schema.js';

// src/taxonomy/ and dist/taxonomy/ are both one level below the repo root.
export const TAXONOMY_ROOT = fileURLToPath(new URL('../../taxonomy', import.meta.url));

export interface VenueFilter {
  category?: Category;
  asset?: string;
  /** A capability id or group, e.g. "lend.borrow" or "lend". */
  capability?: string;
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid ${label}: not valid JSON (${(err as Error).message})`);
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid ${label}: ${issues}`);
  }
  return result.data;
}

/** Every `<dir>/*.json`, sorted by filename and schema-checked. */
function readRecords<T>(dir: string, schema: z.ZodType<T>, kind: string): Array<{ file: string; record: T }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const label = `${kind} file ${file}`;
      return { file, record: parseOrThrow(schema, readJson(join(dir, file), label), label) };
    });
}

export function loadCapabilities(root = TAXONOMY_ROOT): CapabilityNode[] {
  const label = 'capabilities.json';
  const nodes = parseOrThrow(z.array(CapabilityNodeSchema), readJson(join(root, label), label), label);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) throw new Error(`Invalid capabilities.json: duplicate id '${node.id}'`);
    seen.add(node.id);
  }
  return nodes;
}

/** True when `id` is `query` itself or sits under the group `query` ("lend" matches "lend.borrow"). */
export function matchesCapability(id: string, query: string): boolean {
  return id === query || id.startsWith(`${query}.`);
}

export function loadVenues(root = TAXONOMY_ROOT): Venue[] {
  const known = new Set(loadCapabilities(root).map((c) => c.id));
  const owner = new Map<string, string>();
  return readRecords(join(root, 'venues'), VenueSchema, 'venue').map(({ file, record }) => {
    const unknown = record.capabilities.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      throw new Error(
        `Invalid venue file ${file}: ${unknown.map((c) => `'${c}'`).join(', ')} not in capabilities.json`,
      );
    }
    // A hash may appear under several roles in one venue (a V3 script can spend and stake),
    // but never in two venues: the guard must name exactly one venue per contract.
    for (const { hash } of record.scripts ?? []) {
      const first = owner.get(hash);
      if (first !== undefined && first !== record.id) {
        throw new Error(`Invalid venue file ${file}: script ${hash} is already listed by venue '${first}'`);
      }
      owner.set(hash, record.id);
    }
    return record;
  });
}

export function listVenues(filter?: VenueFilter, root = TAXONOMY_ROOT): Venue[] {
  let venues = loadVenues(root);
  if (!filter) return venues;

  if (filter.category) {
    venues = venues.filter((v) => v.category === filter.category);
  }
  if (filter.asset) {
    const asset = filter.asset.toLowerCase();
    venues = venues.filter((v) => v.assets.some((a) => a.toLowerCase() === asset));
  }
  if (filter.capability) {
    const query = filter.capability.trim().toLowerCase();
    venues = venues.filter((v) => v.capabilities.some((c) => matchesCapability(c, query)));
  }
  return venues;
}

export function getVenue(id: string, root = TAXONOMY_ROOT): Venue | undefined {
  return loadVenues(root).find((v) => v.id === id);
}

export function searchVenues(q: string, root = TAXONOMY_ROOT): Venue[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];

  return loadVenues(root).filter((v) =>
    [v.id, v.name, v.description, ...v.assets].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

export function loadMcps(root = TAXONOMY_ROOT): Mcp[] {
  const capabilities = new Set(loadCapabilities(root).map((c) => c.id));
  const venues = new Set(loadVenues(root).map((v) => v.id));

  return readRecords(join(root, 'mcps'), McpSchema, 'MCP').map(({ file, record }) => {
    const problems: string[] = [];
    const names = new Set<string>();
    for (const tool of record.tools) {
      if (names.has(tool.name)) problems.push(`duplicate tool '${tool.name}'`);
      names.add(tool.name);
      if (!capabilities.has(tool.capability)) {
        problems.push(`tool '${tool.name}' capability '${tool.capability}' not in capabilities.json`);
      }
      for (const v of tool.venues ?? []) {
        if (!venues.has(v)) problems.push(`tool '${tool.name}' venue '${v}' is not a venue id`);
      }
    }
    if (problems.length > 0) throw new Error(`Invalid MCP file ${file}: ${problems.join('; ')}`);
    return record;
  });
}

export function getMcp(id: string, root = TAXONOMY_ROOT): Mcp | undefined {
  return loadMcps(root).find((m) => m.id === id);
}
