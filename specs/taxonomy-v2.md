# Taxonomy v2 — capabilities, venues, MCPs

Status: draft spec, no code yet.

## Goal

An agent connects to **this** MCP server and, in one place, can both act (quote, build txs)
and ask "which venues can do X on Cardano, and how do I do it as an agent?"

Today the taxonomy is a flat list of venues with flat tags. v2 makes it a taxonomy: one
capability tree that venues and MCP tools both classify against.

```
capability (what)     lend.borrow, trade.swap, wallet.send …
  ├── venue (where)   Liqwid, Minswap, Indigo …
  └── MCP tool (how)  this server's open_cdp, Fetch's swap tool, Indigo MCP's … 
                      + effect (read / unsigned_tx / signs), official?, install config
```

This server is one entry in its own registry. That is what keeps the server and the
taxonomy in sync (see "Self-entry").

## 1. Capability tree — `taxonomy/capabilities.json`

Two levels, dot paths. Contributors can add nodes by PR (same label gate).

| Node | Meaning |
| --- | --- |
| `trade.swap` | Swap tokens on Cardano |
| `trade.cross_chain_swap` | Swap from another chain into a Cardano asset (or back) |
| `trade.perps` | Perpetual futures |
| `earn.liquidity` | Provide AMM liquidity |
| `earn.stake` | Stake a protocol token for rewards/governance |
| `earn.stability_pool` | Deposit into a liquidation-absorbing stability pool |
| `lend.supply` | Supply assets to a money market |
| `lend.borrow` | Borrow against collateral |
| `mint.cdp` | Mint a synthetic against a collateralized debt position |
| `mint.stablecoin` | Mint/redeem a reserve-backed stablecoin |
| `wallet.balance` | Read an address's balance |
| `wallet.send` | Send ADA or native assets |
| `wallet.delegate` | Delegate ADA to a stake pool |
| `wallet.sign` | Sign and submit a transaction built elsewhere |
| `data.market` | Read prices, rates, utilization |
| `data.position` | Read an address's open DeFi positions |

Record: `{ id, label, description }`. Groups (`trade`, `lend`, …) are implied by the
prefix; they have no record of their own. Non-DeFi branches (governance, NFTs,
identity) are allowed by the format but **not populated** in v2.

## 2. Venue record v2 — `taxonomy/venues/<id>.json`

```jsonc
{
  "id": "liqwid",
  "name": "Liqwid",
  "category": "lending",          // unchanged; kept for humans and the explorer
  "url": "https://liqwid.finance",
  "description": "…",
  "assets": ["ADA", "iUSD", "…"],
  "capabilities": ["lend.supply", "lend.borrow", "earn.stake"],  // tree node ids
  "notes": "…"
}
```

Changes from v1:
- `capabilities` holds tree node ids instead of the flat enum.
- `integration` is **removed**. "Can an agent act here?" is now derived from which MCP
  tools list this venue, so it can never disagree with reality.

Migration (mechanical, one script):

| v1 | v2 |
| --- | --- |
| `swap` | `trade.swap` |
| `perps` | `trade.perps` |
| `liquidity_provision` | `earn.liquidity` |
| `staking` | `earn.stake` |
| `stability_pool` | `earn.stability_pool` |
| `supply` | `lend.supply` |
| `borrow` | `lend.borrow` |
| `cdp_mint` | `mint.cdp` |
| `stablecoin_mint` | `mint.stablecoin` |

## 3. MCP record — `taxonomy/mcps/<id>.json`

```jsonc
{
  "id": "fetch-cardano",
  "name": "Fetch Cardano",
  "publisher": "ADA Markets",
  "official": false,               // true only when the publisher operates the venue(s)
  "repo": "https://github.com/ADA-Markets/fetch-cardano-mcp",
  "connect": [                     // ready-to-paste client config, one per transport
    { "transport": "stdio", "command": "npx", "args": ["-y", "…"] },
    { "transport": "http", "url": "https://…/mcp" }
  ],
  "auth": "none",                  // none | api_key | oauth
  "tools": [
    {
      "name": "quote_swap",
      "capability": "trade.swap",
      "venues": ["minswap", "sundaeswap"],   // omit = venue-agnostic (aggregator, wallet)
      "effect": "read"                       // read | unsigned_tx | signs
    }
  ],
  "notes": "…"
}
```

- Classification is **per tool**, not per server. A server can serve many capabilities.
- `effect: signs` means the server holds keys and moves funds. Agents should rank it last.
- Meta tools (`list_venues` etc.) are not listed. They are not capabilities.
- Every seed entry must have its tool names taken from a real `tools/list` run, not from
  its README.

