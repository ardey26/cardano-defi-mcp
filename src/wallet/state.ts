/**
 * The daily-spend ledger on disk.
 *
 * `.wallet-state.json` at the repo root (gitignored, chmod 600). It holds only
 * what the policy window needs — timestamp, family, base-unit amount, and the
 * tx hash for a human audit — and never any key material.
 *
 * Restart safety is the whole point: the caps would be meaningless if an agent
 * could reset them by restarting the server, so the window is reconstructed
 * from this file on every check rather than kept in memory.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pruneEntries, type SpendEntry } from './policy.js';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function stateFilePath(): string {
  return process.env.WALLET_STATE_FILE ?? `${REPO_ROOT}.wallet-state.json`;
}

interface StateFile {
  version: 1;
  spends: SpendEntry[];
}

function isEntry(value: unknown): value is SpendEntry {
  const entry = value as SpendEntry | null;
  return (
    !!entry &&
    typeof entry.at === 'number' &&
    (entry.family === 'evm' || entry.family === 'cardano') &&
    typeof entry.amount === 'string' &&
    /^\d+$/.test(entry.amount)
  );
}

/**
 * Read the ledger. A missing file is an empty ledger.
 *
 * A corrupt file is NOT treated as empty — that would be a free cap reset for
 * anything that can write junk into the file. It fails loudly instead.
 */
export function readLedger(path: string = stateFilePath()): SpendEntry[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        'Refusing to sign with an unreadable spend ledger — fix or delete the file.',
    );
  }
  const spends = (parsed as StateFile | null)?.spends;
  if (!Array.isArray(spends) || !spends.every(isEntry)) {
    throw new Error(`${path} does not hold a valid spend ledger. Refusing to sign — fix or delete the file.`);
  }
  return spends;
}

export function writeLedger(entries: SpendEntry[], path: string = stateFilePath()): void {
  const body: StateFile = { version: 1, spends: entries };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; a non-POSIX filesystem is not a reason to fail a submitted tx
  }
}

/** Record a spend that actually went out, pruning anything older than the window. */
export function recordSpend(entry: SpendEntry, path: string = stateFilePath()): SpendEntry[] {
  const entries = pruneEntries(readLedger(path), entry.at);
  entries.push(entry);
  writeLedger(entries, path);
  return entries;
}
