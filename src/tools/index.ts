import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SELF_MCP_ID } from '../taxonomy/self.js';
import { registerCardanoTools } from './cardano.js';
import { registerIndigoTools } from './indigo.js';
import { registerSwapTools } from './swap.js';
import { registerTaxonomyTools } from './taxonomy.js';

/** `here` defaults to the keyless server alone; the combined server adds the wallet entry. */
export function registerTools(server: McpServer, here: readonly string[] = [SELF_MCP_ID]): void {
  registerTaxonomyTools(server, here);
  registerSwapTools(server);
  registerCardanoTools(server);
  registerIndigoTools(server);
}
