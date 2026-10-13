import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerGatewayTools } from '../gateway/register.js';
import { SELF_MCP_ID } from '../taxonomy/self.js';
import { registerCardanoTools } from './cardano.js';
import { registerIndigoTools } from './indigo.js';
import { registerSwapRouter } from './swap-router.js';
import { registerTaxonomyTools } from './taxonomy.js';

/**
 * `here` defaults to the keyless server alone; the combined server adds the wallet entry.
 * The gateway (third-party taxonomy tools) is on unless GATEWAY=off.
 */
export function registerTools(
  server: McpServer,
  here: readonly string[] = [SELF_MCP_ID],
  options: { gateway?: boolean } = {},
): void {
  const gatewayOn = options.gateway ?? process.env.GATEWAY !== 'off';
  const gateway = gatewayOn ? registerGatewayTools(server) : undefined;
  registerTaxonomyTools(server, here, gateway?.calls);
  registerSwapRouter(server, gateway);
  registerCardanoTools(server);
  registerIndigoTools(server);
}
