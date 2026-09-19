import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { buildSwapTx, getQuote } from '../adapters/swap.js';
import { toolResult } from './result.js';

export function registerSwapTools(server: McpServer): void {
  server.registerTool(
    'get_quote',
    {
      title: 'Get cross-chain swap quotes',
      description:
        'Race the BazaarSwap routing backend for cross-chain swap quotes (for example EVM assets into ADA) and ' +
        'return the best route plus every route found, sorted by net output. Read-only: quoting moves no funds. ' +
        'Amounts are in the source token\'s smallest unit. The returned quoteId feeds build_swap_tx. ' +
        'The race can take up to ~35 seconds. An EMPTY result usually means the backend was cold-starting, ' +
        'not that no route exists: wait ~30 seconds and retry once before reporting no route.',
      inputSchema: {
        fromChain: z.string().min(1).describe('Source chain id, e.g. "1" for Ethereum'),
        toChain: z.string().min(1).describe('Destination chain id, e.g. "CARDANO" for Cardano'),
        fromToken: z.string().min(1).describe('Source token address (or native-token sentinel)'),
        toToken: z.string().min(1).describe('Destination token address; native ADA on "CARDANO" is the zero address'),
        amount: z.string().min(1).describe('Amount to send, in the source token\'s smallest unit'),
        userAddress: z.string().min(1).describe('Sender address on the source chain'),
        slippage: z.string().optional().describe('Slippage tolerance in percent, e.g. "0.5"'),
        recipientAddress: z
          .string()
          .optional()
          .describe('Destination-chain recipient; defaults to the sender when omitted'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (params) => toolResult(() => getQuote(params)),
  );

  server.registerTool(
    'build_swap_tx',
    {
      title: 'Build an unsigned swap transaction',
      description:
        'Turn a quoteId from get_quote into transaction data for the swap. Returns an UNSIGNED transaction: ' +
        'this server never holds keys, never signs and never broadcasts. The calling agent (or the user\'s ' +
        'wallet) signs and submits it. Quotes expire, so build shortly after quoting.',
      inputSchema: {
        quoteId: z.string().min(1).describe('quoteId from a get_quote result'),
        userAddress: z.string().min(1).describe('Sender address the transaction is built for'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ quoteId, userAddress }) =>
      toolResult(async () => ({
        ...(await buildSwapTx(quoteId, userAddress)),
        signing: 'UNSIGNED. Sign with your own keys and submit; this server holds no keys and no funds.',
      })),
  );
}
