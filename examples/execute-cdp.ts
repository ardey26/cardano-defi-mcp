/**
 * Agent-side Cardano signer — the Indigo CDP round trip the MCP server cannot do.
 *
 * The server builds `open_cdp` / `close_cdp` as UNSIGNED CBOR and holds no keys.
 * This example closes that loop *outside* the server: it talks to the server over
 * stdio like any agent would, signs the returned CBOR with a script-held burner
 * key, submits through Blockfrost, then unwinds the position and sweeps the
 * wallet empty. The key is read here only and is stripped from the child env.
 *
 *   npm run execute:cdp -- gen        # create a burner, print its address
 *   npm run execute:cdp -- run        # print balance + plan, build nothing
 *   npm run execute:cdp -- run --yes  # open → confirm → close → confirm → sweep (REAL FUNDS)
 *   npm run execute:cdp -- close --txhash <h> --index <i>   # recovery: step 5 alone
 *   npm run execute:cdp -- sweep                            # recovery: step 6 alone
 *
 * `run --yes` never pauses. `open_cdp` embeds a signed Pyth price whose validity
 * window is ~280 s, so the built transaction is signed and submitted immediately
 * and the elapsed time since the build is logged. A prompt in the middle of that
 * window is a guaranteed on-chain failure, which is why there is none.
 *
 * Configuration (.env.local wins over .env):
 *   BLOCKFROST_PROJECT_ID     required
 *   INDIGO_SYSTEM_PARAMS_URL  required (or INDIGO_SYSTEM_PARAMS_FILE)
 *   CARDANO_PRIVATE_KEY       the burner, bech32 ed25519 (`gen` writes it)
 *   COLLATERAL_LOVELACE=15000000   MINT_AMOUNT=1000000 (iUSD, 6 decimals)
 *   SWEEP_TO=addr1…           where everything goes at the end
 *   ENV_FILE=…                which file `gen` appends the key to
 *
 * USE A BURNER WALLET. Fund it with exactly what this loop needs and nothing more.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Blockfrost, CML, Lucid, generatePrivateKey, paymentCredentialOf } from '@lucid-evolution/lucid';
import type { LucidEvolution, OutRef } from '@lucid-evolution/lucid';
import {
  fromSystemParamsAssetLucid,
  loadSystemParamsFromFile,
  loadSystemParamsFromUrl,
} from '@indigo-labs/indigo-sdk';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The only iAsset this loop mints. ADA collateral, Pyth-priced. */
const IASSET = 'iUSD';
const DEFAULT_COLLATERAL_LOVELACE = 15_000_000n;
const DEFAULT_MINT_AMOUNT = 1_000_000n;
const DEFAULT_SWEEP_TO =
  'addr1qx6wnfsgzlru7jp9m0yrep8g8uqzlarnyydwz4x5sy7j8d80wm86jx67p5t3g027hwrmtncy3k3r4eauj6w2jsndvwfsh3kpmj';
/** Fees + the Indigo protocol fee + the min-ADA of the change output. */
const HEADROOM_LOVELACE = 4_000_000n;

const CONFIRM_INTERVAL_MS = 20_000;
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
/** Indigo's analytics indexer lags the chain; close_cdp resolves the CDP through it. */
const INDEX_INTERVAL_MS = 20_000;
const INDEX_TIMEOUT_MS = 10 * 60_000;

const BLOCKFROST_URLS: Record<Net, string> = {
  Mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  Preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
};
const EXPLORERS: Record<Net, string> = {
  Mainnet: 'https://cardanoscan.io/transaction/',
  Preprod: 'https://preprod.cardanoscan.io/transaction/',
};

type Net = 'Mainnet' | 'Preprod';

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
  get(flag: string): string | undefined;
  require(flag: string): string;
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
  return {
    command,
    yes,
    get: (flag) => values.get(flag),
    require(flag) {
      const value = values.get(flag);
      if (!value) throw new Error(`missing --${flag}`);
      return value;
    },
  };
}

