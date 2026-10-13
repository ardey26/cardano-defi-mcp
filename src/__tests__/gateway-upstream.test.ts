import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Upstream, childEnv } from '../gateway/upstream.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));
const connect = { command: process.execPath, args: [FAKE] };
const options = { connectTimeoutMs: 20_000, callTimeoutMs: 2_000, idleMs: 60_000, cacheDir: mkdtempSync(join(tmpdir(), 'gw-cache-')) };
const text = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0].text;
const open: Upstream[] = [];
const upstream = (o = options) => { const u = new Upstream('Fake', connect, o); open.push(u); return u; };
afterEach(async () => { await Promise.all(open.splice(0).map((u) => u.close())); });

describe('Upstream', () => {
  it('spawns lazily on the first call and reuses the process', async () => {
    const u = upstream();
    expect(u.running).toBe(false);
    const first = text(await u.call('pid', {}));
    expect(u.running).toBe(true);
    expect(text(await u.call('pid', {}))).toBe(first);
  });

  it('gives the child no secrets and none of this process\'s environment', async () => {
    process.env.GATEWAY_TEST_SECRET = 'do-not-leak';
    try {
      const env = JSON.parse(text(await upstream().call('env', {})));
      expect(env.GATEWAY_TEST_SECRET).toBeUndefined();
      expect(env.npm_config_ignore_scripts).toBe('true');
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(env.npm_config_cache).toBe(options.cacheDir);
    } finally {
      delete process.env.GATEWAY_TEST_SECRET;
    }
  });

  it('times out a hung call, kills the process, and works again on the next call', async () => {
    const u = upstream();
    const before = text(await u.call('pid', {}));
    await expect(u.call('slow', {})).rejects.toThrow(/timed out/i);
    expect(text(await u.call('pid', {}))).not.toBe(before);
  });

  it('restarts after the upstream crashes', async () => {
    const u = upstream();
    await expect(u.call('crash', {})).rejects.toThrow();
    expect(text(await u.call('echo', { msg: 'back' }))).toBe('echo:back');
  });

  it('stops the process after the idle period', async () => {
    const u = upstream({ ...options, idleMs: 200 });
    await u.call('pid', {});
    await new Promise((r) => setTimeout(r, 600));
    expect(u.running).toBe(false);
  });

  it('childEnv sets only the documented variables', () => {
    expect(Object.keys(childEnv('/c')).sort()).toEqual(['HOME', 'PATH', 'npm_config_cache', 'npm_config_ignore_scripts', 'npm_config_update_notifier', 'npm_config_yes']);
  });

  it('accepts an async connect resolver (the lockfile install) and runs it once', async () => {
    let resolved = 0;
    const u = new Upstream('Fake', async () => { resolved++; return connect; }, options);
    open.push(u);
    await u.call('pid', {});
    await u.call('pid', {});
    expect(resolved).toBe(1);
  });
});
