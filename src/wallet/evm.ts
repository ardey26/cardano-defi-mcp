/**
 * viem plumbing for the EVM side of the wallet.
 *
 * Chains are mapped exactly as examples/execute-swap.ts maps them, plus Base;
 * the policy allowlist (WALLET_EVM_CHAINS) decides which of them may actually
 * be signed for, so adding a chain here does not by itself widen the leash.
 *
 * Each chain's RPC can be overridden with RPC_URL_<chainId>; without one viem
 * falls back to the chain's public RPC, which is fine for a PoC and rate
 * limited in practice.
 */

import { createPublicClient, createWalletClient, http, type Chain, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, mainnet } from 'viem/chains';

import { evmKey } from './keys.js';

interface ChainEntry {
  chain: Chain;
  explorer: string;
}

export const EVM_CHAINS: Record<number, ChainEntry> = {
  1: { chain: mainnet, explorer: 'https://etherscan.io/tx/' },
  42161: { chain: arbitrum, explorer: 'https://arbiscan.io/tx/' },
  8453: { chain: base, explorer: 'https://basescan.org/tx/' },
};

export function chainEntry(chainId: number): ChainEntry {
  const entry = EVM_CHAINS[chainId];
  if (!entry) {
    throw new Error(
      `chain ${chainId} is not mapped in this wallet — known chains are ${Object.keys(EVM_CHAINS).join(', ')}`,
    );
  }
  return entry;
}

export function explorerTxUrl(chainId: number, txHash: string): string {
  return `${chainEntry(chainId).explorer}${txHash}`;
}

export function rpcUrl(chainId: number): string | undefined {
  return process.env[`RPC_URL_${chainId}`] || undefined;
}

export function publicClientFor(chainId: number): PublicClient {
  const { chain } = chainEntry(chainId);
  return createPublicClient({ chain, transport: http(rpcUrl(chainId)) }) as PublicClient;
}

export function walletClientFor(chainId: number): WalletClient {
  const { chain } = chainEntry(chainId);
  return createWalletClient({
    account: privateKeyToAccount(evmKey()),
    chain,
    transport: http(rpcUrl(chainId)),
  });
}
