/**
 * The two tools that take a user from "nothing installed" to "the agent can
 * trade for me", without them ever opening a file or an editor.
 *
 *   setup_wallet   creates the burner keys and says how to fund them
 *   configure      stores the Blockfrost key (and any Bazaar API override)
 *
 * Key generation is shared with `gen` on the command line, and keeps its rule:
 * an existing key is never overwritten. A tool that silently replaced a funded
 * key would lose money, so a key that is already there is reported, not
 * regenerated.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { generatePrivateKey as generateCardanoKey } from '@lucid-evolution/lucid';
import { generatePrivateKey as generateEvmKey, privateKeyToAccount } from 'viem/accounts';

import { addressOf, CARDANO_KEY_ENV, EVM_KEY_ENV, network, redact } from './keys.js';
import {
  configPath,
  DEFAULT_BAZAAR_API_URL,
  maskSecret,
  readConfig,
  resolveCredentialsPath,
  writeConfig,
} from './home.js';
import { loadPolicy, policySummary } from './policy.js';
import { readLedger, stateFilePath } from './state.js';

export type Chain = 'evm' | 'cardano';

const KEY_ENV: Record<Chain, string> = { evm: EVM_KEY_ENV, cardano: CARDANO_KEY_ENV };

export function hasKeyLine(path: string, key: string): boolean {
  return existsSync(path) && new RegExp(`^\\s*${key}\\s*=\\s*\\S`, 'm').test(readFileSync(path, 'utf8'));
}

export function appendKey(path: string, key: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const prefix = existsSync(path) && !readFileSync(path, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}${key}=${value}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; a non-POSIX filesystem is not a reason to fail
  }
}

export interface GeneratedKey {
  chain: Chain;
  address: string;
  created: boolean;
  note?: string;
}

/**
 * Create the missing keys for `chains` in `path` and return every address.
 * An existing key is left exactly as it is and reported with `created: false`.
 */
export function ensureKeys(chains: Chain[], path: string): GeneratedKey[] {
  return chains.map((chain) => {
    const env = KEY_ENV[chain];
    const existing = process.env[env];

    if (existing || hasKeyLine(path, env)) {
      // The value in the file may not be loaded into this process (a key added
      // by hand after start-up), so only an in-environment key can be resolved
      // to an address here.
      if (!existing) {
        return {
          chain,
          address: '',
          created: false,
          note: `${env} is already in ${path} but not loaded in this process — restart the server to use it`,
        };
      }
      return {
        chain,
        address: chain === 'evm' ? privateKeyToAccount(existing as `0x${string}`).address : addressOf(existing, network()),
        created: false,
        note: `${env} already exists — kept as it is (never overwritten, it may hold funds)`,
      };
    }

    if (chain === 'evm') {
      const key = generateEvmKey();
      appendKey(path, env, key);
      process.env[env] = key;
      return { chain, address: privateKeyToAccount(key).address, created: true };
    }

    const key = generateCardanoKey();
    appendKey(path, env, key);
    process.env[env] = key;
    return { chain, address: addressOf(key, network()), created: true };
  });
}

const FUNDING =
  'Fund these addresses like a prepaid card, not like a savings account. Whatever sits in them is ' +
  'spendable by the agent without asking you, up to the caps above — there is no confirmation prompt ' +
  'anywhere in this server, the caps are the confirmation. Send a small amount you would not mind ' +
  'losing (a few ADA, a few dollars of ETH for gas), top it up when it runs out, and never use a ' +
  'wallet you also use for anything else.';

async function onboardingResult(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run(), null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: redact(message) }] };
  }
}