function network(): Net {
  const raw = process.env.CARDANO_NETWORK ?? 'mainnet';
  if (raw === 'mainnet') return 'Mainnet';
  if (raw === 'preprod') return 'Preprod';
  throw new Error(`CARDANO_NETWORK must be 'mainnet' or 'preprod', got '${raw}'`);
}

function projectId(): string {
  const value = process.env.BLOCKFROST_PROJECT_ID;
  if (!value) throw new Error('BLOCKFROST_PROJECT_ID is not set (.env)');
  return value;
}

function privateKey(): string {
  const value = process.env.CARDANO_PRIVATE_KEY;
  if (!value) throw new Error('CARDANO_PRIVATE_KEY is not set — run `npm run execute:cdp -- gen` first');
  return value;
}

function sweepTo(): string {
  return process.env.SWEEP_TO ?? DEFAULT_SWEEP_TO;
}

function amountParam(envKey: string, fallback: bigint): bigint {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${envKey} must be a whole number of base units, got '${raw}'`);
  return BigInt(raw);
}

/** Errors carry the subcommand that resumes the loop from where it died. */
class StageError extends Error {
  constructor(
    message: string,
    readonly recovery: string,
  ) {
    super(message);
  }
}

function detail(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause === undefined || cause === null) return base;
  let extra: string;
  try {
    extra = typeof cause === 'string' ? cause : JSON.stringify(cause);
  } catch {
    extra = String(cause);
  }
  return extra && extra !== base ? `${base} — ${extra}` : base;
}

/** Belt and braces: a key must never reach stdout, not even inside a library error. */
function redact(text: string): string {
  const key = process.env.CARDANO_PRIVATE_KEY;
  return key ? text.split(key).join('<private key redacted>') : text;
}

const ada = (lovelace: bigint): string => `${(Number(lovelace) / 1_000_000).toFixed(6)} ADA`;

// ── Blockfrost (direct; the MCP server's read tools do not cover tx lookups) ──

async function blockfrost<T>(path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${BLOCKFROST_URLS[network()]}${path}`, {
    headers: { project_id: projectId() },
  });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Blockfrost ${res.status} for ${path}: ${text.slice(0, 200) || res.statusText}`);
  }
  return { status: res.status, body: (await res.json()) as T };
}

interface Amount {
  unit: string;
  quantity: string;
}

interface Balance {
  lovelace: bigint;
  assets: Amount[];
}

async function getBalance(address: string): Promise<Balance> {
  const { body } = await blockfrost<{ amount: Amount[] }>(`/addresses/${encodeURIComponent(address)}`);
  const amounts = body?.amount ?? [];
  return {
    lovelace: BigInt(amounts.find((a) => a.unit === 'lovelace')?.quantity ?? '0'),
    assets: amounts.filter((a) => a.unit !== 'lovelace'),
  };
}

function printBalance(label: string, balance: Balance): void {
  console.log(`  ${label} ${ada(balance.lovelace)}`);
  for (const asset of balance.assets) console.log(`  ${' '.repeat(label.length)} ${asset.quantity} × ${asset.unit}`);
}

/** Poll until the hash is in a block. Blockfrost 404s a tx it has not seen yet. */
async function awaitConfirmation(txHash: string, what: string, recovery: string): Promise<void> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  console.log(`waiting for ${what} to confirm…`);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_INTERVAL_MS));
    let seen: number;
    try {
      seen = (await blockfrost(`/txs/${txHash}`)).status;
    } catch (err) {
      console.log(`  lookup failed: ${detail(err)} (retrying)`);
      continue;
    }
    if (seen === 200) {
      console.log(`  ${what} confirmed`);
      return;
    }
    console.log(`  ${new Date().toISOString().slice(11, 19)}  not in a block yet`);
  }
  throw new StageError(
    `${what} (${txHash}) did not confirm within 10 minutes. It may still land: ${EXPLORERS[network()]}${txHash}`,
    recovery,
  );
}

// ── the Indigo markers that identify a CDP output ───────────────────────────

interface CdpMarkers {
  /** policy id + hex asset name of the CDP auth NFT minted into every CDP output. */
  authUnit: string;
  /** Payment credential of the CDP validator address (SystemParams.validatorHashes.cdpHash). */
  cdpHash: string;
}

async function cdpMarkers(): Promise<CdpMarkers> {
  const url = process.env.INDIGO_SYSTEM_PARAMS_URL;
  const file = process.env.INDIGO_SYSTEM_PARAMS_FILE;
  if (!url && !file) throw new Error('INDIGO_SYSTEM_PARAMS_URL (or INDIGO_SYSTEM_PARAMS_FILE) is not set (.env)');
  const params = url ? await loadSystemParamsFromUrl(url) : await loadSystemParamsFromFile(file!);
  const token = fromSystemParamsAssetLucid(params.cdpParams.cdpAuthToken);
  return { authUnit: `${token.currencySymbol}${token.tokenName}`, cdpHash: params.validatorHashes.cdpHash };
}

interface TxUtxos {
  outputs: { address: string; amount: Amount[]; output_index: number }[];
}

/**
 * Find the CDP the open transaction produced.
 *
 * `openCdp` mints exactly one `cdpParams.cdpAuthToken` and pays it to the CDP
 * validator address (`validatorHashes.cdpHash`) with the CDP datum inline, so the
 * NFT identifies the output and the script credential double-checks it. Both come
 * from the live SystemParams rather than a pinned hash: the validator hash changes
 * on every Indigo protocol upgrade, the params URL already tracks it.
 */
async function findCdpOutput(txHash: string, markers: CdpMarkers): Promise<OutRef> {
  const { body } = await blockfrost<TxUtxos>(`/txs/${txHash}/utxos`);
  if (!body) throw new Error(`Blockfrost has no UTxOs for ${txHash}`);

  const carrying = body.outputs.filter((o) => o.amount.some((a) => a.unit === markers.authUnit));
  if (carrying.length !== 1) {
    throw new Error(
      `expected exactly one output carrying the CDP auth token ${markers.authUnit} in ${txHash}, found ${carrying.length}`,
    );
  }
  const output = carrying[0]!;
  const credential = paymentCredentialOf(output.address);
  if (credential.hash !== markers.cdpHash) {
    throw new Error(
      `output ${txHash}#${output.output_index} carries the CDP auth token but sits at credential ` +
        `${credential.hash}, not the CDP validator ${markers.cdpHash}`,
    );
  }
  return { txHash, outputIndex: output.output_index };
}

