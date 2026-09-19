/**
 * Cardano signing for the wallet server, and the ADA figure the policy checks.
 *
 * Signing is exactly what examples/execute-cdp.ts proved on mainnet:
 * `selectWallet.fromPrivateKey` + `fromTx(cbor).sign.withWallet().complete().submit()`.
 * Nothing rebuilds the body, so a pinned Pyth price and validity range survive.
 */

import { Blockfrost, CML, Lucid, paymentCredentialOf } from '@lucid-evolution/lucid';
import type { LucidEvolution } from '@lucid-evolution/lucid';

import { getBaseUrl, getProjectId } from '../adapters/blockfrost.js';
import { addressOf, cardanoKey, network, type Net } from './keys.js';

export const EXPLORERS: Record<Net, string> = {
  Mainnet: 'https://cardanoscan.io/transaction/',
  Preprod: 'https://preprod.cardanoscan.io/transaction/',
};

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORERS[network()]}${txHash}`;
}

export interface Outflow {
  /** what the policy checks: everything that does not come back to the wallet, plus the fee */
  lovelace: bigint;
  fee: bigint;
  /** lovelace in outputs that pay back to this wallet's payment credential */
  returnedToWallet: bigint;
  outputs: number;
  conservative: true;
}

/**
 * Conservative net ADA outflow for an unsigned transaction.
 *
 * A transaction body lists its inputs as out-refs only — it carries no input
 * values — so an EXACT net outflow would mean resolving every input against the
 * chain, which needs a UTxO lookup per input and is wrong the moment one of
 * them has already been spent. This deliberately does not do that.
 *
 * Instead: outflow = (every output NOT paying back to this wallet) + the fee.
 *
 * That is exact when every input belongs to the wallet, which is the normal
 * case for a transaction the main server balanced against this address. It
 * OVER-counts when the transaction also spends value the wallet did not own —
 * closing an Indigo CDP, for instance, spends collateral out of the CDP
 * validator and pays it to the wallet, and any part of that value that lands
 * somewhere else is counted here as if the wallet had paid it. Over-counting
 * denies more than it should, never less, which is the right direction for a
 * spending leash. If a legitimate unwind trips the cap, raise
 * WALLET_MAX_TX_LOVELACE for that call rather than making this smarter.
 */
export function cardanoOutflowLovelace(unsignedTxCbor: string, walletAddress: string): Outflow {
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(unsignedTxCbor);
  } catch (err) {
    throw new Error(
      `unsignedTxCbor is not a parseable Cardano transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const ours = paymentCredentialOf(walletAddress).hash;
  const body = tx.body();
  const outputs = body.outputs();
  const fee = body.fee();

  let leaving = 0n;
  let returned = 0n;
  for (let i = 0; i < outputs.len(); i++) {
    const output = outputs.get(i);
    const coin = output.amount().coin();
    let mine = false;
    try {
      mine = paymentCredentialOf(output.address().to_bech32(undefined)).hash === ours;
    } catch {
      // An address this build cannot express as bech32 (e.g. Byron) is not ours.
      mine = false;
    }
    if (mine) returned += coin;
    else leaving += coin;
  }

  return { lovelace: leaving + fee, fee, returnedToWallet: returned, outputs: outputs.len(), conservative: true };
}

export async function mkSigner(): Promise<{ lucid: LucidEvolution; address: string }> {
  const key = cardanoKey();
  const net = network();
  const lucid = await Lucid(new Blockfrost(getBaseUrl(), getProjectId()), net);
  lucid.selectWallet.fromPrivateKey(key);
  // Derived locally rather than asked of the wallet: identical result, and it
  // keeps the address readable when no Blockfrost key is configured.
  return { lucid, address: addressOf(key, net) };
}
