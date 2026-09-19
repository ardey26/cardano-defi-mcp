/**
 * The one-command local server: discovery, quotes, balances, signing and
 * onboarding behind a single MCP connection.
 *
 * `claude mcp add cardano-defi -- npx -y github:ardey26/cardano-defi-mcp` spawns
 * this. It is the keyless server's nine tools PLUS the wallet's signing tools
 * PLUS setup_wallet / configure, so an agent can take a user from nothing
 * installed to a funded, capped, working wallet without them editing a file.
 *
 * It holds keys, so it inherits the wallet server's hard rule: stdio only,
 * never a network transport. `assertStdioOnly` enforces it here exactly as it
 * does in server.ts — the combined mode is not a loophole around it.
 *
 * The hosted deployment is unaffected: nothing in dist/ imports this file, and
 * `node dist/server.js` still starts the keyless nine-tool server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from '../tools/index.js';
import { bootstrapCli, hasCardanoKey, hasEvmKey } from './keys.js';
import { registerOnboardingTools } from './onboarding.js';
import { loadPolicy, policySummary } from './policy.js';
import { assertStdioOnly } from './server.js';
import { readLedger, stateFilePath } from './state.js';
import { registerWalletTools } from './tools.js';

export function createCombinedServer(): McpServer {
  const server = new McpServer(
    { name: 'cardano-defi-mcp', version: '0.1.0' },
    {
      instructions:
        'Cardano DeFi rails with a local signing wallet attached. Read tools browse a taxonomy of Cardano ' +
        'venues, quote cross-chain swaps into ADA through the BazaarSwap routing backend, and read balances ' +
        'and Indigo/Liqwid positions. Build tools return UNSIGNED transactions; the wallet tools in this same ' +
        'server sign and submit them from a local burner key, WITH NO HUMAN CONFIRMATION, bounded only by ' +
        'per-transaction and rolling-24h spending caps per chain family plus an EVM chain allowlist. ' +
        'FIRST RUN: call wallet_status. If it reports no keys, call setup_wallet and show the user the ' +
        'addresses and the funding note it returns. If a tool says a setting is missing, it names the exact ' +
        'call that fixes it — usually configure with blockfrostProjectId (free at https://blockfrost.io). ' +
        "Conventions: amounts are in the token's smallest unit (USDC and ADA both use 6 decimals); " +
        'Cardano\'s chain id is the string "CARDANO" and native ADA is the zero address. ' +
        'Reliability: the quote backend sleeps when idle — if get_quote returns zero routes, that is ' +
        'usually a cold start, not a missing route; wait ~30 seconds and retry once before concluding ' +
        'no route exists. Quotes expire in ~60 seconds and open_cdp transactions embed a price valid ' +
        '~280 seconds, so sign immediately after building. A swap that starts on Cardano executes as a ' +
        'plain payment to the quote\'s deposit address: use send_cardano for that leg.',
    },
  );

  registerTools(server);
  registerWalletTools(server);
  registerOnboardingTools(server);
  return server;
}

export async function main(): Promise<number> {
  bootstrapCli();
  assertStdioOnly();

  const server = createCombinedServer();
  await server.connect(new StdioServerTransport());

  const caps = policySummary(loadPolicy(), readLedger(), Date.now());
  console.error(
    `cardano-defi-mcp ready on stdio (defi + wallet) — EVM key ${hasEvmKey() ? 'loaded' : 'absent'}, ` +
      `Cardano key ${hasCardanoKey() ? 'loaded' : 'absent'}, Blockfrost ` +
      `${process.env.BLOCKFROST_PROJECT_ID ? 'configured' : 'NOT configured (call configure)'}`,
  );
  console.error(
    `caps: EVM ${caps.evm.perTxCap}/tx, ${caps.evm.dailyCap}/24h; ` +
      `Cardano ${caps.cardano.perTxCap}/tx, ${caps.cardano.dailyCap}/24h. Ledger: ${stateFilePath()}`,
  );
  return 0;
}
