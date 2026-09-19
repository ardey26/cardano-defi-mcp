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

## Quickstart — one command

```bash
claude mcp add cardano-defi -- npx -y github:ardey26/cardano-defi-mcp
```

That is the whole install. npx fetches this repo, builds it, and Claude Code spawns it on stdio as
**one server with sixteen tools**: the nine keyless DeFi tools, five signing tools, and two
onboarding tools. Nothing to clone, no `.env` to write, no key to paste into a config file. Node 20+
is the only prerequisite, and the CLI says so plainly if you are on an older one.

> **The wallet spends without asking you.** This mode holds private keys and signs with no
> confirmation prompt anywhere — the policy caps (25 ADA / 0.01 ETH per transaction by default) *are*
> the confirmation. Fund it like a prepaid card, not like a savings account. If you want the keyless
> server only, use the [hosted HTTP endpoint](#hosted--http-mode-keyless) instead.

### The conversation that sets you up

Tell the agent "get me set up" and it walks the whole thing, because every unconfigured state comes
back as an error naming the exact next tool call:

1. **`wallet_status`** → *"This wallet holds no keys yet… Call `setup_wallet`."*
2. **`setup_wallet`** → generates the burner keys into a chmod-600 file, returns **only** the
   addresses, the caps, and the funding note. It never overwrites an existing key, and the private
   keys never enter the conversation.
3. **You fund those addresses** with an amount you would not mind losing.
4. **`get_balance`** (or anything Cardano) → *"BLOCKFROST_PROJECT_ID is not set: call `configure`
   with `blockfrostProjectId` — a free key takes a minute at blockfrost.io."*
5. **`configure { blockfrostProjectId }`** → stored in `~/.cardano-defi-mcp/config.json`, applied to
   the running server, echoed back masked.
6. **`wallet_status`** → addresses, live balances, caps, remaining 24 h headroom. You are done.

From there the agent can quote (`get_quote`), build (`build_swap_tx`, `open_cdp`) and execute
(`sign_and_submit_evm`, `send_cardano`, `sign_and_submit_cardano`) in one connection.

### Where your files live

An npx-installed package lives inside a disposable npm cache directory, so nothing writable goes
there. Config, keys and the spend ledger live in your home directory instead:

| Path | Holds | Mode |
| --- | --- | --- |
| `~/.cardano-defi-mcp/config.json` | `blockfrostProjectId`, `bazaarApiUrl` | `600` |
| `~/.cardano-defi-mcp/credentials.env` | the `WALLET_*_PRIVATE_KEY` lines | `600` |
| `~/.cardano-defi-mcp/wallet-state.json` | the rolling 24 h spend ledger | `600` |

Resolution order for every setting: **explicit environment variable** (an `env` block in
`.mcp.json`, or a shell export) → **repo `.env.local` / `.env`** when running from a checkout →
**home directory**. `CARDANO_DEFI_MCP_HOME` relocates the whole directory. A checkout keeps using
`.env.local` and `.wallet-state.json` exactly as before; only an installed package uses the home
directory.

### The other modes of the same command

```bash
npx -y github:ardey26/cardano-defi-mcp                  # combined local server (the default)
npx -y github:ardey26/cardano-defi-mcp wallet           # signing tools + onboarding only
npx -y github:ardey26/cardano-defi-mcp wallet gen evm   # make a burner key from the shell
PORT=3000 npx -y github:ardey26/cardano-defi-mcp serve-http   # the keyless HTTP server
```

The two key-holding modes refuse to start with `PORT` or `MCP_TRANSPORT=http` set. A server that
signs must never be reachable over the network, and the combined mode is not a loophole around that.

### Environment

| Variable | Required for | Default |
| --- | --- | --- |
| `BLOCKFROST_PROJECT_ID` | `get_balance`, `send_cardano`, `open_cdp`, `close_cdp` | `config.json`, else a clear error |
| `BAZAAR_API_URL` | `get_quote`, `build_swap_tx` | `https://bazaar-web.onrender.com` via the CLI; `http://localhost:3001` in-process |
| `LIQWID_GRAPHQL_URL` | `get_market_data`, Liqwid `get_position` | `https://v2.api.liqwid.finance/graphql` |
| `CARDANO_NETWORK` | Blockfrost / Indigo host selection | `mainnet` (`mainnet` \| `preprod`) |
| `INDIGO_API_URL` | Indigo `get_position` | `https://analytics.indigoprotocol.io` |
| `INDIGO_SYSTEM_PARAMS_URL` | `open_cdp`, `close_cdp` | Indigo's current mainnet params via the CLI; unset otherwise |
| `CARDANO_DEFI_MCP_HOME` | relocating config/keys/ledger | `~/.cardano-defi-mcp` |
| `MCP_TRANSPORT` | transport selection | `stdio`, or `http` when `PORT` is set |
| `PORT` | HTTP mode | — (setting it selects HTTP mode) |
| `RATE_LIMIT_PER_MIN` | HTTP mode | `60` requests/min per IP on `/mcp` |

Every read tool except `get_balance` and the Indigo tools works with no API keys at all. The
spending caps have their own variables — see [the policy leash](#the-policy-leash).

## Hosted / HTTP mode (keyless)

A public instance runs at **`https://cardano-defi-mcp.onrender.com/mcp`** (free tier: expect a cold
start after idle). Connect from Claude Code:

```bash
claude mcp add --transport http cardano-defi https://cardano-defi-mcp.onrender.com/mcp
```

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

## Run from a checkout

The repo is still a normal checkout, and nothing about that path changed.

```bash
npm i
cp .env.example .env    # fill in BLOCKFROST_PROJECT_ID; the rest have working defaults
npm test                # vitest, fully mocked — no network
npx tsx src/server.ts   # the keyless MCP server on stdio
npm run wallet          # the wallet server on stdio (npm run wallet -- gen for burner keys)
node bin/cli.mjs        # the combined server, after npm run build && npm run build:wallet
```

In a checkout, keys stay in `.env.local` and the ledger in `.wallet-state.json` at the repo root —
the home directory is used only by an installed package. `.mcp.json.example` shows the two-server
registration if you would rather keep the keyless server and the wallet apart.

## Tools

The keyless server registers the first nine. The combined CLI server registers all sixteen.

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
| `wallet_status` | Addresses, live balances, caps and remaining 24 h headroom. No key material | read-only |
| `sign_and_submit_evm` | Sign `{ chainId, to, data?, value, gasLimit? }`, broadcast, wait for the receipt | **spends** |
| `approve_erc20` | Set an ERC-20 allowance (resets to zero first for USDT-class tokens) | **spends gas** |
| `sign_and_submit_cardano` | Sign the unsigned CBOR from `open_cdp` / `close_cdp` and submit it | **spends** |
| `send_cardano` | Plain ADA payment — the execution leg of a Cardano-side deposit-address bridge | **spends** |
| `setup_wallet` | Create the missing burner keys; returns addresses, caps and funding instructions | read-only |
| `configure` | Store `blockfrostProjectId` / `bazaarApiUrl`; echoes secrets masked | read-only |

All tools return `{ content: [{ type: 'text', text: <pretty JSON> }] }`; failures return
`isError: true` with a one-line message and no stack trace. A failure caused by missing setup names
the exact tool call that fixes it.

## Security model

This is the model of the **keyless** server — `dist/server.js`, which is what the hosted deployment
runs and what `serve-http` starts. The wallet's model is [further down](#agent-wallet-autonomous-signing-local-only).

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
  Indigo publishes no documented stable URL for the file, so the tools refuse to guess. The CLI
  supplies the current mainnet URL (the same one `render.yaml` pins) so npx users are not stuck —
  expect it to 404 after the next protocol upgrade, and set the variable when it does.
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
bin/cli.mjs                 the npx entry point: combined | wallet | serve-http
taxonomy/venues/*.json      one file per venue, validated by VenueSchema
src/taxonomy/               zod schema + loadVenues / listVenues / getVenue / searchVenues
src/adapters/               blockfrost, liqwid, indigo, swap (BazaarSwap API client)
src/tools/                  MCP tool registrations (thin: parse -> adapter -> JSON text)
src/server.ts               McpServer wiring + transport selection (stdio | http)
src/http.ts                 Streamable HTTP host: routing, CORS, /health, rate limiting
src/rate-limit.ts           in-memory sliding-window per-IP limiter
src/hints.ts                whether a missing-setting error names a tool or an env var
src/wallet/                 agent-wallet: the local-only, key-holding companion server (see below)
src/wallet/combined.ts      the one-command server: defi tools + wallet tools + onboarding
src/wallet/home.ts          ~/.cardano-defi-mcp resolution (config, credentials, ledger)
src/wallet/onboarding.ts    setup_wallet + configure
src/__tests__/              vitest; all network mocked
```

Two build outputs, on purpose:

```
npm run build          tsc            -> dist/         nine keyless tools, no signing code at all
npm run build:wallet   tsconfig.wallet -> dist-wallet/  the key-holding CLI modes
npm run prepare        both           (npx runs this when it installs from GitHub)
```

`dist/` is the deployed artifact and stays structurally incapable of signing: `tsconfig.json`
excludes `src/wallet`, and nothing in `dist/` imports anything from `dist-wallet/`. The CLI does need
the wallet compiled to plain JavaScript (an installed package has no `tsx`), so it gets its own
output directory rather than being folded into the deployed one.

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
- **The private key never touches the keyless MCP server.** It is read by the example only, and the
  server is spawned with `PRIVATE_KEY` stripped from its environment. `dist/server.js` still has no
  signing code path; `viem` is a runtime dependency of the wallet and this example, and nothing in
  `dist/` imports it.

## Agent wallet (autonomous signing, local only)

`examples/execute-swap.ts` and `examples/execute-cdp.ts` prove the loop closes, but a human still runs
them. `src/wallet/` is the same signing logic repackaged as a **second MCP server** — `agent-wallet` —
so an agent can close the loop itself: the main server builds, the wallet signs and submits.

> **Everything in the wallet key is spendable by the agent, without asking you, up to the caps below.**
> There is no confirmation prompt anywhere in this server — the caps *are* the confirmation. Fund it
> like a petty-cash drawer, not like a savings account. Use a burner. `npm run wallet -- gen` makes one.

The one-command install above spawns the wallet *inside* the combined server, which is the simplest
thing that works. The rest of this section is the wallet itself: its caps, its ledger, and the
alternative two-server composition if you would rather keep the keyless server hosted.

### The two-server composition

Two servers with opposite security properties, registered side by side:

| | `cardano-defi` | `agent-wallet` |
| --- | --- | --- |
| Transport | Streamable HTTP, public (or stdio) | **stdio only** — refuses to start with `PORT` or `MCP_TRANSPORT=http` set |
| Keys | none, structurally (no signing code path) | holds `WALLET_EVM_PRIVATE_KEY` / `WALLET_CARDANO_PRIVATE_KEY` |
| Output | quotes, balances, positions, **unsigned** CBOR/calldata | broadcast transaction hashes |
| Blast radius if compromised | reads only | whatever the caps allow per 24 h |

```jsonc
{
  "mcpServers": {
    "cardano-defi": {
      "type": "http",
      "url": "https://cardano-defi-mcp.onrender.com/mcp"
    },
    "agent-wallet": {
      "command": "npx",
      "args": ["tsx", "src/wallet/server.ts"],
      "cwd": "/absolute/path/to/cardano-defi-mcp",
      "env": { "BLOCKFROST_PROJECT_ID": "mainnet<your-blockfrost-project-id>" }
    }
  }
}
```

The keys themselves stay in `.env.local` (chmod 600, gitignored) — not in `.mcp.json`, which tends to
get committed.

```bash
npm run wallet -- gen            # both burners into .env.local; prints ONLY the addresses
npm run wallet -- gen evm        # or just one
npm run wallet -- gen cardano
npm run wallet                   # start the stdio server
```

An agent does the same thing by calling `setup_wallet`, which writes to `.env.local` in a checkout
and to `~/.cardano-defi-mcp/credentials.env` when installed. Both refuse to overwrite a key that
already exists — a key may hold funds, and replacing it would lose them.

### Tools

| Tool | What it does | Funds |
| --- | --- | --- |
| `wallet_status` | Addresses, live balances (viem per allowlisted chain, Blockfrost for ADA), caps and remaining 24 h headroom. No key material. | read-only |
| `sign_and_submit_evm` | Sign `{ chainId, to, data?, value, gasLimit? }`, broadcast, wait for the receipt | **spends** |
| `approve_erc20` | Set an ERC-20 allowance (resets to zero first for USDT-class tokens) | **spends gas** |
| `sign_and_submit_cardano` | Sign the unsigned CBOR from `open_cdp` / `close_cdp` and submit it via Blockfrost | **spends** |
| `send_cardano` | Build, sign and submit a plain ADA payment to an address | **spends** |
| `setup_wallet` | Create the missing burner keys; returns addresses, caps and funding instructions | read-only |
| `configure` | Store `blockfrostProjectId` / `bazaarApiUrl` in `~/.cardano-defi-mcp/config.json` | read-only |

Whichever key is present is served; the other chain's tools fail with a clear message instead of
silently doing nothing. Keys are never printed or returned, and every error leaving the process is
run through a redactor first.

`send_cardano` exists for **deposit-address bridges**: a quote that starts on Cardano is executed not
by signing a built transaction but by paying ADA to the provider's deposit address, so that leg is a
plain transfer. It is capped exactly like `sign_and_submit_cardano` — the amount *plus the fee* is
measured against the lovelace caps before anything is signed — and it refuses an address on the wrong
network rather than sending funds into the void.

### The policy leash

Every signing tool checks the policy *before* it signs. Two caps per chain family — one per
transaction, one rolling 24 hours — plus an EVM chain allowlist.

| Variable | Governs | Default |
| --- | --- | --- |
| `WALLET_MAX_TX_LOVELACE` | ADA per transaction | `25000000` (25 ADA) |
| `WALLET_MAX_DAILY_LOVELACE` | ADA per rolling 24 h | `100000000` (100 ADA) |
| `WALLET_MAX_TX_WEI` | native EVM value per transaction | `10000000000000000` (0.01 ETH) |
| `WALLET_MAX_DAILY_WEI` | native EVM value per rolling 24 h | `30000000000000000` (0.03 ETH) |
| `WALLET_EVM_CHAINS` | chain ids the wallet may sign for at all | `1,42161,8453` |
| `RPC_URL_<chainId>` | per-chain RPC override | viem's public RPC |
| `WALLET_STATE_FILE` | where the spend ledger lives | `.wallet-state.json` at the repo root, or `~/.cardano-defi-mcp/wallet-state.json` |

- **The window is a true sliding window**, not a calendar day: a spend stops counting exactly 24 h
  after it was recorded.
- **Recorded on successful submit only**, to `.wallet-state.json` (gitignored, chmod 600), so the caps
  survive a restart — otherwise an agent could reset them by restarting the server. A corrupt ledger
  file refuses to sign rather than reading as empty.
- **Denials are plannable.** A refusal comes back as `isError` carrying the cap, the attempted amount,
  what is already spent, the headroom left, and — for a daily-cap denial — the ISO timestamp at which
  enough older spends age out for the attempt to fit.
- **The EVM caps count native value only.** `value` is what they measure, so an ERC-20 transfer —
  which moves tokens through calldata and carries `value: 0` — passes the caps untouched. Likewise
  `approve_erc20` is exempt from the value caps (an approval moves no value) but still requires an
  allowlisted chain, and an approval *authorises* a spender to move tokens later, which the caps do
  not police either. Approve exact amounts, to spenders that came from a quote, and do not keep
  token balances in this wallet that you would mind losing. The Cardano cap has no such hole: it
  measures the whole ADA outflow of the transaction body.
- **EVM amounts are summed in wei across chains.** That is only coherent because the default allowlist
  is ETH-native throughout; adding a chain with a different native token makes the daily EVM cap add
  apples to oranges.
- **Cardano spend is measured conservatively**: every output that does not pay back to the wallet,
  plus the fee. A transaction body carries no input values, so an exact net outflow would mean a UTxO
  lookup per input; this over-counts when the transaction also spends value the wallet did not own
  (closing a CDP, for instance). Over-counting denies more than it should, never less. See the comment
  on `cardanoOutflowLovelace` in `src/wallet/cardano.ts`.

### What the wallet does not change about the main server

`npm run build` still excludes `src/wallet` from `dist/`, so `dist/server.js` — the hosted artifact —
still has no way to sign anything, and `npm start` still starts the keyless nine-tool server. The
wallet compiles to `dist-wallet/` instead, which only the CLI's local modes load; `tsc --noEmit`
typechecks all of it either way.

Two honest caveats about that separation:

- `npm run prepare` builds both directories, and `npm ci` runs `prepare`, so a Render deploy has
  `dist-wallet/` on disk even though nothing it runs imports it. The property that protects you is
  that the hosted instance holds no keys and its code path never reaches that directory — not that
  the bytes are absent.
- `viem` moved from `devDependencies` to `dependencies`, because an npx install of a git package
  keeps only runtime dependencies and the wallet needs it to sign. `dist/` imports it nowhere.

## License

Apache-2.0
