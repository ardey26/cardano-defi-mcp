/**
 * Agent-side signer — the piece the MCP server deliberately does not do.
 *
 * The server quotes and builds; it holds no keys, signs nothing and broadcasts
 * nothing. Something has to close that loop for a real trade, so this example
 * does it *outside* the server: it talks to the MCP server over stdio like any
 * agent would, then signs and broadcasts the returned calldata itself. The
 * private key is read here and never enters the server's process (it is
 * explicitly stripped from the child environment below).
 *
 * `viem` is a **devDependency on purpose**: it exists for this example only.
 * DESIGN.md forbids new *runtime* deps, and the shipped server (src/**) never
 * imports it — nothing in the published tool path gains a signing capability.
 *
 *   npm run execute -- gen                     # create a burner, print its address
 *   npm run execute -- quote                   # dry run, no key needed
 *   npm run execute -- run                     # prints the plan, does NOT broadcast
 *   npm run execute -- run --yes               # signs and broadcasts REAL funds
 *
 * Configuration (flags win over env; .env.local wins over .env):
 *   FROM_CHAIN=1|42161   FROM_TOKEN=native|0x…   AMOUNT=<wei>
 *   DEST_ADDRESS=addr1…  TO_CHAIN=CARDANO        TO_TOKEN=native
 *   USER_ADDRESS=0x…     (quote only, when no PRIVATE_KEY is set)
 *   SLIPPAGE=0.5         RPC_URL=…               BAZAAR_API_URL=http://localhost:3001
 *   ENV_FILE=…           (which file `gen` appends PRIVATE_KEY to)
 *
 * USE A BURNER WALLET. Fund it with exactly what you intend to trade.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, appendFileSync, chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  type Chain,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrum, mainnet } from 'viem/chains';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// The API normalises every native-token sentinel to the zero address
// (apps/api/src/utils/token.ts), so that is what `native` expands to.
const NATIVE = '0x0000000000000000000000000000000000000000';

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

const CHAINS: Record<string, { chain: Chain; explorer: string }> = {
  '1': { chain: mainnet, explorer: 'https://etherscan.io/tx/' },
  '42161': { chain: arbitrum, explorer: 'https://arbiscan.io/tx/' },
};

// ── config ──────────────────────────────────────────────────────────────────

/** Minimal .env reader. Existing process env always wins; .env.local beats .env. */
function loadEnvFiles(): void {
  for (const name of ['.env.local', '.env']) {
    const path = `${REPO_ROOT}${name}`;
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

interface Flags {
  command: string;
  yes: boolean;
  get(flag: string, envKey: string, fallback?: string): string | undefined;
  require(flag: string, envKey: string): string;
}

function parseArgs(argv: string[]): Flags {
  const command = argv[0] ?? '';
  const values = new Map<string, string>();
  let yes = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--yes') {
      yes = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) values.set(arg.slice(2, eq), arg.slice(eq + 1));
      else values.set(arg.slice(2), argv[++i] ?? '');
    }
  }
  const get = (flag: string, envKey: string, fallback?: string) =>
    values.get(flag) ?? process.env[envKey] ?? fallback;
  return {
    command,
    yes,
    get,
    require(flag, envKey) {
      const value = get(flag, envKey);
      if (!value) throw new Error(`missing --${flag} (or ${envKey} in .env.local)`);
      return value;
    },
  };
}

function baseUrl(): string {
  return (process.env.BAZAAR_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}

/** Turn fetch's opaque "fetch failed" into one readable line. */
function describeFetchError(err: unknown, what: string): Error {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
  return new Error(`cannot reach the Bazaar API at ${baseUrl()} (${what}): ${detail}`);
}

// ── the shapes this script reads (mirrors src/adapters/swap.ts) ─────────────

interface Quote {
  quoteId: string;
  merchantName: string;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  inAmount: string;
  outAmount: string;
  netOutput: string;
  inAmountUSD?: number;
  outAmountUSD?: number;
  estimatedArrivalSeconds: number;
  approvalAddress?: string;
  isOmniston?: boolean;
}

interface ExecuteResponse {
  txData: { to: string; data: string | Record<string, unknown>; value: string; gasLimit?: string };
  quote: Partial<Quote>;
  tracking?: string;
}

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  chainId: string;
}

