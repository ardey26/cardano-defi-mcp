/**
 * Key handling for the agent-wallet server.
 *
 * The keys live in `.env.local` (gitignored, chmod 600) and are read here only.
 * Nothing in this module ever returns, logs or serialises key material: the
 * tools expose addresses, and every error that leaves the process goes through
 * `redact()` first, because a library can and does put the value it choked on
 * into its own message.
 */

import { existsSync, readFileSync } from 'node:fs';

import { CML } from '@lucid-evolution/lucid';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { REPO_ROOT } from './state.js';

export const EVM_KEY_ENV = 'WALLET_EVM_PRIVATE_KEY';
export const CARDANO_KEY_ENV = 'WALLET_CARDANO_PRIVATE_KEY';

export type Net = 'Mainnet' | 'Preprod';

/** Minimal .env reader. Existing process env always wins; .env.local beats .env. */
export function loadEnvFiles(): void {
  for (const name of ['.env.local', '.env']) {
    const path = `${REPO_ROOT}${name}`;
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/** Belt and braces: a key must never reach a log line or a tool result. */
export function redact(text: string): string {
  let out = text;
  for (const env of [EVM_KEY_ENV, CARDANO_KEY_ENV]) {
    const key = process.env[env];
    if (key) out = out.split(key).join(`<${env} redacted>`);
  }
  return out;
}

export function network(): Net {
  const raw = process.env.CARDANO_NETWORK ?? 'mainnet';
  if (raw === 'mainnet') return 'Mainnet';
  if (raw === 'preprod') return 'Preprod';
  throw new Error(`CARDANO_NETWORK must be 'mainnet' or 'preprod', got '${raw}'`);
}

export function hasEvmKey(): boolean {
  return Boolean(process.env[EVM_KEY_ENV]);
}

export function hasCardanoKey(): boolean {
  return Boolean(process.env[CARDANO_KEY_ENV]);
}

export function evmKey(): Hex {
  const value = process.env[EVM_KEY_ENV];
  if (!value) {
    throw new Error(
      `${EVM_KEY_ENV} is not set — this wallet serves no EVM chains. ` +
        'Add the key to .env.local, or run `npm run wallet -- gen evm` to create a burner.',
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${EVM_KEY_ENV} must be a 0x-prefixed 32-byte hex private key`);
  }
  return value as Hex;
}

export function cardanoKey(): string {
  const value = process.env[CARDANO_KEY_ENV];
  if (!value) {
    throw new Error(
      `${CARDANO_KEY_ENV} is not set — this wallet serves no Cardano transactions. ` +
        'Add the key to .env.local, or run `npm run wallet -- gen cardano` to create a burner.',
    );
  }
  return value;
}

export function evmAddress(): Hex {
  return privateKeyToAccount(evmKey()).address;
}

/**
 * Mainnet/preprod enterprise address for a bech32 ed25519 key — the same
 * derivation `lucid.selectWallet.fromPrivateKey` performs, done without a
 * provider so `gen` needs no Blockfrost key.
 */
export function addressOf(key: string, net: Net): string {
  const pubKeyHash = CML.PrivateKey.from_bech32(key).to_public().hash();
  return CML.EnterpriseAddress.new(net === 'Mainnet' ? 1 : 0, CML.Credential.new_pub_key(pubKeyHash))
    .to_address()
    .to_bech32(undefined);
}

export function cardanoAddress(): string {
  return addressOf(cardanoKey(), network());
}
