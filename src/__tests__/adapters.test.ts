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
import { buildOpenCdp, getPositions as getIndigoPositions } from '../adapters/indigo.js';
import { getQuote, parseSseBuffer } from '../adapters/swap.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const ADDRESS = credentialToAddress('Mainnet', { type: 'Key', hash: '11'.repeat(28) });
const PKH = paymentCredentialOf(ADDRESS).hash;
const OTHER_PKH = '22'.repeat(28);

const ENV_KEYS = [
  'BLOCKFROST_PROJECT_ID',
  'CARDANO_NETWORK',
  'BAZAAR_API_URL',
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

/** A `text/event-stream` Response whose body arrives in the given chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function quote(quoteId: string, netOutput: string, merchantName: string) {
  return {
    quoteId,
    expiresAt: 1_900_000_000_000,
    merchantName,
    merchantLogo: `https://cdn.example/${merchantName}.svg`,
    fromChainId: 1,
    toChainId: 1815,
    fromToken: '0x0000000000000000000000000000000000000000',
    toToken: 'lovelace',
    inAmount: '1000000000000000000',
    outAmount: netOutput,
    netOutput,
    fees: { gas: [], platform: [], totalUSD: 0 },
    estimatedArrivalSeconds: 180,
    tx: { to: '0xrouter', data: '0xdeadbeef', value: '0' },
  };
}

const QUOTE_A = quote('q-a', '1200000000', 'rango');
const QUOTE_B = quote('q-b', '1350000000', 'squid');

/** Canned SSE transcript in the shape apps/api streams on GET /events/market. */
const SSE_FIXTURE =
  `event: adapters\ndata: {"adapters":["rango","squid"]}\n\n` +
  `: heartbeat\n\n` +
  `event: quote\ndata: ${JSON.stringify(QUOTE_A)}\n\n` +
  `event: adapter_result\ndata: {"adapter":"rango","status":"ok"}\n\n` +
  `event: quote\ndata: ${JSON.stringify(QUOTE_B)}\n\n` +
  `event: done\ndata: {"reason":"complete"}\n\n`;

// ── swap.parseSseBuffer ──────────────────────────────────────────────────────

describe('swap.parseSseBuffer', () => {
  it('parses whole events out of a canned text/event-stream buffer', () => {
    const { events, rest } = parseSseBuffer(SSE_FIXTURE);

    expect(rest).toBe('');
    expect(events.map((e) => e.event)).toEqual([
      'adapters',
      'quote',
      'adapter_result',
      'quote',
      'done',
    ]);
    expect(JSON.parse(events[1]!.data).quoteId).toBe('q-a');
  });

  it('drops comment-only blocks (heartbeats) rather than emitting empty events', () => {
    const { events } = parseSseBuffer(': heartbeat\n\n: another\n\n');
    expect(events).toEqual([]);
  });

  it('defaults a data-only block to the "message" event', () => {
    const { events } = parseSseBuffer('data: hello\n\n');
    expect(events).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('joins multi-line data with newlines and strips one leading space', () => {
    const { events } = parseSseBuffer('event: quote\ndata: line1\ndata:line2\n\n');
    expect(events[0]).toEqual({ event: 'quote', data: 'line1\nline2' });
  });

  it('normalises CRLF line endings', () => {
    const { events, rest } = parseSseBuffer('event: done\r\ndata: {}\r\n\r\n');
    expect(events).toEqual([{ event: 'done', data: '{}' }]);
    expect(rest).toBe('');
  });

  it('returns a trailing partial event as rest, and parses it once the rest arrives', () => {
    const split = SSE_FIXTURE.indexOf('"q-b"') + 3; // mid-way through the second quote's JSON
    const head = SSE_FIXTURE.slice(0, split);
    const tail = SSE_FIXTURE.slice(split);

    const first = parseSseBuffer(head);
    expect(first.events.map((e) => e.event)).toEqual(['adapters', 'quote', 'adapter_result']);
    expect(first.rest).not.toBe('');
    // The partial event must not have been emitted yet.
    expect(first.events.filter((e) => e.event === 'quote')).toHaveLength(1);

    const second = parseSseBuffer(first.rest + tail);
    expect(second.events.map((e) => e.event)).toEqual(['quote', 'done']);
    expect(JSON.parse(second.events[0]!.data).quoteId).toBe('q-b');
    expect(second.rest).toBe('');
  });
});

// ── swap.getQuote ────────────────────────────────────────────────────────────

describe('swap.getQuote', () => {
  const params = {
    fromChain: '1',
    toChain: '1815',
    fromToken: '0x0000000000000000000000000000000000000000',
    toToken: 'lovelace',
    amount: '1000000000000000000',
    userAddress: '0xabc',
    slippage: '0.5',
  };

  it('collects quotes off the SSE stream and resolves best/all by netOutput', async () => {
    // Chunk boundary falls inside an event so the carryover path is exercised.
    const cut = SSE_FIXTURE.indexOf('"q-b"') + 3;
    const fetchMock = vi.fn(async () =>
      sseResponse([SSE_FIXTURE.slice(0, cut), SSE_FIXTURE.slice(cut)]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getQuote(params);

    expect(result.all.map((q) => q.quoteId)).toEqual(['q-b', 'q-a']);
    expect(result.best?.quoteId).toBe('q-b');
    expect(result.best?.merchantName).toBe('squid');
  });

  it('requests /events/market with the Bazaar param names and the SSE accept header', async () => {
    process.env.BAZAAR_API_URL = 'https://api.example.com/';
    const fetchMock = vi.fn(async () => sseResponse([SSE_FIXTURE]));
    vi.stubGlobal('fetch', fetchMock);

    await getQuote(params);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.example.com/events/market');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      fromChain: '1',
      toChain: '1815',
      fromToken: params.fromToken,
      toToken: 'lovelace',
      amount: params.amount,
      userAddress: '0xabc',
      slippage: '0.5',
    });
    expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
  });

  it('returns an empty race on no_routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(['event: no_routes\ndata: {"reason":"none"}\n\n'])),
    );

    const result = await getQuote(params);
    expect(result).toEqual({ best: null, all: [] });
  });

  it('throws a short message with the status on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad request', { status: 400 })),
    );

    await expect(getQuote(params)).rejects.toThrow(/400 for \/events\/market/);
  });
});

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

    await expect(getBalance(ADDRESS)).rejects.toThrow(/BLOCKFROST_PROJECT_ID required/);
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
