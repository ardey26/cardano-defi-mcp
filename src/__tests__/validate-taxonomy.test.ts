/** Runs the dependency-free PR validator as a child process against the real tree and fixtures. */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mcp, venue, writeTaxonomy } from './fixtures.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/validate-taxonomy.mjs', import.meta.url));

function validate(root?: string) {
  const env = { ...process.env };
  if (root) env.TAXONOMY_DIR = root;
  else delete env.TAXONOMY_DIR;
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
}

describe('validate-taxonomy.mjs', () => {
  it('passes on the real taxonomy', () => {
    const r = validate();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/capabilities, \d+ venues, \d+ MCPs OK/);
  });

  it('passes on a valid fixture', () => {
    const r = validate(writeTaxonomy({ venues: { alpha: venue('alpha') }, mcps: { m: mcp('m') } }));
    expect(r.status).toBe(0);
  });

  it('rejects a leftover v1 integration field with a migration hint', () => {
    const r = validate(writeTaxonomy({ venues: { alpha: venue('alpha', { integration: 'indexed' }) } }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/venues\/alpha\.json: unknown field "integration" \(removed in v2/);
  });

  it('rejects a capability that is not in the tree', () => {
    const r = validate(writeTaxonomy({ venues: { alpha: venue('alpha', { capabilities: ['lend.flash'] }) } }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/venues\/alpha\.json: .*"lend\.flash" is not a node in capabilities\.json/);
  });

  it('rejects a tool pointing at an unknown venue', () => {
    const r = validate(writeTaxonomy({
      venues: { alpha: venue('alpha') },
      mcps: { m: mcp('m', { tools: [{ name: 't', capability: 'lend.borrow', venues: ['nope'], effect: 'read' }] }) },
    }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mcps\/m\.json tools\[0\]: venue "nope" is not a file in venues\//);
  });

  it('rejects a filename that does not match the id', () => {
    const r = validate(writeTaxonomy({ venues: { alpha: venue('beta') } }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/venues\/alpha\.json: "id" is "beta" but the filename requires "alpha"/);
  });

  it('rejects an unknown effect and a bad connect entry', () => {
    const r = validate(writeTaxonomy({
      venues: { alpha: venue('alpha') },
      mcps: {
        m: mcp('m', {
          connect: [{ transport: 'stdio', command: 'npx' }],
          tools: [{ name: 't', capability: 'lend.borrow', effect: 'moves_funds' }],
        }),
      },
    }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mcps\/m\.json connect\[0\]: stdio needs "args"/);
    expect(r.stderr).toMatch(/mcps\/m\.json tools\[0\]: "effect" must be one of/);
  });
});
