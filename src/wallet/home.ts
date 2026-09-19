/**
 * Where an npx-installed server keeps its configuration.
 *
 * A checkout has `.env.local` and `.wallet-state.json` next to the source. A
 * package installed by `npx github:...` lives inside a disposable npm cache
 * directory, so nothing writable may live there — its config, keys and spend
 * ledger go to `~/.cardano-defi-mcp/` instead:
 *
 *   config.json        blockfrostProjectId, bazaarApiUrl (no secrets beyond the key)
 *   credentials.env    WALLET_*_PRIVATE_KEY lines, chmod 600
 *   wallet-state.json  the rolling 24h spend ledger
 *
 * Resolution order everywhere: explicit environment variable, then the repo's
 * .env.local / .env, then the home directory. The environment always wins so a
 * `.mcp.json` env block or a shell export can override a stored value without
 * editing a file.
 *
 * CARDANO_DEFI_MCP_HOME relocates the whole directory, which is what the tests
 * use instead of touching a real home directory.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed package root: src/wallet/ and dist-wallet/wallet/ are both one level below it. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The hosted BazaarSwap routing backend. Localhost is only right inside the monorepo. */
export const DEFAULT_BAZAAR_API_URL = 'https://bazaar-web.onrender.com';

/** Same value render.yaml pins for the hosted server; Indigo publishes no stable URL. */
export const DEFAULT_INDIGO_SYSTEM_PARAMS_URL =
  'https://config.indigoprotocol.io/mainnet/mainnet-system-params-v3.json';

export interface HomeConfig {
  blockfrostProjectId?: string;
  bazaarApiUrl?: string;
  indigoSystemParamsUrl?: string;
}

/**
 * True when the package root is a working copy rather than an installed
 * package. `files` in package.json ships no `src/`, so its presence is the
 * difference between "developer ran npm run wallet" and "npx fetched us".
 */
export function isRepoCheckout(root: string = PACKAGE_ROOT): boolean {
  return existsSync(join(root, 'src'));
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CARDANO_DEFI_MCP_HOME || join(homedir(), '.cardano-defi-mcp');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), 'config.json');
}

export function homeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), 'credentials.env');
}

export function homeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), 'wallet-state.json');
}

/** The file `setup_wallet` writes keys to, and the last file loadEnvFiles reads. */
export function resolveCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  repo: boolean = isRepoCheckout(),
): string {
  if (env.ENV_FILE) return env.ENV_FILE;
  return repo ? join(PACKAGE_ROOT, '.env.local') : homeCredentialsPath(env);
}

export function resolveStatePath(
  env: NodeJS.ProcessEnv = process.env,
  repo: boolean = isRepoCheckout(),
): string {
  if (env.WALLET_STATE_FILE) return env.WALLET_STATE_FILE;
  return repo ? join(PACKAGE_ROOT, '.wallet-state.json') : homeStatePath(env);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): HomeConfig {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        'Fix or delete the file, then call configure again.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object. Fix or delete the file, then call configure again.`);
  }
  return parsed as HomeConfig;
}

/** Merge `patch` into config.json, creating the directory the first time. */
export function writeConfig(patch: HomeConfig, env: NodeJS.ProcessEnv = process.env): HomeConfig {
  const merged: HomeConfig = { ...readConfig(env) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  mkdirSync(homeDir(env), { recursive: true, mode: 0o700 });
  const path = configPath(env);
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; a non-POSIX filesystem is not a reason to fail
  }
  return merged;
}

/** Apply KEY=VALUE lines from a file, never overwriting what the environment already says. */
export function applyEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (env[key] === undefined) env[key] = value;
  }
}

function setIfUnset(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value !== undefined && value !== '' && (env[key] === undefined || env[key] === '')) env[key] = value;
}

/**
 * Settings the CLI supplies when the environment is silent: config.json first,
 * then the hosted defaults. Never called by the deployed HTTP server, whose
 * settings all come from render.yaml.
 */
export function applyCliDefaults(env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env);
  setIfUnset(env, 'BLOCKFROST_PROJECT_ID', config.blockfrostProjectId);
  setIfUnset(env, 'BAZAAR_API_URL', config.bazaarApiUrl ?? DEFAULT_BAZAAR_API_URL);
  setIfUnset(env, 'INDIGO_SYSTEM_PARAMS_URL', config.indigoSystemParamsUrl ?? DEFAULT_INDIGO_SYSTEM_PARAMS_URL);
}

/** Enough of a secret to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
  const keep = Math.min(8, Math.max(0, value.length - 4));
  return `${value.slice(0, keep)}… (${value.length} chars)`;
}
