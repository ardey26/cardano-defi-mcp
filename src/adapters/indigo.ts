/**
 * Indigo Protocol adapter — CDP reads and UNSIGNED transaction building.
 *
 * Never signs and never holds keys: the wallet is selected by address only
 * (`lucid.selectWallet.fromAddress`), and the built tx is returned as full CBOR
 * hex with an empty witness set, ready for a CIP-30 `signTx`.
 *
 * ── DEVIATIONS FROM DESIGN.md (the SDK does not offer what DESIGN assumed) ──
 *
 * 1. `getPositions(address)` does NOT use @indigo-labs/indigo-sdk. The SDK has no
 *    "find CDPs by owner" helper — only `parseCdpDatum`, which would mean scanning
 *    every UTxO at the CDP validator address through Blockfrost. Instead we read
 *    Indigo's public analytics API (INDIGO_API_URL, default
 *    https://analytics.indigoprotocol.io, endpoint `GET /api/cdps`) and filter by
 *    the address's payment key hash. Upside: it needs no Blockfrost key and it
 *    returns the CDP's out-ref, which is exactly what `buildCloseCdp` needs.
 *
 * 2. `buildOpenCdp` / `buildCloseCdp` need Indigo's SystemParams. The SDK only
 *    offers `loadSystemParamsFromUrl` / `loadSystemParamsFromFile` and ships no
 *    default; Indigo publishes no documented stable URL for it. So
 *    INDIGO_SYSTEM_PARAMS_URL (or INDIGO_SYSTEM_PARAMS_FILE) is required, and we
 *    fail with an explicit message when it is unset rather than guessing.
 *
 * 3. `buildOpenCdp` mints against ADA collateral only. `openCdp` also takes a
 *    price-oracle input: we resolve it from the collateral-asset datum's
 *    `priceInfo`. For `OracleNft` and `Delisted` this works. For
 *    `DeferredValidation` (Indigo's Pyth path) the tx additionally needs a signed
 *    Pyth Lazer price message, which requires a Pyth Lazer access token this
 *    server has no business holding — that case throws NotImplementedError.
 *
 * 4. Param names follow DESIGN.md (`{ address, iasset, collateralLovelace,
 *    mintAmount }`); `buildCloseCdp({ address, cdpOutRef })` takes the CDP out-ref
 *    from `getPositions` because `closeCdp` is keyed on the CDP UTxO, not the iAsset.
 */

import { Blockfrost, Lucid, paymentCredentialOf, fromText } from '@lucid-evolution/lucid';
import type { LucidEvolution, OutRef, UTxO } from '@lucid-evolution/lucid';
import {
  OffchainCommon,
  closeCdp,
  findCollateralAsset,
  findIAsset,
  findInterestOracle,
  findRandomCdpCreator,
  findRandomNonAdminInterestCollector,
  loadSystemParamsFromFile,
  loadSystemParamsFromUrl,
  openCdp,
} from '@indigo-labs/indigo-sdk';
import type { CollateralAssetOutput, SystemParams } from '@indigo-labs/indigo-sdk';

import { getBaseUrl as getBlockfrostBaseUrl, getNetwork, getProjectId } from './blockfrost.js';
import type { CardanoNetwork } from './blockfrost.js';

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export interface IndigoPosition {
  cdpOutRef: OutRef;
  owner: string;
  iasset: string;
  collateralLovelace: string;
  mintedAmount: string;
  frozen: boolean;
}

export interface UnsignedTx {
  unsignedTxCbor: string;
  description: string;
  network: CardanoNetwork;
}

export interface OpenCdpParams {
  address: string;
  iasset: string;
  collateralLovelace: bigint | string;
  mintAmount: bigint | string;
}

export interface CloseCdpParams {
  address: string;
  cdpOutRef: OutRef;
}

const DEFAULT_INDIGO_API_URL = 'https://analytics.indigoprotocol.io';

// ── reads ────────────────────────────────────────────────────────────────────

interface AnalyticsCdp {
  output_hash: string;
  output_index: number;
  owner: string;
  asset: string;
  collateralAmount: number;
  mintedAmount: number;
  frozen_cdp_accumulated_lovelaces_treasury: number | null;
}

