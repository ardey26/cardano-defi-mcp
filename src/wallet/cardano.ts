/**
 * Cardano signing for the wallet server, and the ADA figure the policy checks.
 *
 * Signing is exactly what examples/execute-cdp.ts proved on mainnet:
 * `selectWallet.fromPrivateKey` + `fromTx(cbor).sign.withWallet().complete().submit()`.
 * Nothing rebuilds the body, so a pinned Pyth price and validity range survive.
 */

import { Blockfrost, CML, Lucid } from '@lucid-evolution/lucid';
import type { LucidEvolution } from '@lucid-evolution/lucid';

import { getBaseUrl, getProjectId } from '../adapters/blockfrost.js';
import { isOwnAddress, type ResolveInputs } from './guard.js';
import { makeKeyedApi } from './keyed-wallet.js';
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
  /** lovelace in outputs that pay back to this wallet's exact address (payment and stake part) */
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

  const body = tx.body();
  const outputs = body.outputs();
  const fee = body.fee();

  let leaving = 0n;
  let returned = 0n;
  for (let i = 0; i < outputs.len(); i++) {
    const output = outputs.get(i);
    const coin = output.amount().coin();
    // Only the wallet's exact address counts as returned: its payment key under a
    // foreign stake key is value that leaves the wallet's view.
    if (isOwnAddress(output.address(), walletAddress)) returned += coin;
    else leaving += coin;
  }

  return { lovelace: leaving + fee, fee, returnedToWallet: returned, outputs: outputs.len(), conservative: true };
}

export async function mkSigner(): Promise<{ lucid: LucidEvolution; address: string }> {
  const key = cardanoKey();
  const net = network();
  const provider = new Blockfrost(getBaseUrl(), getProjectId());
  const lucid = await Lucid(provider, net);
  // Not selectWallet.fromPrivateKey: that wallet is an enterprise address, which aggregators refuse.
  lucid.selectWallet.fromAPI(makeKeyedApi(key, net, provider));
  return { lucid, address: addressOf(key, net) };
}

/** The guard's input resolver over Blockfrost, which the signer already requires. */
export function blockfrostResolver(lucid: Pick<LucidEvolution, 'utxosByOutRef'>): ResolveInputs {
  return async (refs) => {
    const utxos = await lucid.utxosByOutRef(
      refs.map((r) => {
        const [txHash, index] = r.split('#');
        return { txHash, outputIndex: Number(index) };
      }),
    );
    return new Map(utxos.map((u) => [`${u.txHash}#${u.outputIndex}`, u.address]));
  };
}
