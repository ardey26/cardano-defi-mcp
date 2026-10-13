/** Installs a tiny local package from a committed-style lockfile, offline, and resolves its bin. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installUpstream } from '../gateway/install.js';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'gw-install-'));
  const pkg = join(base, 'tiny');
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'tiny-mcp', version: '1.0.0', bin: { 'tiny-mcp': 'cli.js' } }));
  writeFileSync(join(pkg, 'cli.js'), '#!/usr/bin/env node\nconsole.log("tiny ran");\n');
  const root = join(base, 'taxonomy');
  const lock = join(root, 'locks', 'tiny');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'package.json'), JSON.stringify({ name: 'gateway-tiny', private: true, dependencies: { 'tiny-mcp': `file:${pkg}` } }));
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: lock, stdio: 'ignore' });
  return { root, cacheDir: join(base, 'cache') };
}

describe('installUpstream', () => {
  it('installs from the lockfile with scripts disabled, resolves the bin, and runs it with node', async () => {
    const { root, cacheDir } = fixture();
    const connect = await installUpstream('tiny', { command: 'npx', args: ['-y', 'tiny-mcp@1.0.0'] }, root, cacheDir);
    expect(connect.command).toBe(process.execPath);
    expect(execFileSync(connect.command, connect.args, { encoding: 'utf8' }).trim()).toBe('tiny ran');
  });

  it('reuses an existing install for the same lockfile', async () => {
    const { root, cacheDir } = fixture();
    const first = await installUpstream('tiny', { command: 'npx', args: ['-y', 'tiny-mcp@1.0.0'] }, root, cacheDir);
    const started = Date.now();
    const second = await installUpstream('tiny', { command: 'npx', args: ['-y', 'tiny-mcp@1.0.0'] }, root, cacheDir);
    expect(second).toEqual(first);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('refuses an MCP with no committed lockfile', async () => {
    const { root, cacheDir } = fixture();
    await expect(installUpstream('other', { command: 'npx', args: ['-y', 'other@1.0.0'] }, root, cacheDir)).rejects.toThrow(
      /no lockfile at locks\/other/,
    );
  });
});