export async function getPositions(address: string): Promise<IndigoPosition[]> {
  const paymentKeyHash = paymentCredentialOf(address).hash;
  const base = (process.env.INDIGO_API_URL ?? DEFAULT_INDIGO_API_URL).replace(/\/+$/, '');

  const res = await fetch(`${base}/api/cdps`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Indigo API ${res.status} for /api/cdps: ${body.slice(0, 200) || res.statusText}`);
  }

  const cdps = (await res.json()) as AnalyticsCdp[];

  return cdps
    .filter((c) => c.owner === paymentKeyHash)
    .map((c) => ({
      cdpOutRef: { txHash: c.output_hash, outputIndex: c.output_index },
      owner: c.owner,
      iasset: c.asset,
      collateralLovelace: String(c.collateralAmount),
      mintedAmount: String(c.mintedAmount),
      frozen: c.frozen_cdp_accumulated_lovelaces_treasury !== null,
    }));
}

// ── tx building ──────────────────────────────────────────────────────────────

async function loadSystemParams(): Promise<SystemParams> {
  const url = process.env.INDIGO_SYSTEM_PARAMS_URL;
  if (url) return loadSystemParamsFromUrl(url);

  const file = process.env.INDIGO_SYSTEM_PARAMS_FILE;
  if (file) return loadSystemParamsFromFile(file);

  throw new Error(
    'INDIGO_SYSTEM_PARAMS_URL (or INDIGO_SYSTEM_PARAMS_FILE) required: Indigo tx building needs the ' +
      'protocol SystemParams JSON, and the SDK ships no default. See ' +
      'https://github.com/IndigoProtocol/indigo-sdk (tests/data/system-params.json for the shape).'
  );
}

async function mkLucid(address: string): Promise<LucidEvolution> {
  const network = getNetwork();
  const provider = new Blockfrost(getBlockfrostBaseUrl(network), getProjectId());
  const lucid = await Lucid(provider, network === 'mainnet' ? 'Mainnet' : 'Preprod');

  // Address-only wallet: enough to balance and build, impossible to sign with.
  const utxos = await lucid.utxosAt(address);
  if (utxos.length === 0) throw new Error(`No UTxOs at ${address}; cannot build a transaction`);
  lucid.selectWallet.fromAddress(address, utxos);

  return lucid;
}

function toOutRef(utxo: UTxO): OutRef {
  return { txHash: utxo.txHash, outputIndex: utxo.outputIndex };
}

/**
 * The out-ref of the price oracle the CDP endpoints must reference, or `undefined`
 * when the collateral asset is delisted (its price is fixed in the datum).
 */
async function resolvePriceOracleOref(
  lucid: LucidEvolution,
  collateral: CollateralAssetOutput
): Promise<OutRef | undefined> {
  const priceInfo = collateral.datum.priceInfo;

  if ('Delisted' in priceInfo) return undefined;

  if ('OracleNft' in priceInfo) {
    const unit = OffchainCommon.assetClassToUnit(priceInfo.OracleNft);
    return toOutRef(await lucid.utxoByUnit(unit));
  }

  throw new NotImplementedError(
    'This Indigo market prices collateral through Pyth (DeferredValidation). Building that ' +
      'transaction needs a signed Pyth Lazer price message, which requires a Pyth Lazer access ' +
      'token; this server holds no credentials. Use a market with an on-chain OracleNft instead.'
  );
}

/** Complete without signing: full tx CBOR with an empty witness set (CIP-30 `signTx` input). */
async function completeUnsigned(
  tx: Awaited<ReturnType<typeof openCdp>>,
  description: string
): Promise<UnsignedTx> {
  const signBuilder = await tx.complete();
  return { unsignedTxCbor: signBuilder.toCBOR(), description, network: getNetwork() };
}

export async function buildOpenCdp(params: OpenCdpParams): Promise<UnsignedTx> {
  const collateralLovelace = BigInt(params.collateralLovelace);
  const mintAmount = BigInt(params.mintAmount);
  if (collateralLovelace <= 0n) throw new Error('collateralLovelace must be greater than zero');
  if (mintAmount <= 0n) throw new Error('mintAmount must be greater than zero');

  const sysParams = await loadSystemParams();
  const lucid = await mkLucid(params.address);

  const iassetName = fromText(params.iasset);
  const iassetNameBytes = Buffer.from(iassetName, 'hex');
  const adaAssetClass = OffchainCommon.adaAssetClass;

  const [iasset, collateral, cdpCreator] = await Promise.all([
    findIAsset(lucid, sysParams, iassetNameBytes),
    findCollateralAsset(lucid, sysParams, iassetNameBytes, adaAssetClass),
    findRandomCdpCreator(lucid, sysParams),
  ]);

  const [priceOracleOref, interestOracle] = await Promise.all([
    resolvePriceOracleOref(lucid, collateral),
    findInterestOracle(lucid, collateral.datum.interestOracleNft),
  ]);

  const tx = await openCdp(
    collateralLovelace,
    mintAmount,
    sysParams,
    toOutRef(cdpCreator),
    toOutRef(iasset.utxo),
    toOutRef(collateral.utxo),
    priceOracleOref,
    toOutRef(interestOracle),
    undefined, // treasuryOref: undefined = direct treasury payment
    lucid
  );

  return completeUnsigned(
    tx,
    `Open an Indigo CDP: lock ${collateralLovelace} lovelace as collateral and mint ${mintAmount} ${params.iasset}.`
  );
}

export async function buildCloseCdp(params: CloseCdpParams): Promise<UnsignedTx> {
  const position = (await getPositions(params.address)).find(
    (p) =>
      p.cdpOutRef.txHash === params.cdpOutRef.txHash && p.cdpOutRef.outputIndex === params.cdpOutRef.outputIndex
  );
  if (!position) {
    throw new Error(
      `No Indigo CDP ${params.cdpOutRef.txHash}#${params.cdpOutRef.outputIndex} owned by ${params.address}`
    );
  }

  const sysParams = await loadSystemParams();
  const lucid = await mkLucid(params.address);

  const iassetNameBytes = Buffer.from(fromText(position.iasset), 'hex');

  const [collateral, interestCollector] = await Promise.all([
    findCollateralAsset(lucid, sysParams, iassetNameBytes, OffchainCommon.adaAssetClass),
    findRandomNonAdminInterestCollector(lucid, sysParams),
  ]);
  const interestOracle = await findInterestOracle(lucid, collateral.datum.interestOracleNft);

  const tx = await closeCdp(
    params.cdpOutRef,
    toOutRef(collateral.utxo),
    toOutRef(interestOracle),
    toOutRef(interestCollector),
    sysParams,
    lucid
  );

  return completeUnsigned(
    tx,
    `Close Indigo CDP ${params.cdpOutRef.txHash}#${params.cdpOutRef.outputIndex}: burn ${position.mintedAmount} ${position.iasset} of debt and withdraw ${position.collateralLovelace} lovelace of collateral.`
  );
}
