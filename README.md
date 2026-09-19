# BazaarSwap Cardano — taxonomy + MCP server

Open-source proof of concept for the **Cardano PRIME** grant. Two things in one small package:

1. **A taxonomy index of Cardano DeFi venues** — 11 hand-researched venue records (DEXes, lending,
   CDPs, stablecoins, perps) with categories, assets, capabilities and honest caveats, validated by a
   zod schema.
2. **An MCP server** that gives an AI agent rails into Cardano DeFi: discover venues, get cross-chain
   swap quotes into ADA, read balances and positions, and receive **unsigned** transactions the agent
   signs with its own keys.

The **BazaarSwap routing backend is a separate, closed-source service**. This repo is only an HTTP
client of it (`BAZAAR_API_URL`); nothing in here does routing, and nothing in here is a wallet.

## Quickstart

```bash
npm i
cp .env.example .env    # fill in BLOCKFROST_PROJECT_ID; the rest have working defaults
npm test                # vitest, fully mocked — no network
npx tsx src/server.ts   # MCP server on stdio
```

### Environment

| Variable | Required for | Default |
| --- | --- | --- |
| `BLOCKFROST_PROJECT_ID` | `get_balance`, `open_cdp`, `close_cdp` | — (clear error if unset) |
| `BAZAAR_API_URL` | `get_quote`, `build_swap_tx` | `http://localhost:3001` |
| `LIQWID_GRAPHQL_URL` | `get_market_data`, Liqwid `get_position` | `https://v2.api.liqwid.finance/graphql` |
| `CARDANO_NETWORK` | Blockfrost / Indigo host selection | `mainnet` (`mainnet` \| `preprod`) |
| `INDIGO_API_URL` | Indigo `get_position` | `https://analytics.indigoprotocol.io` |
| `INDIGO_SYSTEM_PARAMS_URL` | `open_cdp`, `close_cdp` | — (or `INDIGO_SYSTEM_PARAMS_FILE`) |

Every read tool except `get_balance` and the Indigo tools works with no API keys at all.

### Register with Claude Code

Copy `.mcp.json.example` to `.mcp.json` in your project root, fill in the env placeholders, and
restart Claude Code. Then `/mcp` should list `bazaarswap-cardano` with nine tools.

## Tools

| Tool | What it does | Funds |
| --- | --- | --- |
| `list_venues` | List/filter indexed venues by category, asset, capability, or free-text `query` | read-only |
| `get_venue` | Full taxonomy record for one venue id | read-only |
| `get_quote` | Race the BazaarSwap backend for cross-chain routes; returns `best` + `all` by net output | read-only |
| `build_swap_tx` | Turn a `quoteId` into transaction data | **unsigned** |
| `get_balance` | ADA + native-asset balance of a Cardano address (Blockfrost) | read-only |
| `get_position` | Indigo CDPs or Liqwid loans for an address (`protocol: indigo \| liqwid`) | read-only |
| `get_market_data` | Liqwid supply APY / borrow APR / utilization per market | read-only |
| `open_cdp` | Lock ADA collateral, mint an iAsset on Indigo | **unsigned** |
| `close_cdp` | Burn iAsset debt, withdraw ADA collateral on Indigo | **unsigned** |

All tools return `{ content: [{ type: 'text', text: <pretty JSON> }] }`; failures return
`isError: true` with a one-line message and no stack trace.

## Security model

- **No keys, ever.** The server has no signing code path. For Indigo, the wallet is selected by
  address only (`lucid.selectWallet.fromAddress`), which can balance and build a transaction but is
  structurally incapable of signing one.
- **No funds, ever.** Nothing is custodied, pooled or forwarded.
- **No broadcasting.** The server never submits a transaction.
- **Unsigned CBOR out.** `open_cdp` / `close_cdp` return full transaction CBOR hex with an empty
  witness set — exactly the input a CIP-30 `signTx` expects — plus a human-readable `description` of
  what the transaction does, so the agent (or the human behind it) can check before signing.
- Secrets come from the environment and are never logged. `stdout` carries only JSON-RPC; all
  diagnostics go to `stderr`.

## Limitations (read this before trusting it)

- **Liqwid is read-only.** Liqwid v2's supply/borrow/repay actions go through the protocol's
  off-chain batcher with no documented public transaction-building API or SDK. Building those
  transactions would mean reverse-engineering an undocumented batcher contract, which is not
  something a PoC should ship. Rates and loan positions are read live from the public GraphQL API.
- **Indigo's Pyth-oracle path is not implemented.** `open_cdp` resolves the collateral price oracle
  from the collateral asset's datum. `OracleNft` and `Delisted` work. Indigo's newer
  `DeferredValidation` path needs a signed Pyth Lazer price message, which requires a Pyth Lazer
  access token this server has no business holding — that case throws a clear
  `NotImplementedError` instead of failing obscurely.
- **Indigo needs `INDIGO_SYSTEM_PARAMS_URL`.** The Indigo SDK ships no default SystemParams and
  Indigo publishes no documented stable URL for the file, so the tools refuse to guess.
- **Indigo position reads use the analytics API, not the SDK.** The SDK has no "find CDPs by owner"
  helper — only datum parsing, which would mean scanning every UTxO at the CDP validator. The
  analytics endpoint needs no Blockfrost key and returns the CDP out-ref that `close_cdp` needs.
- **Taxonomy asset lists are directional, not exhaustive.** Most venues publish no authoritative
  pool or market listing, so asset lists are the best-confirmed subset, not a complete index. Each
  venue's `notes` field states exactly what was and was not verified — read it rather than treating
  `assets` as ground truth.
- **RealFi is not on mainnet yet** (testnet at time of research; mainnet stated for late 2026), and
  its token tickers are unresolved between the live site (`USDrf`/`sUSDrf`) and press coverage
  (`USDr`/`sUSDr`). It is indexed for completeness, not because it is usable today.
- **Quotes are live and perishable.** `get_quote` can take up to ~25 s (it waits out a provider
  race) and quotes expire; build shortly after quoting.

## Layout

```
taxonomy/venues/*.json      one file per venue, validated by VenueSchema
src/taxonomy/               zod schema + loadVenues / listVenues / getVenue / searchVenues
src/adapters/               blockfrost, liqwid, indigo, swap (BazaarSwap API client)
src/tools/                  MCP tool registrations (thin: parse -> adapter -> JSON text)
src/server.ts               McpServer + StdioServerTransport
src/__tests__/              vitest; all network mocked
```

See `DESIGN.md` for the module contracts and the top of `src/adapters/indigo.ts` for where the
implementation deviates from the original design and why.

## License

Apache-2.0