// ── MCP client ──────────────────────────────────────────────────────────────

/** Never readable from the server's process: the server has no signing code path, and no key either. */
const SECRETS = ['CARDANO_PRIVATE_KEY', 'PRIVATE_KEY'];

async function withMcp<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRETS.includes(key)) env[key] = value;
  }
  // Explicit, so a missing value fails here rather than inside the server.
  env.BLOCKFROST_PROJECT_ID = projectId();
  const params = process.env.INDIGO_SYSTEM_PARAMS_URL;
  if (params) env.INDIGO_SYSTEM_PARAMS_URL = params;

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/server.ts'],
    cwd: REPO_ROOT,
    env,
  });
  const client = new Client({ name: 'cardano-defi-mcp-execute-cdp', version: '0.1.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
  if (result.isError) throw new Error(`${name} failed: ${text.split('\n')[0] ?? 'unknown error'}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name} returned non-JSON content: ${text.slice(0, 200)}`);
  }
}

interface UnsignedTx {
  unsignedTxCbor: string;
  description: string;
}

interface Position {
  cdpOutRef: OutRef;
  iasset: string;
  collateralLovelace: string;
  mintedAmount: string;
}

// ── signing ─────────────────────────────────────────────────────────────────

/**
 * Mainnet enterprise address for a bech32 ed25519 key — the same derivation
 * `makeWalletFromPrivateKey` performs, done without a provider so `gen` needs
 * no Blockfrost key.
 */
