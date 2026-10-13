import { describe, expect, it } from 'vitest';
import { exposedName, exposedTools, gatewayConnect, gatewayMcps, isPinned, packageSpecs } from '../gateway/eligibility.js';
import { mcp, writeTaxonomy } from './fixtures.js';
import type { Mcp } from '../taxonomy/schema.js';

const stdio = (...args: string[]) => [{ transport: 'stdio', command: 'npx', args }];
const tools = [
  { name: 'quote', capability: 'trade.swap', effect: 'read' },
  { name: 'build', capability: 'trade.swap', effect: 'unsigned_tx' },
  { name: 'sign', capability: 'trade.swap', effect: 'signs' },
  { name: 'keyed', capability: 'trade.swap', effect: 'unsigned_tx', env: ['BLOCKFROST_API_KEY'] },
];
const record = (overrides: Record<string, unknown> = {}) => mcp('up', { connect: stdio('-y', 'up-mcp@1.2.3'), tools, ...overrides }) as unknown as Mcp;

describe('package pinning', () => {
  it.each([['up-mcp@1.2.3', true], ['@scope/up@0.4.2', true], ['up-mcp', false], ['@scope/up', false], ['up-mcp@^1.2.0', false], ['up-mcp@latest', false], ['up-mcp@1.2', false]])(
    '%s pinned: %s', (spec, pinned) => expect(isPinned(spec)).toBe(pinned),
  );

  it('finds the package arguments of an npx command', () => {
    expect(packageSpecs(['-y', '-p', 'undici@7.30.0', '-p', '@indigoprotocol/indigo-mcp@0.4.2', 'indigo-mcp'])).toEqual([
      'undici@7.30.0', '@indigoprotocol/indigo-mcp@0.4.2',
    ]);
    expect(packageSpecs(['-y', '@fetchswap/cardano-mcp@0.1.0'])).toEqual(['@fetchswap/cardano-mcp@0.1.0']);
  });
});

describe('exposure rules', () => {
  it('exposes classified read and unsigned_tx tools that need no env', () => {
    expect(exposedTools(record()).map((t) => t.name)).toEqual(['quote', 'build']);
  });

  it.each([
    ['an auth-gated server', { auth: 'api_key' }],
    ['an unpinned package', { connect: stdio('-y', 'up-mcp') }],
    ['an http-only server', { connect: [{ transport: 'http', url: 'https://up.example/mcp' }] }],
    ['a non-npx command', { connect: [{ transport: 'stdio', command: 'docker', args: ['run', 'up@1.2.3'] }] }],
  ])('exposes nothing from %s', (_label, overrides) => {
    expect(gatewayConnect(record(overrides))).toBeUndefined();
  });

  it('names tools mcp__tool with dashes turned into underscores', () => {
    expect(exposedName('fetch-cardano', 'cardano_aggregate_quote')).toBe('fetch_cardano__cardano_aggregate_quote');
  });

  it('skips this repo\'s own servers and servers with nothing to expose', () => {
    const root = writeTaxonomy({
      mcps: {
        up: record(),
        'cardano-defi-mcp': mcp('cardano-defi-mcp', { connect: stdio('-y', 'x@1.0.0'), tools }),
        bare: mcp('bare', { connect: stdio('-y', 'bare@1.0.0'), tools: [tools[2]] }),
      },
    });
    expect(gatewayMcps(root).map((g) => g.mcp.id)).toEqual(['up']);
  });

  it('on the real taxonomy exposes Fetch\'s 5 tools and Indigo MCP\'s 12 reads', () => {
    const counts = Object.fromEntries(gatewayMcps().map((g) => [g.mcp.id, g.tools.length]));
    expect(counts).toEqual({ 'fetch-cardano': 5, 'indigo-mcp': 12 });
  });
});

describe('npx arguments (review fix)', () => {
  it.each([
    [['-y', '--package=evil', '-p', 'x@1.0.0', 'evilbin']],
    [['-y', '--registry=https://evil.example', 'x@1.0.0']],
    [['-y', '--node-options=--require=/tmp/x.js', 'x@1.0.0']],
    [['-y', '-p', 'x@1.0.0', 'bin', 'extra-arg']],
    [['--yes', '-c', 'echo hi', 'x@1.0.0']],
  ])('refuses %j', (args) => {
    expect(gatewayConnect(record({ connect: stdio(...args) }))).toBeUndefined();
  });

  it.each([
    [['-y', 'x@1.0.0']],
    [['--yes', 'x@1.0.0']],
    [['-y', '-p', 'undici@7.30.0', '-p', '@scope/x@0.4.2', 'x-bin']],
    [['-y', '--package', 'x@1.0.0', 'x-bin']],
  ])('accepts %j', (args) => {
    expect(gatewayConnect(record({ connect: stdio(...args) }))).toBeDefined();
  });
});