export function registerOnboardingTools(server: McpServer): void {
  server.registerTool(
    'setup_wallet',
    {
      title: 'Create the burner keys this wallet signs with',
      description:
        'First-run setup. Generates the missing private keys for the requested chains, stores them in a ' +
        'chmod-600 credentials file outside the conversation, and returns ONLY the addresses, the spending ' +
        'caps and how to fund them. An existing key is never overwritten. Call this when wallet_status says ' +
        'there are no keys, then show the user the addresses and the funding note verbatim.',
      inputSchema: {
        chains: z
          .array(z.enum(['evm', 'cardano']))
          .optional()
          .describe('Which key families to create; omit for both'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chains }) =>
      onboardingResult(async () => {
        const wanted: Chain[] = chains && chains.length > 0 ? [...new Set(chains)] : ['evm', 'cardano'];
        const path = resolveCredentialsPath();
        const wallets = ensureKeys(wanted, path);

        return {
          wallets,
          credentialsFile: path,
          spendLedger: stateFilePath(),
          caps: policySummary(loadPolicy(), readLedger(), Date.now()),
          funding: FUNDING,
          nextSteps: [
            'Fund the addresses above (small amounts only).',
            'Call configure with blockfrostProjectId if you have not already — ADA balances and Cardano ' +
              'transaction building need it (free at https://blockfrost.io).',
            'Call wallet_status to confirm the balances arrived.',
          ],
          keysAreNeverReturned: 'The private keys stay in the credentials file; nothing here can print them.',
        };
      }),
  );

  server.registerTool(
    'configure',
    {
      title: 'Store the API settings this server needs',
      description:
        'Persist configuration to ~/.cardano-defi-mcp/config.json and apply it to the running server. ' +
        'blockfrostProjectId unlocks get_balance, wallet_status ADA balances, open_cdp/close_cdp and ' +
        'send_cardano — a free key takes a minute at https://blockfrost.io (create a project on the Cardano ' +
        'mainnet network and copy its project id). bazaarApiUrl overrides the routing backend and is only ' +
        'needed against a local or private deployment. Call with no arguments to read back what is set. ' +
        'Secrets are echoed masked, never in full.',
      inputSchema: {
        blockfrostProjectId: z
          .string()
          .min(1)
          .optional()
          .describe('Blockfrost project id, e.g. mainnet… — stored on disk, never returned in full'),
        bazaarApiUrl: z
          .string()
          .url()
          .optional()
          .describe(`Base URL of the BazaarSwap routing backend (default ${DEFAULT_BAZAAR_API_URL})`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ blockfrostProjectId, bazaarApiUrl }) =>
      onboardingResult(async () => {
        const changed: string[] = [];
        if (blockfrostProjectId !== undefined) {
          process.env.BLOCKFROST_PROJECT_ID = blockfrostProjectId;
          changed.push('blockfrostProjectId');
        }
        if (bazaarApiUrl !== undefined) {
          process.env.BAZAAR_API_URL = bazaarApiUrl;
          changed.push('bazaarApiUrl');
        }
        if (changed.length > 0) writeConfig({ blockfrostProjectId, bazaarApiUrl });

        const config = readConfig();
        const blockfrost = process.env.BLOCKFROST_PROJECT_ID;

        return {
          configFile: configPath(),
          changed,
          configured: {
            blockfrostProjectId: blockfrost ? maskSecret(blockfrost) : null,
            bazaarApiUrl: process.env.BAZAAR_API_URL ?? DEFAULT_BAZAAR_API_URL,
            cardanoNetwork: process.env.CARDANO_NETWORK ?? 'mainnet',
            indigoSystemParamsUrl: process.env.INDIGO_SYSTEM_PARAMS_URL ?? null,
          },
          storedInConfigFile: Object.keys(config),
          ...(blockfrost
            ? {}
            : {
                missing: 'blockfrostProjectId',
                nextStep:
                  'Ask the user for a Blockfrost project id (free at https://blockfrost.io, Cardano mainnet ' +
                  'project) and call configure again with it. Without it, get_balance, send_cardano, ' +
                  'open_cdp and close_cdp cannot run.',
              }),
        };
      }),
  );
}