function addressOf(key: string, net: Net): string {
  const pubKeyHash = CML.PrivateKey.from_bech32(key).to_public().hash();
  return CML.EnterpriseAddress.new(net === 'Mainnet' ? 1 : 0, CML.Credential.new_pub_key(pubKeyHash))
    .to_address()
    .to_bech32(undefined);
}

async function mkSigner(): Promise<{ lucid: LucidEvolution; address: string }> {
  const key = privateKey();
  const net = network();
  const provider = new Blockfrost(BLOCKFROST_URLS[net], projectId());
  const lucid = await Lucid(provider, net);
  lucid.selectWallet.fromPrivateKey(key);
  return { lucid, address: addressOf(key, net) };
}

/**
 * Sign the server's CBOR and submit it.
 *
 * `fromTx` parses the full transaction (empty witness set) into a TxSignBuilder,
 * `sign.withWallet()` adds the vkey witness for the selected private key, and
 * `complete()` reassembles body + witnesses; `submit()` goes out through the
 * wallet's Blockfrost provider. Nothing here rebuilds the body, so the Pyth
 * price and validity range the server pinned survive untouched.
 */
async function signAndSubmit(lucid: LucidEvolution, cbor: string, builtAt: number): Promise<string> {
  const signed = await lucid.fromTx(cbor).sign.withWallet().complete();
  console.log(`  signed ${Date.now() - builtAt} ms after the build returned`);
  const txHash = await signed.submit();
  console.log(`  submitted ${Date.now() - builtAt} ms after the build returned`);
  console.log(`  tx ${txHash}`);
  console.log(`     ${EXPLORERS[network()]}${txHash}`);
  return txHash;
}

// ── steps ───────────────────────────────────────────────────────────────────

const RUN_AGAIN = 'npm run execute:cdp -- run --yes';
const SWEEP_AGAIN = 'npm run execute:cdp -- sweep';
const closeAgain = (outRef: OutRef): string =>
  `npm run execute:cdp -- close --txhash ${outRef.txHash} --index ${outRef.outputIndex}`;

/** Step 2-3: build the open through the MCP server, sign it at once, submit. */
async function openCdpStep(lucid: LucidEvolution, address: string, collateral: bigint, mint: bigint): Promise<string> {
  console.log(`\n── open ──`);
  return await withMcp(async (client) => {
    console.log('building open_cdp through the MCP server…');
    const built = await callTool<UnsignedTx>(client, 'open_cdp', {
      address,
      iasset: IASSET,
      collateralLovelace: collateral.toString(),
      mintAmount: mint.toString(),
    });
    const builtAt = Date.now();
    console.log(`  ${built.description}`);
    try {
      return await signAndSubmit(lucid, built.unsignedTxCbor, builtAt);
    } catch (err) {
      throw new StageError(
        `the open transaction could not be signed or submitted: ${detail(err)}. The collateral should still be in ` +
          `the burner — confirm that on ${EXPLORERS[network()].replace('/transaction/', '/address/')}${address} ` +
          'before retrying, because a submission that only *looked* like it failed would open a second CDP.',
        RUN_AGAIN,
      );
    }
  });
}

/** Indigo's analytics indexer backs close_cdp, so the CDP has to appear there first. */
async function awaitIndexed(client: Client, address: string, outRef: OutRef): Promise<void> {
  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  console.log("waiting for Indigo's analytics API to index the CDP…");
  for (;;) {
    const found = await callTool<{ positions: Position[] }>(client, 'get_position', {
      protocol: 'indigo',
      address,
    }).then(
      (result) =>
        result.positions.some(
          (p) => p.cdpOutRef.txHash === outRef.txHash && p.cdpOutRef.outputIndex === outRef.outputIndex,
        ),
      (err: unknown) => {
        console.log(`  get_position failed: ${detail(err)} (retrying)`);
        return false;
      },
    );
    if (found) {
      console.log('  indexed');
      return;
    }
    if (Date.now() >= deadline) {
      throw new StageError(
        `Indigo's analytics API still does not list CDP ${outRef.txHash}#${outRef.outputIndex} after 10 minutes. ` +
          'The CDP is open on-chain; close_cdp resolves it through that API, so retry once it catches up.',
        closeAgain(outRef),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, INDEX_INTERVAL_MS));
  }
}

