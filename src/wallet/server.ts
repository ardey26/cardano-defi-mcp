#!/usr/bin/env node
/**
 * agent-wallet — the key-holding companion to the keyless cardano-defi-mcp server.
 *
 * The main server builds unsigned transactions and can be hosted publicly
 * because it has no signing code path. This one has the keys, so it is the
 * opposite: stdio only, local only, never network-exposed, and every spend runs
 * through the caps in policy.ts first.
 *
 *   npm run wallet                 # stdio MCP server
 *   npm run wallet -- gen          # create both burner keys in .env.local
 *   npm run wallet -- gen evm      # or just one
 *   npm run wallet -- gen cardano
 *
 * Keys: WALLET_EVM_PRIVATE_KEY and/or WALLET_CARDANO_PRIVATE_KEY in .env.local.
 * Whichever is present is served; the other chain's tools fail with a clear
 * message rather than silently doing nothing.
 */

import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolveCredentialsPath } from './home.js';
import { bootstrapCli, CARDANO_KEY_ENV, EVM_KEY_ENV, hasCardanoKey, hasEvmKey, redact } from './keys.js';
import { ensureKeys, hasKeyLine, registerOnboardingTools, type Chain } from './onboarding.js';
import { loadPolicy, policySummary } from './policy.js';
import { readLedger, stateFilePath } from './state.js';
import { registerWalletTools } from './tools.js';

export function createWalletServer(): McpServer {
  const server = new McpServer(
    { name: 'agent-wallet', version: '0.1.0' },
    {
      instructions:
        'Local signing wallet. This server HOLDS PRIVATE KEYS and SPENDS REAL FUNDS on request, with no ' +
        'human in the loop — the only thing standing between a tool call and a broadcast is the spending ' +
        'policy (per-transaction and rolling-24h caps per chain family, plus an EVM chain allowlist). ' +
        'Pair it with the keyless cardano-defi-mcp server: that one quotes, reads and builds UNSIGNED ' +
        'transactions, this one signs and submits them. Always call wallet_status first to see the ' +
        'addresses, the live balances and the remaining daily headroom; a denial comes back as an error ' +
        'carrying the cap, the attempted amount and the headroom, so re-plan from it rather than retrying. ' +
        'Cardano transactions can embed a price valid for only ~280 seconds — sign them immediately after ' +
        'they are built. ' +
        'FIRST RUN: if wallet_status reports no keys, call setup_wallet and show the user the addresses and ' +
        'the funding note it returns; if a tool says a setting is missing, it names the call that fixes it.',
    },
  );

  registerWalletTools(server);
  registerOnboardingTools(server);
  return server;
}

/**
 * A server that holds keys must never be reachable over the network. There is
 * no auth on the MCP HTTP host in this repo, so an HTTP agent-wallet would be
 * an open "spend my funds" endpoint.
 */
export function assertStdioOnly(env: NodeJS.ProcessEnv = process.env): void {
  const transport = env.MCP_TRANSPORT;
  if (transport !== undefined && transport !== 'stdio') {
    throw new Error(
      `agent-wallet refuses to start with MCP_TRANSPORT=${transport}. It holds private keys and signs ` +
        'transactions with no authentication, so exposing it over the network would be an open endpoint for ' +
        'spending your funds. Run it over stdio only (unset MCP_TRANSPORT), and keep the HTTP transport for ' +
        'the keyless cardano-defi-mcp server.',
    );
  }
  if (env.PORT !== undefined && env.PORT !== '') {
    throw new Error(
      `agent-wallet refuses to start with PORT=${env.PORT} set. PORT selects the HTTP transport, and a ` +
        'key-holding server must never be network-exposed. Unset PORT and run it over stdio.',
    );
  }
}

// ── gen ─────────────────────────────────────────────────────────────────────

/** Create burner keys and print ONLY their addresses. Never overwrites a key. */
function cmdGen(which: string[]): void {
  const wanted = (which.length === 0 ? ['evm', 'cardano'] : which) as Chain[];
  for (const name of wanted) {
    if (name !== 'evm' && name !== 'cardano') {
      throw new Error(`gen takes 'evm', 'cardano' or nothing (both), got '${name}'`);
    }
  }
  const path = resolveCredentialsPath();

  // Check every requested key before writing any of them, so a refusal leaves
  // the file exactly as it was.
  for (const name of wanted) {
    const env = name === 'evm' ? EVM_KEY_ENV : CARDANO_KEY_ENV;
    if (hasKeyLine(path, env)) throw new Error(`${path} already has a ${env} — refusing to overwrite it`);
  }

  for (const key of ensureKeys(wanted, path)) {
    console.log(`${key.chain === 'evm' ? 'EVM    ' : 'CARDANO'} ${key.address}`);
  }
}

// ── entry ───────────────────────────────────────────────────────────────────

const USAGE = `usage: npm run wallet -- [gen [evm|cardano]]   (or: cardano-defi-mcp wallet [gen ...])

  (no args)          start the agent-wallet MCP server on stdio
  gen                create both burner keys, print only their addresses
  gen evm            create only WALLET_EVM_PRIVATE_KEY
  gen cardano        create only WALLET_CARDANO_PRIVATE_KEY

Keys go to .env.local in a checkout, or ~/.cardano-defi-mcp/credentials.env when
installed. An agent can do the same thing by calling the setup_wallet tool.

This server holds private keys and spends real funds within the policy caps.`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  bootstrapCli();
  const [command, ...rest] = argv;

  if (command === 'gen') {
    cmdGen(rest);
    return 0;
  }
  if (command !== undefined) {
    console.log(USAGE);
    return 1;
  }

  assertStdioOnly();
  const policy = loadPolicy();
  const server = createWalletServer();
  await server.connect(new StdioServerTransport());

  const caps = policySummary(policy, readLedger(), Date.now());
  console.error(
    `agent-wallet MCP server ready on stdio — EVM key ${hasEvmKey() ? 'loaded' : 'absent'}, ` +
      `Cardano key ${hasCardanoKey() ? 'loaded' : 'absent'}`,
  );
  console.error(
    `caps: EVM ${caps.evm.perTxCap}/tx, ${caps.evm.dailyCap}/24h on chains [${policy.evmChains.join(', ')}]; ` +
      `Cardano ${caps.cardano.perTxCap}/tx, ${caps.cardano.dailyCap}/24h. Ledger: ${stateFilePath()}`,
  );
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(`error: ${redact(err instanceof Error ? err.message : String(err))}`);
      process.exit(1);
    });
}
