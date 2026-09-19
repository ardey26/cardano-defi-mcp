/**
 * Home-directory configuration: where an installed package keeps its config,
 * keys and spend ledger, and which source wins when several of them speak.
 *
 * Every path is resolved through CARDANO_DEFI_MCP_HOME pointed at a temp
 * directory, so nothing here touches a real home directory.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyCliDefaults,
  applyEnvFile,
  configPath,
  DEFAULT_BAZAAR_API_URL,
  homeCredentialsPath,
  homeStatePath,
  maskSecret,
  readConfig,
  resolveCredentialsPath,
  resolveStatePath,
  writeConfig,
  PACKAGE_ROOT,
} from '../wallet/home.js';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cdm-home-'));
  env = { CARDANO_DEFI_MCP_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('home directory layout', () => {
  it('keeps config, credentials and the ledger under CARDANO_DEFI_MCP_HOME', () => {
    expect(configPath(env)).toBe(join(home, 'config.json'));
    expect(homeCredentialsPath(env)).toBe(join(home, 'credentials.env'));
    expect(homeStatePath(env)).toBe(join(home, 'wallet-state.json'));
  });
});

describe('config.json', () => {
  it('reads as empty when the file does not exist', () => {
    expect(readConfig(env)).toEqual({});
  });

  it('merges writes and stores them 0600', () => {
    writeConfig({ blockfrostProjectId: 'mainnetABC' }, env);
    writeConfig({ bazaarApiUrl: 'https://example.test' }, env);

    expect(readConfig(env)).toEqual({
      blockfrostProjectId: 'mainnetABC',
      bazaarApiUrl: 'https://example.test',
    });
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  });

  it('ignores undefined fields rather than erasing what is stored', () => {
    writeConfig({ blockfrostProjectId: 'mainnetABC' }, env);
    writeConfig({ blockfrostProjectId: undefined, bazaarApiUrl: 'https://example.test' }, env);

    expect(readConfig(env).blockfrostProjectId).toBe('mainnetABC');
  });

  it('refuses to guess at a corrupt file', () => {
    writeConfig({}, env);
    writeFileSync(configPath(env), '{not json');

    expect(() => readConfig(env)).toThrow(/not valid JSON/);
  });
});

describe('resolution order', () => {
  it('prefers an explicit environment variable over every file', () => {
    writeConfig({ blockfrostProjectId: 'fromFile', bazaarApiUrl: 'https://file.test' }, env);
    env.BLOCKFROST_PROJECT_ID = 'fromEnv';
    env.BAZAAR_API_URL = 'https://env.test';

    applyCliDefaults(env);

    expect(env.BLOCKFROST_PROJECT_ID).toBe('fromEnv');
    expect(env.BAZAAR_API_URL).toBe('https://env.test');
  });

  it('falls back to config.json when the environment is silent', () => {
    writeConfig({ blockfrostProjectId: 'fromFile', bazaarApiUrl: 'https://file.test' }, env);

    applyCliDefaults(env);

    expect(env.BLOCKFROST_PROJECT_ID).toBe('fromFile');
    expect(env.BAZAAR_API_URL).toBe('https://file.test');
  });

  it('defaults the CLI to the hosted Bazaar API, never localhost', () => {
    applyCliDefaults(env);

    expect(env.BAZAAR_API_URL).toBe(DEFAULT_BAZAAR_API_URL);
    expect(env.BAZAAR_API_URL).not.toMatch(/localhost/);
    expect(env.BLOCKFROST_PROJECT_ID).toBeUndefined();
    expect(env.INDIGO_SYSTEM_PARAMS_URL).toMatch(/^https:\/\/config\.indigoprotocol\.io\//);
  });

  it('applies an env file without overriding what is already set', () => {
    const file = join(home, 'credentials.env');
    writeFileSync(file, '# comment\nWALLET_EVM_PRIVATE_KEY=0xfile\nBLOCKFROST_PROJECT_ID="quoted"\n');
    env.WALLET_EVM_PRIVATE_KEY = '0xenv';

    applyEnvFile(file, env);

    expect(env.WALLET_EVM_PRIVATE_KEY).toBe('0xenv');
    expect(env.BLOCKFROST_PROJECT_ID).toBe('quoted');
  });

  it('ignores a missing env file', () => {
    expect(() => applyEnvFile(join(home, 'nope.env'), env)).not.toThrow();
  });
});

describe('credentials and ledger paths', () => {
  it('uses the repo files in a checkout and the home directory when installed', () => {
    expect(resolveCredentialsPath(env, true)).toBe(join(PACKAGE_ROOT, '.env.local'));
    expect(resolveCredentialsPath(env, false)).toBe(join(home, 'credentials.env'));
    expect(resolveStatePath(env, true)).toBe(join(PACKAGE_ROOT, '.wallet-state.json'));
    expect(resolveStatePath(env, false)).toBe(join(home, 'wallet-state.json'));
  });

  it('lets an explicit override win in either case', () => {
    env.ENV_FILE = '/tmp/keys.env';
    env.WALLET_STATE_FILE = '/tmp/ledger.json';

    expect(resolveCredentialsPath(env, true)).toBe('/tmp/keys.env');
    expect(resolveCredentialsPath(env, false)).toBe('/tmp/keys.env');
    expect(resolveStatePath(env, true)).toBe('/tmp/ledger.json');
    expect(resolveStatePath(env, false)).toBe('/tmp/ledger.json');
  });
});

describe('maskSecret', () => {
  it('shows a recognisable prefix and never the whole value', () => {
    const masked = maskSecret('mainnetABCDEFGHIJKLMNOP');

    expect(masked).toBe('mainnetA… (23 chars)');
    expect(masked).not.toContain('MNOP');
  });

  it('hides a short value almost entirely', () => {
    expect(maskSecret('abcd')).toBe('… (4 chars)');
  });
});

describe('key generation into the home directory', () => {
  it('writes both keys 0600 and never overwrites an existing one', async () => {
    const { ensureKeys } = await import('../wallet/onboarding.js');
    const path = join(home, 'credentials.env');
    const saved = {
      evm: process.env.WALLET_EVM_PRIVATE_KEY,
      cardano: process.env.WALLET_CARDANO_PRIVATE_KEY,
    };
    delete process.env.WALLET_EVM_PRIVATE_KEY;
    delete process.env.WALLET_CARDANO_PRIVATE_KEY;

    try {
      const created = ensureKeys(['evm', 'cardano'], path);

      expect(created.map((k) => k.created)).toEqual([true, true]);
      expect(created.find((k) => k.chain === 'evm')?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(created.find((k) => k.chain === 'cardano')?.address).toMatch(/^addr1/);
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const before = readFileSync(path, 'utf8');
      const again = ensureKeys(['evm', 'cardano'], path);

      expect(again.every((k) => k.created === false)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      if (saved.evm === undefined) delete process.env.WALLET_EVM_PRIVATE_KEY;
      else process.env.WALLET_EVM_PRIVATE_KEY = saved.evm;
      if (saved.cardano === undefined) delete process.env.WALLET_CARDANO_PRIVATE_KEY;
      else process.env.WALLET_CARDANO_PRIVATE_KEY = saved.cardano;
    }
  });
});
