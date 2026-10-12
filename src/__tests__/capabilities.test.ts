import { describe, expect, it } from 'vitest';
import { loadCapabilities, matchesCapability } from '../taxonomy/index.js';
import { writeTaxonomy } from './fixtures.js';

const CURATED = [
  'trade.swap', 'trade.cross_chain_swap', 'trade.perps',
  'earn.liquidity', 'earn.stake', 'earn.stability_pool',
  'lend.supply', 'lend.borrow',
  'mint.cdp', 'mint.stablecoin',
  'wallet.balance', 'wallet.send', 'wallet.delegate', 'wallet.sign',
  'data.market', 'data.position',
];

describe('loadCapabilities', () => {
  it('loads at least the curated tree', () => {
    // Superset, not equality: contributors may add nodes by PR.
    const ids = loadCapabilities().map((c) => c.id);
    for (const id of CURATED) expect(ids).toContain(id);
  });

  it('rejects a duplicate id', () => {
    const node = { id: 'lend.borrow', label: 'Borrow', description: 'x' };
    const root = writeTaxonomy({ capabilities: [node, node] });
    expect(() => loadCapabilities(root)).toThrow(/duplicate id 'lend\.borrow'/);
  });

  it.each(['borrow', 'Lend.Borrow', 'lend.borrow.fixed', 'lend.'])('rejects the malformed id %j', (id) => {
    const root = writeTaxonomy({ capabilities: [{ id, label: 'x', description: 'x' }] });
    expect(() => loadCapabilities(root)).toThrow(/capabilities\.json/);
  });
});

describe('matchesCapability', () => {
  it('matches the exact id and its group', () => {
    expect(matchesCapability('lend.borrow', 'lend.borrow')).toBe(true);
    expect(matchesCapability('lend.borrow', 'lend')).toBe(true);
  });

  it('does not match a partial segment', () => {
    expect(matchesCapability('lend.borrow', 'lend.b')).toBe(false);
    expect(matchesCapability('trader.x', 'trade')).toBe(false);
    expect(matchesCapability('lend.borrow', 'borrow')).toBe(false);
  });
});