/** Step 5: build the close through the MCP server, sign, submit, confirm. */
async function closeCdpStep(lucid: LucidEvolution, address: string, outRef: OutRef): Promise<void> {
  console.log(`\n── close ──`);
  const txHash = await withMcp(async (client) => {
    await awaitIndexed(client, address, outRef);
    console.log('building close_cdp through the MCP server…');
    const built = await callTool<UnsignedTx>(client, 'close_cdp', {
      address,
      txHash: outRef.txHash,
      outputIndex: outRef.outputIndex,
    });
    const builtAt = Date.now();
    console.log(`  ${built.description}`);
    try {
      return await signAndSubmit(lucid, built.unsignedTxCbor, builtAt);
    } catch (err) {
      throw new StageError(
        `the close transaction was not accepted: ${detail(err)}. The CDP is still open and the collateral is still locked.`,
        closeAgain(outRef),
      );
    }
  });
  await awaitConfirmation(txHash, 'the close', closeAgain(outRef));
}

/** Step 6: one plain lucid tx moving every remaining UTxO — ADA and any native asset — to SWEEP_TO. */
async function sweepStep(lucid: LucidEvolution, address: string): Promise<void> {
  const destination = sweepTo();
  console.log(`\n── sweep ──`);
  const utxos = await lucid.utxosAt(address);
  if (utxos.length === 0) {
    console.log('  nothing left in the burner; skipping the sweep');
    return;
  }
  console.log(`  ${utxos.length} UTxO(s) → ${destination}`);

  let txHash: string;
  try {
    // No explicit output: every input is collected and the whole balance minus
    // the fee leaves as change, which carries any leftover native asset with it.
    const built = await lucid.newTx().collectFrom(utxos).complete({ changeAddress: destination });
    txHash = await (await built.sign.withWallet().complete()).submit();
  } catch (err) {
    throw new StageError(`the sweep transaction was not accepted: ${detail(err)}. The funds are still in the burner.`, SWEEP_AGAIN);
  }
  console.log(`  tx ${txHash}`);
  console.log(`     ${EXPLORERS[network()]}${txHash}`);
  await awaitConfirmation(txHash, 'the sweep', SWEEP_AGAIN);

  console.log('\n── final balances ──');
  printBalance('burner     ', await getBalance(address));
  printBalance('sweep target', await getBalance(destination));
}

// ── subcommands ─────────────────────────────────────────────────────────────

function cmdGen(): void {
  const path = process.env.ENV_FILE ?? `${REPO_ROOT}.env.local`;
  if (existsSync(path) && /^\s*CARDANO_PRIVATE_KEY\s*=\s*\S/m.test(readFileSync(path, 'utf8'))) {
    throw new Error(`${path} already has a CARDANO_PRIVATE_KEY — refusing to overwrite it`);
  }
  const key = generatePrivateKey();
  const prefix = existsSync(path) && !readFileSync(path, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}CARDANO_PRIVATE_KEY=${key}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; a non-POSIX filesystem is not a reason to fail
  }
  console.log(addressOf(key, network()));
}