interface TxStatus {
  txHash: string;
  merchant?: string;
  status: string;
  srcExplorerUrl?: string;
  destExplorerUrl?: string;
  progressPercent?: number;
  message?: string;
}

// ── Bazaar API (direct, for the calls the MCP server does not expose) ───────

/**
 * Warm the API's per-chain token cache before quoting.
 *
 * AdapterRegistry.enrichWithPricing looks up both tokens through
 * aggregateTokens(chainId) while the race is running. On a cold cache that
 * aggregation has to fan out to every provider inline, so it frequently loses
 * and decimals silently fall back to 18 — which makes the USD figures on the
 * quote wrong for any 6-decimal token. One cheap GET primes the cache (30 s
 * TTL) and doubles as the symbol/decimals source for the printout below.
 */
async function fetchTokens(chainId: string): Promise<TokenInfo[]> {
  try {
    const res = await fetch(`${baseUrl()}/tokens?chainId=${encodeURIComponent(chainId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { tokens?: TokenInfo[] };
    return body.tokens ?? [];
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('HTTP')) {
      throw new Error(`Bazaar API ${err.message} for /tokens?chainId=${chainId}`);
    }
    throw describeFetchError(err, `GET /tokens?chainId=${chainId}`);
  }
}

function findToken(tokens: TokenInfo[], address: string): TokenInfo | undefined {
  const target = address.toLowerCase();
  return tokens.find((t) => t.address.toLowerCase() === target);
}

/** POST /status/register — quoteId AND tracking; the quote wins server-side, the token survives a restart. */
async function registerStatus(txHash: string, quoteId: string, tracking?: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/status/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteId, tracking, txHash }),
  }).catch((err: unknown) => {
    throw describeFetchError(err, 'POST /status/register');
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bazaar API ${res.status} for /status/register: ${body.slice(0, 200) || res.statusText}`);
  }
}

/** GET /status/{txHash} — the hash exactly as registered, URL-encoded. */
async function pollStatus(txHash: string): Promise<TxStatus> {
  const res = await fetch(`${baseUrl()}/status/${encodeURIComponent(txHash)}`).catch((err: unknown) => {
    throw describeFetchError(err, 'GET /status/{txHash}');
  });
  // 404 carries a body in the same shape ({ status: 'not_found' }) — keep polling on it.
  const body = (await res.json().catch(() => null)) as TxStatus | null;
  if (!body || typeof body.status !== 'string') {
    throw new Error(`Bazaar API ${res.status} for /status/${txHash}: unexpected body`);
  }
  return body;
}

// ── MCP client ──────────────────────────────────────────────────────────────

async function withMcp<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  // The server is spawned WITHOUT PRIVATE_KEY: the signing key must never be
  // readable from the MCP server's process, even accidentally via env.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'PRIVATE_KEY') env[key] = value;
  }

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/server.ts'],
    cwd: REPO_ROOT,
    env,
  });
  const client = new Client({ name: 'bazaarswap-execute-swap', version: '0.1.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function jsonOf<T>(result: CallToolResult, tool: string): T {
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
  if (result.isError) throw new Error(`${tool} failed: ${text.split('\n')[0] ?? 'unknown error'}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${tool} returned non-JSON content: ${text.slice(0, 200)}`);
  }
}

// ── printing ────────────────────────────────────────────────────────────────

function human(amount: string, decimals: number, symbol: string): string {
  try {
    return `${formatUnits(BigInt(amount), decimals)} ${symbol}`;
  } catch {
    return `${amount} (raw) ${symbol}`;
  }
}

function usd(value: number | undefined): string {
  return value === undefined ? 'n/a' : `$${value.toFixed(2)}`;
}

interface Pair {
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  amount: string;
  userAddress: string;
  recipientAddress: string;
  slippage?: string;
}

