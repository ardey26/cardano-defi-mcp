import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerGatewayTools } from '../gateway/register.js';
import { SELF_MCP_ID } from '../taxonomy/self.js';
import { registerCardanoTools } from './cardano.js';
import { registerIndigoTools } from './indigo.js';
import { registerSwapRouter, routerReady } from './swap-router.js';
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
  // The routers are registered either way, but find_capability must not offer them when no provider is reachable.
  const unavailable = new Set(routerReady(gateway) ? [] : [`${SELF_MCP_ID}/get_quote`, `${SELF_MCP_ID}/build_swap_tx`]);
  registerTaxonomyTools(server, here, gateway?.calls, unavailable);
  registerSwapRouter(server, gateway);
  registerCardanoTools(server);
  registerIndigoTools(server);
}
