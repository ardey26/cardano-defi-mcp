/**
 * Policy tests. Pure math and one filesystem roundtrip in a temp dir —
 * no network, no keys, no clock dependency (every check takes `now`).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CML } from '@lucid-evolution/lucid';

import {
  assertEvmChainAllowed,
  assertSpendAllowed,
  DEFAULT_MAX_DAILY_LOVELACE,
  DEFAULT_MAX_DAILY_WEI,
  DEFAULT_MAX_TX_LOVELACE,
  DEFAULT_MAX_TX_WEI,
  formatAmount,
  loadPolicy,
  PolicyDenied,
  policySummary,
  pruneEntries,
  spentInWindow,
  WINDOW_MS,
  type SpendEntry,
} from '../wallet/policy.js';
import { readLedger, recordSpend, writeLedger } from '../wallet/state.js';
import { cardanoOutflowLovelace } from '../wallet/cardano.js';

const NOW = 1_800_000_000_000;

const entry = (at: number, family: SpendEntry['family'], amount: bigint): SpendEntry => ({
  at,
  family,
  amount: amount.toString(),
});

// ── env-driven caps ─────────────────────────────────────────────────────────

describe('loadPolicy', () => {
  it('defaults to the documented caps and chain allowlist', () => {
    const policy = loadPolicy({});
    expect(policy.maxTxLovelace).toBe(DEFAULT_MAX_TX_LOVELACE);
    expect(policy.maxDailyLovelace).toBe(DEFAULT_MAX_DAILY_LOVELACE);
    expect(policy.maxTxWei).toBe(DEFAULT_MAX_TX_WEI);
    expect(policy.maxDailyWei).toBe(DEFAULT_MAX_DAILY_WEI);
    expect(policy.evmChains).toEqual([1, 42161, 8453]);
  });

  it('reads overrides and trims the chain list', () => {
    const policy = loadPolicy({ WALLET_MAX_TX_LOVELACE: '7', WALLET_EVM_CHAINS: ' 10 , 8453 ' });
    expect(policy.maxTxLovelace).toBe(7n);
    expect(policy.evmChains).toEqual([10, 8453]);
  });

  it('refuses a cap that is not a whole number of base units', () => {
    expect(() => loadPolicy({ WALLET_MAX_TX_WEI: '0.01' })).toThrow(/whole number of base units/);
  });
});

describe('formatAmount', () => {
  it('renders both the human figure and the base units', () => {
    expect(formatAmount('cardano', 25_000_000n)).toBe('25 ADA (25000000 lovelace)');
    expect(formatAmount('cardano', 1_500_000n)).toBe('1.5 ADA (1500000 lovelace)');
    expect(formatAmount('evm', 10_000_000_000_000_000n)).toBe('0.01 ETH (10000000000000000 wei)');
    expect(formatAmount('evm', 0n)).toBe('0 ETH (0 wei)');
  });
});

// ── window math ─────────────────────────────────────────────────────────────

describe('the 24h window', () => {
  const entries = [
    entry(NOW - WINDOW_MS - 1, 'cardano', 90_000_000n), // aged out
    entry(NOW - WINDOW_MS + 1, 'cardano', 10_000_000n), // just inside
    entry(NOW - 1_000, 'cardano', 5_000_000n),
  ];

  it('prunes strictly older than 24h and keeps the edge', () => {
    expect(pruneEntries(entries, NOW)).toHaveLength(2);
  });

  it('sums only what is still inside the window', () => {
    expect(spentInWindow(entries, 'cardano', NOW)).toBe(15_000_000n);
  });

  it('lets an entry age out: the same ledger sums lower an hour later', () => {
    expect(spentInWindow(entries, 'cardano', NOW + 60 * 60_000)).toBe(5_000_000n);
  });
});

describe('per-chain-family buckets', () => {
  const entries = [entry(NOW - 1_000, 'cardano', 90_000_000n), entry(NOW - 1_000, 'evm', 5n)];

  it('does not let a Cardano spend count against the EVM cap', () => {
    expect(spentInWindow(entries, 'evm', NOW)).toBe(5n);
    expect(spentInWindow(entries, 'cardano', NOW)).toBe(90_000_000n);
  });

  it('allows an EVM spend while Cardano is nearly exhausted', () => {
    const policy = loadPolicy({});
    expect(assertSpendAllowed(policy, entries, 'evm', 1_000_000_000_000_000n, NOW).allowed).toBe(true);
    expect(() => assertSpendAllowed(policy, entries, 'cardano', 20_000_000n, NOW)).toThrow(PolicyDenied);
  });
});

// ── denials ─────────────────────────────────────────────────────────────────

describe('denial messages', () => {
  const policy = loadPolicy({});

  it('names the per-tx cap, the attempt and the daily headroom', () => {
    let denied: PolicyDenied | undefined;
    try {
      assertSpendAllowed(policy, [], 'cardano', 30_000_000n, NOW);
    } catch (err) {
      denied = err as PolicyDenied;
    }
    expect(denied).toBeInstanceOf(PolicyDenied);
    expect(denied!.message).toContain('30 ADA (30000000 lovelace)');
    expect(denied!.message).toContain('per-transaction cap of 25 ADA (25000000 lovelace)');
    expect(denied!.message).toContain('WALLET_MAX_TX_LOVELACE');
    expect(denied!.detail).toMatchObject({
      error: 'policy_denied',
      family: 'cardano',
      unit: 'lovelace',
      attempted: '30 ADA (30000000 lovelace)',
      perTxCap: '25 ADA (25000000 lovelace)',
      dailyCap: '100 ADA (100000000 lovelace)',
      spentLast24h: '0 ADA (0 lovelace)',
      remainingDaily: '100 ADA (100000000 lovelace)',
    });
    expect(denied!.detail.headroomReturnsAt).toBeUndefined();
  });

  it('says when headroom comes back after a daily-cap denial', () => {
    const entries = [
      entry(NOW - WINDOW_MS + 60_000, 'cardano', 50_000_000n),
      entry(NOW - 1_000, 'cardano', 40_000_000n),
    ];
    let denied: PolicyDenied | undefined;
    try {
      assertSpendAllowed(policy, entries, 'cardano', 20_000_000n, NOW);
    } catch (err) {
      denied = err as PolicyDenied;
    }
    expect(denied!.detail.spentLast24h).toBe('90 ADA (90000000 lovelace)');
    expect(denied!.detail.remainingDaily).toBe('10 ADA (10000000 lovelace)');
    // Dropping the older 50 ADA entry frees enough, and it leaves the window
    // exactly 24h after it was recorded.
    expect(denied!.detail.headroomReturnsAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('says plainly that waiting cannot help when the attempt beats the whole daily cap', () => {
    let denied: PolicyDenied | undefined;
    try {
      assertSpendAllowed(loadPolicy({ WALLET_MAX_TX_LOVELACE: '200000000' }), [], 'cardano', 150_000_000n, NOW);
    } catch (err) {
      denied = err as PolicyDenied;
    }
    expect(denied!.message).toContain('No amount of waiting helps');
    expect(denied!.detail.headroomReturnsAt).toBeUndefined();
  });

  it('allows a spend that lands exactly on the daily cap', () => {
    const entries = [entry(NOW - 1_000, 'cardano', 80_000_000n)];
    expect(assertSpendAllowed(policy, entries, 'cardano', 20_000_000n, NOW).allowed).toBe(true);
    expect(() => assertSpendAllowed(policy, entries, 'cardano', 20_000_001n, NOW)).toThrow(/rolling 24h/);
  });

  it('rejects an EVM chain that is not on the allowlist, and names the allowlist', () => {
    expect(() => assertEvmChainAllowed(policy, 137)).toThrow(/chain 137 is not in the allowlist \[1, 42161, 8453\]/);
    expect(() => assertEvmChainAllowed(policy, 8453)).not.toThrow();
  });

  it('does not invent spend figures on a chain denial — it never read the ledger', () => {
    let denied: PolicyDenied | undefined;
    try {
      assertEvmChainAllowed(policy, 137);
    } catch (err) {
      denied = err as PolicyDenied;
    }
    expect(denied!.detail.allowedChains).toEqual([1, 42161, 8453]);
    expect(denied!.detail.spentLast24h).toBeUndefined();
    expect(denied!.detail.remainingDaily).toBeUndefined();
  });
});

describe('policySummary', () => {
  it('reports headroom per family and never goes negative', () => {
    const entries = [entry(NOW - 1_000, 'cardano', 200_000_000n)];
    const summary = policySummary(loadPolicy({}), entries, NOW);
    expect(summary.cardano.remainingDaily).toBe('0 ADA (0 lovelace)');
    expect(summary.evm.remainingDaily).toBe('0.03 ETH (30000000000000000 wei)');
    expect(summary.evm.allowedChains).toEqual([1, 42161, 8453]);
  });
});

// ── persistence ─────────────────────────────────────────────────────────────

describe('the ledger file', () => {
  const dirs: string[] = [];
  const tmpFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'wallet-state-'));
    dirs.push(dir);
    return join(dir, '.wallet-state.json');
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads a missing file as an empty ledger', () => {
    expect(readLedger(tmpFile())).toEqual([]);
  });

  it('roundtrips entries so the caps survive a restart', () => {
    const path = tmpFile();
    const entries = [entry(NOW - 1_000, 'evm', 5_000_000_000_000_000n), entry(NOW - 2_000, 'cardano', 1n)];
    writeLedger(entries, path);
    expect(readLedger(path)).toEqual(entries);
    expect(spentInWindow(readLedger(path), 'evm', NOW)).toBe(5_000_000_000_000_000n);
  });

  it('prunes on record, so the file cannot grow forever', () => {
    const path = tmpFile();
    writeLedger([entry(NOW - WINDOW_MS - 1, 'evm', 1n), entry(NOW - 1_000, 'evm', 2n)], path);
    const after = recordSpend(entry(NOW, 'evm', 3n), path);
    expect(after.map((e) => e.amount)).toEqual(['2', '3']);
    expect(readLedger(path)).toHaveLength(2);
  });

  it('refuses to sign on a corrupt ledger rather than treating it as a free reset', () => {
    const path = tmpFile();
    writeFileSync(path, '{ not json');
    expect(() => readLedger(path)).toThrow(/Refusing to sign/);
    writeFileSync(path, JSON.stringify({ version: 1, spends: [{ at: 'soon' }] }));
    expect(() => readLedger(path)).toThrow(/valid spend ledger/);
  });
});

// ── Cardano outflow ─────────────────────────────────────────────────────────

function enterpriseAddress(): { address: string; cml: CML.Address } {
  const hash = CML.PrivateKey.generate_ed25519().to_public().hash();
  const cml = CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(hash)).to_address();
  return { address: cml.to_bech32(undefined), cml };
}

function txWith(outputs: { to: CML.Address; lovelace: bigint }[], fee: bigint): string {
  const inputs = CML.TransactionInputList.new();
  inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex('00'.repeat(32)), 0n));
  const outs = CML.TransactionOutputList.new();
  for (const output of outputs) {
    outs.add(CML.TransactionOutput.new(output.to, CML.Value.new(output.lovelace, CML.MultiAsset.new()), undefined, undefined));
  }
  return CML.Transaction.new(
    CML.TransactionBody.new(inputs, outs, fee),
    CML.TransactionWitnessSet.new(),
    true,
    undefined,
  ).to_cbor_hex();
}

describe('cardanoOutflowLovelace', () => {
  it('charges outputs that leave the wallet, plus the fee, and not the change', () => {
    const wallet = enterpriseAddress();
    const other = enterpriseAddress();
    const cbor = txWith(
      [
        { to: other.cml, lovelace: 8_000_000n },
        { to: wallet.cml, lovelace: 4_000_000n },
      ],
      200_000n,
    );
    const outflow = cardanoOutflowLovelace(cbor, wallet.address);
    expect(outflow.lovelace).toBe(8_200_000n);
    expect(outflow.fee).toBe(200_000n);
    expect(outflow.returnedToWallet).toBe(4_000_000n);
    expect(outflow.outputs).toBe(2);
  });

  it('charges only the fee for a self-transfer', () => {
    const wallet = enterpriseAddress();
    const cbor = txWith([{ to: wallet.cml, lovelace: 9_000_000n }], 170_000n);
    expect(cardanoOutflowLovelace(cbor, wallet.address).lovelace).toBe(170_000n);
  });

  it('rejects CBOR that is not a transaction', () => {
    expect(() => cardanoOutflowLovelace('deadbeef', enterpriseAddress().address)).toThrow(
      /not a parseable Cardano transaction/,
    );
  });

  it('feeds the policy check: a 30 ADA payment trips the default per-tx cap', () => {
    const wallet = enterpriseAddress();
    const other = enterpriseAddress();
    const cbor = txWith([{ to: other.cml, lovelace: 30_000_000n }], 200_000n);
    const { lovelace } = cardanoOutflowLovelace(cbor, wallet.address);
    expect(() => assertSpendAllowed(loadPolicy({}), [], 'cardano', lovelace, NOW)).toThrow(/per-transaction cap/);
  });
});
