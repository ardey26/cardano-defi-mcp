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
 *    default. Indigo hosts the current mainnet params (undocumented, but used
 *    by Indigo's own indigo-mcp) at
 *    https://config.indigoprotocol.io/mainnet/mainnet-system-params-v3.json —
 *    the filename changes on each protocol upgrade (v1 → v2 → v21 → v3), so
 *    INDIGO_SYSTEM_PARAMS_URL (or INDIGO_SYSTEM_PARAMS_FILE) stays required,
 *    and we fail with an explicit message when it is unset rather than pinning
 *    a URL that goes stale.
 *
 * 3. `buildOpenCdp` mints against ADA collateral only. `openCdp` also takes a
 *    price-oracle input: we resolve it from the collateral-asset datum's
 *    `priceInfo`. `OracleNft` reads the oracle UTxO by its NFT; `Delisted` needs
 *    no oracle at all. `DeferredValidation` (Indigo's Pyth path) additionally
 *    needs the signed Pyth Lazer price message and the Pyth state UTxO — this
 *    server holds no Pyth Lazer credential and signs nothing, so it proxies both
 *    from Indigo's public, unauthenticated analytics API:
 *      GET {INDIGO_API_URL}/api/v3/assets/{iasset}/ada/price -> { pythPayload, timestamp, ... }
 *      GET {INDIGO_API_URL}/api/v3/pyth-state/utxo           -> { outputHash, outputIndex }
 *    Indigo's own indigo-mcp (IndigoProtocol/indigo-mcp, src/utils/pyth.ts) takes
 *    exactly this route. The on-chain validator rejects a tx whose validity upper
 *    bound is more than 280 s past the price timestamp, so the payload is fetched
 *    last, immediately before building, and rechecked against PYTH_MAX_DELAY_MS.
 *    The validity window itself is set by the SDK (`attachOracle` pins
 *    validFrom = price timestamp, validTo = +280 s); we do not override it.
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
/** Indigo's ADA collateral is spelled lowercase in the analytics price path. */
const ADA_COLLATERAL_SLUG = 'ada';
/** The on-chain Pyth feed validator rejects a validity upper bound later than this. */
const PYTH_MAX_DELAY_MS = 280_000;

async function indigoApiGet<T>(path: string): Promise<T> {
  const base = (process.env.INDIGO_API_URL ?? DEFAULT_INDIGO_API_URL).replace(/\/+$/, '');

  const res = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Indigo API ${res.status} for ${path}: ${body.slice(0, 200) || res.statusText}`);
  }
  return (await res.json()) as T;
}

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
  const cdps = await indigoApiGet<AnalyticsCdp[]>('/api/cdps');

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
 * The price inputs the CDP endpoints must reference. Exactly one branch is populated:
 * an on-chain oracle out-ref (`OracleNft`), a Pyth message plus state out-ref
 * (`DeferredValidation`), or nothing at all (`Delisted` — price fixed in the datum).
 */
interface PriceSource {
  priceOracleOref?: OutRef;
  pythMessage?: string;
  pythStateOref?: OutRef;
}

interface AnalyticsPythPrice {
  price?: string;
  expiration?: number;
  /** Seconds since epoch. */
  timestamp?: number;
  pythPayload?: string;
  message?: string;
}

/**
 * Proxy Indigo's public analytics API for the signed Pyth message + Pyth state UTxO.
 * Exported so the endpoint contract can be unit-tested without a live chain.
 */
export async function fetchPythPriceSource(iasset: string): Promise<PriceSource> {
  const pricePath = `/api/v3/assets/${encodeURIComponent(iasset)}/${ADA_COLLATERAL_SLUG}/price`;

  const [price, state] = await Promise.all([
    indigoApiGet<AnalyticsPythPrice>(pricePath),
    indigoApiGet<{ outputHash: string; outputIndex: number }>('/api/v3/pyth-state/utxo'),
  ]);

  if (!price.pythPayload || typeof price.timestamp !== 'number') {
    throw new Error(
      `Indigo analytics returned no Pyth price for ${iasset}/${ADA_COLLATERAL_SLUG}` +
        (price.message ? `: ${price.message}` : '')
    );
  }

  const ageMs = Date.now() - price.timestamp * 1000;
  if (ageMs > PYTH_MAX_DELAY_MS) {
    throw new Error(
      `Indigo's Pyth price for ${iasset} is ${Math.round(ageMs / 1000)}s old; the validator rejects ` +
        `anything past ${PYTH_MAX_DELAY_MS / 1000}s. Retry in a moment.`
    );
  }

  return {
    pythMessage: price.pythPayload,
    pythStateOref: { txHash: state.outputHash, outputIndex: state.outputIndex },
  };
}

async function resolvePriceSource(
  lucid: LucidEvolution,
  iasset: string,
  collateral: CollateralAssetOutput
): Promise<PriceSource> {
  const priceInfo = collateral.datum.priceInfo;

  if ('Delisted' in priceInfo) return {};

  if ('OracleNft' in priceInfo) {
    const unit = OffchainCommon.assetClassToUnit(priceInfo.OracleNft);
    return { priceOracleOref: toOutRef(await lucid.utxoByUnit(unit)) };
  }

  return fetchPythPriceSource(iasset);
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

  const interestOracle = await findInterestOracle(lucid, collateral.datum.interestOracleNft);

  // Last, immediately before building: a Pyth message is only good for 280s.
  const price = await resolvePriceSource(lucid, params.iasset, collateral);

  const tx = await openCdp(
    collateralLovelace,
    mintAmount,
    sysParams,
    toOutRef(cdpCreator),
    toOutRef(iasset.utxo),
    toOutRef(collateral.utxo),
    price.priceOracleOref,
    toOutRef(interestOracle),
    undefined, // treasuryOref: undefined = direct treasury payment
    lucid,
    price.pythMessage,
    price.pythStateOref
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
