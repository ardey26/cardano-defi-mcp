/**
 * The drift check's first job runs third-party MCP servers. It must hold no
 * token, leave no credentials on disk, and touch no shared cache.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/mcp-drift.yml', import.meta.url), 'utf8');
const checkJob = workflow.slice(workflow.indexOf('\n  check:'), workflow.indexOf('\n  report:'));

describe('mcp-drift workflow check job', () => {
  it('has no token permissions', () => {
    expect(checkJob).toMatch(/\n {4}permissions: \{\}\n/);
  });

  it('does not persist checkout credentials', () => {
    expect(checkJob).toMatch(/persist-credentials: false/);
  });

  it('does not use the npm cache', () => {
    expect(checkJob).not.toMatch(/cache: npm/);
  });
});
