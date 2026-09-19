/**
 * The four agent-wallet tools.
 *
 * Every one of them either reads the wallet or spends from it. There is no
 * confirmation prompt anywhere: the policy caps in policy.ts ARE the
 * confirmation, which is why the descriptions say so in plain words.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { erc20Abi, type Hex } from 'viem';
import { getAddressDetails } from '@lucid-evolution/lucid';

import { getBalance } from '../adapters/blockfrost.js';
import { cardanoOutflowLovelace, explorerTxUrl as cardanoExplorerTxUrl, mkSigner } from './cardano.js';
import { chainEntry, explorerTxUrl, publicClientFor, walletClientFor, EVM_CHAINS } from './evm.js';
import { cardanoAddress, evmAddress, hasCardanoKey, hasEvmKey, network, redact } from './keys.js';
import {
  assertEvmChainAllowed,
  assertSpendAllowed,
  loadPolicy,
  policySummary,
  PolicyDenied,
  formatAmount,
} from './policy.js';
import { readLedger, recordSpend } from './state.js';

const SPENDS_REAL_FUNDS =
  'THIS TOOL SPENDS REAL FUNDS from a private key held by this server, with no human confirmation, ' +
  'up to the configured policy caps. Check wallet_status for the caps and the remaining daily headroom first.';

/**
 * Same shape as src/tools/result.ts, with two differences that matter here:
 * every message goes through redact(), and a policy denial returns its full
 * numeric detail as JSON so the agent can re-plan instead of guessing.
 */
async function walletResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run(), null, 2) }] };
  } catch (err) {
    if (err instanceof PolicyDenied) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.detail, null, 2) }] };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: redact(message) }] };
  }
}

const amountString = (what: string) => z.string().regex(/^\d+$/, `${what} must be a decimal string of base units`);

