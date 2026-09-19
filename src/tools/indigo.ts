import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { buildCloseCdp, buildOpenCdp } from '../adapters/indigo.js';
import { toolResult } from './result.js';

const SIGNING_NOTE =
  'UNSIGNED. `unsignedTxCbor` is full transaction CBOR with an empty witness set, ready for a CIP-30 ' +
  '`signTx`. Sign it with your own keys and submit it yourself; this server holds no keys and no funds.';

export function registerIndigoTools(server: McpServer): void {
  server.registerTool(
    'open_cdp',
    {
      title: 'Build an unsigned Indigo open-CDP transaction',
      description:
        'Build a transaction that opens an Indigo CDP: lock ADA collateral and mint an iAsset (e.g. iUSD). ' +
        'Returns an UNSIGNED transaction as CBOR hex with an empty witness set, plus a human-readable summary. ' +
        'Pyth-priced markets (e.g. iUSD): the tx embeds a signed price with a ~280-second validity window, so ' +
        'sign and submit promptly after building — a paused/stale tx fails on-chain validation; rebuild instead. ' +
        'This server never signs, never submits and never holds keys or funds — the agent signs it (CIP-30 ' +
        '`signTx`) and submits it. ADA collateral only; requires BLOCKFROST_PROJECT_ID and ' +
        'INDIGO_SYSTEM_PARAMS_URL.',
      inputSchema: {
        address: z.string().min(1).describe('Bech32 Cardano address that will own the CDP and fund it'),
        iasset: z.string().min(1).describe('iAsset to mint, e.g. "iUSD"'),
        collateralLovelace: z
          .string()
          .regex(/^\d+$/)
          .describe('ADA collateral to lock, in lovelace (1 ADA = 1000000 lovelace)'),
        mintAmount: z.string().regex(/^\d+$/).describe('iAsset amount to mint, in its smallest unit'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ address, iasset, collateralLovelace, mintAmount }) =>
      toolResult(async () => ({
        ...(await buildOpenCdp({ address, iasset, collateralLovelace, mintAmount })),
        signing: SIGNING_NOTE,
      })),
  );

  server.registerTool(
    'close_cdp',
    {
      title: 'Build an unsigned Indigo close-CDP transaction',
      description:
        'Build a transaction that closes an Indigo CDP: burn the minted iAsset debt and withdraw the ADA ' +
        'collateral. Identify the CDP by the out-ref from get_position (protocol "indigo"). Returns an ' +
        'UNSIGNED transaction as CBOR hex with an empty witness set, plus a human-readable summary. This ' +
        'server never signs, never submits and never holds keys or funds — the agent signs it (CIP-30 ' +
        '`signTx`) and submits it. Requires BLOCKFROST_PROJECT_ID and INDIGO_SYSTEM_PARAMS_URL.',
      inputSchema: {
        address: z.string().min(1).describe('Bech32 Cardano address that owns the CDP'),
        txHash: z.string().min(1).describe('cdpOutRef.txHash from get_position'),
        outputIndex: z.number().int().min(0).describe('cdpOutRef.outputIndex from get_position'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ address, txHash, outputIndex }) =>
      toolResult(async () => ({
        ...(await buildCloseCdp({ address, cdpOutRef: { txHash, outputIndex } })),
        signing: SIGNING_NOTE,
      })),
  );
}