async function cmdRun(flags: Flags): Promise<void> {
  const collateral = amountParam('COLLATERAL_LOVELACE', DEFAULT_COLLATERAL_LOVELACE);
  const mint = amountParam('MINT_AMOUNT', DEFAULT_MINT_AMOUNT);
  const required = collateral + HEADROOM_LOVELACE;
  const address = addressOf(privateKey(), network());
  const balance = await getBalance(address);

  console.log(`burner ${address} (${network()})`);
  printBalance('balance ', balance);
  console.log('\n── plan ──');
  console.log(`  1. open_cdp   lock ${ada(collateral)} as collateral, mint ${mint} ${IASSET} base units (6 decimals)`);
  console.log(`  2. sign the returned CBOR immediately and submit — the tx embeds a signed Pyth`);
  console.log(`     price valid for ~280 s, so there is no confirmation pause once --yes is given`);
  console.log(`  3. wait for confirmation, then locate the CDP output by its Indigo auth token`);
  console.log(`  4. close_cdp  burn the minted ${IASSET} debt, withdraw the collateral`);
  console.log(`  5. sweep      send everything left to ${sweepTo()}`);
  console.log(`\n  needs at least ${ada(required)} in the burner (collateral + ${ada(HEADROOM_LOVELACE)} for fees)`);

  if (!flags.yes) {
    console.log('\nDRY RUN — add --yes to execute. Nothing was built and nothing was signed.');
    return;
  }

  if (balance.lovelace < required) {
    throw new Error(
      `burner holds ${ada(balance.lovelace)} but the loop needs ${ada(required)} ` +
        `(${ada(collateral)} collateral + ${ada(HEADROOM_LOVELACE)} headroom). Fund ${address} and retry.`,
    );
  }

  const { lucid } = await mkSigner();
  const openHash = await openCdpStep(lucid, address, collateral, mint);
  await awaitConfirmation(
    openHash,
    'the open',
    `check ${EXPLORERS[network()]}${openHash}, then: npm run execute:cdp -- close --txhash ${openHash} --index <n>`,
  );

  const outRef = await findCdpOutput(openHash, await cdpMarkers());
  console.log(`  CDP ${outRef.txHash}#${outRef.outputIndex}`);
  console.log(`  (recovery from here: ${closeAgain(outRef)})`);

  await closeCdpStep(lucid, address, outRef);
  await sweepStep(lucid, address);
}

async function cmdClose(flags: Flags): Promise<void> {
  const txHash = flags.require('txhash');
  const index = Number(flags.require('index'));
  if (!Number.isInteger(index) || index < 0) throw new Error('--index must be a non-negative integer');
  const outRef: OutRef = { txHash, outputIndex: index };
  const { lucid, address } = await mkSigner();
  console.log(`burner ${address} (${network()})`);
  await closeCdpStep(lucid, address, outRef);
  await sweepStep(lucid, address);
}

async function cmdSweep(): Promise<void> {
  const { lucid, address } = await mkSigner();
  console.log(`burner ${address} (${network()})`);
  printBalance('balance ', await getBalance(address));
  await sweepStep(lucid, address);
}

// ── entry ───────────────────────────────────────────────────────────────────

const USAGE = `usage: npm run execute:cdp -- <gen|run|close|sweep> [--yes] [flags]

  gen                             new burner: appends CARDANO_PRIVATE_KEY to .env.local, prints the address
  run                             print the burner balance and the plan, then stop
  run --yes                       open a CDP, close it, sweep the burner — REAL FUNDS, no pauses
  close --txhash H --index N      recovery: close that CDP, then sweep
  sweep                           recovery: send everything left in the burner to SWEEP_TO`;

async function main(): Promise<number> {
  loadEnvFiles();
  const flags = parseArgs(process.argv.slice(2));
  switch (flags.command) {
    case 'gen':
      cmdGen();
      return 0;
    case 'run':
      await cmdRun(flags);
      return 0;
    case 'close':
      await cmdClose(flags);
      return 0;
    case 'sweep':
      await cmdSweep();
      return 0;
    default:
      console.log(USAGE);
      return flags.command ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`error: ${redact(detail(err))}`);
    if (err instanceof StageError) console.error(`recover with: ${err.recovery}`);
    process.exit(1);
  });
