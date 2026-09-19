/**
 * Boots the real HTTP transport on an ephemeral port and talks to it with fetch.
 * Nothing here leaves the loopback interface: `tools/list` touches no adapter.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHttpServer } from '../http.js';
import { createMcpServer } from '../server.js';

const EXPECTED_TOOLS = [
  'list_venues',
  'get_venue',
  'get_quote',
  'build_swap_tx',
  'get_balance',
  'get_position',
  'get_market_data',
  'open_cdp',
  'close_cdp',
];

/** The transport answers a POST with an SSE stream; pull the one JSON-RPC frame out of it. */
function parseSseMessage(body: string): unknown {
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`no SSE data frame in response: ${body}`);
  return JSON.parse(line.slice('data: '.length));
}

async function rpc(base: string, message: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
  });
  return { status: res.status, body: await res.text() };
}

describe('Streamable HTTP transport', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await startHttpServer({ port: 0, createMcpServer });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers the Render health check', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('completes a JSON-RPC initialize', async () => {
    const { status, body } = await rpc(base, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' },
      },
    });

    expect(status).toBe(200);
    const message = parseSseMessage(body) as { result: { serverInfo: { name: string } } };
    expect(message.result.serverInfo.name).toBe('cardano-defi-mcp');
  });

  it('lists the nine tools without a session id', async () => {
    const { status, body } = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(status).toBe(200);
    const message = parseSseMessage(body) as { result: { tools: { name: string }[] } };
    const names = message.result.tools.map((t) => t.name);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('refuses GET and DELETE on the stateless endpoint', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method, headers: { accept: 'text/event-stream' } });
      expect(res.status).toBe(405);
    }
  });

  it('answers the CORS preflight', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('mcp-protocol-version');
  });

  it('404s anything that is not /mcp or /health', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});

describe('rate limiting', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await startHttpServer({ port: 0, createMcpServer, rateLimitPerMin: 2 });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('429s past the per-IP budget with Retry-After and a JSON-RPC body', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await rpc(base, list)).status).toBe(200);
    expect((await rpc(base, list)).status).toBe(200);

    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(list),
    });

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000 } });
  });

  it('does not rate-limit /health', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
