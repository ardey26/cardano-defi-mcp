/** This repo's entries in taxonomy/mcps/. */
export const SELF_MCP_ID = 'cardano-defi-mcp';
export const WALLET_MCP_ID = 'cardano-defi-mcp-wallet';

// Tools that describe the registry or the server itself. They are not
// capabilities, so they are never classified in taxonomy/mcps/.
export const META_TOOLS: readonly string[] = [
  'list_venues',
  'get_venue',
  'list_capabilities',
  'find_capability',
  'get_mcp',
  'wallet_status',
  'setup_wallet',
  'configure',
];
