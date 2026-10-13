import { describe, expect, it } from 'vitest';
import { getVenue, listVenues, loadVenues, searchVenues } from '../taxonomy/index.js';
import { VenueSchema } from '../taxonomy/schema.js';
import { venue, writeTaxonomy } from './fixtures.js';

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

  it('filters by capability id', () => {
    const borrowers = listVenues({ capability: 'lend.borrow' });
    expect(borrowers.map((v) => v.id)).toContain('liqwid');
    expect(borrowers.every((v) => v.capabilities.includes('lend.borrow'))).toBe(true);

    expect(listVenues({ capability: 'trade.perps' }).map((v) => v.id)).toEqual(['strike-finance']);
  });

  it('filters by capability group', () => {
    const lend = listVenues({ capability: 'lend' }).map((v) => v.id);
    expect(lend).toContain('liqwid');
    expect(lend).toContain('fluidtokens');
    expect(lend).not.toContain('minswap');
  });

  it('normalizes case and whitespace in the capability filter', () => {
    expect(listVenues({ capability: '  LEND.Borrow ' }).map((v) => v.id)).toEqual(
      listVenues({ capability: 'lend.borrow' }).map((v) => v.id),
    );
  });

  it('combines filters', () => {
    const result = listVenues({ category: 'dex', capability: 'trade.swap', asset: 'ADA' });
    expect(result.length).toBeGreaterThan(0);
    expect(
      result.every(
        (v) => v.category === 'dex' && v.capabilities.includes('trade.swap') && v.assets.includes('ADA'),
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

describe('venue validation', () => {
  it('rejects a leftover v1 integration field', () => {
    const root = writeTaxonomy({ venues: { alpha: venue('alpha', { integration: 'indexed' }) } });
    expect(() => loadVenues(root)).toThrow(/venue file alpha\.json.*integration/);
  });

  it('rejects a v1 flat capability', () => {
    const root = writeTaxonomy({ venues: { alpha: venue('alpha', { capabilities: ['borrow'] }) } });
    expect(() => loadVenues(root)).toThrow(/venue file alpha\.json: capabilities\.0/);
  });

  it('rejects a well-formed capability that is not in the tree', () => {
    const root = writeTaxonomy({ venues: { alpha: venue('alpha', { capabilities: ['lend.flash'] }) } });
    expect(() => loadVenues(root)).toThrow(/venue file alpha\.json: .*'lend\.flash'.*capabilities\.json/);
  });
});

describe('venue scripts', () => {
  const script = (hash: string, role = 'spend') => ({ hash, role, label: 'order', source: 'https://cexplorer.io/script/x' });
  const A = 'a'.repeat(56);
  const B = 'b'.repeat(56);

  it('loads scripts on a venue', () => {
    const root = writeTaxonomy({ venues: { alpha: venue('alpha', { scripts: [script(A), script(A, 'stake')] }) } });
    expect(loadVenues(root)[0].scripts).toEqual([script(A), script(A, 'stake')]);
  });

  it.each([
    ['uppercase hex', script('A'.repeat(56))],
    ['short hash', script('a'.repeat(54))],
    ['unknown role', script(A, 'withdraw')],
  ])('rejects a script with %s', (_label, bad) => {
    const root = writeTaxonomy({ venues: { alpha: venue('alpha', { scripts: [bad] }) } });
    expect(() => loadVenues(root)).toThrow(/alpha\.json/);
  });

  it('rejects a hash claimed by two venues', () => {
    const root = writeTaxonomy({
      venues: { alpha: venue('alpha', { scripts: [script(A)] }), beta: venue('beta', { scripts: [script(B), script(A, 'mint')] }) },
    });
    expect(() => loadVenues(root)).toThrow(/beta\.json: script a{56} is already listed by venue 'alpha'/);
  });
});
