# Cardano DeFi MCP — taxonomy + agent tools (PoC)

Open-source proof of concept for the Cardano PRIME grant: a taxonomy index of Cardano
DeFi venues plus an MCP server that lets AI agents discover Cardano DeFi, get cross-chain
quotes into ADA via the BazaarSwap API, read positions, and receive **unsigned** Cardano
transactions (Indigo CDPs) that the agent signs with its own keys. This server never
holds funds and never signs anything.

## Layout (single npm package, ESM, strict TS)

```
taxonomy/capabilities.json  # the capability tree (two-level ids)
taxonomy/venues/*.json      # one file per venue, validated by VenueSchema
taxonomy/mcps/*.json        # one file per MCP server, tools classified by capability + effect
src/taxonomy/schema.ts      # zod schemas: capability node, venue, MCP record
src/taxonomy/index.ts       # loaders + cross-checks, listVenues / getVenue / searchVenues / getMcp
src/taxonomy/find.ts        # findCapability / listCapabilities
src/taxonomy/self.ts        # this repo's MCP ids + meta tools
src/adapters/blockfrost.ts  # getBalance(address)
src/adapters/liqwid.ts      # getMarkets() / getPositions(address)  [read-only GraphQL]
src/adapters/indigo.ts      # getPositions(address) / buildOpenCdp / buildCloseCdp  [indigo-sdk]
src/adapters/swap.ts        # getQuote(params) / buildSwapTx(quoteId, userAddress)  [Bazaar API client]
src/tools/*.ts              # MCP tool registrations (thin: parse args -> adapter -> JSON text content)
src/server.ts               # McpServer wiring + transport selection (stdio | http)
src/http.ts                 # Streamable HTTP host: routing, CORS, /health, stateless per-request transport
src/rate-limit.ts           # in-memory sliding-window per-IP limiter for the HTTP host
src/__tests__/              # vitest
```

## Contracts (what each module must export)

### taxonomy
- Records: `taxonomy/capabilities.json` (array of `{ id: "group.action", label, description }`),
  `taxonomy/venues/<id>.json`, `taxonomy/mcps/<id>.json`. All strict: unknown fields are errors.
- `VenueSchema`: `{ id, name, category, url, description, assets: string[], capabilities: CapabilityId[], notes? }`
- `McpSchema`: `{ id, name, publisher, official, repo, connect: (stdio{command,args} | http{url})[], auth: 'none'|'api_key'|'oauth', tools: { name, capability, venues?, effect: 'read'|'unsigned_tx'|'signs', notes? }[], notes? }`
- Loaders (each takes an optional `root`): `loadCapabilities`, `loadVenues`, `loadMcps` (cross-check
  capability and venue ids), `listVenues(filter?: { category?, asset?, capability? })` where
  `capability` is an id or group, `getVenue`, `searchVenues`, `getMcp`, `matchesCapability`.
- `find.ts`: `findCapability({ capability, asset?, venue? }, here)` → `{ venues, paths, gaps }`, paths
  ranked here → lower effect → official; `listCapabilities()` with counts.
- `self.ts`: `SELF_MCP_ID`, `WALLET_MCP_ID`, `META_TOOLS`. `mcps.test.ts` fails if either server
  registers a non-meta tool its entry does not classify, or the entry lists a tool it does not register.

### adapters
- `blockfrost.getBalance(address) -> { address, lovelace: string, ada: number, assets: [{ unit, quantity }] }`
- `liqwid.getMarkets() -> [{ id, asset, supplyAPY, borrowAPR, utilization }]`
- `liqwid.getPositions(address) -> loans for the address's payment key hash` (derive pkh with `paymentCredentialOf` from `@lucid-evolution/lucid`)
- `indigo.getPositions(address)`, `indigo.buildOpenCdp({ address, iasset, collateralLovelace, mintAmount })`
  and `indigo.buildCloseCdp(...)` -> `{ unsignedTxCbor, description, network }` (full tx CBOR hex,
  empty witness set — CIP-30 `signTx` compatible). Lucid Evolution + Blockfrost provider.
- `swap.getQuote(params)` -> opens SSE `GET {BAZAAR_API_URL}/events/market?...`, collects quote
  events until the race settles (or 25s), returns `{ best, all }` sorted by netOutput.
  `swap.buildSwapTx(quoteId, userAddress)` -> `POST {BAZAAR_API_URL}/execute`.
  Param names MUST match the Bazaar API contract — read
  `/Users/andeus/work/bazaar-web/packages/shared/src/schemas.ts` (SwapParamsSchema,
  ExecuteRequestSchema) and `/Users/andeus/work/bazaar-web/apps/api/openapi.yaml`.

### MCP tools (names fixed — the RFP names them)
`list_venues`, `get_venue`, `get_quote`, `build_swap_tx`, `get_balance`,
`get_position` (protocol: indigo | liqwid), `get_market_data` (liqwid APYs),
`open_cdp`, `close_cdp` (both return unsigned CBOR + human-readable summary).

## Rules
- Node 20+, native `fetch` only; no new runtime deps without noting why in DESIGN.md.
- Tool handlers return `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`;
  errors -> `isError: true` with a short message, never a stack trace.
- Read-side tools must work with only `BLOCKFROST_PROJECT_ID` unset EXCEPT get_balance/indigo
  (they may return a clear "BLOCKFROST_PROJECT_ID required" error).
- Unit-test pure logic (taxonomy queries, SSE parsing, GraphQL mapping) with vitest;
  network calls mocked. No live-network tests in `npm test`.
- Env vars: see `.env.example`. Never log secrets.
