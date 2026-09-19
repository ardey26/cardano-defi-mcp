import { describe, expect, it } from 'vitest';
import { getVenue, listVenues, loadVenues, searchVenues } from '../taxonomy/index.js';
import { VenueSchema } from '../taxonomy/schema.js';

const EXPECTED_IDS = [
  'minswap',
  'dano-finance',
  'wingriders',
  'splash',
  'sundaeswap',
  'liqwid',
  'fluidtokens',
  'indigo',
  'realfi',
  'djed',
  'strike-finance',
];

describe('loadVenues', () => {
  it('loads at least the 11 curated venue files', () => {
    // Superset check, not equality: this is a community registry, so a PR
    // adding a new venue must not fail because the curated set grew.
    const ids = loadVenues().map((v) => v.id);
    for (const id of EXPECTED_IDS) expect(ids).toContain(id);
  });

  it('every venue validates against VenueSchema', () => {
    for (const venue of loadVenues()) {
      expect(VenueSchema.safeParse(venue).success).toBe(true);
    }
  });

  it('assigns the documented integration levels', () => {
    expect(getVenue('indigo')?.integration).toBe('adapter_live');
    expect(getVenue('liqwid')?.integration).toBe('read_only');
    // Only the curated set is pinned; community-added venues choose their own
    // (schema-valid) level, though 'indexed' is the norm for a new entry.
    for (const id of EXPECTED_IDS) {
      if (id !== 'indigo' && id !== 'liqwid') {
        expect(getVenue(id)?.integration).toBe('indexed');
      }
    }
  });
});

describe('listVenues', () => {
  it('returns every venue with no filter', () => {
    expect(listVenues()).toHaveLength(loadVenues().length);
  });

  it('filters by category', () => {
    const dexes = listVenues({ category: 'dex' });
    expect(dexes.length).toBeGreaterThan(0);
    expect(dexes.every((v) => v.category === 'dex')).toBe(true);
    expect(dexes.map((v) => v.id)).toContain('minswap');
    expect(dexes.map((v) => v.id)).not.toContain('liqwid');
  });

  it('filters by asset, case-insensitively', () => {
    const ada = listVenues({ asset: 'ADA' });
    expect(ada.length).toBeGreaterThan(0);
    expect(listVenues({ asset: 'ada' }).map((v) => v.id)).toEqual(ada.map((v) => v.id));
    expect(listVenues({ asset: 'iUSD' }).map((v) => v.id)).toContain('indigo');
  });

  it('filters by capability', () => {
    const borrowers = listVenues({ capability: 'borrow' });
    expect(borrowers.map((v) => v.id)).toContain('liqwid');
    expect(borrowers.every((v) => v.capabilities.includes('borrow'))).toBe(true);

    const perps = listVenues({ capability: 'perps' });
    expect(perps.map((v) => v.id)).toEqual(['strike-finance']);
  });

  it('combines filters', () => {
    const result = listVenues({ category: 'dex', capability: 'swap', asset: 'ADA' });
    expect(result.length).toBeGreaterThan(0);
    expect(
      result.every(
        (v) => v.category === 'dex' && v.capabilities.includes('swap') && v.assets.includes('ADA'),
      ),
    ).toBe(true);
  });

  it('returns an empty array when nothing matches', () => {
    expect(listVenues({ asset: 'NOT-A-REAL-TOKEN' })).toEqual([]);
  });
});

describe('getVenue', () => {
  it('returns the venue by id', () => {
    expect(getVenue('indigo')?.name).toBeTruthy();
    expect(getVenue('indigo')?.category).toBe('cdp');
  });

  it('returns undefined for an unknown id', () => {
    expect(getVenue('not-a-venue')).toBeUndefined();
  });
});

describe('searchVenues', () => {
  it('finds indigo by "CDP"', () => {
    expect(searchVenues('CDP').map((v) => v.id)).toContain('indigo');
  });

  it('is case-insensitive', () => {
    expect(searchVenues('cdp').map((v) => v.id)).toEqual(
      searchVenues('CDP').map((v) => v.id),
    );
  });

  it('matches on id', () => {
    expect(searchVenues('minswap').map((v) => v.id)).toContain('minswap');
  });

  it('matches on asset ticker', () => {
    const results = searchVenues('SHEN');
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((v) => v.id)).toContain('djed');
  });

  it('returns an empty array for no match and for a blank query', () => {
    expect(searchVenues('zzzzzzzz')).toEqual([]);
    expect(searchVenues('   ')).toEqual([]);
  });
});
