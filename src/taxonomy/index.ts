import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CapabilityNodeSchema,
  VenueSchema,
  type Capability,
  type CapabilityNode,
  type Category,
  type Venue,
} from './schema.js';

export * from './schema.js';

// src/taxonomy/ and dist/taxonomy/ are both one level below the repo root.
export const TAXONOMY_ROOT = fileURLToPath(new URL('../../taxonomy', import.meta.url));

export interface VenueFilter {
  category?: Category;
  asset?: string;
  capability?: Capability;
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
  return readRecords(join(root, 'venues'), VenueSchema, 'venue').map(({ record }) => record);
}

export function listVenues(filter?: VenueFilter): Venue[] {
  let venues = loadVenues();
  if (!filter) return venues;

  if (filter.category) {
    venues = venues.filter((v) => v.category === filter.category);
  }
  if (filter.asset) {
    const asset = filter.asset.toLowerCase();
    venues = venues.filter((v) => v.assets.some((a) => a.toLowerCase() === asset));
  }
  if (filter.capability) {
    venues = venues.filter((v) => v.capabilities.includes(filter.capability!));
  }
  return venues;
}

export function getVenue(id: string): Venue | undefined {
  return loadVenues().find((v) => v.id === id);
}

export function searchVenues(q: string): Venue[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];

  return loadVenues().filter((v) =>
    [v.id, v.name, v.description, ...v.assets].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}
