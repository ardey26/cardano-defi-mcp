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
    expect(r.stdout).toMatch(/capabilities, \d+ venues \(\d+ scripts\), \d+ MCPs OK/);
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

  it('accepts a per-tool official override and rejects a non-boolean one', () => {
    const tools = (official: unknown) => [{ name: 't', capability: 'lend.borrow', effect: 'read', official }];
    expect(validate(writeTaxonomy({ venues: { alpha: venue('alpha') }, mcps: { m: mcp('m', { tools: tools(false) }) } })).status).toBe(0);
    const r = validate(writeTaxonomy({ venues: { alpha: venue('alpha') }, mcps: { m: mcp('m', { tools: tools('yes') }) } }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mcps\/m\.json tools\[0\]: "official", when present, must be true or false/);
  });

  it('checks venue scripts: shape, role, and one venue per hash', () => {
    const s = (hash: string, role = 'spend') => ({ hash, role, label: 'order', source: 'https://cexplorer.io/script/x' });
    const ok = validate(writeTaxonomy({ venues: { alpha: venue('alpha', { scripts: [s('a'.repeat(56))] }) } }));
    expect(ok.status).toBe(0);
    const r = validate(writeTaxonomy({
      venues: {
        alpha: venue('alpha', { scripts: [s('A'.repeat(56)), s('c'.repeat(56), 'withdraw')] }),
        beta: venue('beta', { scripts: [s('a'.repeat(56))] }),
        gamma: venue('gamma', { scripts: [s('a'.repeat(56), 'mint')] }),
      },
    }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/venues\/alpha\.json scripts\[0\]: "hash" must be 56 lowercase hex characters/);
    expect(r.stderr).toMatch(/venues\/alpha\.json scripts\[1\]: "role" must be one of spend, mint, stake/);
    expect(r.stderr).toMatch(/venues\/gamma\.json scripts\[0\]: script a{56} is already listed by venues\/beta\.json/);
  });

  it('rejects unpinned packages and malformed tool env', () => {
    const r = validate(writeTaxonomy({
      mcps: {
        m: mcp('m', {
          connect: [{ transport: 'stdio', command: 'npx', args: ['-y', 'm-mcp@^1.0.0'] }],
          tools: [{ name: 't', capability: 'lend.borrow', effect: 'read', env: ['lowercase'] }],
        }),
      },
    }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mcps\/m\.json connect\[0\]: package "m-mcp@\^1\.0\.0" must name an exact version/);
    expect(r.stderr).toMatch(/mcps\/m\.json tools\[0\]: "env" must be a non-empty array of UPPER_SNAKE variable names/);
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