export function registerWalletTools(server: McpServer): void {
  server.registerTool(
    'wallet_status',
    {
      title: 'Show the wallet addresses, balances and spending caps',
      description:
        'Read-only. Reports which chains this wallet can sign for, the addresses it signs with, their live ' +
        'balances, and the policy caps plus the remaining rolling-24h headroom per chain family. Returns no ' +
        'key material. Call this before any signing tool to see what is actually spendable.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      walletResult(async () => {
        if (!hasEvmKey() && !hasCardanoKey()) {
          throw new Error(
            'This wallet holds no keys yet, so there is nothing to report. Call setup_wallet to create ' +
              'burner keys (both chains by default), then show the user the addresses it returns so they ' +
              'can fund them.',
          );
        }
        const policy = loadPolicy();
        const ledger = readLedger();
        const now = Date.now();

        const evm = hasEvmKey()
          ? {
              address: evmAddress(),
              balances: await Promise.all(
                policy.evmChains.map(async (chainId) => {
                  if (!EVM_CHAINS[chainId]) {
                    return { chainId, error: 'not mapped in this wallet (known: 1, 42161, 8453)' };
                  }
                  try {
                    const balance = await publicClientFor(chainId).getBalance({ address: evmAddress() });
                    return {
                      chainId,
                      chain: chainEntry(chainId).chain.name,
                      balance: formatAmount('evm', balance),
                    };
                  } catch (err) {
                    return { chainId, error: redact(err instanceof Error ? err.message : String(err)) };
                  }
                }),
              ),
            }
          : {
              address: null,
              note:
                'WALLET_EVM_PRIVATE_KEY is not set — EVM signing is unavailable. ' +
                "Call setup_wallet with chains ['evm'] to create one.",
            };

        const cardano = await (async () => {
          if (!hasCardanoKey()) {
            return {
              address: null,
              note:
                'WALLET_CARDANO_PRIVATE_KEY is not set — Cardano signing is unavailable. ' +
                "Call setup_wallet with chains ['cardano'] to create one.",
            };
          }
          const address = cardanoAddress();
          try {
            const balance = await getBalance(address);
            return { address, balance: formatAmount('cardano', BigInt(balance.lovelace)), assets: balance.assets };
          } catch (err) {
            return { address, error: redact(err instanceof Error ? err.message : String(err)) };
          }
        })();

        return { evm, cardano, policy: policySummary(policy, ledger, now), spendsRecorded: ledger.length };
      }),
  );

  server.registerTool(
    'sign_and_submit_evm',
    {
      title: 'Sign and broadcast an EVM transaction',
      description:
        `${SPENDS_REAL_FUNDS} Signs the given EVM transaction with this wallet's key, broadcasts it, waits for ` +
        'the receipt and returns the hash, an explorer link and the receipt status. `value` is checked against ' +
        'the per-transaction and rolling-24h wei caps, and the chain must be on the WALLET_EVM_CHAINS allowlist. ' +
        'Feed it the `txData` from the main server\'s build_swap_tx. For an ERC-20 source, call approve_erc20 first.',
      inputSchema: {
        chainId: z.number().int().positive().describe('EVM chain id — must be on the WALLET_EVM_CHAINS allowlist'),
        to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('Target contract or address'),
        data: z
          .string()
          .regex(/^0x[0-9a-fA-F]*$/)
          .optional()
          .describe('Calldata hex; omit or "0x" for a plain value transfer'),
        value: amountString('value').describe('Native value to send, in wei (use "0" for none)'),
        gasLimit: amountString('gasLimit').optional().describe('Gas limit; omit to let the node estimate'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ chainId, to, data, value, gasLimit }) =>
      walletResult(async () => {
        const policy = loadPolicy();
        assertEvmChainAllowed(policy, chainId);
        chainEntry(chainId);
        const wei = BigInt(value);
        const decision = assertSpendAllowed(policy, readLedger(), 'evm', wei, Date.now());

        const wallet = walletClientFor(chainId);
        const account = wallet.account!;
        const hash = await wallet.sendTransaction({
          account,
          chain: chainEntry(chainId).chain,
          to: to as Hex,
          data: (data ?? '0x') as Hex,
          value: wei,
          ...(gasLimit ? { gas: BigInt(gasLimit) } : {}),
        });

        // Recorded before the receipt: the value left the wallet at broadcast,
        // and a revert still burns gas. Under-counting here would let a stream
        // of reverting transactions walk straight past the daily cap.
        recordSpend({ at: Date.now(), family: 'evm', amount: wei.toString(), chainId, txHash: hash });

        const receipt = await publicClientFor(chainId).waitForTransactionReceipt({ hash });
        return {
          txHash: hash,
          explorerUrl: explorerTxUrl(chainId, hash),
          status: receipt.status,
          chainId,
          from: account.address,
          to,
          value: formatAmount('evm', wei),
          gasUsed: receipt.gasUsed.toString(),
          blockNumber: receipt.blockNumber.toString(),
          policy: decision.detail,
        };
      }),
  );

  server.registerTool(
    'approve_erc20',
    {
      title: 'Approve an ERC-20 spender',
      description:
        `${SPENDS_REAL_FUNDS} Sets this wallet's ERC-20 allowance for a spender, which is the approval leg a ` +
        'swap needs before sign_and_submit_evm. An approval moves no value, so it is exempt from the value ' +
        'caps — but it AUTHORISES the spender to move up to `amount` of that token later, which the caps do ' +
        'not police, so approve exact amounts to addresses you got from a quote. The chain must be on the ' +
        'WALLET_EVM_CHAINS allowlist. Tokens that reject a non-zero-to-non-zero approve (USDT and friends) are ' +
        'handled by resetting the allowance to zero first.',
      inputSchema: {
        chainId: z.number().int().positive().describe('EVM chain id — must be on the WALLET_EVM_CHAINS allowlist'),
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('ERC-20 token contract'),
        spender: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .describe("Address allowed to move the token — the quote's approvalAddress"),
        amount: amountString('amount').describe('Allowance to set, in the token\'s smallest unit ("0" revokes)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ chainId, token, spender, amount }) =>
      walletResult(async () => {
        const policy = loadPolicy();
        assertEvmChainAllowed(policy, chainId);
        const target = BigInt(amount);

        const publicClient = publicClientFor(chainId);
        const wallet = walletClientFor(chainId);
        const account = wallet.account!;
        const current = await publicClient.readContract({
          address: token as Hex,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [account.address, spender as Hex],
        });

        if (current === target) {
          return { chainId, token, spender, allowance: current.toString(), changed: false, note: 'already set' };
        }

        // USDT-class tokens revert a non-zero -> non-zero approve.
        let resetTxHash: string | undefined;
        if (current > 0n && target > 0n) {
          const hash = await wallet.writeContract({
            account,
            chain: chainEntry(chainId).chain,
            address: token as Hex,
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender as Hex, 0n],
          });
          const reset = await publicClient.waitForTransactionReceipt({ hash });
          if (reset.status !== 'success') throw new Error(`the allowance reset reverted (${hash}) — not approving`);
          resetTxHash = hash;
        }

        const hash = await wallet.writeContract({
          account,
          chain: chainEntry(chainId).chain,
          address: token as Hex,
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender as Hex, target],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        return {
          chainId,
          token,
          spender,
          owner: account.address,
          previousAllowance: current.toString(),
          allowance: target.toString(),
          changed: true,
          ...(resetTxHash ? { resetTxHash, resetExplorerUrl: explorerTxUrl(chainId, resetTxHash) } : {}),
          txHash: hash,
          explorerUrl: explorerTxUrl(chainId, hash),
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
        };
      }),
  );

  server.registerTool(
    'sign_and_submit_cardano',
    {
      title: 'Sign and submit a Cardano transaction',
      description:
        `${SPENDS_REAL_FUNDS} Takes the UNSIGNED transaction CBOR the main server returns (open_cdp, close_cdp, ` +
        "build_swap_tx on Cardano), adds this wallet's vkey witness and submits it through Blockfrost. The body " +
        'is never rebuilt, so a pinned Pyth price and validity range survive — submit promptly after building. ' +
        'Before signing, the ADA leaving the wallet is measured CONSERVATIVELY (every output that does not pay ' +
        'back to this wallet, plus the fee) and checked against the lovelace caps. Requires ' +
        'BLOCKFROST_PROJECT_ID and WALLET_CARDANO_PRIVATE_KEY.',
      inputSchema: {
        unsignedTxCbor: z
          .string()
          .regex(/^[0-9a-fA-F]+$/, 'unsignedTxCbor must be hex')
          .describe('Full transaction CBOR hex with an empty witness set, from the main server'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ unsignedTxCbor }) =>
      walletResult(async () => {
        const policy = loadPolicy();
        const { lucid, address } = await mkSigner();
        const outflow = cardanoOutflowLovelace(unsignedTxCbor, address);
        const decision = assertSpendAllowed(policy, readLedger(), 'cardano', outflow.lovelace, Date.now());

        const signed = await lucid.fromTx(unsignedTxCbor).sign.withWallet().complete();
        const txHash = await signed.submit();
        recordSpend({ at: Date.now(), family: 'cardano', amount: outflow.lovelace.toString(), txHash });

        return {
          txHash,
          explorerUrl: cardanoExplorerTxUrl(txHash),
          from: address,
          outflow: {
            charged: formatAmount('cardano', outflow.lovelace),
            fee: formatAmount('cardano', outflow.fee),
            returnedToWallet: formatAmount('cardano', outflow.returnedToWallet),
            outputs: outflow.outputs,
            note: 'conservative: outputs not returning to this wallet, plus the fee — see src/wallet/cardano.ts',
          },
          policy: decision.detail,
        };
      }),
  );

  server.registerTool(
    'send_cardano',
    {
      title: 'Send ADA to a Cardano address',
      description:
        `${SPENDS_REAL_FUNDS} Builds, signs and submits a plain ADA payment from this wallet. This is the ` +
        'Cardano-side execution leg of a deposit-address bridge: a quote that starts on Cardano gives a ' +
        'deposit address, and the swap happens when this wallet pays it — so `to` usually comes straight ' +
        'from a quote, and the payment must be exact. The amount plus the fee is checked against the ' +
        'lovelace caps before anything is signed. Requires BLOCKFROST_PROJECT_ID and ' +
        'WALLET_CARDANO_PRIVATE_KEY. For an already-built transaction (open_cdp, close_cdp) use ' +
        'sign_and_submit_cardano instead.',
      inputSchema: {
        to: z.string().min(1).describe('Bech32 recipient address, on the same network as this wallet'),
        lovelace: amountString('lovelace').describe('Amount to send, in lovelace (1 ADA = 1000000 lovelace)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, lovelace }) =>
      walletResult(async () => {
        const net = network();
        let details: ReturnType<typeof getAddressDetails>;
        try {
          details = getAddressDetails(to);
        } catch (err) {
          throw new Error(`'to' is not a valid Cardano address: ${err instanceof Error ? err.message : String(err)}`);
        }
        const expectedNetworkId = net === 'Mainnet' ? 1 : 0;
        if (details.networkId !== expectedNetworkId) {
          throw new Error(
            `'to' is a ${details.networkId === 1 ? 'mainnet' : 'testnet'} address but this wallet is on ` +
              `${net}. Refusing to send — funds sent across networks are lost.`,
          );
        }

        const policy = loadPolicy();
        const amount = BigInt(lovelace);
        // Checked before building so an over-cap request costs no Blockfrost
        // round trip; checked again below on the real outflow, which adds the fee.
        assertSpendAllowed(policy, readLedger(), 'cardano', amount, Date.now());

        const { lucid, address } = await mkSigner();
        const built = await lucid.newTx().pay.ToAddress(to, { lovelace: amount }).complete();
        const outflow = cardanoOutflowLovelace(built.toCBOR(), address);
        const decision = assertSpendAllowed(policy, readLedger(), 'cardano', outflow.lovelace, Date.now());

        const signed = await built.sign.withWallet().complete();
        const txHash = await signed.submit();
        recordSpend({ at: Date.now(), family: 'cardano', amount: outflow.lovelace.toString(), txHash });

        return {
          txHash,
          explorerUrl: cardanoExplorerTxUrl(txHash),
          from: address,
          to,
          sent: formatAmount('cardano', amount),
          charged: formatAmount('cardano', outflow.lovelace),
          fee: formatAmount('cardano', outflow.fee),
          policy: decision.detail,
        };
      }),
  );
}
