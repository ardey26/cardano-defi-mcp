import { describe, expect, it } from 'vitest';
import { findCapability, listCapabilities } from '../taxonomy/find.js';
import { loadMcps } from '../taxonomy/index.js';
import { SELF_MCP_ID } from '../taxonomy/self.js';
import { mcp, venue, writeTaxonomy } from './fixtures.js';

// alpha: borrow + supply (ADA, iUSD); beta: borrow (ADA); gamma: swap.
const root = writeTaxonomy({
  venues: {
    alpha: venue('alpha', { capabilities: ['lend.borrow', 'lend.supply'], assets: ['ADA', 'iUSD'] }),
    beta: venue('beta', { capabilities: ['lend.borrow'] }),
    gamma: venue('gamma', { category: 'dex', capabilities: ['trade.swap'] }),
  },
  mcps: {
    'here-mcp': mcp('here-mcp', {
      tools: [
        { name: 'borrow_alpha', capability: 'lend.borrow', venues: ['alpha'], effect: 'unsigned_tx' },
        { name: 'balance', capability: 'wallet.balance', effect: 'read' },
        { name: 'position_alpha', capability: 'wallet.balance', venues: ['alpha'], effect: 'read' },
      ],
    }),
    'ext-official': mcp('ext-official', {
      official: true,
      tools: [
        { name: 'borrow', capability: 'lend.borrow', venues: ['alpha', 'beta'], effect: 'unsigned_tx' },
        { name: 'rates', capability: 'lend.borrow', venues: ['alpha'], effect: 'read' },
      ],
    }),
    'ext-signer': mcp('ext-signer', {
      tools: [{ name: 'auto_borrow', capability: 'lend.borrow', venues: ['beta'], effect: 'signs' }],
    }),
  },
});

const HERE = ['here-mcp'];
const brief = (r: ReturnType<typeof findCapability>) => r.paths.map((p) => `${p.mcp}/${p.tool}@${p.venue}`);

describe('findCapability', () => {
  it('ranks here first, then lower effect, then official', () => {
    const result = findCapability({ capability: 'lend.borrow' }, HERE, root);
    expect(result.venues.map((v) => v.id)).toEqual(['alpha', 'beta']);
    expect(brief(result)).toEqual([
      'here-mcp/borrow_alpha@alpha',
      'ext-official/rates@alpha',
      'ext-official/borrow@alpha',
      'ext-official/borrow@beta',
      'ext-signer/auto_borrow@beta',
    ]);
    expect(result.paths[0]).toMatchObject({ here: true, effect: 'unsigned_tx', official: false });
    expect(result.gaps).toEqual([]);
  });

  it('expands a group and reports venues with no agent path as gaps', () => {
    const result = findCapability({ capability: 'lend' }, HERE, root);
    expect(result.venues.find((v) => v.id === 'alpha')?.capabilities).toEqual(['lend.borrow', 'lend.supply']);
    expect(result.gaps).toEqual([{ venue: 'alpha', capability: 'lend.supply' }]);
  });

  it('filters venues and their paths by asset', () => {
    const result = findCapability({ capability: 'lend.borrow', asset: 'iusd' }, HERE, root);
    expect(result.venues.map((v) => v.id)).toEqual(['alpha']);
    expect(result.paths.every((p) => p.venue === 'alpha')).toBe(true);
  });

  it('filters by venue', () => {
    const result = findCapability({ capability: 'lend.borrow', venue: 'beta' }, HERE, root);
    expect(result.venues.map((v) => v.id)).toEqual(['beta']);
    expect(brief(result)).toEqual(['ext-official/borrow@beta', 'ext-signer/auto_borrow@beta']);
  });

  it('returns venue-agnostic tools with a null venue', () => {
    const result = findCapability({ capability: 'wallet.balance' }, HERE, root);
    expect(result.venues).toEqual([]);
    expect(result.paths[0]).toEqual(
      { capability: 'wallet.balance', venue: null, mcp: 'here-mcp', tool: 'balance', effect: 'read', official: false, here: true },
    );
  });

  it('normalizes case and whitespace', () => {
    expect(findCapability({ capability: '  LEND.Borrow ' }, HERE, root)).toEqual(
      findCapability({ capability: 'lend.borrow' }, HERE, root),
    );
  });

  it.each(['lend.flash', 'lend.b', 'borrow'])('errors on the unknown capability %j and lists the groups', (capability) => {
    expect(() => findCapability({ capability }, HERE, root)).toThrow(
      /Unknown capability .*lend, trade, wallet/,
    );
  });

  it('errors on an unknown venue', () => {
    expect(() => findCapability({ capability: 'lend.borrow', venue: 'nope' }, HERE, root)).toThrow(
      /Unknown venue 'nope'/,
    );
  });

  it('works on the real taxonomy: Indigo CDPs are callable here', () => {
    const result = findCapability({ capability: 'mint.cdp' }, [SELF_MCP_ID]);
    expect(result.venues.map((v) => v.id)).toContain('indigo');
    expect(result.paths[0]).toMatchObject({ mcp: SELF_MCP_ID, venue: 'indigo', here: true });
  });
});

describe('findCapability review fixes', () => {
  it('returns a venue-specific tool even when the venue record does not list that capability', () => {
    // Venues list what they offer (lend.*); agent-side capabilities like positions are not on the venue record.
    const result = findCapability({ capability: 'wallet.balance' }, HERE, root);
    expect(brief(result)).toContain('here-mcp/position_alpha@alpha');
    expect(result.venues).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('drops venue-agnostic paths when a venue filter is set', () => {
    const result = findCapability({ capability: 'wallet.balance', venue: 'alpha' }, HERE, root);
    expect(brief(result)).toEqual(['here-mcp/position_alpha@alpha']);
  });

  it('normalizes case and whitespace in the venue filter', () => {
    expect(findCapability({ capability: 'lend.borrow', venue: ' BETA ' }, HERE, root)).toEqual(
      findCapability({ capability: 'lend.borrow', venue: 'beta' }, HERE, root),
    );
  });

  it('on the real taxonomy, every classified tool is reachable through its own capability', () => {
    for (const server of loadMcps()) {
      for (const tool of server.tools) {
        const paths = findCapability({ capability: tool.capability }, [SELF_MCP_ID]).paths;
        expect(paths.some((p) => p.mcp === server.id && p.tool === tool.name), `${server.id}/${tool.name}`).toBe(true);
      }
    }
  });
});

describe('listCapabilities', () => {
  it('counts venues and tools per node', () => {
    const byId = Object.fromEntries(listCapabilities(root).map((c) => [c.id, c]));
    expect(byId['lend.borrow']).toMatchObject({ venues: 2, tools: 4 });
    expect(byId['lend.supply']).toMatchObject({ venues: 1, tools: 0 });
    expect(byId['wallet.balance']).toMatchObject({ venues: 0, tools: 2 });
  });
});

describe('findCapability against the published taxonomy', () => {
  it('routes every swap venue through an aggregator, so swap has no gaps', () => {
    const result = findCapability({ capability: 'trade.swap' }, [SELF_MCP_ID]);
    expect(result.gaps).toEqual([]);
    const minswap = findCapability({ capability: 'trade.swap', venue: 'minswap' }, [SELF_MCP_ID]);
    expect(minswap.paths.map((p) => `${p.mcp}/${p.tool}`)).toEqual([
      'fetch-cardano/cardano_aggregate_quote',
      'fetch-cardano/cardano_build_swap',
    ]);
  });
});
