/**
 * Throwaway taxonomy trees for loader, finder and validator tests. Every
 * fixture is a fresh temp directory shaped like the repo's taxonomy/.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASE_CAPABILITIES = [
  { id: 'lend.borrow', label: 'Borrow', description: 'Borrow against collateral.' },
  { id: 'lend.supply', label: 'Supply', description: 'Supply to a money market.' },
  { id: 'trade.swap', label: 'Swap', description: 'Swap tokens.' },
  { id: 'wallet.balance', label: 'Balance', description: 'Read a balance.' },
];

export interface TaxonomyFixture {
  capabilities?: unknown;
  /** Keyed by filename without `.json`. */
  venues?: Record<string, unknown>;
  /** Keyed by filename without `.json`. */
  mcps?: Record<string, unknown>;
}

export function writeTaxonomy(fx: TaxonomyFixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'taxonomy-'));
  mkdirSync(join(root, 'venues'));
  mkdirSync(join(root, 'mcps'));
  writeFileSync(join(root, 'capabilities.json'), JSON.stringify(fx.capabilities ?? BASE_CAPABILITIES));
  for (const [id, record] of Object.entries(fx.venues ?? {})) {
    writeFileSync(join(root, 'venues', `${id}.json`), JSON.stringify(record));
  }
  for (const [id, record] of Object.entries(fx.mcps ?? {})) {
    writeFileSync(join(root, 'mcps', `${id}.json`), JSON.stringify(record));
  }
  return root;
}

export function venue(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    category: 'lending',
    url: `https://${id}.example`,
    description: `${id} test venue`,
    assets: ['ADA'],
    capabilities: ['lend.borrow'],
    ...overrides,
  };
}

export function mcp(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    publisher: 'test',
    official: false,
    repo: `https://github.com/test/${id}`,
    connect: [{ transport: 'http', url: `https://${id}.example/mcp` }],
    auth: 'none',
    tools: [{ name: 'borrow', capability: 'lend.borrow', venues: ['alpha'], effect: 'unsigned_tx' }],
    ...overrides,
  };
}
