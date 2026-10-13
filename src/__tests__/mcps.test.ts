/**
 * MCP records: schema and cross-reference checks on fixtures, plus the
 * self-consistency rule — each of this repo's servers is classified in
 * taxonomy/mcps/ exactly as it really registers its tools.
 */

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpServer } from '../server.js';
import { getMcp, loadMcps } from '../taxonomy/index.js';
import { META_TOOLS, SELF_MCP_ID, WALLET_MCP_ID } from '../taxonomy/self.js';
import { createWalletServer } from '../wallet/server.js';
import { mcp, venue, writeTaxonomy } from './fixtures.js';

async function registeredToolNames(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'taxonomy-test', version: '0.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

describe('loadMcps', () => {
  it('loads both self-entries from the real taxonomy', () => {
    const ids = loadMcps().map((m) => m.id);
    expect(ids).toContain(SELF_MCP_ID);
    expect(ids).toContain(WALLET_MCP_ID);
  });

  it('accepts a valid fixture entry', () => {
    const root = writeTaxonomy({ venues: { alpha: venue('alpha') }, mcps: { m: mcp('m') } });
    expect(loadMcps(root).map((m) => m.id)).toEqual(['m']);
  });

  it('rejects a tool that names an unknown venue', () => {
    const root = writeTaxonomy({
      venues: { alpha: venue('alpha') },
      mcps: { m: mcp('m', { tools: [{ name: 't', capability: 'lend.borrow', venues: ['alpah'], effect: 'read' }] }) },
    });
    expect(() => loadMcps(root)).toThrow(/MCP file m\.json: tool 't' venue 'alpah' is not a venue id/);
  });

  it('rejects a tool whose capability is not in the tree', () => {
    const root = writeTaxonomy({
      venues: { alpha: venue('alpha') },
      mcps: { m: mcp('m', { tools: [{ name: 't', capability: 'lend.flash', effect: 'read' }] }) },
    });
    expect(() => loadMcps(root)).toThrow(/MCP file m\.json: tool 't' capability 'lend\.flash'/);
  });

  it('rejects a duplicate tool name', () => {
    const tool = { name: 't', capability: 'lend.borrow', effect: 'read' };
    const root = writeTaxonomy({ venues: { alpha: venue('alpha') }, mcps: { m: mcp('m', { tools: [tool, tool] }) } });
    expect(() => loadMcps(root)).toThrow(/duplicate tool 't'/);
  });

  it('rejects an unknown effect and an empty venues array', () => {
    const bad = writeTaxonomy({
      venues: { alpha: venue('alpha') },
      mcps: { m: mcp('m', { tools: [{ name: 't', capability: 'lend.borrow', effect: 'moves_funds' }] }) },
    });
    expect(() => loadMcps(bad)).toThrow(/MCP file m\.json: tools\.0\.effect/);

    const empty = writeTaxonomy({
      venues: { alpha: venue('alpha') },
      mcps: { m: mcp('m', { tools: [{ name: 't', capability: 'lend.borrow', venues: [], effect: 'read' }] }) },
    });
    expect(() => loadMcps(empty)).toThrow(/MCP file m\.json: tools\.0\.venues/);
  });
});

describe('getMcp', () => {
  it('returns an entry by id and undefined otherwise', () => {
    expect(getMcp(SELF_MCP_ID)?.tools.length).toBeGreaterThan(0);
    expect(getMcp('not-an-mcp')).toBeUndefined();
  });
});

describe.each([
  [SELF_MCP_ID, createMcpServer],
  [WALLET_MCP_ID, createWalletServer],
] as const)('self-entry %s', (id, create) => {
  it('classifies exactly the non-meta tools the server registers', async () => {
    const registered = (await registeredToolNames(create()))
      .filter((name) => !META_TOOLS.includes(name))
      // Gateway tools (<mcp>__<tool>) belong to other MCP records, not the self-entry.
      .filter((name) => !name.includes('__'))
      .sort();
    const classified = getMcp(id)!.tools.map((t) => t.name).sort();
    expect(classified).toEqual(registered);
  });
});

describe('gateway in the key-holding server (review fix)', () => {
  it('is off by default in the combined wallet server, and on only with GATEWAY=on', async () => {
    const { createCombinedServer } = await import('../wallet/combined.js');
    const before = process.env.GATEWAY;
    try {
      delete process.env.GATEWAY;
      expect((await registeredToolNames(createCombinedServer())).filter((n) => n.includes('__'))).toEqual([]);
      process.env.GATEWAY = 'on';
      expect((await registeredToolNames(createCombinedServer())).some((n) => n.includes('__'))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.GATEWAY;
      else process.env.GATEWAY = before;
    }
  });

  it('is on by default in the keyless server', async () => {
    expect((await registeredToolNames(createMcpServer())).some((n) => n.includes('__'))).toBe(true);
  });
});
