/**
 * Adapter unit tests. Every network call is mocked — `npm test` never touches the wire.
 *
 * Indigo tx building is deliberately untested beyond its guard rails: `buildOpenCdp`
 * needs live chain state (Blockfrost UTxOs, Indigo script refs, an on-chain oracle),
 * which a fetch mock cannot stand in for honestly. We cover its read path and the
 * explicit failure it must give when SystemParams are not configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialToAddress, paymentCredentialOf } from '@lucid-evolution/lucid';

import { getBalance } from '../adapters/blockfrost.js';
import { getMarkets, getPositions as getLiqwidPositions } from '../adapters/liqwid.js';
import {
  buildOpenCdp,
  fetchPythPriceSource,
  getPositions as getIndigoPositions,
} from '../adapters/indigo.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const ADDRESS = credentialToAddress('Mainnet', { type: 'Key', hash: '11'.repeat(28) });
const PKH = paymentCredentialOf(ADDRESS).hash;
const OTHER_PKH = '22'.repeat(28);

const ENV_KEYS = [
  'BLOCKFROST_PROJECT_ID',
  'CARDANO_NETWORK',
  'LIQWID_GRAPHQL_URL',
  'INDIGO_API_URL',
  'INDIGO_SYSTEM_PARAMS_URL',
  'INDIGO_SYSTEM_PARAMS_FILE',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ── liqwid ───────────────────────────────────────────────────────────────────

describe('liqwid.getMarkets', () => {
  const MARKETS_PAYLOAD = {
    data: {
      liqwid: {
        data: {
          markets: {
            totalCount: 2,
            results: [
              {
                id: 'Ada',
                displayName: 'ADA',
                supplyAPY: 0.0291,
                borrowAPR: 0.0503,
                utilization: 0.3555,
              },
              {
                id: 'IUSD',
                displayName: 'iUSD',
                supplyAPY: 0.0942,
                borrowAPR: 0.2039,
                utilization: 0.5777,
              },
            ],
          },
        },
      },
    },
  };

  it('maps displayName to asset and keeps the rate fields', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MARKETS_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const markets = await getMarkets();

    expect(markets).toEqual([
      { id: 'Ada', asset: 'ADA', supplyAPY: 0.0291, borrowAPR: 0.0503, utilization: 0.3555 },
      { id: 'IUSD', asset: 'iUSD', supplyAPY: 0.0942, borrowAPR: 0.2039, utilization: 0.5777 },
    ]);
  });

  it('posts a zero-indexed page to the default endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MARKETS_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await getMarkets();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://v2.api.liqwid.finance/graphql');
    const body = JSON.parse(init.body as string);
    expect(body.variables.input.page).toBe(0);
    expect(body.query).toContain('markets(input: $input)');
  });

  it('surfaces GraphQL errors as a single short message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ errors: [{ message: 'field missing' }] })),
    );

    await expect(getMarkets()).rejects.toThrow(/Liqwid GraphQL error: field missing/);
  });

  it('surfaces a transport failure with its status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway down', { status: 502 })),
    );

    await expect(getMarkets()).rejects.toThrow(/Liqwid GraphQL 502/);
  });
});

describe('liqwid.getPositions', () => {
  const LOANS_PAYLOAD = {
    data: {
      liqwid: {
        data: {
          loans: {
            totalCount: 1,
            results: [
              {
                id: 'loan-1',
                marketId: 'Ada',
                ownerPaymentKeyHash: PKH,
                debt: 1234.5,
                collateralValue: 9999.5,
                healthFactor: 2.1,
                LTV: 0.42,
                APY: 0.05,
                asset: { displayName: 'ADA' },
              },
            ],
          },
        },
      },
    },
  };

  it('queries by the payment key hash behind the address and renames LTV/APY', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(LOANS_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const loans = await getLiqwidPositions(ADDRESS);

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.variables.input.paymentKeys).toEqual([PKH]);
    expect(loans).toEqual([
      {
        id: 'loan-1',
        marketId: 'Ada',
        asset: 'ADA',
        ownerPaymentKeyHash: PKH,
        debt: 1234.5,
        collateralValue: 9999.5,
        healthFactor: 2.1,
        ltv: 0.42,
        apy: 0.05,
      },
    ]);
  });

  it('returns an empty list when the address owns no loans', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ data: { liqwid: { data: { loans: { totalCount: 0, results: [] } } } } }),
      ),
    );

    await expect(getLiqwidPositions(ADDRESS)).resolves.toEqual([]);
  });
});

// ── blockfrost ───────────────────────────────────────────────────────────────

describe('blockfrost.getBalance', () => {
  it('splits lovelace from native assets and derives ada', async () => {
    process.env.BLOCKFROST_PROJECT_ID = 'mainnetTESTKEY';
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        address: ADDRESS,
        amount: [
          { unit: 'lovelace', quantity: '12500000' },
          { unit: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880' + '69555344', quantity: '4200' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const balance = await getBalance(ADDRESS);

    expect(balance).toEqual({
      address: ADDRESS,
      lovelace: '12500000',
      ada: 12.5,
      assets: [
        {
          unit: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344',
          quantity: '4200',
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://cardano-mainnet.blockfrost.io/api/v0/addresses/${ADDRESS}`);
    expect((init.headers as Record<string, string>).project_id).toBe('mainnetTESTKEY');
  });

  it('treats a 404 (address never seen on-chain) as a zero balance', async () => {
    process.env.BLOCKFROST_PROJECT_ID = 'mainnetTESTKEY';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Not Found' }, 404)),
    );

    await expect(getBalance(ADDRESS)).resolves.toEqual({
      address: ADDRESS,
      lovelace: '0',
      ada: 0,
      assets: [],
    });
  });

  it('uses the preprod host when CARDANO_NETWORK=preprod', async () => {
    process.env.BLOCKFROST_PROJECT_ID = 'preprodTESTKEY';
    process.env.CARDANO_NETWORK = 'preprod';
    const fetchMock = vi.fn(async () => jsonResponse({ address: ADDRESS, amount: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getBalance(ADDRESS);

    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain(
      'cardano-preprod.blockfrost.io',
    );
  });

  it('fails with a clear message when BLOCKFROST_PROJECT_ID is unset, before any fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getBalance(ADDRESS)).rejects.toThrow(/BLOCKFROST_PROJECT_ID is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown CARDANO_NETWORK', async () => {
    process.env.BLOCKFROST_PROJECT_ID = 'k';
    process.env.CARDANO_NETWORK = 'sanchonet';
    vi.stubGlobal('fetch', vi.fn());

    await expect(getBalance(ADDRESS)).rejects.toThrow(/CARDANO_NETWORK must be/);
  });

  it('surfaces a 4xx from Blockfrost with its status and a truncated body', async () => {
    process.env.BLOCKFROST_PROJECT_ID = 'badkey';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Forbidden","message":"Invalid project token"}', { status: 403 })),
    );

    await expect(getBalance(ADDRESS)).rejects.toThrow(/Blockfrost 403 for \/addresses/);
  });
});

// ── indigo ───────────────────────────────────────────────────────────────────

describe('indigo.getPositions', () => {
  const CDPS = [
    {
      output_hash: 'aa'.repeat(32),
      output_index: 0,
      owner: PKH,
      asset: 'iUSD',
      collateralAmount: 250_000_000,
      mintedAmount: 100_000_000,
      frozen_cdp_accumulated_lovelaces_treasury: null,
    },
    {
      output_hash: 'bb'.repeat(32),
      output_index: 1,
      owner: PKH,
      asset: 'iBTC',
      collateralAmount: 900_000_000,
      mintedAmount: 5_000,
      frozen_cdp_accumulated_lovelaces_treasury: 12_345,
    },
    {
      output_hash: 'cc'.repeat(32),
      output_index: 0,
      owner: OTHER_PKH,
      asset: 'iETH',
      collateralAmount: 1,
      mintedAmount: 1,
      frozen_cdp_accumulated_lovelaces_treasury: null,
    },
  ];

  it('filters the analytics feed to the address and maps out-ref, amounts and frozen', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(CDPS));
    vi.stubGlobal('fetch', fetchMock);

    const positions = await getIndigoPositions(ADDRESS);

    expect(positions).toEqual([
      {
        cdpOutRef: { txHash: 'aa'.repeat(32), outputIndex: 0 },
        owner: PKH,
        iasset: 'iUSD',
        collateralLovelace: '250000000',
        mintedAmount: '100000000',
        frozen: false,
      },
      {
        cdpOutRef: { txHash: 'bb'.repeat(32), outputIndex: 1 },
        owner: PKH,
        iasset: 'iBTC',
        collateralLovelace: '900000000',
        mintedAmount: '5000',
        frozen: true,
      },
    ]);

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://analytics.indigoprotocol.io/api/cdps',
    );
  });

  it('honours INDIGO_API_URL and strips its trailing slash', async () => {
    process.env.INDIGO_API_URL = 'https://indigo.internal/';
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await getIndigoPositions(ADDRESS);

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://indigo.internal/api/cdps',
    );
  });

  it('surfaces a failing analytics endpoint with its status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );

    await expect(getIndigoPositions(ADDRESS)).rejects.toThrow(/Indigo API 503 for \/api\/cdps/);
  });
});

describe('indigo.buildOpenCdp', () => {
  it('rejects with an actionable message when SystemParams are not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      buildOpenCdp({
        address: ADDRESS,
        iasset: 'iUSD',
        collateralLovelace: 250_000_000n,
        mintAmount: 100_000_000n,
      }),
    ).rejects.toThrow(/INDIGO_SYSTEM_PARAMS_URL \(or INDIGO_SYSTEM_PARAMS_FILE\) required/);

    // It must fail on configuration before it reaches Blockfrost or the chain.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the amounts before anything else', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const base = { address: ADDRESS, iasset: 'iUSD' };

    await expect(
      buildOpenCdp({ ...base, collateralLovelace: 0n, mintAmount: 1n }),
    ).rejects.toThrow(/collateralLovelace must be greater than zero/);
    await expect(
      buildOpenCdp({ ...base, collateralLovelace: 1n, mintAmount: 0n }),
    ).rejects.toThrow(/mintAmount must be greater than zero/);
  });
});

// The Pyth (DeferredValidation) price inputs of buildOpenCdp. The rest of that
// branch is live chain state, so only the two analytics endpoints are covered here.
describe('indigo.fetchPythPriceSource', () => {
  const PAYLOAD = 'b9011a82' + 'ab'.repeat(60);
  const STATE = { outputHash: 'dd'.repeat(32), outputIndex: 0 };

  function pythFetchMock(priceStatus = 200) {
    return vi.fn(async (url: string) =>
      String(url).includes('/pyth-state/utxo')
        ? jsonResponse(STATE)
        : priceStatus === 200
          ? jsonResponse({
              price: '4.399807517220',
              expiration: Date.now() + 3_600_000,
              timestamp: Math.floor(Date.now() / 1000),
              pythPayload: PAYLOAD,
            })
          : new Response('Not Found', { status: priceStatus }),
    );
  }

  it('fetches the signed price and the Pyth state out-ref from INDIGO_API_URL', async () => {
    process.env.INDIGO_API_URL = 'https://indigo.internal/';
    const fetchMock = pythFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPythPriceSource('iUSD')).resolves.toEqual({
      pythMessage: PAYLOAD,
      pythStateOref: { txHash: STATE.outputHash, outputIndex: 0 },
    });

    expect(fetchMock.mock.calls.map((c) => String(c[0])).sort()).toEqual([
      'https://indigo.internal/api/v3/assets/iUSD/ada/price',
      'https://indigo.internal/api/v3/pyth-state/utxo',
    ]);
  });

  it('surfaces a 404 from the price endpoint as one clear message', async () => {
    vi.stubGlobal('fetch', pythFetchMock(404));

    await expect(fetchPythPriceSource('iUSD')).rejects.toThrow(
      /Indigo API 404 for \/api\/v3\/assets\/iUSD\/ada\/price/,
    );
  });

  it('refuses a price older than the 280s validator window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/pyth-state/utxo')
          ? jsonResponse(STATE)
          : jsonResponse({ timestamp: Math.floor(Date.now() / 1000) - 400, pythPayload: PAYLOAD }),
      ),
    );

    await expect(fetchPythPriceSource('iUSD')).rejects.toThrow(/the validator rejects anything past 280s/);
  });
});
