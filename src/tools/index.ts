import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerCardanoTools } from './cardano.js';
import { registerIndigoTools } from './indigo.js';
import { registerSwapTools } from './swap.js';
import { registerTaxonomyTools } from './taxonomy.js';

export function registerTools(server: McpServer): void {
  registerTaxonomyTools(server);
  registerSwapTools(server);
  registerCardanoTools(server);
  registerIndigoTools(server);
}
