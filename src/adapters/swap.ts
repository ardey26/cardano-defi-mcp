/**
 * BazaarSwap API client.
 *
 * Contract source of truth: packages/shared/src/schemas.ts (SwapParamsSchema,
 * ExecuteRequestSchema, AdapterResultSchema, RaceDoneSchema) and apps/api/openapi.yaml.
 *
 * `GET /events/market` is SSE. Event names: `adapters`, `quote`, `adapter_result`,
 * `no_routes`, `done`, `heartbeat`. The race re-runs on the same connection, so we
 * settle on the first `done` (or `no_routes`) and close the stream.
 *
 * Env: BAZAAR_API_URL (default http://localhost:3001).
 */

export interface SwapParams {
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  amount: string;
  userAddress: string;
  slippage?: string;
  recipientAddress?: string;
}

export interface QuoteFees {
  gas: { symbol: string; chain?: string; amount: string; amountUSD?: number }[];
  platform: { name: string; amountUSD: number }[];
  totalUSD: number;
}

export interface Quote {
  quoteId: string;
  expiresAt: number;
  merchantName: string;
  merchantLogo: string;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  inAmount: string;
  outAmount: string;
  netOutput: string;
  fees: QuoteFees;
  inAmountUSD?: number;
  outAmountUSD?: number;
  estimatedArrivalSeconds: number;
  tx: { to: string; data: string; value: string; gasLimit?: string };
  approvalAddress?: string;
  isOmniston?: boolean;
}

export interface QuoteRaceResult {
  best: Quote | null;
  all: Quote[];
}

export interface ExecuteResponse {
  txData: { to: string; data: string | Record<string, unknown>; value: string; gasLimit?: string };
  quote: Partial<Quote>;
  tracking?: string;
}

export interface SseEvent {
  event: string;
  data: string;
}

// Must exceed the Bazaar API's own 25 s per-provider window, or we abort at the
// exact moment a slow provider would have delivered.
const RACE_TIMEOUT_MS = 35_000;

export function getBaseUrl(): string {
  return (process.env.BAZAAR_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}

/** Optional partner key for the Bazaar API (X-API-Key); unauthenticated without it. */
export function apiKeyHeaders(): Record<string, string> {
  const key = process.env.BAZAAR_API_KEY;
  return key ? { 'X-API-Key': key } : {};
}

/**
 * Parse a text/event-stream chunk buffer into whole events.
 * Returns the parsed events plus whatever trailing partial text must be re-buffered.
 */
export function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const blocks = normalised.split('\n\n');
  const rest = blocks.pop() ?? '';

  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':') || line.trim() === '') continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
}

function sortByNetOutputDesc(quotes: Quote[]): Quote[] {
  return [...quotes].sort((a, b) => {
    const av = BigInt(a.netOutput);
    const bv = BigInt(b.netOutput);
    return av === bv ? 0 : av > bv ? -1 : 1;
  });
}

function buildQuoteUrl(params: SwapParams): string {
  const qs = new URLSearchParams({
    fromChain: params.fromChain,
    toChain: params.toChain,
    fromToken: params.fromToken,
    toToken: params.toToken,
    amount: params.amount,
    userAddress: params.userAddress,
  });
  if (params.slippage !== undefined) qs.set('slippage', params.slippage);
  if (params.recipientAddress !== undefined) qs.set('recipientAddress', params.recipientAddress);
  return `${getBaseUrl()}/events/market?${qs.toString()}`;
}

/**
 * Open the quote-race SSE stream and collect one round of quotes.
 * Settles on `done` / `no_routes`, or after RACE_TIMEOUT_MS, whichever comes first.
 */
export async function getQuote(params: SwapParams): Promise<QuoteRaceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RACE_TIMEOUT_MS);
  const quotes = new Map<string, Quote>();

  try {
    const res = await fetch(buildQuoteUrl(params), {
      headers: { accept: 'text/event-stream', ...apiKeyHeaders() },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Bazaar API ${res.status} for /events/market: ${body.slice(0, 200) || res.statusText}`);
    }
    if (!res.body) throw new Error('Bazaar API returned no SSE body');

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';
    let settled = false;

    while (!settled) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;

      for (const ev of parsed.events) {
        if (ev.event === 'quote') {
          const quote = JSON.parse(ev.data) as Quote;
          quotes.set(quote.quoteId, quote);
        } else if (ev.event === 'done' || ev.event === 'no_routes') {
          settled = true;
          break;
        }
      }
    }

    await reader.cancel().catch(() => {});
  } catch (err) {
    // The 25 s ceiling aborts the stream; that settles the race with whatever arrived.
    if (!(err instanceof Error && err.name === 'AbortError')) throw err;
  } finally {
    clearTimeout(timer);
  }

  const all = sortByNetOutputDesc([...quotes.values()]);
  return { best: all[0] ?? null, all };
}

export async function buildSwapTx(quoteId: string, userAddress: string): Promise<ExecuteResponse> {
  const res = await fetch(`${getBaseUrl()}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...apiKeyHeaders() },
    body: JSON.stringify({ quoteId, userAddress }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bazaar API ${res.status} for /execute: ${body.slice(0, 200) || res.statusText}`);
  }
  return (await res.json()) as ExecuteResponse;
}