function readPair(flags: Flags, userAddress: string): Pair {
  const fromTokenRaw = flags.get('from-token', 'FROM_TOKEN', 'native')!;
  const toTokenRaw = flags.get('to-token', 'TO_TOKEN', 'native')!;
  return {
    fromChain: flags.require('from-chain', 'FROM_CHAIN'),
    // DESIGN.md's examples say `1815` / `lovelace`, but the live API keys
    // Cardano as `CARDANO` with the zero-address native sentinel (verified
    // against GET /chains and GET /tokens?chainId=CARDANO). A numeric id is
    // inferred as EVM by the API's address validation, so `1815` rejects an
    // addr1… recipient outright. Both are overridable.
    toChain: flags.get('to-chain', 'TO_CHAIN', 'CARDANO')!,
    fromToken: fromTokenRaw === 'native' ? NATIVE : fromTokenRaw,
    toToken: toTokenRaw === 'native' || toTokenRaw === 'lovelace' ? NATIVE : toTokenRaw,
    amount: flags.require('amount', 'AMOUNT'),
    userAddress,
    recipientAddress: flags.require('dest', 'DEST_ADDRESS'),
    slippage: flags.get('slippage', 'SLIPPAGE'),
  };
}

interface QuoteRun {
  pair: Pair;
  best: Quote;
  all: Quote[];
  fromInfo: { symbol: string; decimals: number };
  toInfo: { symbol: string; decimals: number };
}

/** Warm both token caches, race the quote through the MCP server, print the winner. */
async function quoteStep(flags: Flags, userAddress: string): Promise<QuoteRun> {
  const pair = readPair(flags, userAddress);

  const [fromTokens, toTokens] = await Promise.all([
    fetchTokens(pair.fromChain),
    fetchTokens(pair.toChain).catch(() => [] as TokenInfo[]),
  ]);
  const fromToken = findToken(fromTokens, pair.fromToken);
  const toToken = findToken(toTokens, pair.toToken);
  const fromInfo = {
    symbol: fromToken?.symbol ?? (pair.fromToken === NATIVE ? 'native' : pair.fromToken.slice(0, 10)),
    decimals: fromToken?.decimals ?? 18,
  };
  const toInfo = { symbol: toToken?.symbol ?? 'ADA', decimals: toToken?.decimals ?? 6 };
  if (!fromToken) {
    console.log(`note: ${pair.fromToken} is not in the API's token list for chain ${pair.fromChain}; assuming 18 decimals`);
  }

  console.log(
    `quoting ${human(pair.amount, fromInfo.decimals, fromInfo.symbol)} on chain ${pair.fromChain} ` +
      `→ chain ${pair.toChain} (${pair.toToken}) for ${pair.recipientAddress}`,
  );
  console.log('racing providers (up to ~25 s)…');

  const { best, all } = await withMcp(async (client) => {
    const result = (await client.callTool({
      name: 'get_quote',
      arguments: {
        fromChain: pair.fromChain,
        toChain: pair.toChain,
        fromToken: pair.fromToken,
        toToken: pair.toToken,
        amount: pair.amount,
        userAddress: pair.userAddress,
        recipientAddress: pair.recipientAddress,
        ...(pair.slippage ? { slippage: pair.slippage } : {}),
      },
    })) as CallToolResult;
    return jsonOf<{ best: Quote | null; all: Quote[] }>(result, 'get_quote');
  });

  if (!best) throw new Error('no routes for this pair/amount');

  console.log(`\n${all.length} route(s); best is ${best.merchantName}`);
  console.log(`  in      ${human(best.inAmount, fromInfo.decimals, fromInfo.symbol)}  (${usd(best.inAmountUSD)})`);
  console.log(`  out     ${human(best.outAmount, toInfo.decimals, toInfo.symbol)}  (${usd(best.outAmountUSD)})`);
  console.log(`  net     ${human(best.netOutput, toInfo.decimals, toInfo.symbol)}`);
  console.log(`  eta     ~${best.estimatedArrivalSeconds}s`);
  console.log(`  quoteId ${best.quoteId}`);

  return { pair, best, all, fromInfo, toInfo };
}

// ── subcommands ─────────────────────────────────────────────────────────────

