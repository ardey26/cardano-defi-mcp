import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VenueSchema, type Capability, type Category, type Venue } from './schema.js';

export * from './schema.js';

// src/taxonomy/ and dist/taxonomy/ are both one level below the repo root.
const VENUES_DIR = fileURLToPath(new URL('../../taxonomy/venues', import.meta.url));

export interface VenueFilter {
  category?: Category;
  asset?: string;
  capability?: Capability;
}

export function loadVenues(): Venue[] {
  const files = readdirSync(VENUES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  return files.map((file) => {
    const path = join(VENUES_DIR, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid venue file ${file}: not valid JSON (${(err as Error).message})`);
    }

    const result = VenueSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid venue file ${file}: ${issues}`);
    }
    return result.data;
  });
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
