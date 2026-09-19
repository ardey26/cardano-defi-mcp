# cardano-defi-mcp — Cardano DeFi taxonomy + MCP server

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
| `MCP_TRANSPORT` | transport selection | `stdio`, or `http` when `PORT` is set |
| `PORT` | HTTP mode | — (setting it selects HTTP mode) |
| `RATE_LIMIT_PER_MIN` | HTTP mode | `60` requests/min per IP on `/mcp` |

Every read tool except `get_balance` and the Indigo tools works with no API keys at all.

### Register with Claude Code

Copy `.mcp.json.example` to `.mcp.json` in your project root, fill in the env placeholders, and
restart Claude Code. Then `/mcp` should list `cardano-defi-mcp` with nine tools.

## Hosted / HTTP mode

The same nine tools also speak **Streamable HTTP**, so the server can be hosted instead of spawned.
stdio stays the default; setting `PORT` (or `MCP_TRANSPORT=http`) switches transports.

```bash
npm run build
PORT=3000 npm start            # POST /mcp, GET /health
```

Connect a client to it:

```bash
claude mcp add --transport http cardano-defi https://<your-host>/mcp
```

- **Stateless.** No sessions, no `Mcp-Session-Id`: every POST gets its own server instance, so a
  restart costs a client nothing. `GET`/`DELETE /mcp` answer `405` — with no session there is no
  server-initiated stream to open and nothing to tear down.
- **Rate limited** to 60 requests/min per IP on `/mcp` (`RATE_LIMIT_PER_MIN`), sliding window, in
  memory. Over budget gets a `429` with `Retry-After` and a JSON-RPC error body. `/health` is exempt.
- **Open CORS** (`Access-Control-Allow-Origin: *`) so browser-based MCP clients can reach it. There
  is no auth and no secret worth stealing in the response — the server holds no keys and signs
  nothing — but everything it can do, any caller can do, so host it with that in mind.

`render.yaml` deploys it as a Render web service (free plan, `/health` as the health check). Note
what a free tier means: **the instance sleeps after ~15 minutes idle**, so the first call after a
quiet spell can take tens of seconds while it wakes. It is a proof of concept, not an SLA — for
anything real, run your own instance or use stdio.

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
- **Indigo's Pyth-oracle path leans on Indigo's analytics API.** `open_cdp` resolves the collateral
  price oracle from the collateral asset's datum. `OracleNft` and `Delisted` are handled directly.
  Indigo's newer `DeferredValidation` path needs a *signed* Pyth Lazer price message, which needs a
  Pyth Lazer access token this server has no business holding — so it proxies the signed message
  and the Pyth state UTxO from Indigo's public, unauthenticated analytics API
  (`/api/v3/assets/{iasset}/ada/price`, `/api/v3/pyth-state/utxo`), the same route Indigo's own
  `indigo-mcp` takes. Those messages expire 280 s after their timestamp, so the transaction must be
  signed and submitted promptly after it is built.
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
src/server.ts               McpServer wiring + transport selection (stdio | http)
src/http.ts                 Streamable HTTP host: routing, CORS, /health, rate limiting
src/rate-limit.ts           in-memory sliding-window per-IP limiter
src/__tests__/              vitest; all network mocked
```

See `DESIGN.md` for the module contracts and the top of `src/adapters/indigo.ts` for where the
implementation deviates from the original design and why.

## Taxonomy explorer

`scripts/build-explorer.mjs` renders the venue records into a static page plus a machine-readable
`taxonomy.json` bundle. The output is generated, not committed — `docs/` is gitignored.

```bash
npm run build:explorer && open docs/index.html   # local preview over file://
```

The published version is built and deployed to GitHub Pages by `.github/workflows/pages.yml` on
every push to `main` that touches `taxonomy/` or `scripts/`. This requires the repository's
**Settings → Pages → Source** to be set to **GitHub Actions**.

## Add your protocol

The taxonomy is a community registry — a venue is one JSON file, and adding one takes a PR.

1. Fork the repo and create a branch named `taxonomy/<something>` (e.g. `taxonomy/add-myvenue`) —
   the PR gate rejects other branch names.
2. Add `taxonomy/venues/<id>.json`. The filename (minus `.json`) must equal the record's `id`, and
   the record must match [`src/taxonomy/schema.ts`](src/taxonomy/schema.ts). Copy an existing file
   such as `taxonomy/venues/minswap.json` as a starting point.
3. Run `npm run validate:taxonomy` locally — it needs no dependencies and names every problem.
4. Open a PR. CI validates the file and prints a summary of what changed. A maintainer applies the
   `taxonomy-addition` label after review; the PR cannot merge without it.

Keep `notes` honest: say what you verified and what you did not. Asset lists are expected to be
directional rather than exhaustive. On merge, the explorer and `taxonomy.json` republish
automatically.

## Try the reference agent

`npm run demo` runs `examples/reference-agent.ts`: a minimal MCP client that spawns this server over
stdio, lists its tools, and calls `list_venues`, `get_market_data` and `get_position` against live
public APIs. No API keys needed; network access is.

## Execute a real swap (advanced)

`examples/execute-swap.ts` is the other half of the story: the **agent-side signer**. The MCP server
quotes and builds but never signs — something outside it has to close the loop, and this example
shows what that something looks like. It moves real funds.

> **Use a burner wallet.** Fund it with exactly the amount you intend to trade and nothing more.
> This is example code for a proof of concept, not a production signer.

```bash
npm run execute -- gen      # new burner: appends PRIVATE_KEY to .env.local, prints only the address
npm run execute -- quote    # dry run: warms the API token cache, races quotes (no key needed)
npm run execute -- run      # quote → build → approve → summary, then STOPS
npm run execute -- run --yes  # the same, but signs and broadcasts
```

Configure the pair with flags or env (`.env.local` wins over `.env`):
`FROM_CHAIN` (1 or 42161), `FROM_TOKEN` (`native` or an ERC-20 address), `AMOUNT` (wei),
`DEST_ADDRESS` (`addr1…`), plus optional `TO_CHAIN` / `TO_TOKEN` / `SLIPPAGE` / `RPC_URL`.

- **`--yes` is the only way to broadcast.** Without it `run` prints the exact transaction — sender,
  target, value, calldata size, estimated ADA out, destination address — and exits with
  `DRY RUN — add --yes to broadcast`.
- **ERC-20 sources get an exact-amount approval**, only when the current allowance is short, and the
  script waits for that receipt before it signs the swap.
- After broadcasting it registers the hash with the API (`POST /status/register`, sending both the
  `quoteId` and the signed `tracking` token from the execute response) and polls
  `GET /status/{txHash}` every 15 s for up to 10 minutes, printing each transition until
  `complete` / `failed` / `untracked`. A failed swap exits non-zero.
- **The private key never touches the MCP server.** It is read by the example only, and the server
  is spawned with `PRIVATE_KEY` stripped from its environment. The server still has no signing code
  path — `viem` is a devDependency used by this example alone, never by `src/`.

## License

Apache-2.0
