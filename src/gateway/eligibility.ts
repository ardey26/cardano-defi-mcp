/**
 * Which taxonomy MCP tools the gateway exposes, decided from the records alone.
 * The rules mirror specs/taxonomy-gateway.md §2 and are duplicated, on purpose,
 * in scripts/validate-taxonomy.mjs so PR CI needs no install.
 */

import { TAXONOMY_ROOT, loadMcps } from '../taxonomy/index.js';
import type { Mcp, McpTool } from '../taxonomy/schema.js';
import { SELF_MCP_ID, WALLET_MCP_ID } from '../taxonomy/self.js';

export const OWN_MCPS = [SELF_MCP_ID, WALLET_MCP_ID];

const EXACT_VERSION = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:-[\w.]+)?$/;

export function isPinned(spec: string): boolean {
  return EXACT_VERSION.test(spec);
}

/**
 * The only npx shapes the gateway accepts: `-y`/`--yes`, `-p <spec>`/`--package <spec>`, and exactly
 * one bare name (the package when no -p is given, otherwise the bin). Anything else — `--registry=…`,
 * `--node-options=…`, `--package=…`, extra arguments — could run code the pin does not describe.
 */
export function parseNpxArgs(args: string[]): { packages: string[]; bin?: string } | undefined {
  const packages: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-y' || arg === '--yes') continue;
    if (arg === '-p' || arg === '--package') {
      const spec = args[++i];
      if (spec === undefined || spec.startsWith('-')) return undefined;
      packages.push(spec);
    } else if (arg.startsWith('-')) return undefined;
    else positionals.push(arg);
  }
  if (positionals.length !== 1) return undefined;
  return packages.length > 0 ? { packages, bin: positionals[0] } : { packages: [positionals[0]] };
}

/** The packages an accepted npx command names; empty when the command is not accepted. */
export function packageSpecs(args: string[]): string[] {
  return parseNpxArgs(args)?.packages ?? [];
}

export function gatewayConnect(mcp: Mcp): { command: string; args: string[] } | undefined {
  if (mcp.auth !== 'none') return undefined;
  for (const entry of mcp.connect) {
    if (entry.transport !== 'stdio' || entry.command !== 'npx') continue;
    const specs = packageSpecs(entry.args);
    if (specs.length > 0 && specs.every(isPinned)) return { command: entry.command, args: entry.args };
  }
  return undefined;
}

export function exposedTools(mcp: Mcp): McpTool[] {
  return mcp.tools.filter((t) => t.effect !== 'signs' && !t.env);
}

export function exposedName(mcpId: string, tool: string): string {
  return `${mcpId.replace(/-/g, '_')}__${tool}`;
}

export function gatewayMcps(root = TAXONOMY_ROOT): Array<{ mcp: Mcp; connect: { command: string; args: string[] }; tools: McpTool[] }> {
  return loadMcps(root).flatMap((mcp) => {
    if (OWN_MCPS.includes(mcp.id)) return [];
    const connect = gatewayConnect(mcp);
    const tools = exposedTools(mcp);
    return connect && tools.length > 0 ? [{ mcp, connect, tools }] : [];
  });
}