Seed set: this server, this repo's local wallet server (separate entry,
`cardano-defi-mcp-wallet`, `effect: signs`), Indigo MCP, Indigo cardano-mcp, Fetch Cardano.

Venue records are strict: an unknown field (for example a leftover v1 `integration`) is a
validation error, not silently dropped.

## 4. Self-entry

`taxonomy/mcps/cardano-defi-mcp.json` describes this server:

| Tool | Capability | Venues | Effect |
| --- | --- | --- | --- |
| `get_quote` | `trade.cross_chain_swap` | — | read |
| `build_swap_tx` | `trade.cross_chain_swap` | — | unsigned_tx |
| `get_balance` | `wallet.balance` | — | read |
| `get_position` | `data.position` | indigo, liqwid | read |
| `get_market_data` | `data.market` | liqwid | read |
| `open_cdp` / `close_cdp` | `mint.cdp` | indigo | unsigned_tx |

The wallet server has its own entry, `cardano-defi-mcp-wallet`:

| Tool | Capability | Effect |
| --- | --- | --- |
| `sign_and_submit_cardano` | `wallet.sign` | signs |
| `send_cardano` | `wallet.send` | signs |
| `sign_and_submit_evm` / `approve_erc20` | `trade.cross_chain_swap` | signs |

A unit test lists the real tools of each server and fails if the registered set and the
entry differ (minus meta tools). Adding a tool without classifying it breaks the build.

`here` depends on how the agent connected: the keyless server marks `cardano-defi-mcp`
tools as `here`; the combined npx server marks both entries.

## 5. Agent-facing tools (this server)

| Tool | Does |
| --- | --- |
| `list_capabilities` | The tree, with venue and tool counts per node |
| `find_capability` | Input: `capability` (node or prefix, e.g. `lend`), optional `asset`, `venue`. Output below |
| `get_mcp` | One MCP record, including its `connect` config |
| `list_venues` / `get_venue` | Kept. `capability` filter accepts a prefix |

`find_capability` output:

```jsonc
{
  "capability": "mint.cdp",
  "venues": [{ "id": "indigo", "name": "Indigo", "assets": ["…"] }],
  "paths": [
    { "venue": "indigo", "mcp": "cardano-defi-mcp", "tool": "open_cdp",
      "effect": "unsigned_tx", "here": true },
    { "venue": "indigo", "mcp": "indigo-mcp", "tool": "…",
      "effect": "…", "here": false, "official": true }
  ],
  "gaps": []                // venues offering the capability with no MCP path at all
}
```

Ranking of `paths`: `here` first (callable now, no install), then lower effect
(read < unsigned_tx < signs), then `official`. When `here` is false the agent should hand
the user `get_mcp(id).connect` and ask them to add the server. The server never proxies
third-party MCPs (see Non-goals).

Server `instructions` gain one line: "To learn which venues or tools can do something,
call find_capability first."

## 6. CI

- `validate-taxonomy.mjs` checks: capability ids exist in the tree; MCP tool `venues`
  exist; filename = id; `effect` / `auth` / `transport` enums.
- PR gate (branch prefix + `taxonomy-addition` label) extends to `taxonomy/mcps/**` and
  `taxonomy/capabilities.json`. The summary table gains an MCP section.
- Weekly scheduled job: for each MCP with a no-auth `connect` entry, run `tools/list` and
  open an issue when a declared tool is missing. It never commits; drift is a human fix.
  The job that runs third-party servers has no token permissions; a second job with
  `issues: write` reads its report and files the issue.
- Explorer: each venue's status badge is derived (act here / read here / other MCP /
  no agent path) and the record lists its agent paths. The published `taxonomy.json`
  bundle becomes v2 and carries capabilities, venues and MCPs. A full capability × venue
  matrix is deferred.

## Non-goals

- Proxying third-party MCPs through this server. Their tool descriptions would enter the
  agent's context unvetted, and a signing server would move funds through us.
- Verifying that a tool *really* does what its classification says. That is maintainer
  review at the label gate; CI only checks that the tool exists.
- Populating non-DeFi branches.
- Ranking venues by yield, TVL or risk.

## Open decisions

1. Keep `category` on venues, or derive it from the top-level capability groups?
   Recommendation: keep it for v2; it costs nothing and the explorer uses it.
2. `trade.cross_chain_swap` as its own node vs. `trade.swap` plus a `chains` field.
   Recommendation: own node; the agent's intent ("move USDC on Base into ADA") is different.