function cmdGen(): void {
  const path = process.env.ENV_FILE ?? `${REPO_ROOT}.env.local`;
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (/^\s*PRIVATE_KEY\s*=\s*\S/m.test(existing)) {
      throw new Error(`${path} already has a PRIVATE_KEY — refusing to overwrite it`);
    }
  }
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const prefix = existsSync(path) && !readFileSync(path, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}PRIVATE_KEY=${key}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; a non-POSIX filesystem is not a reason to fail
  }
  console.log(`burner created, key written to ${path} (chmod 600, gitignored)`);
  console.log(`ADDRESS ${account.address}`);
  console.log('fund this address with exactly what you intend to trade, and nothing more.');
}

async function cmdQuote(flags: Flags): Promise<void> {
  const key = process.env.PRIVATE_KEY as Hex | undefined;
  const userAddress =
    flags.get('user-address', 'USER_ADDRESS') ??
    (key ? privateKeyToAccount(key).address : undefined);
  if (!userAddress) {
    throw new Error('no sender address — run `gen` first, or set USER_ADDRESS (quoting needs an address, not a key)');
  }
  await quoteStep(flags, userAddress);
}

async function cmdRun(flags: Flags): Promise<number> {
  const key = process.env.PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error('PRIVATE_KEY is not set — run `gen` first');
  const account = privateKeyToAccount(key);

  const chainId = flags.require('from-chain', 'FROM_CHAIN');
  const entry = CHAINS[chainId];
  if (!entry) throw new Error(`unsupported FROM_CHAIN ${chainId} — this example supports 1 and 42161`);
  const rpcUrl = flags.get('rpc', 'RPC_URL');
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: entry.chain, transport });
  const walletClient = createWalletClient({ account, chain: entry.chain, transport });

  const { pair, best, fromInfo, toInfo } = await quoteStep(flags, account.address);

  if (best.isOmniston) {
    throw new Error('the best route is a STON.fi Omniston quote — executed client-side (HTLC), not signable here');
  }

  // build_swap_tx == POST /execute. Its `quote` echo is partial and drops
  // approvalAddress, so the spender comes from the racing quote.
  const execution = await withMcp(async (client) => {
    const result = (await client.callTool({
      name: 'build_swap_tx',
      arguments: { quoteId: best.quoteId, userAddress: account.address },
    })) as CallToolResult;
    return jsonOf<ExecuteResponse>(result, 'build_swap_tx');
  });

  const { txData, tracking } = execution;
  if (typeof txData.data !== 'string' || !txData.data.startsWith('0x')) {
    throw new Error('txData.data is not EVM calldata — this signer only handles EVM source chains');
  }
  // An adapter that could not build the swap still returns a quote, with
  // `to: ''` and `data: '0x'` (see RubicAdapter). Never sign that.
  if (!/^0x[0-9a-fA-F]{40}$/.test(txData.to)) {
    throw new Error(`the quote carries no executable transaction (txData.to is "${txData.to}") — the provider failed to build it; re-quote or try another amount`);
  }
  const calldata = txData.data as Hex;
  const value = BigInt(txData.value || '0');
  const amount = BigInt(pair.amount);
  const isNative = pair.fromToken.toLowerCase() === NATIVE;
  const spender = (best.approvalAddress ?? txData.to) as Hex;

  // A native-source swap must carry at least the amount as msg.value; less
  // than that can only burn gas (and consume the quote) for nothing.
  if (isNative && value < amount) {
    throw new Error(`txData.value (${value}) is below the amount you asked to swap (${amount}) — refusing to broadcast`);
  }

  console.log('\n── transaction ──');
  console.log(`  provider  ${best.merchantName}`);
  console.log(`  from      ${account.address} (chain ${chainId}, ${entry.chain.name})`);
  console.log(`  to        ${txData.to}`);
  console.log(`  value     ${human(value.toString(), 18, entry.chain.nativeCurrency.symbol)}`);
  console.log(`  sending   ${human(pair.amount, fromInfo.decimals, fromInfo.symbol)}${isNative ? ' (native)' : ` (ERC-20 ${pair.fromToken})`}`);
  console.log(`  receiving ~${human(best.outAmount, toInfo.decimals, toInfo.symbol)} at ${pair.recipientAddress}`);
  console.log(
    calldata === '0x'
      ? '  calldata  none — a plain value transfer to the route\'s deposit address'
      : `  calldata  ${calldata.slice(0, 26)}… (${(calldata.length - 2) / 2} bytes)`,
  );
  if (isNative && value > amount) {
    console.log(`  note      msg.value exceeds the swap amount by ${value - amount} wei (route fee)`);
  }
  if (!isNative) console.log(`  spender   ${spender}`);
  console.log(`  tracking  ${tracking ? 'issued' : 'NOT issued (status polling may 404 after an API restart)'}`);

  if (!flags.yes) {
    console.log('\nDRY RUN — add --yes to broadcast');
    return 0;
  }

  // ── approval (ERC-20 source only) ──
  if (!isNative) {
    const token = pair.fromToken as Hex;
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, spender],
    });
    if (allowance < amount) {
      // Some tokens (USDT and friends) reject a non-zero→non-zero approve.
      if (allowance > 0n) {
        console.log(`\nresetting allowance to 0 (currently ${allowance})…`);
        const resetHash = await walletClient.writeContract({
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, 0n],
        });
        await publicClient.waitForTransactionReceipt({ hash: resetHash });
      }
      console.log(`approving exactly ${human(amount.toString(), fromInfo.decimals, fromInfo.symbol)} to ${spender}…`);
      const approveHash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
      });
      console.log(`  approve tx ${entry.explorer}${approveHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (receipt.status !== 'success') throw new Error('approval reverted — aborting before the swap');
      console.log('  approved');
    } else {
      console.log(`\nallowance already sufficient (${allowance})`);
    }
  }

  // ── broadcast ──
  console.log('\nbroadcasting…');
  const hash = await walletClient.sendTransaction({
    to: txData.to as Hex,
    data: calldata,
    value,
    ...(txData.gasLimit ? { gas: BigInt(txData.gasLimit) } : {}),
  });
  console.log(`tx ${hash}`);
  console.log(`   ${entry.explorer}${hash}`);

  // ── register + poll ──
  try {
    await registerStatus(hash, best.quoteId, tracking);
    console.log('registered for status tracking');
  } catch (err) {
    console.log(`could not register for tracking: ${err instanceof Error ? err.message : String(err)}`);
    console.log('the swap is broadcast — follow it on the explorer link above.');
    return 0;
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let status: TxStatus;
    try {
      status = await pollStatus(hash);
    } catch (err) {
      console.log(`  poll failed: ${err instanceof Error ? err.message : String(err)} (retrying)`);
      continue;
    }
    const line = [
      status.status,
      status.progressPercent !== undefined ? `${status.progressPercent}%` : '',
      status.message ?? '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (line !== last) {
      console.log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`);
      last = line;
    }
    if (status.status === 'complete') {
      if (status.destExplorerUrl) console.log(`destination: ${status.destExplorerUrl}`);
      console.log('swap complete.');
      return 0;
    }
    if (status.status === 'failed') {
      console.log('swap FAILED.');
      return 1;
    }
    if (status.status === 'untracked') {
      console.log(`${best.merchantName} exposes no status API — check ${entry.explorer}${hash} and the destination address.`);
      return 0;
    }
  }
  console.log('still in flight after 10 minutes — stopping the poll, the swap itself is unaffected.');
  console.log(`re-check with: curl ${baseUrl()}/status/${hash}`);
  return 0;
}

// ── entry ───────────────────────────────────────────────────────────────────

const USAGE = `usage: npm run execute -- <gen|quote|run> [--yes] [flags]

  gen     create a burner wallet, append PRIVATE_KEY to .env.local, print the address
  quote   dry run: warm the token cache, race quotes through the MCP server (no key needed)
  run     quote → build → approve (ERC-20) → sign → broadcast → poll status; needs --yes

flags: --from-chain --from-token --amount --dest --to-chain --to-token --slippage --rpc --user-address`;

async function main(): Promise<number> {
  loadEnvFiles();
  const flags = parseArgs(process.argv.slice(2));
  switch (flags.command) {
    case 'gen':
      cmdGen();
      return 0;
    case 'quote':
      await cmdQuote(flags);
      return 0;
    case 'run':
      return await cmdRun(flags);
    default:
      console.log(USAGE);
      return flags.command ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
