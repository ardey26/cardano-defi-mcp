/**
 * Blockfrost REST adapter — address balances.
 *
 * Env: BLOCKFROST_PROJECT_ID (required), CARDANO_NETWORK ('mainnet' | 'preprod').
 */

import { nextStep } from '../hints.js';

export type CardanoNetwork = 'mainnet' | 'preprod';

export interface AssetAmount {
  unit: string;
  quantity: string;
}

export interface Balance {
  address: string;
  lovelace: string;
  ada: number;
  assets: AssetAmount[];
}

const BASE_URLS: Record<CardanoNetwork, string> = {
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
};

export function getNetwork(): CardanoNetwork {
  const raw = process.env.CARDANO_NETWORK ?? 'mainnet';
  if (raw !== 'mainnet' && raw !== 'preprod') {
    throw new Error(`CARDANO_NETWORK must be 'mainnet' or 'preprod', got '${raw}'`);
  }
  return raw;
}

export function getProjectId(): string {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      `BLOCKFROST_PROJECT_ID is not set: ${nextStep(
        'call configure with blockfrostProjectId — a free key takes a minute at https://blockfrost.io ' +
          '(create a project on the Cardano mainnet network and copy its project id)',
        'set it to a Blockfrost project id (https://blockfrost.io)',
      )}`,
    );
  }
  return projectId;
}

export function getBaseUrl(network: CardanoNetwork = getNetwork()): string {
  return BASE_URLS[network];
}

interface BlockfrostAddressResponse {
  address: string;
  amount: { unit: string; quantity: string }[];
}

export async function getBalance(address: string): Promise<Balance> {
  const projectId = getProjectId();
  const url = `${getBaseUrl()}/addresses/${encodeURIComponent(address)}`;

  const res = await fetch(url, { headers: { project_id: projectId } });

  // Blockfrost 404s an address it has never seen on-chain; that is a zero balance,
  // not a failure.
  if (res.status === 404) {
    return { address, lovelace: '0', ada: 0, assets: [] };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Blockfrost ${res.status} for /addresses: ${body.slice(0, 200) || res.statusText}`);
  }

  const data = (await res.json()) as BlockfrostAddressResponse;
  const amounts = data.amount ?? [];
  const lovelace = amounts.find((a) => a.unit === 'lovelace')?.quantity ?? '0';

  return {
    address: data.address ?? address,
    lovelace,
    ada: Number(lovelace) / 1_000_000,
    assets: amounts.filter((a) => a.unit !== 'lovelace').map((a) => ({ unit: a.unit, quantity: a.quantity })),
  };
}
